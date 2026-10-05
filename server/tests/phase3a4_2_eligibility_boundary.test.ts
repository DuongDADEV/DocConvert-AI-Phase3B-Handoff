import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CreditService,
  validatePolicyTimestamp,
  getFreeBootstrapPolicyEffectiveAt,
  setTestPolicyEffectiveAtOverride,
} from '../services/credit/creditService.js';
import {
  CANONICAL_PROCESSING_PRICING_VERSION,
  CANONICAL_APPROVED_PRODUCTION_POLICY_V1,
  PRODUCTION_PROCESSING_RATES,
} from '../types/processingPricing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0;
let failed = 0;

async function runTest(id: string, name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result && typeof (result as any).then === 'function') {
      await result;
    }
    console.log(`[PASS] ${id}: ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`[FAIL] ${id}: ${name} ->`, err.message || err);
    failed++;
  }
}

function createMockClientWithAuth(options: {
  authUser?: { id: string; created_at: string } | null;
  profile?: { id: string; created_at: string } | null;
  existingGrant?: any;
  account?: any;
  product?: any;
}) {
  return {
    auth: {
      admin: {
        getUserById: async (userId: string) => {
          if (options.authUser === null) {
            return { data: { user: null }, error: new Error('User not found') };
          }
          if (options.authUser) {
            return { data: { user: options.authUser }, error: null };
          }
          return { data: { user: { id: userId, created_at: '2026-10-04T00:00:00.000Z' } }, error: null };
        },
      },
    },
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === 'profiles') {
            return { data: options.profile !== undefined ? options.profile : { id: 'test-user', created_at: '2026-10-04T00:00:00.000Z' } };
          }
          if (table === 'credit_grants') {
            return { data: options.existingGrant || null };
          }
          if (table === 'credit_accounts') {
            return { data: options.account || null };
          }
          if (table === 'billing_products') {
            return { data: options.product || { id: 'prod-free-uuid' } };
          }
          return { data: null };
        },
      };
      return builder;
    },
  };
}

async function runSuite() {
  console.log('================================================================');
  console.log('PHASE 3A.4.2 — ELIGIBILITY BOUNDARY FINAL HARDENING TEST SUITE');
  console.log('================================================================\n');

  const policyTimestamp = '2026-10-03T01:00:00.000Z';
  const newUserId = 'bbbbbbbb-1111-2222-3333-444444444444';
  const historicalUserId = 'aaaaaaaa-1111-2222-3333-444444444444';

  // Ensure clean test baseline
  setTestPolicyEffectiveAtOverride(policyTimestamp);

  // ---------------------------------------------------------------------------
  // BOUND-01: policy effective time is explicit server-side config
  // ---------------------------------------------------------------------------
  await runTest('BOUND-01', 'policy effective time is explicit server-side config', () => {
    // Valid ISO-8601 with explicit timezone
    const validTzZ = validatePolicyTimestamp('2026-10-04T00:00:00.000Z');
    assert.strictEqual(validTzZ.valid, true);
    assert.ok(validTzZ.date instanceof Date);

    const validTzOffset = validatePolicyTimestamp('2026-10-04T07:00:00+07:00');
    assert.strictEqual(validTzOffset.valid, true);
    assert.ok(validTzOffset.date instanceof Date);

    // Empty or undefined fails closed
    const emptyRes = validatePolicyTimestamp('');
    assert.strictEqual(emptyRes.valid, false);
    assert.strictEqual(emptyRes.error, 'POLICY_NOT_CONFIGURED');
  });

  // ---------------------------------------------------------------------------
  // BOUND-02: production missing policy time fails closed
  // ---------------------------------------------------------------------------
  await runTest('BOUND-02', 'production missing policy time fails closed', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalPolicy = process.env.FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT;
      setTestPolicyEffectiveAtOverride(null);

      const effective = getFreeBootstrapPolicyEffectiveAt();
      assert.strictEqual(effective, null, 'Must return null when policy is not configured in production');

      const testService = new CreditService();
      (testService as any).getAdminClient = () => createMockClientWithAuth({});

      const eligibility = await testService.checkFreeBootstrapEligibility(newUserId);
      assert.strictEqual(eligibility.eligible, false);
      assert.strictEqual(eligibility.reason, 'POLICY_NOT_CONFIGURED');
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalPolicy) process.env.FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT = originalPolicy;
      setTestPolicyEffectiveAtOverride(policyTimestamp);
    }
  });

  // ---------------------------------------------------------------------------
  // BOUND-03: invalid policy timestamp fails closed
  // ---------------------------------------------------------------------------
  await runTest('BOUND-03', 'invalid policy timestamp fails closed', async () => {
    // Missing timezone
    const missingTz = validatePolicyTimestamp('2026-10-04T00:00:00');
    assert.strictEqual(missingTz.valid, false);
    assert.strictEqual(missingTz.error, 'INVALID_POLICY_TIMESTAMP_FORMAT');

    // Date-only without time or timezone
    const dateOnly = validatePolicyTimestamp('2026-10-04');
    assert.strictEqual(dateOnly.valid, false);
    assert.strictEqual(dateOnly.error, 'INVALID_POLICY_TIMESTAMP_FORMAT');

    // Garbage text
    const garbage = validatePolicyTimestamp('not-a-timestamp');
    assert.strictEqual(garbage.valid, false);
    assert.strictEqual(garbage.error, 'INVALID_POLICY_TIMESTAMP_FORMAT');

    // Injected invalid override fails closed in service
    setTestPolicyEffectiveAtOverride('invalid-date');
    const testService = new CreditService();
    (testService as any).getAdminClient = () => createMockClientWithAuth({});

    const eligibility = await testService.checkFreeBootstrapEligibility(newUserId);
    assert.strictEqual(eligibility.eligible, false);
    assert.strictEqual(eligibility.reason, 'POLICY_NOT_CONFIGURED');

    setTestPolicyEffectiveAtOverride(policyTimestamp);
  });

  // ---------------------------------------------------------------------------
  // BOUND-04: frontend cannot override policy timestamp
  // ---------------------------------------------------------------------------
  await runTest('BOUND-04', 'frontend cannot override policy timestamp', () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    const bootstrapRoute = creditsRouteSrc.slice(creditsRouteSrc.indexOf("router.post('/bootstrap'"));
    assert.strictEqual(bootstrapRoute.includes('req.body.policyEffectiveAt'), false);
    assert.strictEqual(bootstrapRoute.includes('req.body.created_at'), false);
    assert.strictEqual(bootstrapRoute.includes('req.body.effectiveAt'), false);
  });

  // ---------------------------------------------------------------------------
  // BOUND-05: auth.users.created_at before policy => historical
  // ---------------------------------------------------------------------------
  await runTest('BOUND-05', 'auth.users.created_at before policy => historical', async () => {
    const testService = new CreditService();
    (testService as any).getAdminClient = () =>
      createMockClientWithAuth({
        authUser: { id: historicalUserId, created_at: '2026-09-01T00:00:00.000Z' },
        profile: { id: historicalUserId, created_at: '2026-09-01T00:00:00.000Z' },
      });

    const eligibility = await testService.checkFreeBootstrapEligibility(historicalUserId);
    assert.strictEqual(eligibility.eligible, false);
    assert.strictEqual(eligibility.reason, 'HISTORICAL_USER');
  });

  // ---------------------------------------------------------------------------
  // BOUND-06: auth.users.created_at after policy => eligible
  // ---------------------------------------------------------------------------
  await runTest('BOUND-06', 'auth.users.created_at after policy => eligible', async () => {
    const testService = new CreditService();
    (testService as any).getAdminClient = () =>
      createMockClientWithAuth({
        authUser: { id: newUserId, created_at: '2026-10-04T12:00:00.000Z' },
        profile: { id: newUserId, created_at: '2026-10-04T12:00:00.000Z' },
      });

    const eligibility = await testService.checkFreeBootstrapEligibility(newUserId);
    assert.strictEqual(eligibility.eligible, true);
    assert.strictEqual(eligibility.reason, 'ELIGIBLE');
  });

  // ---------------------------------------------------------------------------
  // BOUND-07: historical auth user + newly created profile remains NOT eligible
  // ---------------------------------------------------------------------------
  await runTest('BOUND-07', 'historical auth user + newly created profile remains NOT eligible', async () => {
    const testService = new CreditService();
    // CRITICAL SCENARIO:
    // auth.users.created_at is in September 2026 (prior to policy activation)
    // profiles.created_at is today 2026-10-04 (e.g. created on login)
    (testService as any).getAdminClient = () =>
      createMockClientWithAuth({
        authUser: { id: historicalUserId, created_at: '2026-09-15T08:30:00.000Z' },
        profile: { id: historicalUserId, created_at: '2026-10-04T12:00:00.000Z' },
      });

    const eligibility = await testService.checkFreeBootstrapEligibility(historicalUserId);
    assert.strictEqual(eligibility.eligible, false, 'Historical auth account must remain NOT eligible');
    assert.strictEqual(eligibility.reason, 'HISTORICAL_USER');
  });

  // ---------------------------------------------------------------------------
  // BOUND-08: profile.created_at cannot override older auth.users.created_at
  // ---------------------------------------------------------------------------
  await runTest('BOUND-08', 'profile.created_at cannot override older auth.users.created_at', async () => {
    const testService = new CreditService();
    (testService as any).getAdminClient = () =>
      createMockClientWithAuth({
        authUser: { id: historicalUserId, created_at: '2025-12-31T23:59:59.000Z' },
        profile: { id: historicalUserId, created_at: '2026-10-04T00:00:00.000Z' },
      });

    const eligibility = await testService.checkFreeBootstrapEligibility(historicalUserId);
    assert.strictEqual(eligibility.eligible, false);
    assert.strictEqual(eligibility.reason, 'HISTORICAL_USER');
    assert.strictEqual(eligibility.authUserCreatedAt, '2025-12-31T23:59:59.000Z');
  });

  // ---------------------------------------------------------------------------
  // BOUND-09: eligible new user still receives 10000 units
  // ---------------------------------------------------------------------------
  await runTest('BOUND-09', 'eligible new user still receives 10000 units', async () => {
    let capturedParams: any = null;
    const testService = new CreditService();

    (testService as any).getAdminClient = () =>
      createMockClientWithAuth({
        authUser: { id: newUserId, created_at: '2026-10-04T00:00:00.000Z' },
        profile: { id: newUserId, created_at: '2026-10-04T00:00:00.000Z' },
      });

    (testService as any).grantCredits = async (params: any) => {
      capturedParams = params;
      return {
        grantId: 'grant-bound-09',
        accountId: 'acc-bound-09',
        userId: params.userId,
        originalUnits: 10000,
        remainingUnits: 10000,
        totalAvailableUnits: 10000,
        alreadyProcessed: false,
      };
    };

    const result = await testService.bootstrapNewUserFreeCredits(newUserId, { enforceEligibility: true });
    assert.ok(capturedParams, 'grantCredits must be called');
    assert.strictEqual(capturedParams.originalUnits, 10000);
    assert.strictEqual(result.alreadyProcessed, false);
    assert.strictEqual(result.totalAvailableUnits, 10000);
  });

  // ---------------------------------------------------------------------------
  // BOUND-10: already-granted eligible user remains idempotent success
  // ---------------------------------------------------------------------------
  await runTest('BOUND-10', 'already-granted eligible user remains idempotent success', async () => {
    const testService = new CreditService();

    (testService as any).getAdminClient = () =>
      createMockClientWithAuth({
        authUser: { id: newUserId, created_at: '2026-10-04T00:00:00.000Z' },
        profile: { id: newUserId, created_at: '2026-10-04T00:00:00.000Z' },
        existingGrant: {
          id: 'existing-free-grant-id',
          account_id: 'existing-acc-id',
          user_id: newUserId,
          original_units: 10000,
          remaining_units: 10000,
        },
      });

    (testService as any).getUserBalance = async () => ({
      availableUnits: 10000,
      grossRemainingUnits: 10000,
      reservedUnits: 0,
    });

    const eligibility = await testService.checkFreeBootstrapEligibility(newUserId);
    assert.strictEqual(eligibility.alreadyGranted, true);

    const result = await testService.bootstrapNewUserFreeCredits(newUserId, { enforceEligibility: true });
    assert.strictEqual(result.alreadyProcessed, true);
    assert.strictEqual(result.grantId, 'existing-free-grant-id');
  });

  // ---------------------------------------------------------------------------
  // BOUND-11: historical user cannot use recovery endpoint
  // ---------------------------------------------------------------------------
  await runTest('BOUND-11', 'historical user cannot use recovery endpoint', () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    assert.ok(
      creditsRouteSrc.includes('checkFreeBootstrapEligibility(userId)'),
      'Must guard endpoint with checkFreeBootstrapEligibility'
    );
    assert.ok(
      creditsRouteSrc.includes("code: 'FREE_BOOTSTRAP_NOT_ELIGIBLE'"),
      'Must reject ineligible with FREE_BOOTSTRAP_NOT_ELIGIBLE'
    );
    assert.ok(
      creditsRouteSrc.includes("code: 'FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED'"),
      'Must handle POLICY_NOT_CONFIGURED with 503'
    );
  });

  // ---------------------------------------------------------------------------
  // BOUND-12: register Branch 1 remains eligible
  // ---------------------------------------------------------------------------
  await runTest('BOUND-12', 'register Branch 1 remains eligible', () => {
    const authRoutePath = path.resolve(__dirname, '../routes/auth.ts');
    const authRouteSrc = fs.readFileSync(authRoutePath, 'utf-8');

    assert.ok(
      authRouteSrc.includes('adminSupabase.auth.admin.createUser'),
      'Branch 1 must call admin.createUser'
    );
    assert.ok(
      authRouteSrc.includes('creditService.bootstrapNewUserFreeCredits(user.id, { enforceEligibility: true })'),
      'Branch 1 must call bootstrapNewUserFreeCredits with enforceEligibility: true'
    );
  });

  // ---------------------------------------------------------------------------
  // BOUND-13: register Branch 2 remains eligible
  // ---------------------------------------------------------------------------
  await runTest('BOUND-13', 'register Branch 2 remains eligible', () => {
    const authRoutePath = path.resolve(__dirname, '../routes/auth.ts');
    const authRouteSrc = fs.readFileSync(authRoutePath, 'utf-8');

    assert.ok(
      authRouteSrc.includes('liveSupabase.auth.signUp'),
      'Branch 2 must call liveSupabase.auth.signUp'
    );
    assert.ok(
      authRouteSrc.includes('creditService.bootstrapNewUserFreeCredits(authData.user.id, { enforceEligibility: true })'),
      'Branch 2 must call bootstrapNewUserFreeCredits with enforceEligibility: true'
    );
  });

  // ---------------------------------------------------------------------------
  // BOUND-14: Branch 3 remains DEV_ONLY and no credit bootstrap
  // ---------------------------------------------------------------------------
  await runTest('BOUND-14', 'Branch 3 remains DEV_ONLY and no credit bootstrap', () => {
    const authRoutePath = path.resolve(__dirname, '../routes/auth.ts');
    const authRouteSrc = fs.readFileSync(authRoutePath, 'utf-8');

    const branch3Start = authRouteSrc.indexOf('// 3. Unified Supabase Local Auth Engine fallback');
    const branch3End = authRouteSrc.indexOf('// 2. LOGIN USER');
    const branch3Src = authRouteSrc.slice(branch3Start, branch3End);

    assert.ok(branch3Src.includes('DEV-ONLY FALLBACK'), 'Branch 3 must be marked dev-only');
    assert.strictEqual(
      branch3Src.includes('bootstrapNewUserFreeCredits'),
      false,
      'Branch 3 must NOT call bootstrapNewUserFreeCredits'
    );
  });

  // ---------------------------------------------------------------------------
  // BOUND-15: login does not auto-bootstrap
  // ---------------------------------------------------------------------------
  await runTest('BOUND-15', 'login does not auto-bootstrap', () => {
    const authRoutePath = path.resolve(__dirname, '../routes/auth.ts');
    const authRouteSrc = fs.readFileSync(authRoutePath, 'utf-8');

    const loginStart = authRouteSrc.indexOf("router.post('/login'");
    const loginEnd = authRouteSrc.indexOf("router.get('/me'");
    const loginSrc = authRouteSrc.slice(loginStart, loginEnd);

    assert.strictEqual(
      loginSrc.includes('bootstrapNewUserFreeCredits'),
      false,
      'Login route must NOT invoke bootstrapNewUserFreeCredits'
    );
    assert.strictEqual(
      loginSrc.includes('ensureFreeBootstrapCredits'),
      false,
      'Login route must NOT invoke ensureFreeBootstrapCredits'
    );
  });

  // ---------------------------------------------------------------------------
  // BOUND-16: processing pricing remains unchanged
  // ---------------------------------------------------------------------------
  await runTest('BOUND-16', 'processing pricing remains unchanged', () => {
    const policy = CANONICAL_APPROVED_PRODUCTION_POLICY_V1;
    assert.strictEqual(policy.processingPricingVersion, CANONICAL_PROCESSING_PRICING_VERSION);
    assert.strictEqual(policy.processingPricingVersion, 'processing-pricing-v1');
    assert.strictEqual(policy.unitScale, 1000);
    assert.strictEqual(policy.strategyRates.LOCAL_NATIVE, 350);
    assert.strictEqual(policy.strategyRates.AZURE_FULL_PAGE, 1980);
    assert.strictEqual(policy.strategyRates.HYBRID, 1980);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.LOCAL_NATIVE, 350);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.AZURE_FULL_PAGE, 1980);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.HYBRID, 1980);
  });

  console.log('\n================================================================');
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
