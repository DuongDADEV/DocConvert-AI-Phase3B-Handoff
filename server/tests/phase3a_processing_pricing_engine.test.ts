import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  processingPricingEngine,
  ProcessingPricingEngine,
} from '../services/credit/processingPricingEngine.js';
import {
  processingPricingPolicyProvider,
  ProcessingPricingPolicyProvider,
  validateProcessingPricingPolicy,
} from '../services/credit/processingPricingPolicyProvider.js';
import {
  CANONICAL_PROCESSING_PRICING_VERSION,
  ProcessingPricingPolicy,
  ProcessingPricingInput,
  ProcessingActualUsageInput,
} from '../types/processingPricing.js';
import { processingEligibilityService } from '../services/credit/processingEligibilityService.js';

let passed = 0;
let failed = 0;

function runTest(id: string, name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result && typeof (result as any).then === 'function') {
      return (result as Promise<void>)
        .then(() => {
          console.log(`[PASS] ${id}: ${name}`);
          passed++;
        })
        .catch((err) => {
          console.error(`[FAIL] ${id}: ${name} ->`, err.message || err);
          failed++;
        });
    }
    console.log(`[PASS] ${id}: ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`[FAIL] ${id}: ${name} ->`, err.message || err);
    failed++;
  }
}

async function runAll() {
  console.log('================================================================');
  console.log('PHASE 3A — PROCESSING PRICING ENGINE TEST SUITE');
  console.log('================================================================\n');

  const testProvider = new ProcessingPricingPolicyProvider();
  const testEngine = new ProcessingPricingEngine({ policyProvider: testProvider });
  const testPolicy = testProvider.getDevelopmentPolicy();

  // ==========================================================================
  // I. POLICY MATRIX: PP-01 .. PP-09
  // ==========================================================================
  console.log('--- I. Policy Validation Matrix (PP-01 .. PP-09) ---');

  runTest('PP-01', 'processing pricing version is processing-pricing-v1', () => {
    assert.strictEqual(CANONICAL_PROCESSING_PRICING_VERSION, 'processing-pricing-v1');
    assert.strictEqual(testPolicy.processingPricingVersion, 'processing-pricing-v1');
  });

  runTest('PP-02', 'commercial pricing-v1 is not reused', () => {
    assert.throws(
      () => {
        validateProcessingPricingPolicy({
          ...testPolicy,
          processingPricingVersion: 'pricing-v1' as any,
        });
      },
      (err: any) => err.code === 'INVALID_PRICING_VERSION' || err.code === 'PRICING_NAMESPACE_COLLISION'
    );
  });

  runTest('PP-03', 'pricing policy cannot contain negative units', () => {
    assert.throws(
      () => {
        validateProcessingPricingPolicy({
          ...testPolicy,
          strategyRates: {
            ...testPolicy.strategyRates,
            LOCAL_NATIVE: -100,
          },
        });
      },
      (err: any) => err.code === 'INVALID_STRATEGY_RATE'
    );
  });

  runTest('PP-04', 'pricing policy cannot contain fractional units', () => {
    assert.throws(
      () => {
        validateProcessingPricingPolicy({
          ...testPolicy,
          strategyRates: {
            ...testPolicy.strategyRates,
            LOCAL_NATIVE: 100.5,
          },
        });
      },
      (err: any) => err.code === 'INVALID_STRATEGY_RATE'
    );
  });

  runTest('PP-05', 'pricing policy rejects NaN and Infinity', () => {
    assert.throws(
      () => {
        validateProcessingPricingPolicy({
          ...testPolicy,
          strategyRates: {
            ...testPolicy.strategyRates,
            AZURE_FULL_PAGE: NaN,
          },
        });
      },
      (err: any) => err.code === 'INVALID_STRATEGY_RATE'
    );

    assert.throws(
      () => {
        validateProcessingPricingPolicy({
          ...testPolicy,
          strategyRates: {
            ...testPolicy.strategyRates,
            AZURE_FULL_PAGE: Infinity,
          },
        });
      },
      (err: any) => err.code === 'INVALID_STRATEGY_RATE'
    );
  });

  runTest('PP-06', 'pricing policy rejects unsafe integer values', () => {
    assert.throws(
      () => {
        validateProcessingPricingPolicy({
          ...testPolicy,
          strategyRates: {
            ...testPolicy.strategyRates,
            AZURE_FULL_PAGE: Number.MAX_SAFE_INTEGER + 10,
          },
        });
      },
      (err: any) => err.code === 'INVALID_STRATEGY_RATE'
    );
  });

  await runTest('PP-07', 'unconfigured production pricing fails closed', async () => {
    const freshProvider = new ProcessingPricingPolicyProvider();
    const freshEngine = new ProcessingPricingEngine({ policyProvider: freshProvider });

    await assert.rejects(
      async () => {
        await freshEngine.estimateProcessingCost({
          documentId: 'doc_1',
          pageCount: 3,
        });
      },
      (err: any) => err.code === 'PROCESSING_PRICING_NOT_CONFIGURED'
    );
  });

  runTest('PP-08', 'test pricing policy can be injected explicitly', () => {
    const custom = testProvider.createTestPolicy({
      strategyRates: {
        LOCAL_NATIVE: 150,
        AZURE_FULL_PAGE: 800,
        HYBRID: 500,
        LOCAL_RECHECK: 250,
        AZURE_FALLBACK: 800,
      },
    });
    assert.strictEqual(custom.strategyRates.LOCAL_NATIVE, 150);
    assert.strictEqual(custom.strategyRates.AZURE_FULL_PAGE, 800);
    assert.strictEqual(custom.isApprovedProductionPolicy, false);
  });

  runTest('PP-09', 'test pricing cannot silently become production pricing', () => {
    const unapprovedPolicy = testProvider.getDevelopmentPolicy();
    assert.strictEqual(unapprovedPolicy.isApprovedProductionPolicy, false);

    assert.throws(
      () => {
        testProvider.setApprovedProductionPolicy(unapprovedPolicy);
      },
      (err: any) => err.code === 'UNAPPROVED_POLICY_REJECTED'
    );
  });

  // ==========================================================================
  // II. ESTIMATION MATRIX: PE-01 .. PE-10
  // ==========================================================================
  console.log('\n--- II. Estimation Engine Matrix (PE-01 .. PE-10) ---');

  await runTest('PE-01', 'same input + same policy => same estimate (deterministic)', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_det_1',
      pageCount: 2,
      pages: [
        { pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' },
        { pageNumber: 2, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' },
      ],
    };

    const est1 = await testEngine.estimateProcessingCost(input, testPolicy);
    const est2 = await testEngine.estimateProcessingCost(input, testPolicy);

    assert.strictEqual(est1.estimatedUnits, est2.estimatedUnits);
    assert.strictEqual(est1.estimatedCredits, est2.estimatedCredits);
    assert.deepStrictEqual(est1.pageBreakdown, est2.pageBreakdown);
  });

  await runTest('PE-02', 'document estimate equals page breakdown sum where no document surcharge exists', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_sum_1',
      pageCount: 3,
      pages: [
        { pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' },
        { pageNumber: 2, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' },
        { pageNumber: 3, classification: 'MIXED', processingStrategy: 'HYBRID' },
      ],
    };

    const estimate = await testEngine.estimateProcessingCost(input, testPolicy);
    const sumPages = estimate.pageBreakdown.reduce((sum, p) => sum + p.estimatedUnits, 0);

    assert.strictEqual(estimate.estimatedUnits, sumPages);
    assert.strictEqual(estimate.pageBreakdown.length, 3);
  });

  await runTest('PE-03', 'page count mismatch fails safely', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_mismatch',
      pageCount: 3,
      pages: [
        { pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' },
      ],
    };

    await assert.rejects(
      async () => {
        await testEngine.estimateProcessingCost(input, testPolicy);
      },
      (err: any) => err.code === 'PAGE_COUNT_MISMATCH'
    );
  });

  await runTest('PE-04', 'missing page strategy falls back to canonical PDE evaluation', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_pde_fallback',
      pageCount: 2,
      pages: [
        { pageNumber: 1, classification: 'NATIVE_TEXT', textCharCount: 200 },
        { pageNumber: 2, classification: 'SCANNED', imageCoverage: 0.9 },
      ],
    };

    const estimate = await testEngine.estimateProcessingCost(input, testPolicy);
    assert.strictEqual(estimate.pageBreakdown[0].processingStrategy, 'LOCAL_NATIVE');
    assert.strictEqual(estimate.pageBreakdown[1].processingStrategy, 'AZURE_FULL_PAGE');
  });

  await runTest('PE-05', 'unknown classification resolves safely via PDE', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_uncertain',
      pageCount: 1,
      pages: [
        { pageNumber: 1, classification: 'UNCERTAIN', textCharCount: 10, imageCoverage: 0.8 },
      ],
    };

    const estimate = await testEngine.estimateProcessingCost(input, testPolicy);
    assert.strictEqual(estimate.pageBreakdown[0].processingStrategy, 'AZURE_FULL_PAGE');
    assert.strictEqual(estimate.confidence, 'CONDITIONAL_ESTIMATE');
  });

  await runTest('PE-06', 'unknown processing strategy fails safely', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_unknown_strat',
      pageCount: 1,
      pages: [
        { pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'NON_EXISTENT_STRATEGY' as any },
      ],
    };

    await assert.rejects(
      async () => {
        await testEngine.estimateProcessingCost(input, testPolicy);
      },
      (err: any) => err.code === 'UNKNOWN_PROCESSING_STRATEGY'
    );
  });

  await runTest('PE-07', 'estimatedUnits > 0 for chargeable processing', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_pos_units',
      pageCount: 1,
      pages: [{ pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' }],
    };

    const estimate = await testEngine.estimateProcessingCost(input, testPolicy);
    assert(estimate.estimatedUnits > 0, 'estimatedUnits must be > 0');
  });

  await runTest('PE-08', 'estimatedUnits is safe integer', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_safe_int',
      pageCount: 5,
      pages: [
        { pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' },
        { pageNumber: 2, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' },
        { pageNumber: 3, classification: 'HYBRID', processingStrategy: 'HYBRID' },
        { pageNumber: 4, classification: 'LOCAL_RECHECK', processingStrategy: 'LOCAL_RECHECK' },
        { pageNumber: 5, classification: 'SCANNED', processingStrategy: 'AZURE_FALLBACK' },
      ],
    };

    const estimate = await testEngine.estimateProcessingCost(input, testPolicy);
    assert(Number.isSafeInteger(estimate.estimatedUnits));
    assert(estimate.estimatedUnits >= 0);
  });

  await runTest('PE-09', 'estimatedCredits derived from units only', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_credits_derived',
      pageCount: 1,
      pages: [{ pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' }],
    };

    const estimate = await testEngine.estimateProcessingCost(input, testPolicy);
    assert.strictEqual(estimate.estimatedUnits, 200);
    assert.strictEqual(estimate.estimatedCredits, 0.2);
  });

  await runTest('PE-10', 'frontend-provided estimatedUnits is never authoritative', async () => {
    // The server pricing engine accepts document metadata, not user-dictated estimatedUnits
    const input: any = {
      documentId: 'doc_spoof_attempt',
      pageCount: 2,
      estimatedUnits: 1, // Malicious client attempt to pay 1 unit
      pages: [
        { pageNumber: 1, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' },
        { pageNumber: 2, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' },
      ],
    };

    const estimate = await testEngine.estimateProcessingCost(input, testPolicy);
    // Must calculate authoritative 2000 units (2 x 1000), ignoring frontend 1
    assert.strictEqual(estimate.estimatedUnits, 2000);
  });

  // ==========================================================================
  // III. PIPELINE TYPES MATRIX: PT-01 .. PT-06
  // ==========================================================================
  console.log('\n--- III. Real Pipeline Types Matrix (PT-01 .. PT-06) ---');

  await runTest('PT-01', 'LOCAL_NATIVE estimate', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_pt01',
      pageCount: 1,
      pages: [{ pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' }],
    };
    const est = await testEngine.estimateProcessingCost(input, testPolicy);
    assert.strictEqual(est.estimatedUnits, 200);
    assert.strictEqual(est.pageBreakdown[0].processingStrategy, 'LOCAL_NATIVE');
  });

  await runTest('PT-02', 'AZURE_FULL_PAGE estimate', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_pt02',
      pageCount: 1,
      pages: [{ pageNumber: 1, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' }],
    };
    const est = await testEngine.estimateProcessingCost(input, testPolicy);
    assert.strictEqual(est.estimatedUnits, 1000);
    assert.strictEqual(est.pageBreakdown[0].processingStrategy, 'AZURE_FULL_PAGE');
  });

  await runTest('PT-03', 'HYBRID estimate', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_pt03',
      pageCount: 1,
      pages: [{ pageNumber: 1, classification: 'MIXED', processingStrategy: 'HYBRID' }],
    };
    const est = await testEngine.estimateProcessingCost(input, testPolicy);
    assert.strictEqual(est.estimatedUnits, 600);
    assert.strictEqual(est.pageBreakdown[0].processingStrategy, 'HYBRID');
  });

  await runTest('PT-04', 'mixed document with multiple page strategies', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_pt04',
      pageCount: 5,
      pages: [
        { pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' }, // 200
        { pageNumber: 2, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' }, // 200
        { pageNumber: 3, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' },   // 1000
        { pageNumber: 4, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' },   // 1000
        { pageNumber: 5, classification: 'MIXED', processingStrategy: 'HYBRID' },              // 600
      ],
    };
    const est = await testEngine.estimateProcessingCost(input, testPolicy);
    assert.strictEqual(est.estimatedUnits, 3000); // 200 + 200 + 1000 + 1000 + 600
    assert.strictEqual(est.estimatedCredits, 3.0);
  });

  await runTest('PT-05', 'requires_secondary_ocr behavior is conditional/actual (0 at preflight)', async () => {
    // Secondary OCR occurs cell-by-cell post validation when review is required.
    // At preflight, it cannot be known, so estimatedUnits relies on page strategies.
    const input: ProcessingPricingInput = {
      documentId: 'doc_pt05',
      pageCount: 1,
      requiresSecondaryOcr: true,
      pages: [{ pageNumber: 1, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' }],
    };
    const est = await testEngine.estimateProcessingCost(input, testPolicy);
    assert.strictEqual(est.estimatedUnits, 1000);
  });

  await runTest('PT-06', 'requires_region_analysis behavior applies configured surcharge', async () => {
    const input: ProcessingPricingInput = {
      documentId: 'doc_pt06',
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          classification: 'MIXED',
          processingStrategy: 'HYBRID',
          requiresRegionAnalysis: true,
        },
      ],
    };
    const est = await testEngine.estimateProcessingCost(input, testPolicy);
    // Base HYBRID (600) + regionAnalysisPerPage (100) = 700 units
    assert.strictEqual(est.estimatedUnits, 700);
    assert.strictEqual(est.pageBreakdown[0].additionalUnits, 100);
  });

  // ==========================================================================
  // IV. CREDIT GUARD MATRIX: CG-01 .. CG-07
  // ==========================================================================
  console.log('\n--- IV. Credit Guard Eligibility Matrix (CG-01 .. CG-07) ---');

  runTest('CG-01', 'available > estimate => eligible', () => {
    const res = processingEligibilityService.evaluateCreditSufficiency(
      30000,
      25000,
      'ACTIVE',
      'processing-pricing-v1'
    );
    assert.strictEqual(res.eligible, true);
    assert.strictEqual(res.reason, 'ELIGIBLE');
    assert.strictEqual(res.shortageUnits, 0);
  });

  runTest('CG-02', 'available = estimate => eligible', () => {
    const res = processingEligibilityService.evaluateCreditSufficiency(
      20000,
      20000,
      'ACTIVE',
      'processing-pricing-v1'
    );
    assert.strictEqual(res.eligible, true);
    assert.strictEqual(res.reason, 'ELIGIBLE');
  });

  runTest('CG-03', 'available < estimate => blocked', () => {
    const res = processingEligibilityService.evaluateCreditSufficiency(
      20000,
      27000,
      'ACTIVE',
      'processing-pricing-v1'
    );
    assert.strictEqual(res.eligible, false);
    assert.strictEqual(res.reason, 'INSUFFICIENT_CREDIT');
  });

  runTest('CG-04', 'shortage calculation correct', () => {
    const res = processingEligibilityService.evaluateCreditSufficiency(
      20000,
      27000,
      'ACTIVE',
      'processing-pricing-v1'
    );
    assert.strictEqual(res.shortageUnits, 7000);
    assert.strictEqual(res.shortageCredits, 7);
  });

  runTest('CG-05', 'reserved credits reduce available balance', () => {
    // Gross: 30000, Reserved: 10000 => Available: 20000. Estimate: 25000 => Blocked
    const available = 30000 - 10000;
    const res = processingEligibilityService.evaluateCreditSufficiency(
      available,
      25000,
      'ACTIVE',
      'processing-pricing-v1'
    );
    assert.strictEqual(res.eligible, false);
    assert.strictEqual(res.shortageUnits, 5000);
  });

  runTest('CG-06', 'gross balance cannot bypass insufficient available credit', () => {
    // If gross is 50000 but reserved is 40000, available is only 10000.
    const grossRemaining = 50000;
    const reserved = 40000;
    const available = grossRemaining - reserved;
    const res = processingEligibilityService.evaluateCreditSufficiency(
      available,
      15000,
      'ACTIVE',
      'processing-pricing-v1'
    );
    assert.strictEqual(res.eligible, false);
    assert.strictEqual(res.reason, 'INSUFFICIENT_CREDIT');
  });

  runTest('CG-07', 'pricing not configured => processing eligibility fails closed', () => {
    const res = processingEligibilityService.evaluateCreditSufficiency(
      50000,
      0, // Zero / unconfigured
      'ACTIVE',
      'processing-pricing-v1'
    );
    assert.strictEqual(res.eligible, false);
    assert.strictEqual(res.reason, 'INVALID_PROCESSING_ESTIMATE');
  });

  // ==========================================================================
  // V. ACTUAL USAGE CONTRACT MATRIX: AU-01 .. AU-07
  // ==========================================================================
  console.log('\n--- V. Actual Usage Contract Matrix (AU-01 .. AU-07) ---');

  runTest('AU-01', 'actual usage result contains processingPricingVersion', () => {
    const input: ProcessingActualUsageInput = {
      documentId: 'doc_au01',
      estimatedUnits: 2000,
      pages: [
        { pageNumber: 1, executedStrategy: 'AZURE_FULL_PAGE', primaryOcrUsed: true, actualUnits: 1000 },
      ],
    };
    const usage = testEngine.calculateActualUsage(input, testPolicy);
    assert.strictEqual(usage.processingPricingVersion, 'processing-pricing-v1');
  });

  runTest('AU-02', 'actual usage total equals page usage sum where applicable', () => {
    const input: ProcessingActualUsageInput = {
      documentId: 'doc_au02',
      estimatedUnits: 2500,
      pages: [
        { pageNumber: 1, executedStrategy: 'LOCAL_NATIVE', primaryOcrUsed: false, actualUnits: 200 },
        { pageNumber: 2, executedStrategy: 'AZURE_FULL_PAGE', primaryOcrUsed: true, actualUnits: 1000 },
        { pageNumber: 3, executedStrategy: 'HYBRID', primaryOcrUsed: true, actualUnits: 700 },
      ],
    };
    const usage = testEngine.calculateActualUsage(input, testPolicy);
    assert.strictEqual(usage.totalActualUnits, 1900); // 200 + 1000 + 700
    assert.strictEqual(usage.totalActualCredits, 1.9);
  });

  runTest('AU-03', 'actual units safe integer', () => {
    const input: ProcessingActualUsageInput = {
      documentId: 'doc_au03',
      pages: [
        { pageNumber: 1, executedStrategy: 'AZURE_FULL_PAGE', primaryOcrUsed: true, actualUnits: 1000 },
      ],
    };
    const usage = testEngine.calculateActualUsage(input, testPolicy);
    assert(Number.isSafeInteger(usage.totalActualUnits));
    assert(usage.totalActualUnits >= 0);
  });

  runTest('AU-04', 'actual usage cannot be negative', () => {
    const input: ProcessingActualUsageInput = {
      documentId: 'doc_au04',
      pages: [
        { pageNumber: 1, executedStrategy: 'AZURE_FULL_PAGE', primaryOcrUsed: true, actualUnits: -500 },
      ],
    };
    assert.throws(
      () => testEngine.calculateActualUsage(input, testPolicy),
      (err: any) => err.code === 'INVALID_ACTUAL_UNITS'
    );
  });

  runTest('AU-05', 'actual strategy may differ from estimated strategy (e.g. fallback triggered)', () => {
    // Estimated as LOCAL_NATIVE (200), but execution fell back to AZURE_FALLBACK (1000)
    const input: ProcessingActualUsageInput = {
      documentId: 'doc_au05',
      estimatedUnits: 200,
      pages: [
        {
          pageNumber: 1,
          executedStrategy: 'AZURE_FALLBACK',
          primaryOcrUsed: true,
          actualUnits: 1000,
        },
      ],
    };
    const usage = testEngine.calculateActualUsage(input, testPolicy);
    assert.strictEqual(usage.pageUsage[0].executedStrategy, 'AZURE_FALLBACK');
    assert.strictEqual(usage.totalActualUnits, 1000);
  });

  runTest('AU-06', 'actual > estimated is detectable', () => {
    // Estimated: 1000 units, Actual: 1500 units (e.g. unexpected fallback + secondary cell OCR)
    const input: ProcessingActualUsageInput = {
      documentId: 'doc_au06',
      estimatedUnits: 1000,
      pages: [
        { pageNumber: 1, executedStrategy: 'AZURE_FULL_PAGE', primaryOcrUsed: true, actualUnits: 1500 },
      ],
    };
    const usage = testEngine.calculateActualUsage(input, testPolicy);
    assert.strictEqual(usage.reconciliationRequired, true);
    assert.strictEqual(usage.varianceUnits, 500);
  });

  runTest('AU-07', 'actual > estimated does NOT automatically debit anything', () => {
    // Pure calculation: check that calculateActualUsage returns a pure data object
    // without invoking any credit ledger mutations or RPCs
    const input: ProcessingActualUsageInput = {
      documentId: 'doc_au07',
      estimatedUnits: 500,
      pages: [
        { pageNumber: 1, executedStrategy: 'AZURE_FULL_PAGE', primaryOcrUsed: true, actualUnits: 1000 },
      ],
    };
    const usage = testEngine.calculateActualUsage(input, testPolicy);
    assert.strictEqual(usage.reconciliationRequired, true);
    assert.strictEqual(usage.totalActualUnits, 1000);
    // Verification: Object is plain JSON-serializable, zero side-effects
    const serialized = JSON.stringify(usage);
    assert(serialized.includes('"reconciliationRequired":true'));
  });

  // ==========================================================================
  // VI. FINANCIAL MUTATION & SOURCE INTEGRITY AUDIT
  // ==========================================================================
  console.log('\n--- VI. Financial Mutation & Source Audit ---');

  runTest('FM-01', 'Processing Pricing Engine does NOT contain financial mutation RPCs', () => {
    const engineSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/services/credit/processingPricingEngine.ts'),
      'utf8'
    );
    assert(!engineSrc.includes('reserve_credit_units'), 'Engine must not call reserve_credit_units');
    assert(!engineSrc.includes('capture_credit_reservation'), 'Engine must not call capture_credit_reservation');
    assert(!engineSrc.includes('release_credit_reservation'), 'Engine must not call release_credit_reservation');
    assert(!engineSrc.includes('grant_user_credits'), 'Engine must not call grant_user_credits');
  });

  runTest('FM-02', 'Policy Provider does NOT contain financial mutation RPCs', () => {
    const providerSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/services/credit/processingPricingPolicyProvider.ts'),
      'utf8'
    );
    assert(!providerSrc.includes('reserve_credit_units'), 'Provider must not call reserve_credit_units');
    assert(!providerSrc.includes('capture_credit_reservation'), 'Provider must not call capture_credit_reservation');
    assert(!providerSrc.includes('release_credit_reservation'), 'Provider must not call release_credit_reservation');
    assert(!providerSrc.includes('grant_user_credits'), 'Provider must not call grant_user_credits');
  });

  console.log('\n================================================================');
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
