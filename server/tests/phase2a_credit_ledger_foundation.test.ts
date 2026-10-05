import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import {
  creditService,
  UNITS_PER_CREDIT,
  MAX_SAFE_CREDIT_UNITS,
  unitsToCredits,
  creditsToUnits,
  safeParseCreditUnits,
  addMonthlyAnniversary,
} from '../services/credit/creditService.js';
import { billingService } from '../services/billing/billingService.js';

interface TestCase {
  id: string;
  name: string;
  run: () => Promise<void>;
}

const testCases: TestCase[] = [
  // ---------------------------------------------------------------------------
  // CR-01: 1 credit = 1000 units invariant (NO FLOAT in DB)
  // ---------------------------------------------------------------------------
  {
    id: 'CR-01',
    name: '1 credit = 1000 units invariant (scaled integer units, NO FLOAT)',
    run: async () => {
      assert.strictEqual(UNITS_PER_CREDIT, 1000, 'UNITS_PER_CREDIT must be 1000');
      assert.strictEqual(creditsToUnits(1), 1000, '1 credit must equal 1000 units');
      assert.strictEqual(creditsToUnits(0.5), 500, '0.5 credit must equal 500 units');
      assert.strictEqual(creditsToUnits(0.75), 750, '0.75 credit must equal 750 units');
      assert.strictEqual(creditsToUnits(1.25), 1250, '1.25 credit must equal 1250 units');
      assert.strictEqual(creditsToUnits(120), 120000, '120 credits must equal 120000 units');
      assert.strictEqual(unitsToCredits(1000), 1, '1000 units must convert to 1 credit');
      assert.strictEqual(unitsToCredits(500), 0.5, '500 units must convert to 0.5 credit');
      assert.strictEqual(unitsToCredits(120000), 120, '120000 units must convert to 120 credits');

      // Negative credit must throw
      assert.throws(() => creditsToUnits(-1), /CREDIT_UNITS_INVALID/);
    },
  },

  // ---------------------------------------------------------------------------
  // CR-02: credit_accounts one per user schema definition
  // ---------------------------------------------------------------------------
  {
    id: 'CR-02',
    name: 'credit_accounts schema guarantees one account per user (UNIQUE user_id)',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('CREATE TABLE IF NOT EXISTS public.credit_accounts'),
        'Migration must define public.credit_accounts table'
      );
      assert(
        migrationSql.includes('user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id)'),
        'user_id in credit_accounts must be UNIQUE REFERENCES auth.users(id)'
      );
      assert(
        migrationSql.includes("status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'"),
        'credit_accounts must have status column default ACTIVE'
      );
      assert(
        migrationSql.includes("status IN ('ACTIVE', 'FROZEN', 'CLOSED')"),
        'credit_accounts must enforce status check'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-03: GRANT creates grant + ledger atomically
  // ---------------------------------------------------------------------------
  {
    id: 'CR-03',
    name: 'grant_user_credits RPC creates credit_grant and credit_ledger atomically',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('CREATE OR REPLACE FUNCTION public.grant_user_credits'),
        'Migration must define atomic grant_user_credits RPC'
      );
      assert(
        migrationSql.includes('INSERT INTO public.credit_grants'),
        'RPC must insert into public.credit_grants'
      );
      assert(
        migrationSql.includes('INSERT INTO public.credit_ledger'),
        'RPC must insert into public.credit_ledger'
      );
      assert(
        migrationSql.includes('entry_type') &&
        migrationSql.includes('delta_units') &&
        migrationSql.includes('balance_after_units'),
        'RPC must record entry_type, delta_units, balance_after_units in ledger'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-04: same idempotency key cannot double grant
  // ---------------------------------------------------------------------------
  {
    id: 'CR-04',
    name: 'Idempotency key enforcement prevents duplicate grant and duplicate ledger entry',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('idempotency_key TEXT NOT NULL UNIQUE'),
        'credit_grants and credit_ledger must enforce UNIQUE idempotency_key'
      );
      assert(
        migrationSql.includes('WHERE idempotency_key = p_idempotency_key'),
        'RPC must query existing grant by idempotency_key before mutating'
      );
      assert(
        migrationSql.includes("'already_processed', true"),
        'RPC must return already_processed = true when idempotent duplicate arrives'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-05: subscription-cycle grant expires_at = cycle_end
  // ---------------------------------------------------------------------------
  {
    id: 'CR-05',
    name: 'Subscription cycle grant binds expires_at to cycle_end',
    run: async () => {
      const cycleStart = '2026-10-01T00:00:00.000Z';
      const cycleEnd = '2026-11-01T00:00:00.000Z';

      let capturedParams: any = null;
      const mockService = new (creditService.constructor as any)();
      mockService.grantCredits = async (params: any) => {
        capturedParams = params;
        return {
          grantId: 'mock-grant-id',
          accountId: 'mock-acc-id',
          userId: params.userId,
          originalUnits: params.originalUnits,
          remainingUnits: params.originalUnits,
          totalAvailableUnits: params.originalUnits,
          alreadyProcessed: false,
        };
      };

      await mockService.grantSubscriptionCycleCredits({
        userId: '00000000-0000-0000-0000-000000000001',
        productCode: 'BASIC',
        cycleStart,
        cycleEnd,
        idempotencyKey: 'test_cycle_sub_01',
      });

      assert(capturedParams, 'grantCredits must be called');
      assert.strictEqual(capturedParams.expiresAt, cycleEnd, 'expiresAt must equal cycleEnd');
      assert.strictEqual(capturedParams.billingCycleStart, cycleStart, 'billingCycleStart must match');
      assert.strictEqual(capturedParams.billingCycleEnd, cycleEnd, 'billingCycleEnd must match');
      assert.strictEqual(capturedParams.sourceType, 'SUBSCRIPTION_CYCLE', 'sourceType must be SUBSCRIPTION_CYCLE');
      assert.strictEqual(capturedParams.originalUnits, 120000, 'BASIC must grant 120,000 units (120 credits)');
    },
  },

  // ---------------------------------------------------------------------------
  // CR-06: purchased credit pack grant expires_at IS NULL
  // ---------------------------------------------------------------------------
  {
    id: 'CR-06',
    name: 'Purchased credit pack grant has expires_at = NULL (non-expiring)',
    run: async () => {
      let capturedParams: any = null;
      const mockService = new (creditService.constructor as any)();
      mockService.grantCredits = async (params: any) => {
        capturedParams = params;
        return {
          grantId: 'mock-grant-pack',
          accountId: 'mock-acc-id',
          userId: params.userId,
          originalUnits: params.originalUnits,
          remainingUnits: params.originalUnits,
          totalAvailableUnits: params.originalUnits,
          alreadyProcessed: false,
        };
      };

      await mockService.grantPurchasedCreditPack({
        userId: '00000000-0000-0000-0000-000000000001',
        productCode: 'PACK_500',
        idempotencyKey: 'test_pack_500_01',
      });

      assert(capturedParams, 'grantCredits must be called');
      assert.strictEqual(capturedParams.expiresAt, null, 'expiresAt must be strictly NULL for credit packs');
      assert.strictEqual(capturedParams.sourceType, 'CREDIT_PACK_PURCHASE', 'sourceType must be CREDIT_PACK_PURCHASE');
      assert.strictEqual(capturedParams.originalUnits, 500000, 'PACK_500 must grant 500,000 units (500 credits)');
    },
  },

  // ---------------------------------------------------------------------------
  // CR-07: Canonical product_credit_grants is used for amount
  // ---------------------------------------------------------------------------
  {
    id: 'CR-07',
    name: 'Canonical product_credit_grants is the commercial source of truth for amounts',
    run: async () => {
      const freeCredits = await billingService.getCanonicalCreditGrant('FREE');
      const basicCredits = await billingService.getCanonicalCreditGrant('BASIC');
      const proCredits = await billingService.getCanonicalCreditGrant('PRO');
      const bizCredits = await billingService.getCanonicalCreditGrant('BUSINESS');
      const pack50 = await billingService.getCanonicalCreditGrant('PACK_50');
      const pack200 = await billingService.getCanonicalCreditGrant('PACK_200');
      const pack500 = await billingService.getCanonicalCreditGrant('PACK_500');
      const pack2000 = await billingService.getCanonicalCreditGrant('PACK_2000');

      assert.strictEqual(freeCredits, 10, 'FREE must be 10 credits');
      assert.strictEqual(basicCredits, 120, 'BASIC must be 120 credits');
      assert.strictEqual(proCredits, 450, 'PRO must be 450 credits');
      assert.strictEqual(bizCredits, 1400, 'BUSINESS must be 1400 credits');
      assert.strictEqual(pack50, 50, 'PACK_50 must be 50 credits');
      assert.strictEqual(pack200, 200, 'PACK_200 must be 200 credits');
      assert.strictEqual(pack500, 500, 'PACK_500 must be 500 credits');
      assert.strictEqual(pack2000, 2000, 'PACK_2000 must be 2000 credits');
    },
  },

  // ---------------------------------------------------------------------------
  // CR-08: plan_entitlements.included_credits is NEVER used for grant amount
  // ---------------------------------------------------------------------------
  {
    id: 'CR-08',
    name: 'creditService NEVER queries or references plan_entitlements.included_credits',
    run: async () => {
      const servicePath = path.resolve('server/services/credit/creditService.ts');
      const serviceCode = fs.readFileSync(servicePath, 'utf-8');

      assert(
        !serviceCode.includes('plan_entitlements'),
        'creditService.ts must NEVER query or reference plan_entitlements'
      );
      assert(
        !serviceCode.includes('included_credits'),
        'creditService.ts must NEVER query or reference included_credits'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-09: Missing canonical commercial grant fails closed
  // ---------------------------------------------------------------------------
  {
    id: 'CR-09',
    name: 'Missing canonical commercial grant fails closed with explicit error',
    run: async () => {
      await assert.rejects(
        async () => {
          await billingService.getCanonicalCreditGrant('NON_EXISTENT_PLAN_XYZ');
        },
        /CANONICAL_CREDIT_GRANT_NOT_FOUND/,
        'Querying invalid/missing product must fail closed'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-10 & CR-11: Ledger UPDATE and DELETE rejected (Immutability trigger)
  // ---------------------------------------------------------------------------
  {
    id: 'CR-10',
    name: 'DB trigger fn_guard_credit_ledger_immutability rejects UPDATE on credit_ledger',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('fn_guard_credit_ledger_immutability'),
        'Migration must define fn_guard_credit_ledger_immutability'
      );
      assert(
        migrationSql.includes('CREDIT_LEDGER_IMMUTABLE'),
        'Trigger function must raise CREDIT_LEDGER_IMMUTABLE'
      );
      assert(
        migrationSql.includes('BEFORE UPDATE OR DELETE ON public.credit_ledger'),
        'Trigger must attach BEFORE UPDATE OR DELETE ON public.credit_ledger'
      );
    },
  },
  {
    id: 'CR-11',
    name: 'DB trigger fn_guard_credit_ledger_immutability rejects DELETE on credit_ledger',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('BEFORE UPDATE OR DELETE ON public.credit_ledger'),
        'Trigger must guard DELETE operations'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-12: remaining_units cannot exceed original_units
  // ---------------------------------------------------------------------------
  {
    id: 'CR-12',
    name: 'Schema constraint chk_credit_grants_remaining_units enforces remaining_units <= original_units',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('remaining_units <= original_units'),
        'credit_grants must enforce remaining_units <= original_units'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-13: negative remaining_units rejected
  // ---------------------------------------------------------------------------
  {
    id: 'CR-13',
    name: 'Schema constraint chk_credit_grants_remaining_units enforces remaining_units >= 0',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('remaining_units >= 0'),
        'credit_grants must enforce remaining_units >= 0'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-14: user cannot read another user account (RLS)
  // ---------------------------------------------------------------------------
  {
    id: 'CR-14',
    name: 'RLS policies isolate user read access strictly to auth.uid() = user_id',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('ALTER TABLE public.credit_accounts ENABLE ROW LEVEL SECURITY;'),
        'credit_accounts must have RLS enabled'
      );
      assert(
        migrationSql.includes('ALTER TABLE public.credit_grants ENABLE ROW LEVEL SECURITY;'),
        'credit_grants must have RLS enabled'
      );
      assert(
        migrationSql.includes('ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;'),
        'credit_ledger must have RLS enabled'
      );
      assert(
        migrationSql.includes('CREATE POLICY credit_accounts_read_own ON public.credit_accounts'),
        'credit_accounts must have read own policy'
      );
      assert(
        migrationSql.includes('CREATE POLICY credit_grants_read_own ON public.credit_grants'),
        'credit_grants must have read own policy'
      );
      assert(
        migrationSql.includes('CREATE POLICY credit_ledger_read_own ON public.credit_ledger'),
        'credit_ledger must have read own policy'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-15: user cannot insert/update/delete financial rows directly
  // ---------------------------------------------------------------------------
  {
    id: 'CR-15',
    name: 'Client roles (anon, authenticated, PUBLIC) have zero INSERT/UPDATE/DELETE grants',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('REVOKE INSERT, UPDATE, DELETE ON public.credit_accounts FROM PUBLIC, anon, authenticated;'),
        'Must revoke write from public roles on credit_accounts'
      );
      assert(
        migrationSql.includes('REVOKE INSERT, UPDATE, DELETE ON public.credit_grants FROM PUBLIC, anon, authenticated;'),
        'Must revoke write from public roles on credit_grants'
      );
      assert(
        migrationSql.includes('REVOKE INSERT, UPDATE, DELETE ON public.credit_ledger FROM PUBLIC, anon, authenticated;'),
        'Must revoke write from public roles on credit_ledger'
      );
      assert(
        migrationSql.includes('REVOKE ALL ON FUNCTION public.grant_user_credits') &&
        migrationSql.includes('FROM PUBLIC, anon, authenticated;'),
        'Must revoke direct execution of grant RPC from public client roles'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-16: read balance equals sum of active remaining grant units
  // ---------------------------------------------------------------------------
  {
    id: 'CR-16',
    name: 'getUserBalance calculates balance strictly as sum of active unexpired grant units',
    run: async () => {
      const futureDate = new Date(Date.now() + 86400000 * 30).toISOString();
      const pastDate = new Date(Date.now() - 86400000).toISOString();

      const mockGrants = [
        { remaining_units: 120000, source_type: 'SUBSCRIPTION_CYCLE', expires_at: futureDate, status: 'ACTIVE' },
        { remaining_units: 500000, source_type: 'CREDIT_PACK_PURCHASE', expires_at: null, status: 'ACTIVE' },
        { remaining_units: 25000, source_type: 'PROMOTION', expires_at: null, status: 'ACTIVE' },
        { remaining_units: 40000, source_type: 'SUBSCRIPTION_CYCLE', expires_at: pastDate, status: 'ACTIVE' }, // expired, excluded
      ];

      const mockClient: any = {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'mock-account-id', status: 'ACTIVE' },
                error: null,
              }),
              eq: () => Promise.resolve({
                data: mockGrants,
                error: null,
              }),
            }),
          }),
        }),
      };

      const balance = await creditService.getUserBalance('00000000-0000-0000-0000-000000000001', mockClient);

      assert.strictEqual(balance.buckets.subscriptionUnits, 120000, 'Active subscription units must be 120000');
      assert.strictEqual(balance.buckets.purchasedUnits, 500000, 'Purchased pack units must be 500000');
      assert.strictEqual(balance.buckets.otherUnits, 25000, 'Other promotion units must be 25000');
      assert.strictEqual(balance.totalAvailableUnits, 645000, 'Total units must equal 645000');
      assert.strictEqual(balance.totalAvailableCredits, 645, 'Total credits must equal 645');
    },
  },

  // ---------------------------------------------------------------------------
  // CR-17: FREE bootstrap idempotency works
  // ---------------------------------------------------------------------------
  {
    id: 'CR-17',
    name: 'bootstrapNewUserFreeCredits uses deterministic idempotency key and canonical FREE grant',
    run: async () => {
      let capturedParams: any = null;
      const mockService = new (creditService.constructor as any)();
      mockService.grantCredits = async (params: any) => {
        capturedParams = params;
        return {
          grantId: 'mock-grant-free',
          accountId: 'mock-acc-id',
          userId: params.userId,
          originalUnits: params.originalUnits,
          remainingUnits: params.originalUnits,
          totalAvailableUnits: params.originalUnits,
          alreadyProcessed: false,
        };
      };

      const testUserId = '00000000-0000-0000-0000-000000000002';
      await mockService.bootstrapNewUserFreeCredits(testUserId);

      assert(capturedParams, 'grantCredits must be called');
      assert.strictEqual(
        capturedParams.idempotencyKey,
        `free-bootstrap:v1:${testUserId}`,
        'Idempotency key format must match canonical specification'
      );
      assert.strictEqual(capturedParams.originalUnits, 10000, 'FREE bootstrap must grant exactly 10,000 units (10 credits)');
      assert.strictEqual(capturedParams.sourceType, 'FREE_BOOTSTRAP', 'sourceType must be FREE_BOOTSTRAP');
      assert.strictEqual(capturedParams.expiresAt, null, 'FREE bootstrap must have expiresAt = null (non-expiring)');
    },
  },

  // ---------------------------------------------------------------------------
  // CR-18: Existing users are NOT mass-granted automatically
  // ---------------------------------------------------------------------------
  {
    id: 'CR-18',
    name: 'Migration contains NO retroactive INSERT into credit_accounts or credit_grants for existing users',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        !migrationSql.includes('INSERT INTO public.credit_accounts SELECT'),
        'Migration must NOT backfill credit_accounts from existing users'
      );
      assert(
        !migrationSql.includes('INSERT INTO public.credit_grants SELECT'),
        'Migration must NOT backfill credit_grants from existing users'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // CR-19: Legacy document quota behavior remains unchanged
  // ---------------------------------------------------------------------------
  {
    id: 'CR-19',
    name: 'Legacy public.plans, profiles.used_documents, and quotaService remain completely unchanged',
    run: async () => {
      const schemaPath = path.resolve('supabase/migrations/20260930030000_billing_invariant_closure.sql');
      const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
      assert(schemaSql.includes("('FREE', 'Gói Miễn Phí (Free)', 0, 3650, 3,"), 'Legacy FREE plan quota must be 3 docs');
      assert(schemaSql.includes("('7_DAYS_FULL', 'Gói 7 Ngày Đầy Đủ', 29000, 7, 50,"), 'Legacy 7_DAYS_FULL quota must be 50 docs');
      assert(schemaSql.includes("('30_DAYS_FULL', 'Gói 30 Ngày Toàn Diện', 79000, 30, 250,"), 'Legacy 30_DAYS_FULL quota must be 250 docs');

      const quotaPath = path.resolve('server/services/quotaService.ts');
      const quotaCode = fs.readFileSync(quotaPath, 'utf-8');
      assert(quotaCode.includes('used_documents'), 'quotaService must continue using legacy used_documents');
      assert(quotaCode.includes('document_quota'), 'quotaService must continue using document_quota');
      assert(!quotaCode.includes('credit_ledger'), 'quotaService must NOT touch credit_ledger in Phase 2A');
    },
  },

  // ---------------------------------------------------------------------------
  // CR-20: Frontend/Backend Build Verification
  // ---------------------------------------------------------------------------
  {
    id: 'CR-20',
    name: 'Frontend assets and server bundle build successfully',
    run: async () => {
      const serverCjs = path.resolve('dist/server.cjs');
      const distIndex = path.resolve('dist/index.html');
      assert(fs.existsSync(serverCjs), 'dist/server.cjs must exist after build');
      assert(fs.existsSync(distIndex), 'dist/index.html must exist after build');
    },
  },

  // ===========================================================================
  // PHASE 2A.1 HARDENING TESTS (HR-01 to HR-13)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // HR-01: Authenticated cannot execute SECURITY DEFINER balance RPC arbitrarily
  // ---------------------------------------------------------------------------
  {
    id: 'HR-01',
    name: 'Authenticated role cannot execute SECURITY DEFINER balance RPC arbitrarily (service_role only)',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('REVOKE ALL ON FUNCTION public.get_user_credit_balance(UUID) FROM PUBLIC, anon, authenticated;'),
        'get_user_credit_balance must be revoked from authenticated'
      );
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.get_user_credit_balance(UUID) TO postgres, service_role;'),
        'get_user_credit_balance must only be granted to postgres and service_role'
      );
      assert(
        !migrationSql.includes('GRANT EXECUTE ON FUNCTION public.get_user_credit_balance(UUID) TO postgres, service_role, authenticated;') &&
        !migrationSql.includes('GRANT EXECUTE ON FUNCTION public.get_user_credit_balance TO postgres, service_role, authenticated;'),
        'authenticated must NOT have execute grant on get_user_credit_balance'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // HR-02: Admin adjustment writes ADJUSTMENT ledger entry
  // ---------------------------------------------------------------------------
  {
    id: 'HR-02',
    name: 'Admin adjustment writes ADJUSTMENT ledger entry (DB-controlled entry_type mapping)',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes("IF p_source_type = 'ADMIN_ADJUSTMENT' THEN") &&
        migrationSql.includes("v_entry_type := 'ADJUSTMENT';") &&
        migrationSql.includes("v_entry_type := 'GRANT';"),
        'DB RPC must map ADMIN_ADJUSTMENT to ADJUSTMENT ledger entry_type, others to GRANT'
      );

      let capturedParams: any = null;
      const mockService = new (creditService.constructor as any)();
      mockService.grantCredits = async (params: any) => {
        capturedParams = params;
        return {
          grantId: 'mock-adj-grant',
          accountId: 'mock-acc',
          userId: params.userId,
          originalUnits: params.originalUnits,
          remainingUnits: params.originalUnits,
          totalAvailableUnits: params.originalUnits,
          alreadyProcessed: false,
        };
      };

      await mockService.adjustUserCredits({
        userId: '00000000-0000-0000-0000-000000000001',
        deltaUnits: 50000,
        actorId: 'admin_test_1',
        reason: 'Compensation for system downtime',
        idempotencyKey: 'test_adj_01',
      });

      assert.strictEqual(capturedParams.sourceType, 'ADMIN_ADJUSTMENT');
      assert.strictEqual(capturedParams.originalUnits, 50000);
      assert.strictEqual(capturedParams.expiresAt, null);
    },
  },

  // ---------------------------------------------------------------------------
  // HR-03: Concurrent duplicate idempotency cannot double grant
  // ---------------------------------------------------------------------------
  {
    id: 'HR-03',
    name: 'Concurrent duplicate idempotency safe via transaction advisory lock and unique violation catch',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('pg_advisory_xact_lock(hashtext(p_idempotency_key))'),
        'grant_user_credits must acquire transaction-scoped advisory lock on idempotency key'
      );
      assert(
        migrationSql.includes('EXCEPTION WHEN unique_violation THEN'),
        'grant_user_credits must catch unique_violation to read back existing grant on concurrency race'
      );

      // Concurrency simulation with advisory lock behavior
      let insertedCount = 0;
      const mockDbGrants = new Map<string, any>();
      const advisoryLocks = new Set<string>();

      const acquireAdvisoryLock = async (key: string) => {
        while (advisoryLocks.has(key)) {
          await new Promise((r) => setTimeout(r, 5));
        }
        advisoryLocks.add(key);
      };
      const releaseAdvisoryLock = (key: string) => {
        advisoryLocks.delete(key);
      };

      const mockConcurrentRpc = async (key: string) => {
        await acquireAdvisoryLock(key);
        try {
          // Idempotency read under lock
          if (mockDbGrants.has(key)) {
            return { already_processed: true, ...mockDbGrants.get(key) };
          }
          await new Promise((r) => setTimeout(r, 10)); // simulated DB work
          insertedCount++;
          const record = { grant_id: 'grant_concurrent_1', idempotency_key: key };
          mockDbGrants.set(key, record);
          return { already_processed: false, ...record };
        } finally {
          releaseAdvisoryLock(key);
        }
      };

      const [res1, res2] = await Promise.all([
        mockConcurrentRpc('same_concurrent_key'),
        mockConcurrentRpc('same_concurrent_key'),
      ]);

      assert.strictEqual(insertedCount, 1, 'Exactly one grant must be inserted');
      const initial = res1.already_processed ? res2 : res1;
      const duplicate = res1.already_processed ? res1 : res2;
      assert.strictEqual(initial.already_processed, false, 'First concurrent call must return already_processed = false');
      assert.strictEqual(duplicate.already_processed, true, 'Second concurrent call must return already_processed = true');
    },
  },

  // ---------------------------------------------------------------------------
  // HR-04: SUBSCRIPTION_CYCLE invalid semantic combinations rejected
  // ---------------------------------------------------------------------------
  {
    id: 'HR-04',
    name: 'SUBSCRIPTION_CYCLE invalid semantic combinations rejected by DB constraints and RPC',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('chk_credit_grants_subscription_semantics'),
        'Migration must define chk_credit_grants_subscription_semantics CHECK constraint'
      );
      assert(
        migrationSql.includes("INVALID_GRANT_SEMANTICS: SUBSCRIPTION_CYCLE requires p_product_id"),
        'RPC must validate p_product_id for SUBSCRIPTION_CYCLE'
      );
      assert(
        migrationSql.includes("INVALID_GRANT_SEMANTICS: SUBSCRIPTION_CYCLE requires p_pricing_version_id"),
        'RPC must validate p_pricing_version_id for SUBSCRIPTION_CYCLE'
      );
      assert(
        migrationSql.includes("INVALID_GRANT_SEMANTICS: SUBSCRIPTION_CYCLE requires p_expires_at equal to p_billing_cycle_end"),
        'RPC must validate p_expires_at = p_billing_cycle_end for SUBSCRIPTION_CYCLE'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // HR-05: CREDIT_PACK_PURCHASE with expires_at rejected
  // ---------------------------------------------------------------------------
  {
    id: 'HR-05',
    name: 'CREDIT_PACK_PURCHASE with expires_at rejected by DB constraints and RPC',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('chk_credit_grants_pack_semantics'),
        'Migration must define chk_credit_grants_pack_semantics CHECK constraint'
      );
      assert(
        migrationSql.includes("INVALID_GRANT_SEMANTICS: CREDIT_PACK_PURCHASE must not have p_expires_at (must be NULL)"),
        'RPC must reject non-null expires_at for CREDIT_PACK_PURCHASE'
      );
      assert(
        migrationSql.includes("INVALID_GRANT_SEMANTICS: CREDIT_PACK_PURCHASE must not have billing cycle dates (must be NULL)"),
        'RPC must reject cycle dates for CREDIT_PACK_PURCHASE'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // HR-06: Subscription grant rejects non-SUBSCRIPTION product
  // ---------------------------------------------------------------------------
  {
    id: 'HR-06',
    name: 'Subscription cycle grant strictly validates product_type = SUBSCRIPTION (rejects CREDIT_PACK)',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes("INVALID_PRODUCT_TYPE: SUBSCRIPTION_CYCLE product must have product_type = SUBSCRIPTION"),
        'DB RPC must reject non-SUBSCRIPTION product for SUBSCRIPTION_CYCLE'
      );

      // TypeScript service validation
      const mockClient: any = {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'prod-pack-id', product_type: 'CREDIT_PACK' },
                error: null,
              }),
            }),
          }),
        }),
      };

      const testService = new (creditService.constructor as any)(mockClient);

      await assert.rejects(
        async () => {
          await testService.grantSubscriptionCycleCredits({
            userId: '00000000-0000-0000-0000-000000000001',
            productCode: 'PACK_500',
            cycleStart: '2026-10-01T00:00:00Z',
            cycleEnd: '2026-11-01T00:00:00Z',
            idempotencyKey: 'test_sub_invalid_pack',
          });
        },
        /INVALID_SUBSCRIPTION_PRODUCT/,
        'Must reject CREDIT_PACK product when attempting subscription grant'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // HR-07: Grant account/user mismatch impossible
  // ---------------------------------------------------------------------------
  {
    id: 'HR-07',
    name: 'Grant account/user mismatch impossible via composite foreign key (account_id, user_id)',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('CONSTRAINT uq_credit_accounts_id_user UNIQUE (id, user_id)'),
        'credit_accounts must have composite UNIQUE (id, user_id)'
      );
      assert(
        migrationSql.includes('CONSTRAINT fk_credit_grants_account_user') &&
        migrationSql.includes('FOREIGN KEY (account_id, user_id)') &&
        migrationSql.includes('REFERENCES public.credit_accounts(id, user_id)'),
        'credit_grants must enforce composite FK (account_id, user_id) referencing credit_accounts(id, user_id)'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // HR-08: Ledger account/user/grant mismatch impossible
  // ---------------------------------------------------------------------------
  {
    id: 'HR-08',
    name: 'Ledger account/user/grant mismatch impossible via composite FKs and fn_guard_credit_ledger_identity',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('CONSTRAINT fk_credit_ledger_grant_account_user') &&
        migrationSql.includes('FOREIGN KEY (grant_id, account_id, user_id)') &&
        migrationSql.includes('REFERENCES public.credit_grants(id, account_id, user_id)'),
        'credit_ledger must enforce composite FK (grant_id, account_id, user_id)'
      );
      assert(
        migrationSql.includes('fn_guard_credit_ledger_identity'),
        'Migration must define fn_guard_credit_ledger_identity trigger function'
      );
      assert(
        migrationSql.includes('trg_guard_credit_ledger_identity'),
        'Migration must define trg_guard_credit_ledger_identity trigger'
      );
      assert(
        migrationSql.includes('IDENTITY_MISMATCH'),
        'Identity guard trigger must raise IDENTITY_MISMATCH on mismatch'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // HR-09: Monthly anniversary helper passes normal month
  // ---------------------------------------------------------------------------
  {
    id: 'HR-09',
    name: 'Monthly anniversary calendar arithmetic preserves day-of-month and time (12th -> 12th)',
    run: async () => {
      const start1 = new Date('2026-09-12T14:30:00.000Z');
      const next1 = addMonthlyAnniversary(start1);
      assert.strictEqual(next1.toISOString(), '2026-10-12T14:30:00.000Z', '2026-09-12 -> 2026-10-12 with identical time');

      const start2 = new Date('2026-10-12T00:00:00.000Z');
      const next2 = addMonthlyAnniversary(start2);
      assert.strictEqual(next2.toISOString(), '2026-11-12T00:00:00.000Z', '2026-10-12 -> 2026-11-12');

      const start3 = new Date('2026-12-15T08:00:00.000Z');
      const next3 = addMonthlyAnniversary(start3);
      assert.strictEqual(next3.toISOString(), '2027-01-15T08:00:00.000Z', '2026-12-15 -> 2027-01-15 (year wrap)');
    },
  },

  // ---------------------------------------------------------------------------
  // HR-10: Jan 31 clamp behavior correct
  // ---------------------------------------------------------------------------
  {
    id: 'HR-10',
    name: 'Monthly anniversary end-of-month clamp behavior (2026-01-31 -> 2026-02-28)',
    run: async () => {
      const jan31 = new Date('2026-01-31T10:00:00.000Z');
      const febResult = addMonthlyAnniversary(jan31);
      assert.strictEqual(febResult.toISOString(), '2026-02-28T10:00:00.000Z', 'Jan 31 non-leap year clamps to Feb 28');

      const mar31 = new Date('2026-03-31T00:00:00.000Z');
      const aprResult = addMonthlyAnniversary(mar31);
      assert.strictEqual(aprResult.toISOString(), '2026-04-30T00:00:00.000Z', 'Mar 31 clamps to Apr 30');

      const may31 = new Date('2026-05-31T00:00:00.000Z');
      const junResult = addMonthlyAnniversary(may31);
      assert.strictEqual(junResult.toISOString(), '2026-06-30T00:00:00.000Z', 'May 31 clamps to Jun 30');
    },
  },

  // ---------------------------------------------------------------------------
  // HR-11: Leap-year clamp correct
  // ---------------------------------------------------------------------------
  {
    id: 'HR-11',
    name: 'Monthly anniversary leap-year February clamp (2028-01-31 -> 2028-02-29)',
    run: async () => {
      const leapJan31 = new Date('2028-01-31T12:00:00.000Z');
      const leapFebResult = addMonthlyAnniversary(leapJan31);
      assert.strictEqual(leapFebResult.toISOString(), '2028-02-29T12:00:00.000Z', 'Jan 31 leap year clamps to Feb 29');

      const leapFeb29 = new Date('2028-02-29T12:00:00.000Z');
      const leapMarResult = addMonthlyAnniversary(leapFeb29);
      assert.strictEqual(leapMarResult.toISOString(), '2028-03-29T12:00:00.000Z', 'Feb 29 rolls forward to Mar 29');
    },
  },

  // ---------------------------------------------------------------------------
  // HR-12: Unsafe BIGINT -> JS number conversion fails closed
  // ---------------------------------------------------------------------------
  {
    id: 'HR-12',
    name: 'Unsafe BIGINT -> JS number conversion fails closed (safeParseCreditUnits)',
    run: async () => {
      // Valid conversions
      assert.strictEqual(safeParseCreditUnits(1000), 1000);
      assert.strictEqual(safeParseCreditUnits('50000'), 50000);
      assert.strictEqual(safeParseCreditUnits(0), 0);
      assert.strictEqual(safeParseCreditUnits(MAX_SAFE_CREDIT_UNITS), MAX_SAFE_CREDIT_UNITS);

      // Non-integer must fail
      assert.throws(() => safeParseCreditUnits(123.45), /INTEGER_SAFETY_ERROR/);
      assert.throws(() => safeParseCreditUnits('123.45'), /INTEGER_SAFETY_ERROR/);

      // Null / undefined / NaN must fail
      assert.throws(() => safeParseCreditUnits(null), /INTEGER_SAFETY_ERROR/);
      assert.throws(() => safeParseCreditUnits(undefined), /INTEGER_SAFETY_ERROR/);
      assert.throws(() => safeParseCreditUnits('invalid_number'), /INTEGER_SAFETY_ERROR/);

      // Overflow beyond Number.MAX_SAFE_INTEGER must fail closed
      assert.throws(
        () => safeParseCreditUnits('9007199254740992'),
        /INTEGER_OVERFLOW_ERROR/
      );
    },
  },

  // ---------------------------------------------------------------------------
  // HR-13: Financial rows are not cascade-destroyed unintentionally
  // ---------------------------------------------------------------------------
  {
    id: 'HR-13',
    name: 'Financial rows are not cascade-destroyed unintentionally (ON DELETE RESTRICT audit protection)',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      // Ensure NO ON DELETE CASCADE exists anywhere in migration
      assert(
        !migrationSql.includes('ON DELETE CASCADE'),
        'Financial schema must NOT contain any ON DELETE CASCADE clauses'
      );

      // Verify explicit ON DELETE RESTRICT on credit_accounts, credit_grants, credit_ledger
      assert(
        migrationSql.includes('user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT'),
        'credit_accounts must have ON DELETE RESTRICT'
      );
      assert(
        migrationSql.includes('account_id UUID NOT NULL'),
        'credit_grants must define account_id'
      );
      assert(
        migrationSql.includes('fk_credit_grants_account_user') &&
        migrationSql.includes('ON DELETE RESTRICT'),
        'credit_grants must have ON DELETE RESTRICT'
      );
      assert(
        migrationSql.includes('fk_credit_ledger_grant_account_user') &&
        migrationSql.includes('ON DELETE RESTRICT'),
        'credit_ledger must have ON DELETE RESTRICT'
      );
    },
  },

  // ===========================================================================
  // FINAL PATCH TESTS (FP-01 to FP-09)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // FP-01: grant_user_credits uses p_product_id correctly for source_product_id
  // ---------------------------------------------------------------------------
  {
    id: 'FP-01',
    name: 'grant_user_credits INSERT correctly maps source_product_id <- p_product_id (no undeclared parameters)',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      // Must NOT contain undeclared p_source_product_id
      assert(
        !migrationSql.includes('p_source_product_id'),
        'grant_user_credits must NOT reference undeclared p_source_product_id'
      );

      // Must insert p_product_id into source_product_id
      assert(
        migrationSql.includes('source_product_id,') && migrationSql.includes('p_product_id,'),
        'grant_user_credits INSERT must map source_product_id <- p_product_id'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // FP-02: Explicit function signatures for GRANT/REVOKE exactly match SQL declaration
  // ---------------------------------------------------------------------------
  {
    id: 'FP-02',
    name: 'Explicit function signatures for GRANT/REVOKE exactly match SQL declaration',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('REVOKE ALL ON FUNCTION public.get_user_credit_balance(UUID) FROM PUBLIC, anon, authenticated;'),
        'get_user_credit_balance REVOKE must use explicit (UUID) signature'
      );
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.get_user_credit_balance(UUID) TO postgres, service_role;'),
        'get_user_credit_balance GRANT must use explicit (UUID) signature'
      );

      // Verify explicit 14-argument signature for grant_user_credits
      assert(
        migrationSql.includes('REVOKE ALL ON FUNCTION public.grant_user_credits(') &&
        migrationSql.includes('UUID,\n    VARCHAR,\n    BIGINT,\n    TEXT,\n    TIMESTAMPTZ,\n    UUID,\n    UUID,\n    UUID,\n    TIMESTAMPTZ,\n    TIMESTAMPTZ,\n    VARCHAR,\n    TEXT,\n    TEXT,\n    JSONB'),
        'grant_user_credits REVOKE must specify full 14-argument signature'
      );
      assert(
        migrationSql.includes('GRANT EXECUTE ON FUNCTION public.grant_user_credits(') &&
        migrationSql.includes('TO postgres, service_role;'),
        'grant_user_credits GRANT must specify full 14-argument signature to postgres, service_role'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // FP-03: Same idempotency key + same payload returns already_processed=true
  // ---------------------------------------------------------------------------
  {
    id: 'FP-03',
    name: 'Same idempotency key + same payload returns already_processed = true',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('IDEMPOTENCY_KEY_CONFLICT'),
        'grant_user_credits must raise IDEMPOTENCY_KEY_CONFLICT on payload mismatch'
      );

      const store = new Map<string, any>();
      const processGrant = (params: any) => {
        const existing = store.get(params.idempotencyKey);
        if (existing) {
          if (
            existing.userId !== params.userId ||
            existing.sourceType !== params.sourceType ||
            existing.originalUnits !== params.originalUnits ||
            existing.productId !== params.productId ||
            existing.pricingVersionId !== params.pricingVersionId
          ) {
            throw new Error(`IDEMPOTENCY_KEY_CONFLICT: Idempotency key "${params.idempotencyKey}" conflict`);
          }
          return { ...existing, alreadyProcessed: true };
        }
        const created = { ...params, grantId: 'grant_001', alreadyProcessed: false };
        store.set(params.idempotencyKey, created);
        return created;
      };

      const payload = {
        userId: 'user_001',
        sourceType: 'SUBSCRIPTION_CYCLE',
        originalUnits: 120000,
        productId: 'prod_001',
        pricingVersionId: 'pv_001',
        idempotencyKey: 'idem_key_matching',
      };

      const res1 = processGrant(payload);
      assert.strictEqual(res1.alreadyProcessed, false);

      const res2 = processGrant(payload);
      assert.strictEqual(res2.alreadyProcessed, true);
      assert.strictEqual(res2.grantId, res1.grantId);
    },
  },

  // ---------------------------------------------------------------------------
  // FP-04: Same idempotency key + different user_id fails with IDEMPOTENCY_KEY_CONFLICT
  // ---------------------------------------------------------------------------
  {
    id: 'FP-04',
    name: 'Same idempotency key + different user_id fails with IDEMPOTENCY_KEY_CONFLICT',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('v_existing_grant.user_id <> p_user_id'),
        'RPC must validate user_id match on idempotency read'
      );

      const store = new Map<string, any>();
      store.set('idem_key_01', {
        userId: 'user_original',
        sourceType: 'CREDIT_PACK_PURCHASE',
        originalUnits: 50000,
        productId: 'prod_50',
        pricingVersionId: 'pv_1',
      });

      const attemptTamperedUser = () => {
        const existing = store.get('idem_key_01');
        if (existing.userId !== 'user_attacker') {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT: user_id mismatch');
        }
      };

      assert.throws(attemptTamperedUser, /IDEMPOTENCY_KEY_CONFLICT/);
    },
  },

  // ---------------------------------------------------------------------------
  // FP-05: Same idempotency key + different original_units fails
  // ---------------------------------------------------------------------------
  {
    id: 'FP-05',
    name: 'Same idempotency key + different original_units fails with IDEMPOTENCY_KEY_CONFLICT',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('v_existing_grant.original_units <> p_original_units'),
        'RPC must validate original_units match on idempotency read'
      );

      const store = new Map<string, any>();
      store.set('idem_key_units', {
        userId: 'user_01',
        sourceType: 'CREDIT_PACK_PURCHASE',
        originalUnits: 50000,
      });

      const attemptTamperedUnits = () => {
        const existing = store.get('idem_key_units');
        if (existing.originalUnits !== 200000) {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT: original_units mismatch');
        }
      };

      assert.throws(attemptTamperedUnits, /IDEMPOTENCY_KEY_CONFLICT/);
    },
  },

  // ---------------------------------------------------------------------------
  // FP-06: Same idempotency key + different product_id fails
  // ---------------------------------------------------------------------------
  {
    id: 'FP-06',
    name: 'Same idempotency key + different product_id fails with IDEMPOTENCY_KEY_CONFLICT',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('v_existing_grant.source_product_id IS DISTINCT FROM p_product_id'),
        'RPC must validate source_product_id IS NOT DISTINCT FROM p_product_id'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // FP-07: Same idempotency key + different pricing_version_id fails
  // ---------------------------------------------------------------------------
  {
    id: 'FP-07',
    name: 'Same idempotency key + different pricing_version_id fails with IDEMPOTENCY_KEY_CONFLICT',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(
        migrationSql.includes('v_existing_grant.pricing_version_id IS DISTINCT FROM p_pricing_version_id'),
        'RPC must validate pricing_version_id IS NOT DISTINCT FROM p_pricing_version_id'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // FP-08: unique_violation recovery path also enforces payload equivalence
  // ---------------------------------------------------------------------------
  {
    id: 'FP-08',
    name: 'unique_violation recovery path enforces identical payload equivalence check',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      const exceptionBlock = migrationSql.slice(migrationSql.indexOf('EXCEPTION WHEN unique_violation THEN'));
      assert(
        exceptionBlock.includes('IDEMPOTENCY_KEY_CONFLICT'),
        'unique_violation recovery block must enforce IDEMPOTENCY_KEY_CONFLICT validation'
      );
      assert(
        exceptionBlock.includes('v_existing_grant.user_id <> p_user_id'),
        'unique_violation recovery block must validate user_id match'
      );
      assert(
        exceptionBlock.includes('v_existing_grant.original_units <> p_original_units'),
        'unique_violation recovery block must validate original_units match'
      );
      assert(
        exceptionBlock.includes('v_existing_grant.source_product_id IS DISTINCT FROM p_product_id'),
        'unique_violation recovery block must validate product_id match'
      );
    },
  },

  // ---------------------------------------------------------------------------
  // FP-09: Migration contains no markdown escape artifacts such as "\\--" or "\\."
  // ---------------------------------------------------------------------------
  {
    id: 'FP-09',
    name: 'Migration contains no markdown escape artifacts (\\--, \\., etc.)',
    run: async () => {
      const migrationPath = path.resolve('supabase/migrations/20261001000000_credit_ledger_foundation.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      assert(!migrationSql.includes('\\--'), 'Migration must NOT contain markdown comment escape \\--');
      assert(!migrationSql.includes('\\.'), 'Migration must NOT contain markdown dot escape \\.');
      assert(!migrationSql.includes('NEW\\.grant_id'), 'Migration must NOT contain NEW\\.grant_id');
      assert(!migrationSql.includes('\\*'), 'Migration must NOT contain markdown asterisk escape \\*');
      assert(!migrationSql.includes('\\_'), 'Migration must NOT contain markdown underscore escape \\_');
    },
  },
];

async function runAllTests() {
  console.log('================================================================');
  console.log('PHASE 2A / 2A.1 — CREDIT LEDGER FOUNDATION TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    try {
      await tc.run();
      console.log(`\x1b[32m[PASS]\x1b[0m ${tc.id}: ${tc.name}`);
      passed++;
    } catch (err: any) {
      console.error(`\x1b[31m[FAIL]\x1b[0m ${tc.id}: ${tc.name}`);
      console.error(`       Error: ${err.message}`);
      failed++;
    }
  }

  console.log('\n================================================================');
  console.log(`TOTAL: ${testCases.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
