import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from '../supabaseClient.js';
import { billingService } from '../billing/billingService.js';
import {
  GrantUserCreditsParams,
  GrantSubscriptionCycleCreditsParams,
  GrantPurchasedCreditPackParams,
  AdminCreditAdjustmentParams,
  ReserveCreditUnitsParams,
  CaptureCreditReservationParams,
  ReleaseCreditReservationParams,
  UserCreditBalanceDto,
  CreditGrantDto,
  CreditLedgerPageDto,
  CreditReservationDto,
  CreditGrantRecord,
  CreditLedgerRecord,
  CreditReservationRecord,
  CreditReservationAllocationRecord,
} from '../../types/credit.js';

export const UNITS_PER_CREDIT = 1000;
export const MAX_SAFE_CREDIT_UNITS = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991

export function unitsToCredits(units: number): number {
  return Number((units / UNITS_PER_CREDIT).toFixed(3));
}

export function creditsToUnits(credits: number): number {
  if (credits < 0) throw new Error('CREDIT_UNITS_INVALID: Credits must be non-negative');
  return Math.round(credits * UNITS_PER_CREDIT);
}

/**
 * Safe integer parser for BIGINT-derived credit units.
 * Enforces that units are finite integers within [-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER].
 * Fails closed with explicit error if non-integer or overflowing.
 * Note: If units ever exceed Number.MAX_SAFE_INTEGER in future scale,
 * the application architecture must migrate to native BigInt / string representations.
 */
export function safeParseCreditUnits(value: unknown, fieldName = 'credit_units'): number {
  if (value === null || value === undefined) {
    throw new Error(`INTEGER_SAFETY_ERROR: ${fieldName} is null or undefined`);
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`INTEGER_SAFETY_ERROR: ${fieldName} must be a valid integer, received: ${String(value)}`);
  }
  if (num > Number.MAX_SAFE_INTEGER || num < -Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `INTEGER_OVERFLOW_ERROR: ${fieldName} (${String(value)}) exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). Future architecture requires BigInt / string representation.`
    );
  }
  return num;
}

/**
 * Calculates the next monthly anniversary date in UTC with calendar arithmetic and end-of-month clamping.
 * 
 * UTC Calendar Behavior:
 * - Preserves the exact UTC time (hours, minutes, seconds, milliseconds).
 * - Increments the month by 1 (wrapping year if moving from December to January).
 * - If the target month has fewer days than the start date's day of month,
 *   clamps to the last valid day of that target month.
 *
 * Examples:
 * - 2026-09-12T00:00:00Z -> 2026-10-12T00:00:00Z
 * - 2026-10-12T00:00:00Z -> 2026-11-12T00:00:00Z
 * - 2026-01-31T00:00:00Z -> 2026-02-28T00:00:00Z (non leap-year February)
 * - 2028-01-31T00:00:00Z -> 2028-02-29T00:00:00Z (leap-year February)
 * - 2026-03-31T12:00:00Z -> 2026-04-30T12:00:00Z (April has 30 days)
 */
export function addMonthlyAnniversary(startDate: Date | string): Date {
  const d = typeof startDate === 'string' ? new Date(startDate) : new Date(startDate.getTime());
  if (isNaN(d.getTime())) {
    throw new Error('INVALID_DATE: Invalid startDate provided to addMonthlyAnniversary');
  }

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0 to 11
  const day = d.getUTCDate();

  let targetYear = year;
  let targetMonth = month + 1;
  if (targetMonth > 11) {
    targetYear += 1;
    targetMonth = 0;
  }

  // Day 0 of the following month gives the last day of targetMonth
  const maxDaysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, maxDaysInTargetMonth);

  const result = new Date(d.getTime());
  result.setUTCFullYear(targetYear, targetMonth, clampedDay);

  return result;
}

/**
 * Phase 3A.4.2: Server-authoritative policy effective activation timestamp.
 * Historical users created prior to this timestamp are NOT eligible for initial FREE_BOOTSTRAP.
 *
 * CANONICAL RULE:
 * Must be an explicit server-controlled Product Owner-approved timestamp.
 * Must NOT be derived automatically from migration filename, git commit time, build time, or server startup.
 *
 * In production (NODE_ENV=production):
 * If FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT is missing or invalid, fails closed.
 */
export const DEFAULT_FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT = '2026-10-03T01:00:00.000Z'; // Deprecated / test fallback only

let testPolicyEffectiveAtOverride: string | null = null;

export function setTestPolicyEffectiveAtOverride(value: string | null) {
  testPolicyEffectiveAtOverride = value;
}

export function validatePolicyTimestamp(raw?: string | null): {
  valid: boolean;
  date?: Date;
  error?: 'POLICY_NOT_CONFIGURED' | 'INVALID_POLICY_TIMESTAMP_FORMAT' | 'INVALID_POLICY_TIMESTAMP';
} {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return { valid: false, error: 'POLICY_NOT_CONFIGURED' };
  }
  const trimmed = raw.trim();
  // ISO-8601 with explicit timezone (Z or +HH:mm or -HH:mm)
  const isoWithTzRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
  if (!isoWithTzRegex.test(trimmed)) {
    return { valid: false, error: 'INVALID_POLICY_TIMESTAMP_FORMAT' };
  }
  const date = new Date(trimmed);
  if (isNaN(date.getTime())) {
    return { valid: false, error: 'INVALID_POLICY_TIMESTAMP' };
  }
  return { valid: true, date };
}

