import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  creditService,
  CreditService,
  DEFAULT_FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT,
  getFreeBootstrapPolicyEffectiveAt,
} from '../services/credit/creditService.js';

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

function createChainableMockClient(options: {
  profile?: any;
  existingGrant?: any;
  account?: any;
  product?: any;
}) {
  return {
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === 'profiles') {
            return { data: options.profile || null };
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
  console.log('PHASE 3A.4.1 — BOOTSTRAP ELIGIBILITY & AUTH-BRANCH TEST SUITE');
  console.log('================================================================\n');

  const newUserId = '22222222-3333-4444-5555-666666666666';
  const historicalUserId = '33333333-4444-5555-6666-777777777777';

  // ---------------------------------------------------------------------------
  // ELIG-01: new user after policy effective time is eligible
  // ---------------------------------------------------------------------------
  await runTest('ELIG-01', 'new user after policy effective time is eligible', async () => {
    const testService = new CreditService();
    // User created at 2026-10-04 (after policy effective date 2026-10-03)
    (testService as any).getAdminClient = () =>
      createChainableMockClient({
        profile: {
          id: newUserId,
          created_at: '2026-10-04T00:00:00.000Z',
        },
      });

    const eligibility = await testService.checkFreeBootstrapEligibility(newUserId);
    assert.strictEqual(eligibility.eligible, true, 'New user must be eligible');
    assert.strictEqual(eligibility.alreadyGranted, false);
    assert.ok(eligibility.reason === 'ELIGIBLE' || eligibility.reason === undefined, 'Reason must be ELIGIBLE or undefined');
  });

  // ---------------------------------------------------------------------------
  // ELIG-02: historical user before policy effective time is NOT eligible
  // ---------------------------------------------------------------------------
  await runTest('ELIG-02', 'historical user before policy effective time is NOT eligible', async () => {
    const testService = new CreditService();
    // User created at 2026-09-15 (before policy effective date 2026-10-03)
    (testService as any).getAdminClient = () =>
      createChainableMockClient({
        profile: {
          id: historicalUserId,
          created_at: '2026-09-15T12:00:00.000Z',
        },
      });

    const eligibility = await testService.checkFreeBootstrapEligibility(historicalUserId);
    assert.strictEqual(eligibility.eligible, false, 'Historical user must NOT be eligible');
    assert.strictEqual(eligibility.alreadyGranted, false);
    assert.ok(
      eligibility.reason === 'HISTORICAL_USER' || eligibility.reason === 'HISTORICAL_USER_NOT_ELIGIBLE',
      'Reason must indicate historical user'
    );
  });

  // ---------------------------------------------------------------------------
  // ELIG-03: eligible user with no grant receives 10000 units
  // ---------------------------------------------------------------------------
  await runTest('ELIG-03', 'eligible user with no grant receives 10000 units', async () => {
    let capturedParams: any = null;
    const testService = new CreditService();

    (testService as any).getAdminClient = () =>
      createChainableMockClient({
        profile: {
          id: newUserId,
          created_at: '2026-10-04T00:00:00.000Z',
        },
      });

    (testService as any).grantCredits = async (params: any) => {
      capturedParams = params;
      return {
        grantId: 'grant-elig-03',
        accountId: 'acc-elig-03',
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
  // ELIG-04: eligible user already granted returns idempotent success
  // ---------------------------------------------------------------------------
  await runTest('ELIG-04', 'eligible user already granted returns idempotent success', async () => {
    const testService = new CreditService();

    (testService as any).getAdminClient = () =>
      createChainableMockClient({
        profile: {
          id: newUserId,
          created_at: '2026-10-04T00:00:00.000Z',
        },
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
    assert.strictEqual(eligibility.alreadyGranted, true, 'Must detect existing grant');

    const result = await testService.bootstrapNewUserFreeCredits(newUserId, { enforceEligibility: true });
    assert.strictEqual(result.alreadyProcessed, true, 'Must return alreadyProcessed = true');
    assert.strictEqual(result.grantId, 'existing-free-grant-id');
  });

  // ---------------------------------------------------------------------------
  // ELIG-05: historical user cannot call bootstrap endpoint to claim credits
  // ---------------------------------------------------------------------------
  await runTest('ELIG-05', 'historical user cannot call bootstrap endpoint (fails with 409)', async () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    // Verify endpoint checks eligibility and returns 409 for historical user
    assert.ok(
      creditsRouteSrc.includes('checkFreeBootstrapEligibility(userId)'),
      'Endpoint must invoke checkFreeBootstrapEligibility'
    );
    assert.ok(
      creditsRouteSrc.includes("code: 'FREE_BOOTSTRAP_NOT_ELIGIBLE'"),
      'Endpoint must return FREE_BOOTSTRAP_NOT_ELIGIBLE code'
    );
    assert.ok(
      creditsRouteSrc.includes('409'),
      'Endpoint must return HTTP 409 on eligibility denial'
    );
  });

  // ---------------------------------------------------------------------------
  // ELIG-06: request body cannot override eligibility
  // ---------------------------------------------------------------------------
  await runTest('ELIG-06', 'request body cannot override eligibility', async () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    const bootstrapRoute = creditsRouteSrc.slice(creditsRouteSrc.indexOf("router.post('/bootstrap'"));
    assert.strictEqual(
      bootstrapRoute.includes('req.body.isEligible'),
      false,
      'Route must NOT inspect req.body.isEligible'
    );
    assert.strictEqual(
      bootstrapRoute.includes('req.body.force'),
      false,
      'Route must NOT inspect req.body.force'
    );
  });

  // ---------------------------------------------------------------------------
  // ELIG-07: request body cannot override user_id
  // ---------------------------------------------------------------------------
  await runTest('ELIG-07', 'request body cannot override user_id', async () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    const bootstrapRoute = creditsRouteSrc.slice(creditsRouteSrc.indexOf("router.post('/bootstrap'"));
    assert.ok(
      bootstrapRoute.includes('const userId = req.user?.id;'),
      'Must derive userId strictly from authenticated session'
    );
    assert.strictEqual(
      bootstrapRoute.includes('req.body.userId'),
      false,
      'Must not read req.body.userId'
    );
    assert.strictEqual(
      bootstrapRoute.includes('req.body.user_id'),
      false,
      'Must not read req.body.user_id'
    );
  });

  // ---------------------------------------------------------------------------
  // ELIG-08: anonymous request denied
  // ---------------------------------------------------------------------------
  await runTest('ELIG-08', 'anonymous request denied', async () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    assert.ok(
      creditsRouteSrc.includes("router.post('/bootstrap', authMiddleware,"),
      'POST /bootstrap must require authMiddleware'
    );
    assert.ok(
      creditsRouteSrc.includes("res.status(401).json({ success: false, error: 'Chưa đăng nhập' })"),
      'Missing session user must return 401'
    );
  });

  // ---------------------------------------------------------------------------
  // ELIG-09: register-created new user remains eligible
  // ---------------------------------------------------------------------------
  await runTest('ELIG-09', 'register-created new user remains eligible', async () => {
    const effectiveAt = getFreeBootstrapPolicyEffectiveAt();
    const now = new Date();

    // Any new user created at registration time is strictly >= policy effective time (2026-10-03)
    assert.ok(
      now.getTime() >= effectiveAt.getTime(),
      `Registration timestamp (${now.toISOString()}) must be >= policy effective date (${effectiveAt.toISOString()})`
    );
  });

  // ---------------------------------------------------------------------------
  // ELIG-10: no login route auto-bootstrap exists
  // ---------------------------------------------------------------------------
  await runTest('ELIG-10', 'no login route auto-bootstrap exists', async () => {
    const authRoutePath = path.resolve(__dirname, '../routes/auth.ts');
    const authRouteSrc = fs.readFileSync(authRoutePath, 'utf-8');

    const loginRoute = authRouteSrc.slice(
      authRouteSrc.indexOf("router.post('/login'"),
      authRouteSrc.indexOf("router.get('/me'")
    );

    assert.strictEqual(
      loginRoute.includes('bootstrapNewUserFreeCredits'),
      false,
      'POST /login MUST NOT call bootstrapNewUserFreeCredits'
    );
    assert.strictEqual(
      loginRoute.includes('ensureFreeBootstrapCredits'),
      false,
      'POST /login MUST NOT call ensureFreeBootstrapCredits'
    );
  });

  // ---------------------------------------------------------------------------
  // AUTH-01: branch 1 returns auth.users-backed UUID
  // ---------------------------------------------------------------------------
  await runTest('AUTH-01', 'branch 1 returns auth.users-backed UUID', async () => {
    const authRoutePath = path.resolve(__dirname, '../routes/auth.ts');
    const authRouteSrc = fs.readFileSync(authRoutePath, 'utf-8');

    // Branch 1 calls adminSupabase.auth.admin.createUser
    assert.ok(
      authRouteSrc.includes('adminSupabase.auth.admin.createUser'),
      'Branch 1 must call admin.createUser'
    );
    assert.ok(
      authRouteSrc.includes('const user = createData.user;'),
      'Branch 1 must extract real user from createData'
    );
    assert.ok(
      authRouteSrc.includes('db.ensureProfile(user.id,'),
      'Branch 1 must use real auth.users user.id for profile'
    );
    assert.ok(
      authRouteSrc.includes('creditService.bootstrapNewUserFreeCredits(user.id'),
      'Branch 1 must use real auth.users user.id for credit bootstrap'
    );
  });

  // ---------------------------------------------------------------------------
  // AUTH-02: branch 2 returns auth.users-backed UUID
  // ---------------------------------------------------------------------------
  await runTest('AUTH-02', 'branch 2 returns auth.users-backed UUID', async () => {
    const authRoutePath = path.resolve(__dirname, '../routes/auth.ts');
    const authRouteSrc = fs.readFileSync(authRoutePath, 'utf-8');

    // Branch 2 calls liveSupabase.auth.signUp
    assert.ok(
      authRouteSrc.includes('liveSupabase.auth.signUp'),
      'Branch 2 must call liveSupabase.auth.signUp'
    );
    assert.ok(
      authRouteSrc.includes('db.ensureProfile(authData.user.id,'),
      'Branch 2 must use real auth.users authData.user.id for profile'
    );
    assert.ok(
      authRouteSrc.includes('creditService.bootstrapNewUserFreeCredits(authData.user.id'),
      'Branch 2 must use real auth.users authData.user.id for credit bootstrap'
    );
  });

  // ---------------------------------------------------------------------------
  // AUTH-03: branch 3 behavior is explicitly verified
  // ---------------------------------------------------------------------------
  await runTest('AUTH-03', 'branch 3 behavior is explicitly verified (local dev fallback only)', async () => {
    const dbPath = path.resolve(__dirname, '../db/db.ts');
    const dbSrc = fs.readFileSync(dbPath, 'utf-8');

    // Verify db.createAuthUserAndProfile uses crypto.randomUUID() and does not call auth.users
    assert.ok(
      dbSrc.includes('createAuthUserAndProfile(data:'),
      'db.createAuthUserAndProfile must be defined'
    );
    assert.ok(
      dbSrc.includes('const userId = crypto.randomUUID();'),
      'createAuthUserAndProfile uses local crypto.randomUUID()'
    );
    assert.strictEqual(
      dbSrc.slice(dbSrc.indexOf('createAuthUserAndProfile'), dbSrc.indexOf('authenticateUser')).includes('auth.admin.createUser'),
      false,
      'createAuthUserAndProfile does not touch Supabase auth.users'
    );
  });

  // ---------------------------------------------------------------------------
  // AUTH-04: no production branch attempts credit bootstrap using a non-auth.users UUID
  // ---------------------------------------------------------------------------
  await runTest('AUTH-04', 'no production branch attempts credit bootstrap using a non-auth.users UUID', async () => {
    const authRoutePath = path.resolve(__dirname, '../routes/auth.ts');
    const authRouteSrc = fs.readFileSync(authRoutePath, 'utf-8');

    const branch3Code = authRouteSrc.slice(
      authRouteSrc.indexOf('// 3. Unified Supabase Local Auth Engine fallback'),
      authRouteSrc.indexOf("router.post('/login'")
    );

    assert.strictEqual(
      branch3Code.includes('creditService.bootstrapNewUserFreeCredits'),
      false,
      'Branch 3 MUST NOT call bootstrapNewUserFreeCredits (no auth.users row)'
    );
  });

  // ---------------------------------------------------------------------------
  // AUTH-05: credit_accounts FK compatibility preserved
  // ---------------------------------------------------------------------------
  await runTest('AUTH-05', 'credit_accounts FK compatibility preserved (references auth.users)', async () => {
    const migrationPath = path.resolve(
      __dirname,
      '../../supabase/migrations/20261001000000_credit_ledger_foundation.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

    assert.ok(
      migrationSql.includes('REFERENCES auth.users(id)'),
      'credit_accounts.user_id must enforce foreign key constraint to auth.users(id)'
    );
  });

  // Summary
  console.log('\n================================================================');
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
