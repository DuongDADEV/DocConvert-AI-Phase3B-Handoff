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
} from '../services/credit/processingPricingPolicyProvider.js';
import {
  CANONICAL_PROCESSING_PRICING_VERSION,
  ProcessingPricingInput,
  ProcessingActualUsageInput,
} from '../types/processingPricing.js';
import { processingEligibilityService } from '../services/credit/processingEligibilityService.js';
import { processingDecisionEngine } from '../services/pde/ProcessingDecisionEngine.js';

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
  console.log('PHASE 3A.1 — PRICING SAFETY & ECONOMIC DECISION PREPARATION TEST SUITE');
  console.log('================================================================\n');

  // PS-01: production pricing remains fail-closed
  await runTest('PS-01', 'production pricing remains fail-closed', async () => {
    const provider = new ProcessingPricingPolicyProvider();
    const engine = new ProcessingPricingEngine({ policyProvider: provider });

    await assert.rejects(
      async () => {
        await engine.estimateProcessingCost({
          documentId: 'doc_ps01',
          pageCount: 1,
        });
      },
      (err: any) => err.code === 'PROCESSING_PRICING_NOT_CONFIGURED'
    );
  });

  // PS-02: no speculative production rates are active
  runTest('PS-02', 'no speculative production rates are active', () => {
    // 1. Unconfigured provider instance must fail closed
    const unconfigured = new ProcessingPricingPolicyProvider();
    assert.strictEqual(
      unconfigured.isProductionPricingEnabled(),
      false,
      'Unconfigured provider must NOT be enabled'
    );
    assert.throws(
      () => unconfigured.getActiveProductionPolicy(),
      (err: any) => err.code === 'PROCESSING_PRICING_NOT_CONFIGURED'
    );
    // 2. Active production policy (when enabled) must NEVER contain speculative dev rates
    if (processingPricingPolicyProvider.isProductionPricingEnabled()) {
      const active = processingPricingPolicyProvider.getActiveProductionPolicy();
      assert.notStrictEqual(active.strategyRates.LOCAL_NATIVE, 200, 'Must NOT be speculative dev rate 200');
      assert.strictEqual(active.strategyRates.LOCAL_NATIVE, 350, 'Must be approved MVP rate 350');
      assert.strictEqual(active.isApprovedProductionPolicy, true);
    }
  });

  // PS-03: processing-pricing-v1 remains canonical
  runTest('PS-03', 'processing-pricing-v1 remains canonical', () => {
    assert.strictEqual(CANONICAL_PROCESSING_PRICING_VERSION, 'processing-pricing-v1');
  });

  // PS-04: unconfigured provider approved flag is false / approved policy matches contract
  runTest('PS-04', 'unconfigured provider approved flag is false / approved policy matches contract', () => {
    const unconfigured = new ProcessingPricingPolicyProvider();
    assert.strictEqual(unconfigured.isProductionPricingApproved(), false);
    if (processingPricingPolicyProvider.isProductionPricingApproved()) {
      assert.strictEqual(processingPricingPolicyProvider.getActiveProductionPolicy().isApprovedProductionPolicy, true);
    }
  });

  // PS-05: production engine enabled flag/report semantics correct
  runTest('PS-05', 'production engine enabled flag/report semantics correct', () => {
    const unconfigured = new ProcessingPricingEngine({ policyProvider: new ProcessingPricingPolicyProvider() });
    assert.strictEqual(unconfigured.isProductionEnabled(), false);
    assert.strictEqual(typeof processingPricingEngine.isProductionEnabled(), 'boolean');
  });

  // PS-06: LOCAL_NATIVE fallback possibility is detected/documented in source
  runTest('PS-06', 'LOCAL_NATIVE fallback possibility is verified in LocalPdfExtractor and ProcessingExecutor', () => {
    const extractorSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/services/pde/LocalPdfExtractor.ts'),
      'utf8'
    );
    assert(extractorSrc.includes('structureRequiresFallback'), 'Must contain structureRequiresFallback logic');
    assert(extractorSrc.includes('multiColumnLines.length < 2'), 'Must trigger fallback if columns < 2 in EXCEL');

    const execSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/services/pde/ProcessingExecutor.ts'),
      'utf8'
    );
    assert(execSrc.includes("azureStrategyMap.set(pageNum, 'AZURE_FALLBACK')"), 'Must route fallback to Azure');
  });

  // PS-07: fallback risk can produce actual > planned estimate under planned-path model
  runTest('PS-07', 'fallback risk can produce actual > planned estimate under planned-path model', () => {
    const testPolicy = processingPricingPolicyProvider.getDevelopmentPolicy();
    const plannedUnits = testPolicy.strategyRates.LOCAL_NATIVE; // 200
    const fallbackUnits = testPolicy.strategyRates.AZURE_FALLBACK; // 1000

    const usage = processingPricingEngine.calculateActualUsage(
      {
        documentId: 'doc_ps07',
        estimatedUnits: plannedUnits,
        pages: [
          {
            pageNumber: 1,
            executedStrategy: 'AZURE_FALLBACK',
            primaryOcrUsed: true,
            actualUnits: fallbackUnits,
          },
        ],
      },
      testPolicy
    );

    assert.strictEqual(usage.reconciliationRequired, true);
    assert.strictEqual(usage.varianceUnits, fallbackUnits - plannedUnits);
    assert.strictEqual(usage.totalActualUnits, fallbackUnits);
  });

  // PS-08: reconciliation is classified as exception path
  runTest('PS-08', 'reconciliation is classified as exception path', () => {
    const testPolicy = processingPricingPolicyProvider.getDevelopmentPolicy();
    // Normal planned execution where actual <= estimate:
    const normalUsage = processingPricingEngine.calculateActualUsage(
      {
        documentId: 'doc_ps08_normal',
        estimatedUnits: 1000,
        pages: [
          {
            pageNumber: 1,
            executedStrategy: 'AZURE_FULL_PAGE',
            primaryOcrUsed: true,
            actualUnits: 1000,
          },
        ],
      },
      testPolicy
    );
    assert.strictEqual(normalUsage.reconciliationRequired, false);
    assert.strictEqual(normalUsage.varianceUnits, 0);

    // Over-consumption exception:
    const overUsage = processingPricingEngine.calculateActualUsage(
      {
        documentId: 'doc_ps08_over',
        estimatedUnits: 1000,
        pages: [
          {
            pageNumber: 1,
            executedStrategy: 'AZURE_FULL_PAGE',
            primaryOcrUsed: true,
            actualUnits: 1200,
          },
        ],
      },
      testPolicy
    );
    assert.strictEqual(overUsage.reconciliationRequired, true);
    assert.strictEqual(overUsage.varianceUnits, 200);
  });

  // PS-09: secondary OCR unpredictability is represented
  runTest('PS-09', 'secondary OCR unpredictability is represented in preflight vs actual usage', () => {
    // Secondary OCR is post-validation in SecondaryOcrCoordinator
    const coordSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/services/secondaryOcr/SecondaryOcrCoordinator.ts'),
      'utf8'
    );
    assert(coordSrc.includes('requires_secondary_ocr'), 'Queries cells requiring secondary OCR');
    assert(coordSrc.includes('maxCellsPerDocument'), 'Has configurable budget cap');
  });

  // PS-10: UNCERTAIN flow matches source
  runTest('PS-10', 'UNCERTAIN flow matches ProcessingDecisionEngine resolveSecondPass', () => {
    // Verify resolveSecondPass resolves UNCERTAIN to LOCAL_NATIVE, HYBRID, or AZURE_FULL_PAGE
    const pde = processingDecisionEngine;

    // High text, low image -> LOCAL_NATIVE
    const dec1 = pde.evaluatePage({
      pageNumber: 1,
      classification: 'UNCERTAIN',
      classificationConfidence: 0.5,
      textCharCount: 200,
      textBlockCount: 5,
      textCoverage: 0.2,
      imageCount: 0,
      imageCoverage: 0.05,
      hasFullPageImage: false,
      classificationReason: 'Test uncertain 1',
    });
    assert.strictEqual(dec1.preferredStrategy, 'LOCAL_NATIVE');
    assert.strictEqual(dec1.fallbackStrategy, 'AZURE_FALLBACK');

    // High image -> AZURE_FULL_PAGE
    const dec2 = pde.evaluatePage({
      pageNumber: 2,
      classification: 'UNCERTAIN',
      classificationConfidence: 0.5,
      textCharCount: 20,
      textBlockCount: 1,
      textCoverage: 0.01,
      imageCount: 1,
      imageCoverage: 0.8,
      hasFullPageImage: true,
      classificationReason: 'Test uncertain 2',
    });
    assert.strictEqual(dec2.preferredStrategy, 'AZURE_FULL_PAGE');

    // Moderate text, moderate image -> HYBRID
    const dec3 = pde.evaluatePage({
      pageNumber: 3,
      classification: 'UNCERTAIN',
      classificationConfidence: 0.5,
      textCharCount: 80,
      textBlockCount: 2,
      textCoverage: 0.1,
      imageCount: 1,
      imageCoverage: 0.25,
      hasFullPageImage: false,
      classificationReason: 'Test uncertain 3',
    });
    assert.strictEqual(dec3.preferredStrategy, 'HYBRID');
  });

  // PS-11: HYBRID technical execution matches source
  runTest('PS-11', 'HYBRID technical execution matches source (calls Azure full-page in current pipeline)', () => {
    const execSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/services/pde/ProcessingExecutor.ts'),
      'utf8'
    );
    // In ProcessingExecutor: pages not LOCAL_NATIVE are pushed to pagesForAzure
    assert(execSrc.includes('pagesForAzure.push(pageNum)'), 'Hybrid pages are routed to Azure');
  });

  // PS-12: no minimum document charge is active without approval
  runTest('PS-12', 'no minimum document charge is active without approval', () => {
    const devPolicy = processingPricingPolicyProvider.getDevelopmentPolicy();
    assert.strictEqual(devPolicy.minDocumentChargeUnits, 0);
  });

  // PS-13: actual usage contract != runtime telemetry readiness
  runTest('PS-13', 'actual usage contract != runtime telemetry readiness', () => {
    // The contract interface is ready:
    const input: ProcessingActualUsageInput = {
      documentId: 'doc_ps13',
      pages: [
        {
          pageNumber: 1,
          executedStrategy: 'AZURE_FULL_PAGE',
          primaryOcrUsed: true,
          actualUnits: 1000,
        },
      ],
    };
    const usage = processingPricingEngine.calculateActualUsage(
      input,
      processingPricingPolicyProvider.getDevelopmentPolicy()
    );
    assert.strictEqual(usage.totalActualUnits, 1000);

    // But runtime worker does not persist these telemetry items in document_pages or jobs table
    const workerSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/services/ocrWorker.ts'),
      'utf8'
    );
    assert(!workerSrc.includes('actual_units'), 'Worker does not record actual_units column');
  });

  // PS-14: eligibility fails closed without production pricing
  runTest('PS-14', 'eligibility fails closed without production pricing', () => {
    const res = processingEligibilityService.evaluateCreditSufficiency(
      50000,
      0, // Zero / unconfigured
      'ACTIVE',
      'processing-pricing-v1'
    );
    assert.strictEqual(res.eligible, false);
    assert.strictEqual(res.reason, 'INVALID_PROCESSING_ESTIMATE');
  });

  // PS-15: no financial mutation
  runTest('PS-15', 'no financial mutation exists in Phase 3A/3A.1 source', () => {
    const engineSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/services/credit/processingPricingEngine.ts'),
      'utf8'
    );
    assert(!engineSrc.includes('reserve_credit_units'));
    assert(!engineSrc.includes('capture_credit_reservation'));
    assert(!engineSrc.includes('release_credit_reservation'));
    assert(!engineSrc.includes('grant_user_credits'));
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