export function getFreeBootstrapPolicyEffectiveAt(options?: { allowTestFallback?: boolean }): Date | null {
  if (testPolicyEffectiveAtOverride !== null) {
    const res = validatePolicyTimestamp(testPolicyEffectiveAtOverride);
    if (!res.valid || !res.date) {
      throw new Error(`INVALID_POLICY_TIMESTAMP: Invalid test policy override ${testPolicyEffectiveAtOverride}`);
    }
    return res.date;
  }

  const envTimestamp = process.env.FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT;
  if (envTimestamp) {
    const res = validatePolicyTimestamp(envTimestamp);
    if (!res.valid || !res.date) {
      throw new Error(`INVALID_POLICY_TIMESTAMP: Invalid FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT format or value (${envTimestamp})`);
    }
    return res.date;
  }

  // In production, strictly fail closed if environment variable is not configured
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  // In test / development environment, allow test fallback if requested or when running tests
  if (options?.allowTestFallback || process.env.NODE_ENV === 'test' || !process.env.NODE_ENV) {
    return new Date(DEFAULT_FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT);
  }

  return null;
}

export class CreditService {
  private clientOverride: SupabaseClient | null = null;

  constructor(client?: SupabaseClient) {
    if (client) this.clientOverride = client;
  }

  private getAdminClient(): SupabaseClient {
    if (this.clientOverride) return this.clientOverride;
    const client = getSupabaseAdminClient();
    if (!client) {
      throw new Error('CREDIT_SERVICE_ERROR: Supabase admin client unavailable');
    }
    return client;
  }

  /**
   * CR-01 / CR-03 / CR-04: Atomic Grant RPC wrapper
   * Guarantees transactional all-or-nothing execution & idempotency safety.
   */
  async grantCredits(params: GrantUserCreditsParams): Promise<{
    grantId: string;
    accountId: string;
    userId: string;
    originalUnits: number;
    remainingUnits: number;
    totalAvailableUnits: number;
    alreadyProcessed: boolean;
  }> {
    const client = this.getAdminClient();

    if (!params.userId) throw new Error('INVALID_ARGUMENT: userId is required');
    if (!params.idempotencyKey) throw new Error('INVALID_ARGUMENT: idempotencyKey is required');
    if (!params.originalUnits || !Number.isInteger(params.originalUnits) || params.originalUnits <= 0) {
      throw new Error('INVALID_ARGUMENT: originalUnits must be positive integer');
    }
    if (params.originalUnits > Number.MAX_SAFE_INTEGER) {
      throw new Error(`INTEGER_OVERFLOW_ERROR: originalUnits (${params.originalUnits}) exceeds Number.MAX_SAFE_INTEGER`);
    }

    const { data, error } = await client.rpc('grant_user_credits', {
      p_user_id: params.userId,
      p_source_type: params.sourceType,
      p_original_units: params.originalUnits,
      p_idempotency_key: params.idempotencyKey,
      p_expires_at: params.expiresAt || null,
      p_product_id: params.productId || null,
      p_pricing_version_id: params.pricingVersionId || null,
      p_subscription_id: params.subscriptionId || null,
      p_billing_cycle_start: params.billingCycleStart || null,
      p_billing_cycle_end: params.billingCycleEnd || null,
      p_reference_type: params.referenceType || null,
      p_reference_id: params.referenceId || null,
      p_description: params.description || null,
      p_metadata: params.metadata || {},
    });

    if (error) {
      throw new Error(`GRANT_CREDITS_FAILED: ${error.message}`);
    }

    return {
      grantId: data.grant_id,
      accountId: data.account_id,
      userId: data.user_id,
      originalUnits: safeParseCreditUnits(data.original_units, 'original_units'),
      remainingUnits: safeParseCreditUnits(data.remaining_units, 'remaining_units'),
      totalAvailableUnits: safeParseCreditUnits(data.total_available_units, 'total_available_units'),
      alreadyProcessed: Boolean(data.already_processed),
    };
  }

  /**
   * CR-05 / CR-07 / CR-08 / CR-09: Grant Subscription Cycle Credits
   * Strictly resolves canonical product_credit_grants (never legacy plan limits).
   * Validates product_type = 'SUBSCRIPTION'. Sets expires_at = cycleEnd.
   */
  async grantSubscriptionCycleCredits(params: GrantSubscriptionCycleCreditsParams) {
    const client = this.getAdminClient();

    // 1. Resolve canonical commercial credit grant amount (fail-closed)
    const creditsGranted = await billingService.getCanonicalCreditGrant(
      params.productCode,
      params.pricingVersionId
    );

    // 2. Resolve product UUID and pricing version UUID
    const { data: prod, error: pErr } = await client
      .from('billing_products')
      .select('id, product_type')
      .eq('code', params.productCode)
      .maybeSingle();

    if (pErr || !prod?.id) {
      throw new Error(
        `SUBSCRIPTION_PRODUCT_NOT_FOUND: Product '${params.productCode}' could not be resolved (${pErr?.message || 'NOT_FOUND'})`
      );
    }

    if (prod.product_type !== 'SUBSCRIPTION') {
      throw new Error(
        `INVALID_SUBSCRIPTION_PRODUCT: Product '${params.productCode}' is not a SUBSCRIPTION (type: ${prod.product_type})`
      );
    }

    let versionId = params.pricingVersionId;
    if (!versionId) {
      const version = await billingService.getPricingVersion('pricing-v1');
      if (!version?.id) {
        throw new Error('ACTIVE_PRICING_VERSION_NOT_FOUND: Failed to resolve active pricing version');
      }
      versionId = version.id;
    }

    const originalUnits = creditsToUnits(creditsGranted);

    return this.grantCredits({
      userId: params.userId,
      sourceType: 'SUBSCRIPTION_CYCLE',
      originalUnits,
      idempotencyKey: params.idempotencyKey,
      expiresAt: params.cycleEnd,
      productId: prod.id,
      pricingVersionId: versionId,
      subscriptionId: params.subscriptionId || null,
      billingCycleStart: params.cycleStart,
      billingCycleEnd: params.cycleEnd,
      referenceType: 'SUBSCRIPTION_CYCLE',
      referenceId: params.subscriptionId || `${params.productCode}_${params.cycleStart}`,
      description: `Subscription cycle credits for ${params.productCode} (${creditsGranted} credits)`,
      metadata: {
        productCode: params.productCode,
        creditsGranted,
      },
    });
  }

