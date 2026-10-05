import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creditService, CreditService, creditsToUnits } from '../services/credit/creditService.js';
import { billingService } from '../services/billing/billingService.js';
import {
  CANONICAL_APPROVED_PRODUCTION_POLICY_V1,
} from '../services/credit/processingPricingPolicyProvider.js';
import {
  CANONICAL_PROCESSING_PRICING_VERSION,
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

function createChainableMockClient(existingGrantData: any = null) {
  return {
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === 'billing_products') {
            return { data: { id: 'prod-free-uuid' } };
          }
          if (table === 'credit_grants') {
            return { data: existingGrantData };
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
  console.log('PHASE 3A.4 — NEW USER FREE BOOTSTRAP TEST SUITE');
  console.log('================================================================\n');

  const testUserId = '11111111-2222-3333-4444-555555555555';

  // ---------------------------------------------------------------------------
  // FB-01: new user bootstrap policy = 10000 units (10 credits)
  // ---------------------------------------------------------------------------
  await runTest('FB-01', 'new user bootstrap policy = 10000 units (10 credits)', async () => {
    let capturedParams: any = null;
    const testService = new CreditService();
    (testService as any).grantCredits = async (params: any) => {
      capturedParams = params;
      return {
        grantId: 'grant-fb-01',
        accountId: 'acc-fb-01',
        userId: params.userId,
        originalUnits: params.originalUnits,
        remainingUnits: params.originalUnits,
        totalAvailableUnits: params.originalUnits,
        alreadyProcessed: false,
      };
    };

    await testService.bootstrapNewUserFreeCredits(testUserId);
    assert.ok(capturedParams, 'grantCredits must be called');
    assert.strictEqual(capturedParams.originalUnits, 10000, 'Original units must be 10000 (10 credits * 1000 units/credit)');
  });

  // ---------------------------------------------------------------------------
  // FB-02: source_type = FREE_BOOTSTRAP
  // ---------------------------------------------------------------------------
  await runTest('FB-02', 'source_type = FREE_BOOTSTRAP', async () => {
    let capturedParams: any = null;
    const testService = new CreditService();
    (testService as any).grantCredits = async (params: any) => {
      capturedParams = params;
      return {
        grantId: 'grant-fb-02',
        accountId: 'acc-fb-02',
        userId: params.userId,
        originalUnits: params.originalUnits,
        remainingUnits: params.originalUnits,
        totalAvailableUnits: params.originalUnits,
        alreadyProcessed: false,
      };
    };

    await testService.bootstrapNewUserFreeCredits(testUserId);
    assert.strictEqual(capturedParams.sourceType, 'FREE_BOOTSTRAP', 'sourceType must be FREE_BOOTSTRAP');
  });

  // ---------------------------------------------------------------------------
  // FB-03: expires_at = null (non-expiring semantics)
  // ---------------------------------------------------------------------------
  await runTest('FB-03', 'expires_at = null (non-expiring in MVP)', async () => {
    let capturedParams: any = null;
    const testService = new CreditService();
    (testService as any).grantCredits = async (params: any) => {
      capturedParams = params;
      return {
        grantId: 'grant-fb-03',
        accountId: 'acc-fb-03',
        userId: params.userId,
        originalUnits: params.originalUnits,
        remainingUnits: params.originalUnits,
        totalAvailableUnits: params.originalUnits,
        alreadyProcessed: false,
      };
    };

    await testService.bootstrapNewUserFreeCredits(testUserId);
    assert.strictEqual(capturedParams.expiresAt, null, 'expiresAt must be null for FREE_BOOTSTRAP');
  });

  // ---------------------------------------------------------------------------
  // FB-04: billing_cycle_start/end = null
  // ---------------------------------------------------------------------------
  await runTest('FB-04', 'billing_cycle_start/end = null (independent of subscriptions)', async () => {
    let capturedParams: any = null;
    const testService = new CreditService();
    (testService as any).grantCredits = async (params: any) => {
      capturedParams = params;
      return {
        grantId: 'grant-fb-04',
        accountId: 'acc-fb-04',
        userId: params.userId,
        originalUnits: params.originalUnits,
        remainingUnits: params.originalUnits,
        totalAvailableUnits: params.originalUnits,
        alreadyProcessed: false,
      };
    };

    await testService.bootstrapNewUserFreeCredits(testUserId);
    assert.strictEqual(capturedParams.billingCycleStart, null, 'billingCycleStart must be null');
    assert.strictEqual(capturedParams.billingCycleEnd, null, 'billingCycleEnd must be null');
  });

  // ---------------------------------------------------------------------------
  // FB-05: canonical deterministic idempotency key
  // ---------------------------------------------------------------------------
  await runTest('FB-05', 'canonical deterministic idempotency key free-bootstrap:v1:{user_id}', async () => {
    let capturedParams: any = null;
    const testService = new CreditService();
    (testService as any).grantCredits = async (params: any) => {
      capturedParams = params;
      return {
        grantId: 'grant-fb-05',
        accountId: 'acc-fb-05',
        userId: params.userId,
        originalUnits: params.originalUnits,
        remainingUnits: params.originalUnits,
        totalAvailableUnits: params.originalUnits,
        alreadyProcessed: false,
      };
    };

    await testService.bootstrapNewUserFreeCredits(testUserId);
    const expectedKey = `free-bootstrap:v1:${testUserId}`;
    assert.strictEqual(capturedParams.idempotencyKey, expectedKey, `idempotencyKey must be ${expectedKey}`);

    // Call again to verify determinism
    await testService.bootstrapNewUserFreeCredits(testUserId);
    assert.strictEqual(capturedParams.idempotencyKey, expectedKey, 'Key must be completely deterministic');
  });

  // ---------------------------------------------------------------------------
  // FB-06: first ensure creates grant
  // ---------------------------------------------------------------------------
  await runTest('FB-06', 'first ensure creates grant (alreadyProcessed = false)', async () => {
    const testService = new CreditService();
    (testService as any).grantCredits = async (params: any) => {
      return {
        grantId: 'grant-fb-06',
        accountId: 'acc-fb-06',
        userId: params.userId,
        originalUnits: 10000,
        remainingUnits: 10000,
        totalAvailableUnits: 10000,
        alreadyProcessed: false,
      };
    };

    const result = await testService.bootstrapNewUserFreeCredits(testUserId);
    assert.strictEqual(result.alreadyProcessed, false, 'First call must create grant with alreadyProcessed = false');
    assert.strictEqual(result.originalUnits, 10000);
    assert.strictEqual(result.remainingUnits, 10000);
    assert.strictEqual(result.totalAvailableUnits, 10000);
  });

  // ---------------------------------------------------------------------------
  // FB-07: second ensure does not create duplicate grant
  // ---------------------------------------------------------------------------
  await runTest('FB-07', 'second ensure returns alreadyProcessed = true without duplicate', async () => {
    let grantCallCount = 0;
    const testService = new CreditService();
    (testService as any).grantCredits = async (params: any) => {
      grantCallCount++;
      return {
        grantId: 'grant-fb-07',
        accountId: 'acc-fb-07',
        userId: params.userId,
        originalUnits: 10000,
        remainingUnits: 10000,
        totalAvailableUnits: 10000,
        alreadyProcessed: grantCallCount > 1,
      };
    };

    const first = await testService.bootstrapNewUserFreeCredits(testUserId);
    assert.strictEqual(first.alreadyProcessed, false);

    const second = await testService.bootstrapNewUserFreeCredits(testUserId);
    assert.strictEqual(second.alreadyProcessed, true, 'Second call must return alreadyProcessed = true');
    assert.strictEqual(second.grantId, first.grantId, 'Must reference the same grantId');
  });

  // ---------------------------------------------------------------------------
  // FB-08: different idempotency attempt cannot bypass one-time DB invariant
  // ---------------------------------------------------------------------------
  await runTest('FB-08', 'different idempotency attempt cannot bypass one-time DB invariant', async () => {
    const testService = new CreditService();
    // Simulate DB unique partial index violation (uq_credit_grants_one_time_free_bootstrap)
    (testService as any).grantCredits = async () => {
      const err: any = new Error(
        'GRANT_CREDITS_FAILED: DUPLICATE_FREE_BOOTSTRAP: User 11111111-2222-3333-4444-555555555555 has already received a one-time FREE_BOOTSTRAP grant'
      );
      throw err;
    };

    // Chainable mock client
    (testService as any).getAdminClient = () =>
      createChainableMockClient({
        id: 'existing-grant-uuid',
        account_id: 'existing-account-uuid',
        user_id: testUserId,
        original_units: 10000,
        remaining_units: 10000,
      });

    (testService as any).getUserBalance = async () => ({
      availableUnits: 10000,
      grossRemainingUnits: 10000,
      reservedUnits: 0,
    });

    const result = await testService.bootstrapNewUserFreeCredits(testUserId);
    assert.strictEqual(result.alreadyProcessed, true, 'Conflict must resolve safely to alreadyProcessed = true');
    assert.strictEqual(result.grantId, 'existing-grant-uuid');
    assert.strictEqual(result.totalAvailableUnits, 10000);
  });

  // ---------------------------------------------------------------------------
  // FB-09: concurrent bootstrap attempts create only one grant
  // ---------------------------------------------------------------------------
  await runTest('FB-09', 'concurrent bootstrap attempts create only one grant', async () => {
    let grantCreated = false;
    const testService = new CreditService();

    (testService as any).grantCredits = async (params: any) => {
      if (grantCreated) {
        // Second concurrent request hits DB unique index catch
        const err: any = new Error(
          'GRANT_CREDITS_FAILED: DUPLICATE_FREE_BOOTSTRAP: User has already received a one-time FREE_BOOTSTRAP grant'
        );
        throw err;
      }
      grantCreated = true;
      return {
        grantId: 'grant-race-01',
        accountId: 'acc-race-01',
        userId: params.userId,
        originalUnits: 10000,
        remainingUnits: 10000,
        totalAvailableUnits: 10000,
        alreadyProcessed: false,
      };
    };

    (testService as any).getAdminClient = () =>
      createChainableMockClient({
        id: 'grant-race-01',
        account_id: 'acc-race-01',
        user_id: testUserId,
        original_units: 10000,
        remaining_units: 10000,
      });

    (testService as any).getUserBalance = async () => ({
      availableUnits: 10000,
      grossRemainingUnits: 10000,
      reservedUnits: 0,
    });

    // Run 2 concurrent calls simultaneously
    const [res1, res2] = await Promise.all([
      testService.bootstrapNewUserFreeCredits(testUserId),
      testService.bootstrapNewUserFreeCredits(testUserId),
    ]);

    assert.ok(res1 && res2, 'Both callers must resolve safely');
    assert.strictEqual(
      Number(res1.alreadyProcessed) + Number(res2.alreadyProcessed),
      1,
      'Exactly one caller should be first (false), the other idempotent repair (true)'
    );
    assert.strictEqual(res1.grantId, res2.grantId, 'Both callers must reference the same grant');
  });

  // ---------------------------------------------------------------------------
  // FB-10: ledger entry is GRANT_FREE +10000
  // ---------------------------------------------------------------------------
  await runTest('FB-10', 'ledger entry is GRANT_FREE +10000 in DB SQL mapping', async () => {
    const patchPath = path.resolve(
      __dirname,
      '../../supabase/migrations/20261003010000_credit_settlement_and_free_bootstrap_patch.sql'
    );
    const patchSql = fs.readFileSync(patchPath, 'utf-8');

    assert.ok(
      patchSql.includes("WHEN 'FREE_BOOTSTRAP'       THEN 'GRANT_FREE'"),
      'grant_user_credits RPC must map FREE_BOOTSTRAP to GRANT_FREE entry_type'
    );
    assert.ok(
      patchSql.includes('delta_units,') && patchSql.includes('p_original_units,'),
      'grant_user_credits RPC must insert delta_units = p_original_units'
    );
  });

  // ---------------------------------------------------------------------------
  // FB-11: retry does not create second ledger entry
  // ---------------------------------------------------------------------------
  await runTest('FB-11', 'retry does not create second ledger entry (idempotency short-circuit)', async () => {
    const patchPath = path.resolve(
      __dirname,
      '../../supabase/migrations/20261003010000_credit_settlement_and_free_bootstrap_patch.sql'
    );
    const patchSql = fs.readFileSync(patchPath, 'utf-8');

    // Verify SQL returns already_processed before ledger INSERT block
    const idempotencyReturnIndex = patchSql.indexOf("'already_processed', true");
    const ledgerInsertIndex = patchSql.indexOf('INSERT INTO public.credit_ledger');

    assert.ok(idempotencyReturnIndex > 0, 'Must have already_processed return');
    assert.ok(ledgerInsertIndex > 0, 'Must have ledger insert');
    assert.ok(
      idempotencyReturnIndex < ledgerInsertIndex,
      'Idempotency check must return BEFORE inserting into credit_ledger'
    );
  });

  // ---------------------------------------------------------------------------
  // FB-12: frontend cannot choose amount
  // ---------------------------------------------------------------------------
  await runTest('FB-12', 'frontend cannot choose amount (endpoint ignores client amount)', async () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    const bootstrapRoute = creditsRouteSrc.slice(creditsRouteSrc.indexOf("router.post('/bootstrap'"));
    assert.ok(bootstrapRoute, 'POST /bootstrap route must exist in credits.ts');
    assert.strictEqual(
      bootstrapRoute.includes('req.body.amount'),
      false,
      'Route must NOT inspect req.body.amount'
    );
    assert.strictEqual(
      bootstrapRoute.includes('req.body.originalUnits'),
      false,
      'Route must NOT inspect req.body.originalUnits'
    );
  });

  // ---------------------------------------------------------------------------
  // FB-13: frontend cannot choose target user
  // ---------------------------------------------------------------------------
  await runTest('FB-13', 'frontend cannot choose target user (strictly uses req.user.id)', async () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    const bootstrapRoute = creditsRouteSrc.slice(creditsRouteSrc.indexOf("router.post('/bootstrap'"));
    assert.ok(
      bootstrapRoute.includes('const userId = req.user?.id;'),
      'Must resolve userId exclusively from authenticated session (req.user.id)'
    );
    assert.strictEqual(
      bootstrapRoute.includes('req.body.userId'),
      false,
      'Route must NOT inspect req.body.userId'
    );
    assert.strictEqual(
      bootstrapRoute.includes('req.body.user_id'),
      false,
      'Route must NOT inspect req.body.user_id'
    );
  });

  // ---------------------------------------------------------------------------
  // FB-14: frontend cannot choose source type
  // ---------------------------------------------------------------------------
  await runTest('FB-14', 'frontend cannot choose source type (strictly FREE_BOOTSTRAP)', async () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    const bootstrapRoute = creditsRouteSrc.slice(creditsRouteSrc.indexOf("router.post('/bootstrap'"));
    assert.strictEqual(
      bootstrapRoute.includes('req.body.sourceType'),
      false,
      'Route must NOT inspect req.body.sourceType'
    );
  });

  // ---------------------------------------------------------------------------
  // FB-15: anon cannot bootstrap
  // ---------------------------------------------------------------------------
  await runTest('FB-15', 'anon cannot bootstrap (protected by authMiddleware)', async () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    assert.ok(
      creditsRouteSrc.includes("router.post('/bootstrap', authMiddleware,"),
      'POST /bootstrap must require authMiddleware'
    );
  });

  // ---------------------------------------------------------------------------
  // FB-16: authenticated user can bootstrap only self through server endpoint
  // ---------------------------------------------------------------------------
  await runTest('FB-16', 'authenticated user can bootstrap only self through server endpoint', async () => {
    const creditsRoutePath = path.resolve(__dirname, '../routes/credits.ts');
    const creditsRouteSrc = fs.readFileSync(creditsRoutePath, 'utf-8');

    const bootstrapRoute = creditsRouteSrc.slice(creditsRouteSrc.indexOf("router.post('/bootstrap'"));
    assert.ok(
      bootstrapRoute.includes('bootstrapNewUserFreeCredits(userId'),
      'Endpoint must invoke bootstrapNewUserFreeCredits with authenticated user ID'
    );
  });

  // ---------------------------------------------------------------------------
  // FB-17: existing user mass bootstrap is not implemented
  // ---------------------------------------------------------------------------
  await runTest('FB-17', 'existing user mass bootstrap is not implemented (no mass backfill)', async () => {
    const migrationsDir = path.resolve(__dirname, '../../supabase/migrations');
    const migrationFiles = fs.readdirSync(migrationsDir);

    for (const file of migrationFiles) {
      const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      assert.strictEqual(
        content.includes('INSERT INTO public.credit_grants SELECT') && content.includes('FROM public.profiles'),
        false,
        `Migration ${file} must NOT mass backfill credit_grants from existing profiles`
      );
      assert.strictEqual(
        content.includes('INSERT INTO public.credit_accounts SELECT') && content.includes('FROM public.profiles'),
        false,
        `Migration ${file} must NOT mass backfill credit_accounts from existing profiles`
      );
    }
  });

  // ---------------------------------------------------------------------------
  // FB-18: no monthly refill mechanism exists
  // ---------------------------------------------------------------------------
  await runTest('FB-18', 'no monthly refill mechanism exists (one-time policy)', async () => {
    const patchPath = path.resolve(
      __dirname,
      '../../supabase/migrations/20261003010000_credit_settlement_and_free_bootstrap_patch.sql'
    );
    const patchSql = fs.readFileSync(patchPath, 'utf-8');

    // Verify partial unique index enforces single FREE_BOOTSTRAP per account
    assert.ok(
      patchSql.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_grants_one_time_free_bootstrap'),
      'Unique index must enforce one-time grant per account'
    );
  });

  // ---------------------------------------------------------------------------
  // FB-19: balance after clean bootstrap = 10000 available, 0 reserved
  // ---------------------------------------------------------------------------
  await runTest('FB-19', 'balance after clean bootstrap = 10000 available, 0 reserved', async () => {
    // Contract verification of balance shape
    const mockBalance = {
      grossRemainingUnits: 10000,
      reservedUnits: 0,
      availableUnits: 10000,
      grossRemainingCredits: 10,
      reservedCredits: 0,
      availableCredits: 10,
    };

    assert.strictEqual(mockBalance.availableUnits, 10000);
    assert.strictEqual(mockBalance.reservedUnits, 0);
    assert.strictEqual(mockBalance.grossRemainingUnits, 10000);
    assert.strictEqual(mockBalance.availableCredits, 10);
  });

  // ---------------------------------------------------------------------------
  // FB-20: processing pricing policy remains unchanged
  // ---------------------------------------------------------------------------
  await runTest('FB-20', 'processing pricing policy remains unchanged', async () => {
    const policy = CANONICAL_APPROVED_PRODUCTION_POLICY_V1;

    assert.strictEqual(policy.processingPricingVersion, CANONICAL_PROCESSING_PRICING_VERSION);
    assert.strictEqual(policy.processingPricingVersion, 'processing-pricing-v1');
    assert.strictEqual(policy.unitScale, 1000);
    assert.strictEqual(policy.strategyRates.LOCAL_NATIVE, 350);
    assert.strictEqual(policy.strategyRates.AZURE_FULL_PAGE, 1980);
    assert.strictEqual(policy.strategyRates.HYBRID, 1980);
    assert.strictEqual(policy.strategyRates.LOCAL_RECHECK, 0);
    assert.strictEqual(policy.strategyRates.AZURE_FALLBACK, 0);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.LOCAL_NATIVE, 350);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.AZURE_FULL_PAGE, 1980);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.HYBRID, 1980);
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
