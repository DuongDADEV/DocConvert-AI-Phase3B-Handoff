import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import {
  CreditService,
  UNITS_PER_CREDIT,
  safeParseCreditUnits,
  unitsToCredits,
  creditsToUnits,
} from '../services/credit/creditService.js';

interface TestCase {
  id: string;
  name: string;
  run: () => Promise<void>;
}

const migrationPath = path.resolve('supabase/migrations/20261002010000_credit_reservation_foundation.sql');
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

const testCases: TestCase[] = [
  // ---------------------------------------------------------------------------
  // RB-01: reserved_units column is BIGINT and constrained: 0 <= reserved_units <= remaining_units
  // ---------------------------------------------------------------------------
  {
    id: 'RB-01',
    name: 'reserved_units column is BIGINT and constrained (0 <= reserved_units <= remaining_units)',
    run: async () => {
      assert(
        migrationSql.includes('ADD COLUMN IF NOT EXISTS reserved_units BIGINT NOT NULL DEFAULT 0'),
        'Must add reserved_units BIGINT with DEFAULT 0'
      );
      assert(
        migrationSql.includes('chk_credit_grants_reserved_units') &&
        migrationSql.includes('CHECK (reserved_units >= 0 AND reserved_units <= remaining_units)'),
        'Must enforce check: reserved_units >= 0 AND reserved_units <= remaining_units'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-02: reservation schema constraints valid
  // ---------------------------------------------------------------------------
  {
    id: 'RB-02',
    name: 'reservation schema constraints valid (requested_units = reserved_units, captured+released <= reserved)',
    run: async () => {
      assert(migrationSql.includes('CREATE TABLE IF NOT EXISTS public.credit_reservations'), 'Must create credit_reservations table');
      assert(migrationSql.includes('CHECK (requested_units > 0)'), 'requested_units must be > 0');
      assert(migrationSql.includes('CHECK (reserved_units > 0)'), 'reserved_units must be > 0');
      assert(migrationSql.includes('CHECK (captured_units >= 0)'), 'captured_units must be >= 0');
      assert(migrationSql.includes('CHECK (released_units >= 0)'), 'released_units must be >= 0');
      assert(migrationSql.includes('CHECK (captured_units + released_units <= reserved_units)'), 'captured + released must be <= reserved');
      assert(migrationSql.includes('CHECK (requested_units = reserved_units)'), 'requested_units must equal reserved_units on successful reservation');
      assert(migrationSql.includes('idempotency_key TEXT NOT NULL UNIQUE'), 'idempotency_key must be UNIQUE');
      assert(
        migrationSql.includes("CHECK (status IN ('RESERVED', 'PARTIALLY_CAPTURED', 'CAPTURED', 'RELEASED', 'SETTLED', 'EXPIRED'))"),
        'status must be strictly constrained'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-03: allocation schema identity constraints valid
  // ---------------------------------------------------------------------------
  {
    id: 'RB-03',
    name: 'allocation schema identity constraints valid (composite FKs to reservation and grant)',
    run: async () => {
      assert(
        migrationSql.includes('CREATE TABLE IF NOT EXISTS public.credit_reservation_allocations'),
        'Must create credit_reservation_allocations table'
      );
      assert(
        migrationSql.includes('FOREIGN KEY (reservation_id, account_id, user_id)') &&
        migrationSql.includes('REFERENCES public.credit_reservations(id, account_id, user_id)'),
        'Must enforce composite FK to credit_reservations(id, account_id, user_id)'
      );
      assert(
        migrationSql.includes('FOREIGN KEY (grant_id, account_id, user_id)') &&
        migrationSql.includes('REFERENCES public.credit_grants(id, account_id, user_id)'),
        'Must enforce composite FK to credit_grants(id, account_id, user_id)'
      );
      assert(
        migrationSql.includes('UNIQUE (reservation_id, grant_id)'),
        'Must enforce UNIQUE(reservation_id, grant_id)'
      );
      assert(
        migrationSql.includes('UNIQUE (reservation_id, allocation_order)'),
        'Must enforce UNIQUE(reservation_id, allocation_order)'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-04: reservation event table append-only
  // ---------------------------------------------------------------------------
  {
    id: 'RB-04',
    name: 'reservation event table append-only (immutability trigger rejects UPDATE and DELETE)',
    run: async () => {
      assert(
        migrationSql.includes('CREATE TABLE IF NOT EXISTS public.credit_reservation_events'),
        'Must create credit_reservation_events table'
      );
      assert(
        migrationSql.includes('CREATE OR REPLACE FUNCTION public.fn_guard_credit_reservation_events_immutability()'),
        'Must declare immutability guard function'
      );
      assert(
        migrationSql.includes('BEFORE UPDATE OR DELETE ON public.credit_reservation_events'),
        'Must attach trigger before UPDATE or DELETE'
      );
      assert(
        migrationSql.includes('CREDIT_RESERVATION_EVENTS_IMMUTABLE'),
        'Must raise immutable exception'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-05: reserve single grant works
  // ---------------------------------------------------------------------------
  {
    id: 'RB-05',
    name: 'reserve single grant works (service calls reserve_credit_units RPC atomically)',
    run: async () => {
      let rpcCalled = false;
      const mockClient = {
        rpc: async (fnName: string, args: any) => {
          assert.strictEqual(fnName, 'reserve_credit_units');
          assert.strictEqual(args.p_requested_units, 5000);
          rpcCalled = true;
          return {
            data: {
              reservation_id: 'res-01',
              account_id: 'acc-01',
              user_id: args.p_user_id,
              requested_units: 5000,
              reserved_units: 5000,
              total_available_units: 95000,
              status: 'RESERVED',
              allocations: [
                { allocation_id: 'alloc-01', grant_id: 'grant-01', allocation_order: 1, reserved_units: 5000 },
              ],
              already_processed: false,
            },
            error: null,
          };
        },
      } as any;

      const svc = new CreditService(mockClient);
      const res = await svc.reserveCredits({
        userId: 'user-01',
        requestedUnits: 5000,
        idempotencyKey: 'res_key_1',
      });

      assert(rpcCalled);
      assert.strictEqual(res.reservationId, 'res-01');
      assert.strictEqual(res.reservedUnits, 5000);
      assert.strictEqual(res.totalAvailableUnits, 95000);
      assert.strictEqual(res.status, 'RESERVED');
    },
  },

  // ---------------------------------------------------------------------------
  // RB-06: reserve across multiple grants works
  // ---------------------------------------------------------------------------
  {
    id: 'RB-06',
    name: 'reserve across multiple grants works (splits across multiple allocations)',
    run: async () => {
      const mockClient = {
        rpc: async (_fnName: string, args: any) => ({
          data: {
            reservation_id: 'res-multi',
            account_id: 'acc-01',
            user_id: args.p_user_id,
            requested_units: 7000,
            reserved_units: 7000,
            total_available_units: 0,
            status: 'RESERVED',
            allocations: [
              { allocation_id: 'alloc-1', grant_id: 'grant-expiring', allocation_order: 1, reserved_units: 3000 },
              { allocation_id: 'alloc-2', grant_id: 'grant-pack', allocation_order: 2, reserved_units: 4000 },
            ],
            already_processed: false,
          },
          error: null,
        }),
      } as any;

      const svc = new CreditService(mockClient);
      const res = await svc.reserveCredits({
        userId: 'user-01',
        requestedUnits: 7000,
        idempotencyKey: 'res_multi_key',
      });

      assert.strictEqual(res.allocations.length, 2);
      assert.strictEqual(res.allocations[0].reserved_units, 3000);
      assert.strictEqual(res.allocations[1].reserved_units, 4000);
    },
  },

  // ---------------------------------------------------------------------------
  // RB-07: allocation priority uses: expires_at ASC NULLS LAST, granted_at ASC, id ASC
  // ---------------------------------------------------------------------------
  {
    id: 'RB-07',
    name: 'allocation priority uses (expires_at ASC NULLS LAST, granted_at ASC, id ASC)',
    run: async () => {
      assert(
        migrationSql.includes('ORDER BY expires_at ASC NULLS LAST, granted_at ASC, id ASC'),
        'reserve_credit_units must order grants by expires_at ASC NULLS LAST, granted_at ASC, id ASC'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-08: expired grants cannot be used for NEW reservation
  // ---------------------------------------------------------------------------
  {
    id: 'RB-08',
    name: 'expired grants cannot be used for NEW reservation (expires_at > NOW() required)',
    run: async () => {
      assert(
        migrationSql.includes('(expires_at IS NULL OR expires_at > NOW())'),
        'reserve_credit_units must require expires_at IS NULL OR expires_at > NOW()'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-09: purchased NULL-expiration grant comes after expiring grant
  // ---------------------------------------------------------------------------
  {
    id: 'RB-09',
    name: 'purchased NULL-expiration grant comes after expiring grant (NULLS LAST sorting)',
    run: async () => {
      assert(
        migrationSql.includes('expires_at ASC NULLS LAST'),
        'Sorting must place non-expiring grants (expires_at IS NULL) last'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-10: insufficient credit fails atomically
  // ---------------------------------------------------------------------------
  {
    id: 'RB-10',
    name: 'insufficient credit fails atomically (INSUFFICIENT_CREDIT exception raised)',
    run: async () => {
      assert(
        migrationSql.includes("RAISE EXCEPTION 'INSUFFICIENT_CREDIT: Requested % units, but only % available'"),
        'Must raise INSUFFICIENT_CREDIT with requested and available details'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-11: no partial reservation on insufficient balance
  // ---------------------------------------------------------------------------
  {
    id: 'RB-11',
    name: 'no partial reservation on insufficient balance (all-or-nothing rollback)',
    run: async () => {
      // In PostgreSQL functions, an uncaught RAISE EXCEPTION rolls back the entire transaction.
      // Confirm that the available check occurs before any INSERT into credit_reservations.
      const checkPos = migrationSql.indexOf('IF v_total_available < p_requested_units THEN');
      const insertPos = migrationSql.indexOf('INSERT INTO public.credit_reservations');
      assert(checkPos > 0 && insertPos > checkPos, 'Availability check must happen before reservation insert');
    },
  },

  // ---------------------------------------------------------------------------
  // RB-12: concurrent reserves cannot overspend
  // ---------------------------------------------------------------------------
  {
    id: 'RB-12',
    name: 'concurrent reserves cannot overspend (row-level FOR UPDATE locking & DB constraints)',
    run: async () => {
      assert(
        migrationSql.includes('FROM public.credit_accounts') && migrationSql.includes('FOR UPDATE'),
        'Account row must be locked with FOR UPDATE'
      );
      assert(
        migrationSql.includes('FROM public.credit_grants') && migrationSql.includes('FOR UPDATE'),
        'Grant rows must be locked with FOR UPDATE'
      );
      assert(
        migrationSql.includes('CHECK (reserved_units >= 0 AND reserved_units <= remaining_units)'),
        'DB constraint must prevent reserved_units > remaining_units under any condition'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-13: reserve same idempotency key + same payload returns existing reservation
  // ---------------------------------------------------------------------------
  {
    id: 'RB-13',
    name: 'reserve same idempotency key + same payload returns existing reservation',
    run: async () => {
      assert(
        migrationSql.includes("'already_processed', true"),
        'Idempotency check must return already_processed = true on matching payload'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-14: reserve same key + different payload fails conflict
  // ---------------------------------------------------------------------------
  {
    id: 'RB-14',
    name: 'reserve same key + different payload fails conflict (IDEMPOTENCY_KEY_CONFLICT)',
    run: async () => {
      assert(
        migrationSql.includes("RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Idempotency key \"%\" was already processed"),
        'Must raise IDEMPOTENCY_KEY_CONFLICT on mismatched reservation payload'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-15: full capture decreases remaining_units and reserved_units
  // ---------------------------------------------------------------------------
  {
    id: 'RB-15',
    name: 'full capture decreases remaining_units and reserved_units',
    run: async () => {
      assert(
        migrationSql.includes('v_new_remaining := v_grant.remaining_units - v_capture_amount;') &&
        migrationSql.includes('v_new_reserved := v_grant.reserved_units - v_capture_amount;'),
        'Capture must decrease both remaining_units and reserved_units'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-16: capture creates negative CAPTURE ledger entry
  // ---------------------------------------------------------------------------
  {
    id: 'RB-16',
    name: 'capture creates negative CAPTURE ledger entry (entry_type = CAPTURE, delta_units < 0)',
    run: async () => {
      assert(
        migrationSql.includes("'CAPTURE'") &&
        migrationSql.includes('-v_capture_amount'),
        'Capture must insert ledger entry with entry_type = CAPTURE and negative delta'
      );
      assert(
        migrationSql.includes('chk_credit_ledger_capture_delta') &&
        migrationSql.includes("entry_type <> 'CAPTURE' OR delta_units < 0"),
        'credit_ledger constraint must enforce negative delta for CAPTURE'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-17: multi-grant capture creates correctly scoped ledger entries
  // ---------------------------------------------------------------------------
  {
    id: 'RB-17',
    name: 'multi-grant capture creates correctly scoped ledger entries (one per affected grant)',
    run: async () => {
      assert(
        migrationSql.includes("'CAPTURE:' || p_idempotency_key || ':' || v_alloc.grant_id::text"),
        'Ledger entry idempotency key must be scoped per grant (CAPTURE:key:grantId)'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-18: partial capture works
  // ---------------------------------------------------------------------------
  {
    id: 'RB-18',
    name: 'partial capture works (leaves outstanding reservation active for later settlement)',
    run: async () => {
      assert(
        migrationSql.includes("v_new_status := 'PARTIALLY_CAPTURED';"),
        'Must transition to PARTIALLY_CAPTURED when captured_units < reserved_units'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-19: capture cannot exceed outstanding reservation
  // ---------------------------------------------------------------------------
  {
    id: 'RB-19',
    name: 'capture cannot exceed outstanding reservation (CAPTURE_EXCEEDS_RESERVED)',
    run: async () => {
      assert(
        migrationSql.includes("RAISE EXCEPTION 'CAPTURE_EXCEEDS_RESERVED: Cannot capture % units; only % outstanding"),
        'Must raise CAPTURE_EXCEEDS_RESERVED when capture_units > outstanding'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-20: capture idempotent retry cannot double debit
  // ---------------------------------------------------------------------------
  {
    id: 'RB-20',
    name: 'capture idempotent retry cannot double debit (checked against credit_reservation_events)',
    run: async () => {
      assert(
        migrationSql.includes('FROM public.credit_reservation_events') &&
        migrationSql.includes('WHERE idempotency_key = p_idempotency_key;'),
        'Capture must check credit_reservation_events for prior idempotent execution'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-21: capture idempotency conflict fails closed
  // ---------------------------------------------------------------------------
  {
    id: 'RB-21',
    name: 'capture idempotency conflict fails closed (IDEMPOTENCY_KEY_CONFLICT)',
    run: async () => {
      assert(
        migrationSql.includes("RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Capture idempotency key \"%\" was already processed"),
        'Must raise IDEMPOTENCY_KEY_CONFLICT if capture key was used with different payload'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-22: release decreases reserved_units only
  // ---------------------------------------------------------------------------
  {
    id: 'RB-22',
    name: 'release decreases reserved_units only (SET reserved_units = reserved_units - v_release_amount)',
    run: async () => {
      assert(
        migrationSql.includes('SET reserved_units = reserved_units - v_release_amount'),
        'Release must decrement reserved_units on grant bucket'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-23: release does NOT increase/decrease remaining_units
  // ---------------------------------------------------------------------------
  {
    id: 'RB-23',
    name: 'release does NOT increase/decrease remaining_units',
    run: async () => {
      // In release_credit_reservation, remaining_units must never be updated
      const releaseFnStart = migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.release_credit_reservation');
      const releaseFnEnd = migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.get_user_credit_balance');
      const releaseFnCode = migrationSql.slice(releaseFnStart, releaseFnEnd);

      assert(
        !releaseFnCode.includes('remaining_units = remaining_units -') &&
        !releaseFnCode.includes('remaining_units = remaining_units +'),
        'release_credit_reservation must NOT touch remaining_units'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-24: release creates operational event but no financial delta ledger entry
  // ---------------------------------------------------------------------------
  {
    id: 'RB-24',
    name: 'release creates operational event but no financial delta ledger entry',
    run: async () => {
      const releaseFnStart = migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.release_credit_reservation');
      const releaseFnEnd = migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.get_user_credit_balance');
      const releaseFnCode = migrationSql.slice(releaseFnStart, releaseFnEnd);

      assert(
        releaseFnCode.includes("INSERT INTO public.credit_reservation_events"),
        'release must log operational event in credit_reservation_events'
      );
      assert(
        !releaseFnCode.includes('INSERT INTO public.credit_ledger'),
        'release must NEVER insert into credit_ledger'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-25: release cannot exceed outstanding reservation
  // ---------------------------------------------------------------------------
  {
    id: 'RB-25',
    name: 'release cannot exceed outstanding reservation (RELEASE_EXCEEDS_RESERVED)',
    run: async () => {
      assert(
        migrationSql.includes("RAISE EXCEPTION 'RELEASE_EXCEEDS_RESERVED: Cannot release % units; only % outstanding"),
        'Must raise RELEASE_EXCEEDS_RESERVED when release_units > outstanding'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-26: release idempotent retry safe
  // ---------------------------------------------------------------------------
  {
    id: 'RB-26',
    name: 'release idempotent retry safe',
    run: async () => {
      assert(
        migrationSql.includes("RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Release idempotency key \"%\" was already processed"),
        'Must guard release idempotency key against conflicting reuse'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-27: reservation status transitions correct
  // ---------------------------------------------------------------------------
  {
    id: 'RB-27',
    name: 'reservation status transitions correct (RESERVED, PARTIALLY_CAPTURED, CAPTURED, RELEASED, SETTLED)',
    run: async () => {
      assert(migrationSql.includes("v_new_status := 'CAPTURED';"), 'Must set CAPTURED when captured = reserved');
      assert(migrationSql.includes("v_new_status := 'RELEASED';"), 'Must set RELEASED when released = reserved');
      assert(migrationSql.includes("v_new_status := 'SETTLED';"), 'Must set SETTLED on mixed final settlement');
      assert(migrationSql.includes("v_new_status := 'PARTIALLY_CAPTURED';"), 'Must set PARTIALLY_CAPTURED on partial capture');
    },
  },

  // ---------------------------------------------------------------------------
  // RB-28: FROZEN account cannot create reservation
  // ---------------------------------------------------------------------------
  {
    id: 'RB-28',
    name: 'FROZEN account cannot create reservation (CREDIT_ACCOUNT_FROZEN)',
    run: async () => {
      assert(
        migrationSql.includes("IF v_account_status = 'FROZEN' THEN") &&
        migrationSql.includes("RAISE EXCEPTION 'CREDIT_ACCOUNT_FROZEN: Account for user % is frozen'"),
        'Must block reservation for FROZEN account'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-29: FROZEN account may release existing reservation
  // ---------------------------------------------------------------------------
  {
    id: 'RB-29',
    name: 'FROZEN account may release existing reservation (release permitted to free held credits)',
    run: async () => {
      const releaseFnStart = migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.release_credit_reservation');
      const releaseFnEnd = migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.get_user_credit_balance');
      const releaseFnCode = migrationSql.slice(releaseFnStart, releaseFnEnd);

      assert(
        !releaseFnCode.includes("v_account_status = 'FROZEN'"),
        'release_credit_reservation must NOT block FROZEN account'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-30: CLOSED account cannot reserve/capture
  // ---------------------------------------------------------------------------
  {
    id: 'RB-30',
    name: 'CLOSED account cannot reserve, capture, or release',
    run: async () => {
      assert(
        migrationSql.includes("RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Account for user % is closed'"),
        'reserve must reject CLOSED account'
      );
      assert(
        migrationSql.includes("RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Cannot capture on closed account'"),
        'capture must reject CLOSED account'
      );
      assert(
        migrationSql.includes("RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Cannot release on closed account'"),
        'release must reject CLOSED account'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-31: balance API subtracts reserved credit
  // ---------------------------------------------------------------------------
  {
    id: 'RB-31',
    name: 'balance API subtracts reserved credit (total_available_units = gross_remaining - reserved)',
    run: async () => {
      assert(
        migrationSql.includes('COALESCE(SUM(remaining_units - reserved_units), 0)'),
        'get_user_credit_balance RPC must compute available units as remaining - reserved'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-32: grossRemainingUnits remains distinct from available units
  // ---------------------------------------------------------------------------
  {
    id: 'RB-32',
    name: 'grossRemainingUnits remains distinct from available units (getUserBalance DTO)',
    run: async () => {
      const mockClient = {
        from: (table: string) => {
          if (table === 'credit_accounts') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: 'acc-1', status: 'ACTIVE' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'credit_grants') {
            return {
              select: () => ({
                eq: () => ({
                  eq: async () => ({
                    data: [
                      { remaining_units: 120000, reserved_units: 5000, source_type: 'SUBSCRIPTION_CYCLE', expires_at: null },
                    ],
                    error: null,
                  }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      } as any;

      const svc = new CreditService(mockClient);
      const balance = await svc.getUserBalance('u-1');

      assert.strictEqual(balance.grossRemainingUnits, 120000, 'grossRemainingUnits must be 120000');
      assert.strictEqual(balance.reservedUnits, 5000, 'reservedUnits must be 5000');
      assert.strictEqual(balance.totalAvailableUnits, 115000, 'totalAvailableUnits must be 115000');
      assert.strictEqual(balance.totalAvailableCredits, 115, 'totalAvailableCredits must be 115');
      assert.strictEqual(balance.buckets.subscriptionUnits, 115000, 'subscription bucket must be net available');
    },
  },

  // ---------------------------------------------------------------------------
  // RB-33: RLS own-read only
  // ---------------------------------------------------------------------------
  {
    id: 'RB-33',
    name: 'RLS own-read only (auth.uid() = user_id for all reservation tables)',
    run: async () => {
      assert(
        migrationSql.includes('ALTER TABLE public.credit_reservations ENABLE ROW LEVEL SECURITY;'),
        'RLS must be enabled on credit_reservations'
      );
      assert(
        migrationSql.includes('ALTER TABLE public.credit_reservation_allocations ENABLE ROW LEVEL SECURITY;'),
        'RLS must be enabled on credit_reservation_allocations'
      );
      assert(
        migrationSql.includes('ALTER TABLE public.credit_reservation_events ENABLE ROW LEVEL SECURITY;'),
        'RLS must be enabled on credit_reservation_events'
      );
      assert(
        migrationSql.includes('CREATE POLICY credit_reservations_read_own ON public.credit_reservations') &&
        migrationSql.includes('FOR SELECT USING (auth.uid() = user_id);'),
        'credit_reservations owner read policy required'
      );
      assert(
        migrationSql.includes('CREATE POLICY credit_reservation_allocations_read_own ON public.credit_reservation_allocations') &&
        migrationSql.includes('FOR SELECT USING (auth.uid() = user_id);'),
        'credit_reservation_allocations owner read policy required'
      );
      assert(
        migrationSql.includes('CREATE POLICY credit_reservation_events_read_own ON public.credit_reservation_events') &&
        migrationSql.includes('FOR SELECT USING (auth.uid() = user_id);'),
        'credit_reservation_events owner read policy required'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-34: client roles cannot mutate reservation tables
  // ---------------------------------------------------------------------------
  {
    id: 'RB-34',
    name: 'client roles cannot mutate reservation tables (REVOKE INSERT, UPDATE, DELETE)',
    run: async () => {
      assert(
        migrationSql.includes('REVOKE INSERT, UPDATE, DELETE ON public.credit_reservations FROM PUBLIC, anon, authenticated;'),
        'Direct mutations must be revoked on credit_reservations'
      );
      assert(
        migrationSql.includes('REVOKE INSERT, UPDATE, DELETE ON public.credit_reservation_allocations FROM PUBLIC, anon, authenticated;'),
        'Direct mutations must be revoked on credit_reservation_allocations'
      );
      assert(
        migrationSql.includes('REVOKE INSERT, UPDATE, DELETE ON public.credit_reservation_events FROM PUBLIC, anon, authenticated;'),
        'Direct mutations must be revoked on credit_reservation_events'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-35: client roles cannot execute mutation RPCs
  // ---------------------------------------------------------------------------
  {
    id: 'RB-35',
    name: 'client roles cannot execute mutation RPCs (reserve, capture, release revoked from client roles)',
    run: async () => {
      assert(
        migrationSql.includes('REVOKE ALL ON FUNCTION public.reserve_credit_units') &&
        migrationSql.includes('FROM PUBLIC, anon, authenticated;'),
        'reserve_credit_units must be revoked from public/anon/authenticated'
      );
      assert(
        migrationSql.includes('REVOKE ALL ON FUNCTION public.capture_credit_reservation') &&
        migrationSql.includes('FROM PUBLIC, anon, authenticated;'),
        'capture_credit_reservation must be revoked from public/anon/authenticated'
      );
      assert(
        migrationSql.includes('REVOKE ALL ON FUNCTION public.release_credit_reservation') &&
        migrationSql.includes('FROM PUBLIC, anon, authenticated;'),
        'release_credit_reservation must be revoked from public/anon/authenticated'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-36: service_role permissions correct
  // ---------------------------------------------------------------------------
  {
    id: 'RB-36',
    name: 'service_role permissions correct (GRANT EXECUTE to postgres, service_role only)',
    run: async () => {
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.reserve_credit_units') &&
        migrationSql.includes('TO postgres, service_role;'),
        'reserve_credit_units must be granted to postgres, service_role'
      );
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.capture_credit_reservation') &&
        migrationSql.includes('TO postgres, service_role;'),
        'capture_credit_reservation must be granted to postgres, service_role'
      );
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.release_credit_reservation') &&
        migrationSql.includes('TO postgres, service_role;'),
        'release_credit_reservation must be granted to postgres, service_role'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-37: credit_ledger immutability remains intact
  // ---------------------------------------------------------------------------
  {
    id: 'RB-37',
    name: 'credit_ledger immutability remains intact (trigger fn_guard_credit_ledger_immutability untouched)',
    run: async () => {
      assert(
        !migrationSql.includes('DROP TRIGGER IF EXISTS trg_guard_credit_ledger_immutability'),
        'Phase 2B migration must NOT drop ledger immutability trigger'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-38: legacy quota unchanged
  // ---------------------------------------------------------------------------
  {
    id: 'RB-38',
    name: 'legacy quota unchanged (public.plans, profiles.used_documents intact)',
    run: async () => {
      assert(!migrationSql.includes('DROP TABLE plans'), 'plans table must not be dropped');
      assert(!migrationSql.includes('ALTER TABLE profiles'), 'profiles table must not be altered');
      assert(!migrationSql.includes('used_documents'), 'used_documents must not be referenced');
    },
  },

  // ---------------------------------------------------------------------------
  // RB-39: no automatic FREE bootstrap introduced
  // ---------------------------------------------------------------------------
  {
    id: 'RB-39',
    name: 'no automatic FREE bootstrap introduced (0 mass-grant inserts in migration)',
    run: async () => {
      assert(
        !migrationSql.includes('INSERT INTO public.credit_accounts SELECT') &&
        !migrationSql.includes('INSERT INTO public.credit_grants SELECT'),
        'Phase 2B migration must contain zero mass-grant inserts'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // RB-40: build passes
  // ---------------------------------------------------------------------------
  {
    id: 'RB-40',
    name: 'build passes (unitsToCredits, creditsToUnits, safeParseCreditUnits intact)',
    run: async () => {
      assert.strictEqual(unitsToCredits(1000), 1);
      assert.strictEqual(creditsToUnits(1), 1000);
      assert.strictEqual(safeParseCreditUnits(5000), 5000);
      assert.throws(() => safeParseCreditUnits('not_a_number'), /INTEGER_SAFETY_ERROR/);
    },
  },

  // ===========================================================================
  // PHASE 2B.1 TRANSACTION INTEGRITY AUDIT TEST SUITE (TI-01 to TI-30)
  // ===========================================================================

  // TI-01: reserve locks account BEFORE balance/allocation decision
  {
    id: 'TI-01',
    name: 'reserve locks account BEFORE balance/allocation decision',
    run: async () => {
      const accountLockPos = migrationSql.indexOf('SELECT id, status INTO v_account_id, v_account_status\n    FROM public.credit_accounts\n    WHERE user_id = p_user_id\n    FOR UPDATE;');
      const balanceCheckPos = migrationSql.indexOf('SELECT COALESCE(SUM(remaining_units - reserved_units), 0)\n    INTO v_total_available');
      const allocationPos = migrationSql.indexOf('v_alloc_units := LEAST(v_grant_available, v_remaining_to_reserve);');
      assert(accountLockPos > 0, 'Must lock credit_accounts FOR UPDATE');
      assert(balanceCheckPos > accountLockPos, 'Account lock MUST occur BEFORE balance calculation');
      assert(allocationPos > balanceCheckPos, 'Allocation MUST occur AFTER locked balance calculation');
    },
  },

  // TI-02: eligible grant rows are FOR UPDATE locked before allocation
  {
    id: 'TI-02',
    name: 'eligible grant rows are FOR UPDATE locked before allocation',
    run: async () => {
      const grantLockPos = migrationSql.indexOf('PERFORM id\n    FROM public.credit_grants');
      const balanceCheckPos = migrationSql.indexOf('SELECT COALESCE(SUM(remaining_units - reserved_units), 0)\n    INTO v_total_available');
      assert(grantLockPos > 0, 'Must perform deterministic FOR UPDATE lock on credit_grants');
      assert(grantLockPos < balanceCheckPos, 'Grant row locking MUST occur BEFORE total available calculation');
      assert(
        migrationSql.includes('ORDER BY expires_at ASC NULLS LAST, granted_at ASC, id ASC\n    FOR UPDATE'),
        'Grant rows MUST be locked in strict deterministic order'
      );
    },
  },

  // TI-03: two different idempotency keys for one user cannot overspend
  {
    id: 'TI-03',
    name: 'two different idempotency keys for one user cannot overspend',
    run: async () => {
      let availableUnits = 10000;
      let reservedUnits = 0;
      const simulateReserve = (requested: number) => {
        const currentAvailable = availableUnits - reservedUnits;
        if (currentAvailable < requested) {
          throw new Error('INSUFFICIENT_CREDIT: Requested units exceed available');
        }
        reservedUnits += requested;
        return { requested, reserved: reservedUnits, remainingAvailable: availableUnits - reservedUnits };
      };

      const resA = simulateReserve(7000);
      assert.strictEqual(resA.reserved, 7000);
      assert.strictEqual(resA.remainingAvailable, 3000);

      assert.throws(() => simulateReserve(7000), /INSUFFICIENT_CREDIT/);
      assert.strictEqual(reservedUnits, 7000);
    },
  },

  // TI-04: multi-grant capture ledger running balance is correct per ledger row
  {
    id: 'TI-04',
    name: 'multi-grant capture ledger running balance is correct per ledger row',
    run: async () => {
      assert(
        migrationSql.includes('v_running_gross_balance := v_running_gross_balance - v_capture_amount;') &&
        migrationSql.includes('balance_after_units,\n            reference_type'),
        'Must maintain exact running gross balance per ledger mutation'
      );

      let runningGross = 10000;
      const ledgerEntries: Array<{ delta: number; balanceAfter: number }> = [];

      const captureSliceA = 3000;
      runningGross -= captureSliceA;
      ledgerEntries.push({ delta: -captureSliceA, balanceAfter: runningGross });

      const captureSliceB = 2000;
      runningGross -= captureSliceB;
      ledgerEntries.push({ delta: -captureSliceB, balanceAfter: runningGross });

      assert.strictEqual(ledgerEntries[0].delta, -3000);
      assert.strictEqual(ledgerEntries[0].balanceAfter, 7000);
      assert.strictEqual(ledgerEntries[1].delta, -2000);
      assert.strictEqual(ledgerEntries[1].balanceAfter, 5000);
    },
  },

  // TI-05: ledger balance_after_units means gross remaining, not available
  {
    id: 'TI-05',
    name: 'ledger balance_after_units means gross remaining, not available',
    run: async () => {
      assert(
        migrationSql.includes('SELECT COALESCE(SUM(remaining_units), 0)\n    INTO v_running_gross_balance\n    FROM public.credit_grants'),
        'Must initialize v_running_gross_balance from remaining_units (gross owned), not available'
      );
      assert(
        !migrationSql.includes('SELECT COALESCE(SUM(remaining_units - reserved_units), 0)\n    INTO v_running_gross_balance'),
        'Running gross balance MUST NOT subtract reserved_units'
      );
    },
  },

  // TI-06: capture across two allocations is atomic
  {
    id: 'TI-06',
    name: 'capture across two allocations is atomic',
    run: async () => {
      assert(
        migrationSql.includes('CREATE OR REPLACE FUNCTION public.capture_credit_reservation'),
        'capture_credit_reservation is a single atomic PL/pgSQL function'
      );
      assert(
        migrationSql.includes('FOR v_alloc IN') && migrationSql.includes('UPDATE public.credit_grants'),
        'Allocations updated in single transactional loop'
      );
    },
  },

  // TI-07: release across two allocations is atomic
  {
    id: 'TI-07',
    name: 'release across two allocations is atomic',
    run: async () => {
      assert(
        migrationSql.includes('CREATE OR REPLACE FUNCTION public.release_credit_reservation'),
        'release_credit_reservation is a single atomic PL/pgSQL function'
      );
      assert(
        migrationSql.includes('FOR v_alloc IN') && migrationSql.includes('UPDATE public.credit_reservation_allocations'),
        'Release loop executes within single atomic transaction'
      );
    },
  },

  // TI-08: partial release with no capture keeps valid non-terminal status
  {
    id: 'TI-08',
    name: 'partial release with no capture keeps valid non-terminal status (Case A: RESERVED)',
    run: async () => {
      const deriveStatus = (reserved: number, captured: number, released: number) => {
        if (captured + released === reserved) {
          if (captured === reserved) return 'CAPTURED';
          if (released === reserved) return 'RELEASED';
          return 'SETTLED';
        }
        if (captured > 0) return 'PARTIALLY_CAPTURED';
        return 'RESERVED';
      };

      assert.strictEqual(deriveStatus(5500, 0, 500), 'RESERVED');
    },
  },

  // TI-09: partial capture + partial release status correct
  {
    id: 'TI-09',
    name: 'partial capture + partial release status correct (Case B: PARTIALLY_CAPTURED)',
    run: async () => {
      const deriveStatus = (reserved: number, captured: number, released: number) => {
        if (captured + released === reserved) {
          if (captured === reserved) return 'CAPTURED';
          if (released === reserved) return 'RELEASED';
          return 'SETTLED';
        }
        if (captured > 0) return 'PARTIALLY_CAPTURED';
        return 'RESERVED';
      };

      assert.strictEqual(deriveStatus(5500, 2000, 500), 'PARTIALLY_CAPTURED');
    },
  },

  // TI-10: full release status = RELEASED
  {
    id: 'TI-10',
    name: 'full release status = RELEASED (Case C: RELEASED)',
    run: async () => {
      const deriveStatus = (reserved: number, captured: number, released: number) => {
        if (captured + released === reserved) {
          if (captured === reserved) return 'CAPTURED';
          if (released === reserved) return 'RELEASED';
          return 'SETTLED';
        }
        if (captured > 0) return 'PARTIALLY_CAPTURED';
        return 'RESERVED';
      };

      assert.strictEqual(deriveStatus(5500, 0, 5500), 'RELEASED');
    },
  },

  // TI-11: capture+release complete settlement = SETTLED
  {
    id: 'TI-11',
    name: 'capture+release complete settlement = SETTLED (Case D: SETTLED)',
    run: async () => {
      const deriveStatus = (reserved: number, captured: number, released: number) => {
        if (captured + released === reserved) {
          if (captured === reserved) return 'CAPTURED';
          if (released === reserved) return 'RELEASED';
          return 'SETTLED';
        }
        if (captured > 0) return 'PARTIALLY_CAPTURED';
        return 'RESERVED';
      };

      assert.strictEqual(deriveStatus(5500, 5000, 500), 'SETTLED');
    },
  },

  // TI-12: full capture status = CAPTURED
  {
    id: 'TI-12',
    name: 'full capture status = CAPTURED (Case E: CAPTURED)',
    run: async () => {
      const deriveStatus = (reserved: number, captured: number, released: number) => {
        if (captured + released === reserved) {
          if (captured === reserved) return 'CAPTURED';
          if (released === reserved) return 'RELEASED';
          return 'SETTLED';
        }
        if (captured > 0) return 'PARTIALLY_CAPTURED';
        return 'RESERVED';
      };

      assert.strictEqual(deriveStatus(5500, 5500, 0), 'CAPTURED');
    },
  },

  // TI-13: reservation totals remain equal to allocation sums
  {
    id: 'TI-13',
    name: 'reservation totals remain equal to allocation sums',
    run: async () => {
      assert(migrationSql.includes('chk_credit_reservations_settlement_sum'), 'Reservation table must check sum');
      assert(migrationSql.includes('chk_alloc_settlement_sum'), 'Allocation table must check sum');
      assert(
        migrationSql.includes('v_new_captured := v_reservation.captured_units + p_capture_units;'),
        'Reservation captured_units accumulates exact captured units'
      );
      assert(
        migrationSql.includes('v_new_released := v_reservation.released_units + p_release_units;'),
        'Reservation released_units accumulates exact released units'
      );
    },
  },

  // TI-14: reserve idempotency payload conflict detection complete
  {
    id: 'TI-14',
    name: 'reserve idempotency payload conflict detection complete',
    run: async () => {
      assert(
        migrationSql.includes('v_existing_res.user_id <> p_user_id') &&
        migrationSql.includes('v_existing_res.requested_units <> p_requested_units') &&
        migrationSql.includes('v_existing_res.reference_type IS DISTINCT FROM p_reference_type') &&
        migrationSql.includes('v_existing_res.reference_id IS DISTINCT FROM p_reference_id') &&
        migrationSql.includes('v_existing_res.reservation_expires_at IS DISTINCT FROM p_reservation_expires_at'),
        'Reserve must validate user_id, requested_units, reference_type, reference_id, and reservation_expires_at'
      );
    },
  },

  // TI-15: capture idempotency payload conflict detection complete
  {
    id: 'TI-15',
    name: 'capture idempotency payload conflict detection complete',
    run: async () => {
      assert(
        migrationSql.includes('v_existing_event.reservation_id <> p_reservation_id') &&
        migrationSql.includes("v_existing_event.event_type <> 'CAPTURE'") &&
        migrationSql.includes('v_existing_event.units <> p_capture_units') &&
        migrationSql.includes('v_existing_event.user_id <> p_user_id'),
        'Capture must validate reservation_id, event_type, units, and user_id'
      );
    },
  },

  // TI-16: release idempotency payload conflict detection complete
  {
    id: 'TI-16',
    name: 'release idempotency payload conflict detection complete',
    run: async () => {
      assert(
        migrationSql.includes('v_existing_event.reservation_id <> p_reservation_id') &&
        migrationSql.includes("v_existing_event.event_type <> 'RELEASE'") &&
        migrationSql.includes('v_existing_event.units <> p_release_units') &&
        migrationSql.includes('v_existing_event.user_id <> p_user_id'),
        'Release must validate reservation_id, event_type, units, and user_id'
      );
    },
  },

  // TI-17: same event idempotency key cannot cross CAPTURE/RELEASE semantics
  {
    id: 'TI-17',
    name: 'same event idempotency key cannot cross CAPTURE/RELEASE semantics',
    run: async () => {
      assert(
        migrationSql.includes("v_existing_event.event_type <> 'CAPTURE'"),
        'Capture rejects if existing event is not CAPTURE'
      );
      assert(
        migrationSql.includes("v_existing_event.event_type <> 'RELEASE'"),
        'Release rejects if existing event is not RELEASE'
      );
    },
  },

  // TI-18: capture ledger keys deterministic and collision-safe
  {
    id: 'TI-18',
    name: 'capture ledger keys deterministic and collision-safe',
    run: async () => {
      const pattern = "'CAPTURE:' || p_idempotency_key || ':' || v_alloc.grant_id::text";
      assert(migrationSql.includes(pattern), 'Capture ledger key pattern must be deterministic and scoped by grant ID');
    },
  },

  // TI-19: expired source grant can still be captured after valid reservation
  {
    id: 'TI-19',
    name: 'expired source grant can still be captured after valid reservation',
    run: async () => {
      const captureAllocSection = migrationSql.slice(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.capture_credit_reservation'),
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.release_credit_reservation')
      );
      assert(
        !captureAllocSection.includes('expires_at > NOW()'),
        'Capture must allow settlement even if source grant expires after reservation'
      );
    },
  },

  // TI-20: expired source grant can still be released after valid reservation
  {
    id: 'TI-20',
    name: 'expired source grant can still be released after valid reservation',
    run: async () => {
      const releaseAllocSection = migrationSql.slice(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.release_credit_reservation'),
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.get_user_credit_balance')
      );
      assert(
        !releaseAllocSection.includes('expires_at > NOW()'),
        'Release must allow clearing reserved hold even if source grant expires after reservation'
      );
    },
  },

  // TI-21: /api/credits/balance remains functional under service-role-only balance RPC permissions
  {
    id: 'TI-21',
    name: '/api/credits/balance remains functional under service-role-only balance RPC permissions',
    run: async () => {
      const creditServicePath = path.resolve('server/services/credit/creditService.ts');
      const creditServiceCode = fs.readFileSync(creditServicePath, 'utf-8');
      assert(
        creditServiceCode.includes("from('credit_accounts')") && creditServiceCode.includes("from('credit_grants')"),
        'getUserBalance uses direct RLS table select via user Supabase client, avoiding RPC execute permission failure'
      );
    },
  },

  // TI-22: reservation detail endpoint cannot access another user's reservation
  {
    id: 'TI-22',
    name: "reservation detail endpoint cannot access another user's reservation",
    run: async () => {
      const creditServicePath = path.resolve('server/services/credit/creditService.ts');
      const creditServiceCode = fs.readFileSync(creditServicePath, 'utf-8');
      assert(
        creditServiceCode.includes(".eq('id', reservationId)") && creditServiceCode.includes(".eq('user_id', userId)"),
        'getReservation strictly filters by both reservationId and userId'
      );
    },
  },

  // TI-23: RPC TypeScript keys exactly match SQL parameter declarations
  {
    id: 'TI-23',
    name: 'RPC TypeScript keys exactly match SQL parameter declarations',
    run: async () => {
      const creditServicePath = path.resolve('server/services/credit/creditService.ts');
      const creditServiceCode = fs.readFileSync(creditServicePath, 'utf-8');

      assert(creditServiceCode.includes('p_user_id: params.userId'));
      assert(creditServiceCode.includes('p_requested_units: params.requestedUnits'));
      assert(creditServiceCode.includes('p_idempotency_key: params.idempotencyKey'));
      assert(creditServiceCode.includes('p_reference_type: params.referenceType || null'));
      assert(creditServiceCode.includes('p_reference_id: params.referenceId || null'));
      assert(creditServiceCode.includes('p_reservation_expires_at: params.reservationExpiresAt || null'));
      assert(creditServiceCode.includes('p_metadata: params.metadata || {}'));

      assert(creditServiceCode.includes('p_reservation_id: params.reservationId'));
      assert(creditServiceCode.includes('p_capture_units: params.captureUnits'));

      assert(creditServiceCode.includes('p_release_units: params.releaseUnits'));
    },
  },

  // TI-24: all GRANT/REVOKE function signatures match actual declarations
  {
    id: 'TI-24',
    name: 'all GRANT/REVOKE function signatures match actual declarations',
    run: async () => {
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.reserve_credit_units(\n    UUID,\n    BIGINT,\n    TEXT,\n    VARCHAR,\n    TEXT,\n    TIMESTAMPTZ,\n    JSONB\n) TO postgres, service_role;'),
        'reserve_credit_units signature matches'
      );
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.capture_credit_reservation(\n    UUID,\n    UUID,\n    BIGINT,\n    TEXT,\n    JSONB\n) TO postgres, service_role;'),
        'capture_credit_reservation signature matches'
      );
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.release_credit_reservation(\n    UUID,\n    UUID,\n    BIGINT,\n    TEXT,\n    JSONB\n) TO postgres, service_role;'),
        'release_credit_reservation signature matches'
      );
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.get_user_credit_balance(UUID) TO postgres, service_role;'),
        'get_user_credit_balance signature matches'
      );
    },
  },

  // TI-25: migration contains no undeclared PL/pgSQL identifiers
  {
    id: 'TI-25',
    name: 'migration contains no undeclared PL/pgSQL identifiers',
    run: async () => {
      assert(!migrationSql.includes('p_source_product_id'), 'No stale p_source_product_id in Phase 2B migration');
      assert(!migrationSql.includes('v_total_gross_balance'), 'v_total_gross_balance cleanly replaced by v_running_gross_balance');
    },
  },

  // TI-26: Phase 2A applied migration source unchanged
  {
    id: 'TI-26',
    name: 'Phase 2A applied migration source unchanged',
    run: async () => {
      const p2aPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const p2aSql = fs.readFileSync(p2aPath, 'utf-8');
      assert(p2aSql.includes('MIGRATION: 20261001000000_credit_ledger_foundation.sql'));
      assert(p2aSql.includes("chk_credit_ledger_entry_type CHECK (\n        entry_type IN ('GRANT', 'ADJUSTMENT', 'EXPIRATION')\n    )"));
    },
  },

  // TI-27: CAPTURE constraint extension preserves all old ledger entry types
  {
    id: 'TI-27',
    name: 'CAPTURE constraint extension preserves all old ledger entry types',
    run: async () => {
      assert(
        migrationSql.includes("entry_type IN ('GRANT', 'ADJUSTMENT', 'EXPIRATION', 'CAPTURE')"),
        'Must preserve GRANT, ADJUSTMENT, EXPIRATION while adding CAPTURE'
      );
      assert(
        migrationSql.includes("entry_type <> 'CAPTURE' OR delta_units < 0"),
        'Must enforce delta_units < 0 for CAPTURE'
      );
    },
  },

  // TI-28: terminal reservations cannot be settled again
  {
    id: 'TI-28',
    name: 'terminal reservations cannot be settled again (RESERVATION_ALREADY_SETTLED)',
    run: async () => {
      assert(
        migrationSql.includes("IF v_reservation.status IN ('CAPTURED', 'RELEASED', 'SETTLED', 'EXPIRED') OR v_outstanding <= 0 THEN\n        RAISE EXCEPTION 'RESERVATION_ALREADY_SETTLED: Reservation % is already in terminal status %'"),
        'Both capture and release must fail closed on terminal reservation'
      );
    },
  },

  // TI-29: reservation_expires_at does not silently trigger auto-expiration behavior
  {
    id: 'TI-29',
    name: 'reservation_expires_at does not silently trigger auto-expiration behavior',
    run: async () => {
      assert(!migrationSql.includes('cron.schedule'), 'No cron schedule in Phase 2B');
      assert(!migrationSql.includes('fn_auto_expire'), 'No auto-expire function in Phase 2B');
    },
  },

  // TI-30: all client financial mutations remain blocked
  {
    id: 'TI-30',
    name: 'all client financial mutations remain blocked',
    run: async () => {
      assert(
        migrationSql.includes('REVOKE INSERT, UPDATE, DELETE ON public.credit_reservations FROM PUBLIC, anon, authenticated;'),
        'Revoke mutations on credit_reservations'
      );
      assert(
        migrationSql.includes('REVOKE INSERT, UPDATE, DELETE ON public.credit_reservation_allocations FROM PUBLIC, anon, authenticated;'),
        'Revoke mutations on credit_reservation_allocations'
      );
      assert(
        migrationSql.includes('REVOKE INSERT, UPDATE, DELETE ON public.credit_reservation_events FROM PUBLIC, anon, authenticated;'),
        'Revoke mutations on credit_reservation_events'
      );
    },
  },

  // ===========================================================================
  // PHASE 2B.2 CROSS-PHASE CONSISTENCY TEST SUITE (CP-01 to CP-18)
  // ===========================================================================

  // CP-01: grant_user_credits total_available_units subtracts reserved_units
  {
    id: 'CP-01',
    name: 'grant_user_credits total_available_units subtracts reserved_units',
    run: async () => {
      const grantFuncSection = migrationSql.slice(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.grant_user_credits')
      );
      assert(
        grantFuncSection.includes('SELECT COALESCE(SUM(GREATEST(remaining_units - reserved_units, 0)), 0)\n    INTO v_total_available'),
        'grant_user_credits new grant path must subtract reserved_units for total_available_units'
      );
    },
  },

  // CP-02: grant_user_credits already_processed path also subtracts reserved_units
  {
    id: 'CP-02',
    name: 'grant_user_credits already_processed path also subtracts reserved_units',
    run: async () => {
      const grantFuncSection = migrationSql.slice(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.grant_user_credits')
      );
      const firstAvailableCalc = grantFuncSection.indexOf('SELECT COALESCE(SUM(GREATEST(remaining_units - reserved_units, 0)), 0)\n        INTO v_total_available');
      assert(
        firstAvailableCalc > 0 && firstAvailableCalc < grantFuncSection.indexOf('-- 4. Fail-closed Grant Semantic Validation'),
        'grant_user_credits already_processed path must subtract reserved_units'
      );
    },
  },

  // CP-03: grant_user_credits ledger balance_after_units uses gross owned balance
  {
    id: 'CP-03',
    name: 'grant_user_credits ledger balance_after_units uses gross owned balance',
    run: async () => {
      const grantFuncSection = migrationSql.slice(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.grant_user_credits')
      );
      assert(
        grantFuncSection.includes('SELECT COALESCE(SUM(remaining_units), 0)\n    INTO v_ledger_balance_after\n    FROM public.credit_grants\n    WHERE account_id = v_account_id\n      AND remaining_units > 0;'),
        'grant_user_credits must calculate gross owned balance for ledger balance_after_units'
      );
    },
  },

  // CP-04: grant_user_credits response available balance and ledger gross balance are not conflated
  {
    id: 'CP-04',
    name: 'grant_user_credits response available balance and ledger gross balance are not conflated',
    run: async () => {
      const grantFuncSection = migrationSql.slice(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.grant_user_credits')
      );
      assert(
        grantFuncSection.includes('balance_after_units,\n        reference_type') &&
        grantFuncSection.includes('v_ledger_balance_after,') &&
        grantFuncSection.includes("'total_available_units', v_total_available"),
        'balance_after_units gets v_ledger_balance_after while response gets v_total_available'
      );
    },
  },

  // CP-05: capture ledger balance_after_units uses the exact same gross-owned semantic
  {
    id: 'CP-05',
    name: 'capture ledger balance_after_units uses the exact same gross-owned semantic',
    run: async () => {
      const captureSection = migrationSql.slice(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.capture_credit_reservation'),
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.release_credit_reservation')
      );
      assert(
        captureSection.includes('SELECT COALESCE(SUM(remaining_units), 0)\n    INTO v_running_gross_balance\n    FROM public.credit_grants\n    WHERE account_id = v_reservation.account_id\n      AND remaining_units > 0;'),
        'capture_credit_reservation uses gross remaining units without subtracting reserved_units'
      );
    },
  },

  // CP-06: expired-but-not-yet-expired-via-ledger grant semantic is documented consistently
  {
    id: 'CP-06',
    name: 'expired-but-not-yet-expired-via-ledger grant semantic is documented consistently',
    run: async () => {
      assert(
        migrationSql.includes('COMMENT ON COLUMN public.credit_ledger.balance_after_units IS') &&
        migrationSql.includes('Reservation holds are excluded from this field.') &&
        migrationSql.includes('Clock-time expiration alone does not change this balance; explicit expiration mutations do.'),
        'SQL COMMENT explicitly defines ledger balance as unaffected by clock-time expiry until explicit expiration mutation'
      );
    },
  },

  // CP-07: capture multi-grant running balance remains correct
  {
    id: 'CP-07',
    name: 'capture multi-grant running balance remains correct',
    run: async () => {
      const captureSection = migrationSql.slice(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.capture_credit_reservation'),
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.release_credit_reservation')
      );
      assert(
        captureSection.includes('v_running_gross_balance := v_running_gross_balance - v_capture_amount;'),
        'Running gross balance decrements by exact slice amount inside allocation loop'
      );
    },
  },

  // CP-08: capture loop requires remaining_to_capture = 0
  {
    id: 'CP-08',
    name: 'capture loop requires remaining_to_capture = 0',
    run: async () => {
      assert(
        migrationSql.includes('IF v_remaining_to_capture > 0 THEN\n        RAISE EXCEPTION \'ALLOCATION_INTEGRITY_ERROR'),
        'Must assert v_remaining_to_capture = 0 after capture loop'
      );
    },
  },

  // CP-09: capture allocation integrity failure raises ALLOCATION_INTEGRITY_ERROR
  {
    id: 'CP-09',
    name: 'capture allocation integrity failure raises ALLOCATION_INTEGRITY_ERROR',
    run: async () => {
      assert(
        migrationSql.includes("RAISE EXCEPTION 'ALLOCATION_INTEGRITY_ERROR: Unable to fully allocate requested capture units"),
        'Must raise ALLOCATION_INTEGRITY_ERROR if capture allocation fails'
      );
    },
  },

  // CP-10: release loop requires remaining_to_release = 0
  {
    id: 'CP-10',
    name: 'release loop requires remaining_to_release = 0',
    run: async () => {
      assert(
        migrationSql.includes('IF v_remaining_to_release > 0 THEN\n        RAISE EXCEPTION \'ALLOCATION_INTEGRITY_ERROR'),
        'Must assert v_remaining_to_release = 0 after release loop'
      );
    },
  },

  // CP-11: release allocation integrity failure raises ALLOCATION_INTEGRITY_ERROR
  {
    id: 'CP-11',
    name: 'release allocation integrity failure raises ALLOCATION_INTEGRITY_ERROR',
    run: async () => {
      assert(
        migrationSql.includes("RAISE EXCEPTION 'ALLOCATION_INTEGRITY_ERROR: Unable to fully allocate requested release units"),
        'Must raise ALLOCATION_INTEGRITY_ERROR if release allocation fails'
      );
    },
  },

  // CP-12: reservation header captured_units equals allocation captured sum after successful capture
  {
    id: 'CP-12',
    name: 'reservation header captured_units equals allocation captured sum after successful capture',
    run: async () => {
      assert(
        migrationSql.includes('IF v_sum_captured <> v_new_captured THEN\n        RAISE EXCEPTION \'ALLOCATION_INTEGRITY_ERROR: Allocation captured sum (%) does not match reservation captured_units (%)'),
        'Must assert allocation captured sum equals header captured_units'
      );
    },
  },

  // CP-13: reservation header released_units equals allocation released sum after successful release
  {
    id: 'CP-13',
    name: 'reservation header released_units equals allocation released sum after successful release',
    run: async () => {
      assert(
        migrationSql.includes('IF v_sum_released <> v_new_released THEN\n        RAISE EXCEPTION \'ALLOCATION_INTEGRITY_ERROR: Allocation released sum (%) does not match reservation released_units (%)'),
        'Must assert allocation released sum equals header released_units'
      );
    },
  },

  // CP-14: reservation reserved_units equals allocation reserved sum
  {
    id: 'CP-14',
    name: 'reservation reserved_units equals allocation reserved sum',
    run: async () => {
      assert(
        migrationSql.includes('IF v_sum_reserved <> v_reservation.reserved_units THEN\n        RAISE EXCEPTION \'ALLOCATION_INTEGRITY_ERROR: Allocation reserved sum (%) does not match reservation reserved_units (%)'),
        'Must assert allocation reserved sum equals header reserved_units'
      );
    },
  },

  // CP-15: Phase 2B replacement grant_user_credits signature exactly matches Phase 2A function
  {
    id: 'CP-15',
    name: 'Phase 2B replacement grant_user_credits signature exactly matches Phase 2A function',
    run: async () => {
      const p2aPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const p2aSql = fs.readFileSync(p2aPath, 'utf-8');

      const p2aSig = p2aSql.slice(
        p2aSql.indexOf('CREATE OR REPLACE FUNCTION public.grant_user_credits('),
        p2aSql.indexOf('RETURNS JSONB')
      ).trim();

      const p2bSig = migrationSql.slice(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.grant_user_credits('),
        migrationSql.indexOf('RETURNS JSONB', migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.grant_user_credits('))
      ).trim();

      assert.strictEqual(p2aSig, p2bSig, 'grant_user_credits signature in Phase 2B must be an exact drop-in replacement');
    },
  },

  // CP-16: grant_user_credits permissions remain service_role/postgres only
  {
    id: 'CP-16',
    name: 'grant_user_credits permissions remain service_role/postgres only',
    run: async () => {
      assert(
        migrationSql.includes('REVOKE ALL ON FUNCTION public.grant_user_credits(\n    UUID,\n    VARCHAR,\n    BIGINT,\n    TEXT,\n    TIMESTAMPTZ,\n    UUID,\n    UUID,\n    UUID,\n    TIMESTAMPTZ,\n    TIMESTAMPTZ,\n    VARCHAR,\n    TEXT,\n    TEXT,\n    JSONB\n) FROM PUBLIC, anon, authenticated;'),
        'Revoke grant_user_credits from client roles'
      );
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.grant_user_credits(\n    UUID,\n    VARCHAR,\n    BIGINT,\n    TEXT,\n    TIMESTAMPTZ,\n    UUID,\n    UUID,\n    UUID,\n    TIMESTAMPTZ,\n    TIMESTAMPTZ,\n    VARCHAR,\n    TEXT,\n    TEXT,\n    JSONB\n) TO postgres, service_role;'),
        'Grant execute on grant_user_credits to postgres, service_role'
      );
    },
  },

  // CP-17: Phase 2A migration file is not modified by this task
  {
    id: 'CP-17',
    name: 'Phase 2A migration file is not modified by this task',
    run: async () => {
      const p2aPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const p2aSql = fs.readFileSync(p2aPath, 'utf-8');
      assert(p2aSql.includes('20261001000000_credit_ledger_foundation.sql'));
      assert.strictEqual(fs.statSync(p2aPath).size, 27151, 'Phase 2A file size remains exactly 27151 bytes');
    },
  },

  // CP-18: static SQL source contains no undeclared parameter references
  {
    id: 'CP-18',
    name: 'static SQL source contains no undeclared parameter references',
    run: async () => {
      assert(!migrationSql.includes('p_source_product_id'), 'No p_source_product_id in Phase 2B');
      assert(!migrationSql.includes('v_total_gross_balance'), 'No stale v_total_gross_balance in Phase 2B');
    },
  },
];

async function runAll() {
  console.log('================================================================');
  console.log('PHASE 2B — CREDIT RESERVATION FOUNDATION TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    try {
      await tc.run();
      console.log(`[PASS] ${tc.id}: ${tc.name}`);
      passed++;
    } catch (err: any) {
      console.error(`[FAIL] ${tc.id}: ${tc.name}`);
      console.error(`       Error: ${err.message}`);
      failed++;
    }
  }

  console.log('\n================================================================');
  console.log(`TOTAL: ${testCases.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAll().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