  /**
   * CR-06 / CR-07: Grant Purchased Credit Pack
   * Credit packs are independent from subscription cycles and DO NOT expire (expires_at = null).
   */
  async grantPurchasedCreditPack(params: GrantPurchasedCreditPackParams) {
    const client = this.getAdminClient();

    // 1. Resolve product and verify product_type is CREDIT_PACK
    const { data: prod, error: pErr } = await client
      .from('billing_products')
      .select('id, product_type')
      .eq('code', params.productCode)
      .maybeSingle();

    if (pErr || !prod?.id) {
      throw new Error(
        `CREDIT_PACK_NOT_FOUND: Product '${params.productCode}' could not be resolved (${pErr?.message || 'NOT_FOUND'})`
      );
    }

    if (prod.product_type !== 'CREDIT_PACK') {
      throw new Error(
        `INVALID_CREDIT_PACK_PRODUCT: Product '${params.productCode}' is not a CREDIT_PACK (type: ${prod.product_type})`
      );
    }

    // 2. Resolve canonical credits
    const creditsGranted = await billingService.getCanonicalCreditGrant(
      params.productCode,
      params.pricingVersionId
    );

    let versionId = params.pricingVersionId;
    if (!versionId) {
      const version = await billingService.getPricingVersion('pricing-v1');
      if (!version?.id) {
        throw new Error('ACTIVE_PRICING_VERSION_NOT_FOUND: Failed to resolve active pricing version');
      }
      versionId = version.id;
    }

    const originalUnits = creditsToUnits(creditsGranted);

    return this.grantCredits({
      userId: params.userId,
      sourceType: 'CREDIT_PACK_PURCHASE',
      originalUnits,
      idempotencyKey: params.idempotencyKey,
      expiresAt: null, // Non-expiring per Product Owner decision
      productId: prod.id,
      pricingVersionId: versionId,
      referenceType: 'CREDIT_PACK_PURCHASE',
      referenceId: params.referenceId || params.idempotencyKey,
      description: `Purchased credit pack ${params.productCode} (${creditsGranted} credits)`,
      metadata: {
        productCode: params.productCode,
        creditsGranted,
      },
    });
  }

  /**
   * Phase 3A.4.2: Server-authoritative eligibility check for initial FREE_BOOTSTRAP.
   * Enforces that only new users (auth.users.created_at >= policy effective timestamp) who do not
   * already have a FREE_BOOTSTRAP grant can receive the 10 free credits.
   *
   * Canonical account creation authority:
   * auth.users.created_at takes absolute precedence over profiles.created_at.
   * Historical users with recreated profiles remain strictly NOT eligible.
   */
  async checkFreeBootstrapEligibility(userId: string): Promise<{
    eligible: boolean;
    alreadyGranted: boolean;
    reason?:
      | 'ELIGIBLE'
      | 'HISTORICAL_USER'
      | 'HISTORICAL_USER_NOT_ELIGIBLE'
      | 'POLICY_NOT_CONFIGURED'
      | 'ACCOUNT_FROZEN'
      | 'ACCOUNT_CLOSED'
      | 'ALREADY_GRANTED'
      | 'USER_NOT_FOUND';
    authUserCreatedAt?: string;
    userCreatedAt?: string;
    policyEffectiveAt?: string;
    grantId?: string;
  }> {
    if (!userId) {
      return { eligible: false, alreadyGranted: false, reason: 'USER_NOT_FOUND' };
    }

    // 1. Policy effective configuration validation
    let policyEffectiveDate: Date | null = null;
    try {
      policyEffectiveDate = getFreeBootstrapPolicyEffectiveAt();
    } catch {
      return {
        eligible: false,
        alreadyGranted: false,
        reason: 'POLICY_NOT_CONFIGURED',
      };
    }

    if (!policyEffectiveDate) {
      return {
        eligible: false,
        alreadyGranted: false,
        reason: 'POLICY_NOT_CONFIGURED',
      };
    }

    const client = this.getAdminClient();

    // 2. Fetch auth user from Supabase Admin Auth API to verify authoritative account creation timestamp
    let authUserCreatedAt: string | undefined = undefined;
    let authUserFound = false;

    if (typeof (client as any).auth?.admin?.getUserById === 'function') {
      try {
        const { data: authData, error: authErr } = await (client as any).auth.admin.getUserById(userId);
        if (!authErr && authData?.user) {
          authUserFound = true;
          authUserCreatedAt = authData.user.created_at;
        }
      } catch {
        // Fall back to profiles table
      }
    }

    // 3. Fetch user profile from database
    const { data: profile } = await client
      .from('profiles')
      .select('id, created_at')
      .eq('id', userId)
      .maybeSingle();

    if (!authUserFound && !profile) {
      return { eligible: false, alreadyGranted: false, reason: 'USER_NOT_FOUND' };
    }

    // 4. Check if user already has a FREE_BOOTSTRAP grant
    const { data: existingGrant } = await client
      .from('credit_grants')
      .select('id, account_id, user_id, original_units, remaining_units')
      .eq('user_id', userId)
      .eq('source_type', 'FREE_BOOTSTRAP')
      .maybeSingle();

    if (existingGrant) {
      return {
        eligible: false,
        alreadyGranted: true,
        reason: 'ALREADY_GRANTED',
        grantId: existingGrant.id,
        authUserCreatedAt,
        userCreatedAt: profile?.created_at,
        policyEffectiveAt: policyEffectiveDate.toISOString(),
      };
    }

    // 5. Canonical account creation authority check:
    // auth.users.created_at takes absolute precedence.
    const authDate = authUserCreatedAt ? new Date(authUserCreatedAt) : null;
    const profileDate = profile?.created_at ? new Date(profile.created_at) : null;

    // Check A: auth.users.created_at is before policy effective time => HISTORICAL_USER
    if (authDate && (isNaN(authDate.getTime()) || authDate.getTime() < policyEffectiveDate.getTime())) {
      return {
        eligible: false,
        alreadyGranted: false,
        reason: 'HISTORICAL_USER',
        authUserCreatedAt,
        userCreatedAt: profile?.created_at,
        policyEffectiveAt: policyEffectiveDate.toISOString(),
      };
    }

    // Check B: If auth user creation timestamp is absent (offline test mock), fallback to profile.created_at
    if (!authDate && profileDate && (isNaN(profileDate.getTime()) || profileDate.getTime() < policyEffectiveDate.getTime())) {
      return {
        eligible: false,
        alreadyGranted: false,
        reason: 'HISTORICAL_USER',
        authUserCreatedAt,
        userCreatedAt: profile?.created_at,
        policyEffectiveAt: policyEffectiveDate.toISOString(),
      };
    }

    // Check C: If profile exists and is older than policy timestamp
    if (profileDate && (isNaN(profileDate.getTime()) || profileDate.getTime() < policyEffectiveDate.getTime())) {
      return {
        eligible: false,
        alreadyGranted: false,
        reason: 'HISTORICAL_USER',
        authUserCreatedAt,
        userCreatedAt: profile?.created_at,
        policyEffectiveAt: policyEffectiveDate.toISOString(),
      };
    }

    // 6. Check account status if credit account already exists
    const { data: account } = await client
      .from('credit_accounts')
      .select('status')
      .eq('user_id', userId)
      .maybeSingle();

    if (account && (account.status === 'FROZEN' || account.status === 'CLOSED')) {
      return {
        eligible: false,
        alreadyGranted: false,
        reason: `ACCOUNT_${account.status}` as any,
        authUserCreatedAt,
        userCreatedAt: profile?.created_at,
        policyEffectiveAt: policyEffectiveDate.toISOString(),
      };
    }

    return {
      eligible: true,
      alreadyGranted: false,
      reason: 'ELIGIBLE',
      authUserCreatedAt,
      userCreatedAt: profile?.created_at,
      policyEffectiveAt: policyEffectiveDate.toISOString(),
    };
  }

  /**
   * Phase 3A.4: New user FREE bootstrap
   * Grants initial approved 10 credits (10,000 credit_units) once per account.
   * Non-expiring (expires_at = null), independent from billing cycles (null).
   * Safe repair-on-retry and concurrency-resilient via DB partial unique index and advisory lock.
   */
  async bootstrapNewUserFreeCredits(
    userId: string,
    options?: { pricingVersionCode?: string; enforceEligibility?: boolean } | string
  ) {
    const pricingVersionCode = typeof options === 'string' ? options : options?.pricingVersionCode || 'pricing-v1';
    const enforceEligibility = typeof options === 'object' ? Boolean(options?.enforceEligibility) : false;

    const client = this.getAdminClient();

    // Enforce server-authoritative eligibility if requested (e.g. from public endpoint)
    if (enforceEligibility) {
      const eligibility = await this.checkFreeBootstrapEligibility(userId);
      if (eligibility.alreadyGranted) {
        const { data: existingGrant } = await client
          .from('credit_grants')
          .select('id, account_id, user_id, original_units, remaining_units')
          .eq('user_id', userId)
          .eq('source_type', 'FREE_BOOTSTRAP')
          .maybeSingle();

        if (existingGrant) {
          const balance = await this.getUserBalance(userId);
          return {
            grantId: existingGrant.id,
            accountId: existingGrant.account_id,
            userId: existingGrant.user_id,
            originalUnits: safeParseCreditUnits(existingGrant.original_units, 'original_units'),
            remainingUnits: safeParseCreditUnits(existingGrant.remaining_units, 'remaining_units'),
            totalAvailableUnits: balance.availableUnits,
            alreadyProcessed: true,
          };
        }
      }

      if (!eligibility.eligible) {
        if (eligibility.reason === 'POLICY_NOT_CONFIGURED') {
          const err: any = new Error('FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED: Policy effective timestamp is not configured');
          err.code = 'FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED';
          err.reason = 'POLICY_NOT_CONFIGURED';
          throw err;
        }
        const err: any = new Error(
          `FREE_BOOTSTRAP_NOT_ELIGIBLE: User ${userId} is not eligible for initial free credits (${eligibility.reason})`
        );
        err.code = 'FREE_BOOTSTRAP_NOT_ELIGIBLE';
        err.reason = eligibility.reason;
        throw err;
      }
    }

    const version = await billingService.getPricingVersion(pricingVersionCode);
    if (!version?.id) {
      throw new Error(`FREE_BOOTSTRAP_ERROR: Pricing version '${pricingVersionCode}' not found`);
    }

    const creditsGranted = await billingService.getCanonicalCreditGrant('FREE', version.id);
    const originalUnits = creditsToUnits(creditsGranted);

    const { data: prod } = await client
      .from('billing_products')
      .select('id')
      .eq('code', 'FREE')
      .maybeSingle();

    const idempotencyKey = `free-bootstrap:v1:${userId}`;

    try {
      return await this.grantCredits({
        userId,
        sourceType: 'FREE_BOOTSTRAP',
        originalUnits,
        idempotencyKey,
        expiresAt: null,
        productId: prod?.id || null,
        pricingVersionId: version.id,
        billingCycleStart: null,
        billingCycleEnd: null,
        referenceType: 'USER_ONBOARDING',
        referenceId: userId,
        description: `New user initial FREE credit grant (${creditsGranted} credits)`,
        metadata: {
          policy: 'free-bootstrap-v1',
          reason: 'new_user_signup',
          credits: creditsGranted,
          credit_units: originalUnits,
        },
      });
    } catch (err: any) {
      // Concurrency / Duplicate handling: if DB one-time partial unique index catches a race
      if (
        err.message &&
        (err.message.includes('DUPLICATE_FREE_BOOTSTRAP') ||
          err.message.includes('uq_credit_grants_one_time_free_bootstrap'))
      ) {
        const { data: existingGrant } = await client
          .from('credit_grants')
          .select('id, account_id, user_id, original_units, remaining_units')
          .eq('user_id', userId)
          .eq('source_type', 'FREE_BOOTSTRAP')
          .maybeSingle();

        if (existingGrant) {
          const balance = await this.getUserBalance(userId);
          return {
            grantId: existingGrant.id,
            accountId: existingGrant.account_id,
            userId: existingGrant.user_id,
            originalUnits: safeParseCreditUnits(existingGrant.original_units, 'original_units'),
            remainingUnits: safeParseCreditUnits(existingGrant.remaining_units, 'remaining_units'),
            totalAvailableUnits: balance.availableUnits,
            alreadyProcessed: true,
          };
        }
      }
      // Re-throw if error is genuine (e.g. account FROZEN/CLOSED or DB failure)
      throw err;
    }
  }

  /**
   * Phase 3A.4: Retry-safe ensure pattern for new user free bootstrap credits
   */
  async ensureFreeBootstrapCredits(
    userId: string,
    options?: { pricingVersionCode?: string; enforceEligibility?: boolean } | string
  ) {
    return this.bootstrapNewUserFreeCredits(userId, options);
  }

  /**
   * CR-16: Admin Adjustment Foundation
   * Positive adjustment creates ADMIN_ADJUSTMENT grant + ledger entry.
   * Negative adjustment requiring grant allocation is handled via capture/release in Phase 2B.
   */
  async adjustUserCredits(params: AdminCreditAdjustmentParams) {
    if (params.deltaUnits === 0) {
      throw new Error('INVALID_ADJUSTMENT: deltaUnits cannot be zero');
    }

    if (params.deltaUnits < 0) {
      throw new Error(
        'NEGATIVE_ADJUSTMENT_DEFERRED: Negative adjustments requiring grant allocation are processed via operational reservation/capture primitives.'
      );
    }

    return this.grantCredits({
      userId: params.userId,
      sourceType: 'ADMIN_ADJUSTMENT',
      originalUnits: params.deltaUnits,
      idempotencyKey: params.idempotencyKey,
      expiresAt: null, // Admin positive adjustments do not expire by default
      referenceType: 'ADMIN_ADJUSTMENT',
      referenceId: params.actorId,
      description: `Admin adjustment by ${params.actorId}: ${params.reason}`,
      metadata: {
        actorId: params.actorId,
        reason: params.reason,
        ...params.metadata,
      },
    });
  }

  /**
   * Phase 2B: Atomic Credit Reservation
   * Locks eligible grant buckets in deterministic order and increments reserved_units.
   * Fails atomically with INSUFFICIENT_CREDIT if available units < requested.
   */
  async reserveCredits(params: ReserveCreditUnitsParams): Promise<{
    reservationId: string;
    accountId: string;
    userId: string;
    requestedUnits: number;
    reservedUnits: number;
    totalAvailableUnits: number;
    status: string;
    allocations: Array<{
      allocation_id: string;
      grant_id: string;
      allocation_order: number;
      reserved_units: number;
      captured_units: number;
      released_units: number;
    }>;
    alreadyProcessed: boolean;
  }> {
    const client = this.getAdminClient();

    if (!params.userId) throw new Error('INVALID_ARGUMENT: userId is required');
    if (!params.idempotencyKey) throw new Error('INVALID_ARGUMENT: idempotencyKey is required');
    if (!params.requestedUnits || !Number.isInteger(params.requestedUnits) || params.requestedUnits <= 0) {
      throw new Error('INVALID_ARGUMENT: requestedUnits must be positive integer');
    }
    if (params.requestedUnits > Number.MAX_SAFE_INTEGER) {
      throw new Error(`INTEGER_OVERFLOW_ERROR: requestedUnits (${params.requestedUnits}) exceeds Number.MAX_SAFE_INTEGER`);
    }

    const { data, error } = await client.rpc('reserve_credit_units', {
      p_user_id: params.userId,
      p_requested_units: params.requestedUnits,
      p_idempotency_key: params.idempotencyKey,
      p_reference_type: params.referenceType || null,
      p_reference_id: params.referenceId || null,
      p_reservation_expires_at: params.reservationExpiresAt || null,
      p_metadata: params.metadata || {},
    });

    if (error) {
      throw new Error(`RESERVE_CREDITS_FAILED: ${error.message}`);
    }

    return {
      reservationId: data.reservation_id,
      accountId: data.account_id,
      userId: data.user_id,
      requestedUnits: safeParseCreditUnits(data.requested_units, 'requested_units'),
      reservedUnits: safeParseCreditUnits(data.reserved_units, 'reserved_units'),
      totalAvailableUnits: safeParseCreditUnits(data.total_available_units, 'total_available_units'),
      status: data.status,
      allocations: data.allocations || [],
      alreadyProcessed: Boolean(data.already_processed),
    };
  }

  /**
   * Phase 2B: Atomic Credit Capture
   * Permanently consumes credit by decrementing remaining_units and reserved_units.
   * Creates immutable CAPTURE ledger entries and operational audit events.
   */
  async captureReservation(params: CaptureCreditReservationParams): Promise<{
    reservationId: string;
    accountId: string;
    userId: string;
    capturedUnits: number;
    totalCapturedUnits: number;
    outstandingUnits: number;
    status: string;
    alreadyProcessed: boolean;
  }> {
    const client = this.getAdminClient();

    if (!params.userId) throw new Error('INVALID_ARGUMENT: userId is required');
    if (!params.reservationId) throw new Error('INVALID_ARGUMENT: reservationId is required');
    if (!params.idempotencyKey) throw new Error('INVALID_ARGUMENT: idempotencyKey is required');
    if (!params.captureUnits || !Number.isInteger(params.captureUnits) || params.captureUnits <= 0) {
      throw new Error('INVALID_ARGUMENT: captureUnits must be positive integer');
    }
    if (params.captureUnits > Number.MAX_SAFE_INTEGER) {
      throw new Error(`INTEGER_OVERFLOW_ERROR: captureUnits (${params.captureUnits}) exceeds Number.MAX_SAFE_INTEGER`);
    }

    const { data, error } = await client.rpc('capture_credit_reservation', {
      p_user_id: params.userId,
      p_reservation_id: params.reservationId,
      p_capture_units: params.captureUnits,
      p_idempotency_key: params.idempotencyKey,
      p_metadata: params.metadata || {},
    });

    if (error) {
      throw new Error(`CAPTURE_RESERVATION_FAILED: ${error.message}`);
    }

    return {
      reservationId: data.reservation_id,
      accountId: data.account_id,
      userId: data.user_id,
      capturedUnits: safeParseCreditUnits(data.captured_units, 'captured_units'),
      totalCapturedUnits: safeParseCreditUnits(data.total_captured_units, 'total_captured_units'),
      outstandingUnits: safeParseCreditUnits(data.outstanding_units, 'outstanding_units'),
      status: data.status,
      alreadyProcessed: Boolean(data.already_processed),
    };
  }

  /**
   * Phase 2B: Atomic Credit Release
   * Decrements reserved_units on credit_grants and allocations without modifying remaining_units.
   * Writes NO financial ledger delta; logs operational RELEASE event.
   */
  async releaseReservation(params: ReleaseCreditReservationParams): Promise<{
    reservationId: string;
    accountId: string;
    userId: string;
    releasedUnits: number;
    totalReleasedUnits: number;
    outstandingUnits: number;
    status: string;
    alreadyProcessed: boolean;
  }> {
    const client = this.getAdminClient();

    if (!params.userId) throw new Error('INVALID_ARGUMENT: userId is required');
    if (!params.reservationId) throw new Error('INVALID_ARGUMENT: reservationId is required');
    if (!params.idempotencyKey) throw new Error('INVALID_ARGUMENT: idempotencyKey is required');
    if (!params.releaseUnits || !Number.isInteger(params.releaseUnits) || params.releaseUnits <= 0) {
      throw new Error('INVALID_ARGUMENT: releaseUnits must be positive integer');
    }
    if (params.releaseUnits > Number.MAX_SAFE_INTEGER) {
      throw new Error(`INTEGER_OVERFLOW_ERROR: releaseUnits (${params.releaseUnits}) exceeds Number.MAX_SAFE_INTEGER`);
    }

    const { data, error } = await client.rpc('release_credit_reservation', {
      p_user_id: params.userId,
      p_reservation_id: params.reservationId,
      p_release_units: params.releaseUnits,
      p_idempotency_key: params.idempotencyKey,
      p_metadata: params.metadata || {},
    });

    if (error) {
      throw new Error(`RELEASE_RESERVATION_FAILED: ${error.message}`);
    }

    return {
      reservationId: data.reservation_id,
      accountId: data.account_id,
      userId: data.user_id,
      releasedUnits: safeParseCreditUnits(data.released_units, 'released_units'),
      totalReleasedUnits: safeParseCreditUnits(data.total_released_units, 'total_released_units'),
      outstandingUnits: safeParseCreditUnits(data.outstanding_units, 'outstanding_units'),
      status: data.status,
      alreadyProcessed: Boolean(data.already_processed),
    };
  }

  /**
   * Phase 2B: Query Single Reservation by ID
   */
  async getReservation(
    reservationId: string,
    userId: string,
    userClient?: SupabaseClient | null
  ): Promise<CreditReservationDto> {
    const client = userClient || this.getAdminClient();

    const { data: res, error: rErr } = await client
      .from('credit_reservations')
      .select('*')
      .eq('id', reservationId)
      .eq('user_id', userId)
      .maybeSingle();

    if (rErr) throw new Error(`GET_RESERVATION_FAILED: ${rErr.message}`);
    if (!res) throw new Error(`RESERVATION_NOT_FOUND: Reservation '${reservationId}' not found`);

    const { data: allocs, error: aErr } = await client
      .from('credit_reservation_allocations')
      .select('*')
      .eq('reservation_id', reservationId)
      .order('allocation_order', { ascending: true });

    if (aErr) throw new Error(`GET_ALLOCATIONS_FAILED: ${aErr.message}`);

    const req = safeParseCreditUnits(res.requested_units, 'requested_units');
    const reserved = safeParseCreditUnits(res.reserved_units, 'reserved_units');
    const captured = safeParseCreditUnits(res.captured_units, 'captured_units');
    const released = safeParseCreditUnits(res.released_units, 'released_units');
    const outstanding = reserved - captured - released;

    return {
      id: res.id,
      accountId: res.account_id,
      userId: res.user_id,
      requestedUnits: req,
      reservedUnits: reserved,
      capturedUnits: captured,
      releasedUnits: released,
      outstandingUnits: outstanding,
      status: res.status,
      idempotencyKey: res.idempotency_key,
      referenceType: res.reference_type,
      referenceId: res.reference_id,
      reservationExpiresAt: res.reservation_expires_at,
      createdAt: res.created_at,
      updatedAt: res.updated_at,
      settledAt: res.settled_at,
      allocations: (allocs || []).map((a: CreditReservationAllocationRecord) => ({
        allocationId: a.id,
        grantId: a.grant_id,
        allocationOrder: a.allocation_order,
        reservedUnits: safeParseCreditUnits(a.reserved_units, 'reserved_units'),
        capturedUnits: safeParseCreditUnits(a.captured_units, 'captured_units'),
        releasedUnits: safeParseCreditUnits(a.released_units, 'released_units'),
      })),
    };
  }

  /**
   * Phase 2B: List Reservations for User (Paginated)
   */
  async listUserReservations(
    userId: string,
    options?: { page?: number; pageSize?: number; status?: string },
    userClient?: SupabaseClient | null
  ): Promise<{ items: CreditReservationDto[]; page: number; pageSize: number; total: number }> {
    const client = userClient || this.getAdminClient();

    const safePage = Math.max(1, options?.page || 1);
    const safePageSize = Math.min(100, Math.max(1, options?.pageSize || 20));
    const offset = (safePage - 1) * safePageSize;

    let query = client
      .from('credit_reservations')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + safePageSize - 1);

    if (options?.status) {
      query = query.eq('status', options.status);
    }

    const { data: items, count, error } = await query;
    if (error) throw new Error(`LIST_RESERVATIONS_FAILED: ${error.message}`);

    return {
      items: (items || []).map((res: CreditReservationRecord) => {
        const req = safeParseCreditUnits(res.requested_units, 'requested_units');
        const reserved = safeParseCreditUnits(res.reserved_units, 'reserved_units');
        const captured = safeParseCreditUnits(res.captured_units, 'captured_units');
        const released = safeParseCreditUnits(res.released_units, 'released_units');
        const outstanding = reserved - captured - released;
        return {
          id: res.id,
          accountId: res.account_id,
          userId: res.user_id,
          requestedUnits: req,
          reservedUnits: reserved,
          capturedUnits: captured,
          releasedUnits: released,
          outstandingUnits: outstanding,
          status: res.status,
          idempotencyKey: res.idempotency_key,
          referenceType: res.reference_type,
          referenceId: res.reference_id,
          reservationExpiresAt: res.reservation_expires_at,
          createdAt: res.created_at,
          updatedAt: res.updated_at,
          settledAt: res.settled_at,
        };
      }),
      page: safePage,
      pageSize: safePageSize,
      total: count || 0,
    };
  }

  /**
   * CR-14 / CR-16 / Phase 2B: Read User Credit Balance
   * Explicitly distinguishes:
   *   - grossRemainingUnits: total remaining in unexpired active grants
   *   - reservedUnits: total actively held for in-flight operations
   *   - totalAvailableUnits: grossRemainingUnits - reservedUnits
   * Net buckets reflect remaining - reserved.
   */
  async getUserBalance(userId: string, userClient?: SupabaseClient | null): Promise<UserCreditBalanceDto> {
    const client = userClient || this.getAdminClient();

    // 1. Get account
    const { data: account, error: accErr } = await client
      .from('credit_accounts')
      .select('id, status')
      .eq('user_id', userId)
      .maybeSingle();

    if (accErr) {
      throw new Error(`GET_BALANCE_FAILED: ${accErr.message}`);
    }

    if (!account) {
      return {
        grossRemainingUnits: 0,
        reservedUnits: 0,
        totalAvailableUnits: 0,
        totalAvailableCredits: 0,
        buckets: {
          subscriptionUnits: 0,
          purchasedUnits: 0,
          otherUnits: 0,
        },
        status: 'NONE',
        userId,
        accountId: null,
      };
    }

    // 2. Query active grants
    const nowIso = new Date().toISOString();
    const { data: grants, error: gErr } = await client
      .from('credit_grants')
      .select('remaining_units, reserved_units, source_type, expires_at')
      .eq('account_id', account.id)
      .eq('status', 'ACTIVE');

    if (gErr) {
      throw new Error(`GET_BALANCE_GRANTS_FAILED: ${gErr.message}`);
    }

    let grossRemainingUnits = 0;
    let reservedUnits = 0;
    let subscriptionUnits = 0;
    let purchasedUnits = 0;
    let otherUnits = 0;

    (grants || []).forEach((g: any) => {
      // Expiration check: if expires_at is set and past, it is not available for new reservations
      if (g.expires_at && g.expires_at <= nowIso) {
        return;
      }
      const rem = safeParseCreditUnits(g.remaining_units, 'remaining_units');
      const res = safeParseCreditUnits(g.reserved_units ?? 0, 'reserved_units');
      const avail = Math.max(0, rem - res);

      grossRemainingUnits += rem;
      reservedUnits += res;

      if (g.source_type === 'SUBSCRIPTION_CYCLE' || g.source_type === 'FREE_BOOTSTRAP') {
        subscriptionUnits += avail;
      } else if (g.source_type === 'CREDIT_PACK_PURCHASE') {
        purchasedUnits += avail;
      } else {
        otherUnits += avail;
      }
    });

    const totalAvailableUnits = Math.max(0, grossRemainingUnits - reservedUnits);

    return {
      grossRemainingUnits,
      reservedUnits,
      totalAvailableUnits,
      totalAvailableCredits: unitsToCredits(totalAvailableUnits),
      buckets: {
        subscriptionUnits,
        purchasedUnits,
        otherUnits,
      },
      status: account.status,
      userId,
      accountId: account.id,
    };
  }

  /**
   * Read Grants for authenticated user with Phase 2B reservation fields
   */
  async getUserGrants(userId: string, userClient?: SupabaseClient | null): Promise<CreditGrantDto[]> {
    const client = userClient || this.getAdminClient();

    const { data: grants, error } = await client
      .from('credit_grants')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`GET_GRANTS_FAILED: ${error.message}`);
    }

    return (grants || []).map((g: CreditGrantRecord) => {
      const orig = safeParseCreditUnits(g.original_units, 'original_units');
      const rem = safeParseCreditUnits(g.remaining_units, 'remaining_units');
      const res = safeParseCreditUnits(g.reserved_units ?? 0, 'reserved_units');
      const avail = Math.max(0, rem - res);
      return {
        id: g.id,
        sourceType: g.source_type,
        originalUnits: orig,
        remainingUnits: rem,
        reservedUnits: res,
        availableUnits: avail,
        originalCredits: unitsToCredits(orig),
        remainingCredits: unitsToCredits(rem),
        reservedCredits: unitsToCredits(res),
        availableCredits: unitsToCredits(avail),
        grantedAt: g.granted_at,
        expiresAt: g.expires_at || null,
        status: g.status,
        billingCycleStart: g.billing_cycle_start,
        billingCycleEnd: g.billing_cycle_end,
      };
    });
  }

  /**
   * Read Paginated Ledger for authenticated user
   */
  async getUserLedger(
    userId: string,
    page = 1,
    pageSize = 20,
    userClient?: SupabaseClient | null
  ): Promise<CreditLedgerPageDto> {
    const client = userClient || this.getAdminClient();

    const safePage = Math.max(1, page);
    const safePageSize = Math.min(100, Math.max(1, pageSize));
    const offset = (safePage - 1) * safePageSize;

    const { data: items, count, error } = await client
      .from('credit_ledger')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + safePageSize - 1);

    if (error) {
      throw new Error(`GET_LEDGER_FAILED: ${error.message}`);
    }

    return {
      items: (items || []).map((it: CreditLedgerRecord) => {
        const delta = safeParseCreditUnits(it.delta_units, 'delta_units');
        const bal = it.balance_after_units != null ? safeParseCreditUnits(it.balance_after_units, 'balance_after_units') : null;
        return {
          id: it.id,
          entryType: it.entry_type,
          deltaUnits: delta,
          deltaCredits: unitsToCredits(delta),
          balanceAfterUnits: bal,
          balanceAfterCredits: bal != null ? unitsToCredits(bal) : null,
          description: it.description,
          referenceType: it.reference_type,
          createdAt: it.created_at,
        };
      }),
      page: safePage,
      pageSize: safePageSize,
      total: count || 0,
    };
  }
}

export const creditService = new CreditService();
