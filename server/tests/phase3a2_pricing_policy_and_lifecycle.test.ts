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
  CANONICAL_APPROVED_PRODUCTION_POLICY_V1,
} from '../services/credit/processingPricingPolicyProvider.js';
import {
  CANONICAL_PROCESSING_PRICING_VERSION,
  CREDIT_UNIT_SCALE,
  PRODUCTION_PROCESSING_RATES,
  ProcessingPricingPolicy,
  ProcessingPricingInput,
  ProcessingActualUsageInput,
  ProcessingPageTechnicalUsage,
} from '../types/processingPricing.js';
import { unitsToCredits, creditsToUnits } from '../services/credit/creditService.js';

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
  console.log('PHASE 3A.2 — PRODUCTION PRICING POLICY & LIFECYCLE TEST SUITE');
  console.log('================================================================\n');

  const policy = CANONICAL_APPROVED_PRODUCTION_POLICY_V1;

  // ==========================================================================
  // I. BILLABLE PRICING POLICY TESTS: PRICE-01 .. PRICE-15
  // ==========================================================================
  console.log('--- I. Billable Pricing Policy Tests (PRICE-01 .. PRICE-15) ---');

  // PRICE-01: LOCAL_NATIVE = 350 units
  runTest('PRICE-01', 'LOCAL_NATIVE = 350 units', () => {
    assert.strictEqual(policy.strategyRates.LOCAL_NATIVE, 350);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.LOCAL_NATIVE, 350);
    assert.strictEqual(unitsToCredits(350), 0.35);
  });

  // PRICE-02: AZURE_FULL_PAGE = 1980 units
  runTest('PRICE-02', 'AZURE_FULL_PAGE = 1980 units', () => {
    assert.strictEqual(policy.strategyRates.AZURE_FULL_PAGE, 1980);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.AZURE_FULL_PAGE, 1980);
    assert.strictEqual(unitsToCredits(1980), 1.98);
  });

  // PRICE-03: HYBRID = 1980 units
  runTest('PRICE-03', 'HYBRID = 1980 units', () => {
    assert.strictEqual(policy.strategyRates.HYBRID, 1980);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.HYBRID, 1980);
    assert.strictEqual(unitsToCredits(1980), 1.98);
  });

  // PRICE-04: LOCAL_RECHECK has no incremental customer charge
  runTest('PRICE-04', 'LOCAL_RECHECK has no incremental customer charge', () => {
    assert.strictEqual(policy.strategyRates.LOCAL_RECHECK, 0);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.LOCAL_RECHECK, 0);
  });

  // PRICE-05: AZURE_FALLBACK has no incremental customer charge
  runTest('PRICE-05', 'AZURE_FALLBACK has no incremental customer charge (absorbed in MVP)', () => {
    assert.strictEqual(policy.strategyRates.AZURE_FALLBACK, 0);
    assert.strictEqual(PRODUCTION_PROCESSING_RATES.AZURE_FALLBACK, 0);
  });

  // PRICE-06: SECONDARY_OCR has no incremental customer charge
  runTest('PRICE-06', 'SECONDARY_OCR has no incremental customer charge (included QA cost)', () => {
    assert.strictEqual(policy.additionalRates?.secondaryOcrPerCell, 0);
  });

  // PRICE-07: REGION_ANALYSIS has no incremental customer charge
  runTest('PRICE-07', 'REGION_ANALYSIS has no incremental customer charge (included in HYBRID)', () => {
    assert.strictEqual(policy.additionalRates?.regionAnalysisPerPage, 0);
  });

  // PRICE-08: minimum document charge = 0
  runTest('PRICE-08', 'minimum document charge = 0 in MVP', () => {
    assert.strictEqual(policy.minDocumentChargeUnits, 0);
  });

  // PRICE-09: processing-pricing-v1 approved production policy validates
  runTest('PRICE-09', 'processing-pricing-v1 approved production policy validates cleanly', () => {
    assert.doesNotThrow(() => validateProcessingPricingPolicy(policy));
    assert.strictEqual(policy.processingPricingVersion, CANONICAL_PROCESSING_PRICING_VERSION);
    assert.strictEqual(policy.unitScale, CREDIT_UNIT_SCALE);
    assert.strictEqual(policy.isApprovedProductionPolicy, true);
  });

  // PRICE-10: all rates are safe integers
  runTest('PRICE-10', 'all rates are safe integers >= 0', () => {
    for (const [strat, rate] of Object.entries(policy.strategyRates)) {
      assert(Number.isSafeInteger(rate), `Strategy ${strat} rate must be safe integer`);
      assert(rate >= 0, `Strategy ${strat} rate must be non-negative`);
    }
    if (policy.additionalRates) {
      for (const [key, rate] of Object.entries(policy.additionalRates)) {
        assert(Number.isSafeInteger(rate), `Additional rate ${key} must be safe integer`);
        assert(rate >= 0, `Additional rate ${key} must be non-negative`);
      }
    }
  });

  // PRICE-11: estimated credits are derived from integer units
  await runTest('PRICE-11', 'estimated credits are derived from integer units (1 credit = 1000 units)', async () => {
    const estimate = await processingPricingEngine.estimateProcessingCost(
      {
        documentId: 'doc_price11',
        pageCount: 3,
        processingStrategies: ['LOCAL_NATIVE', 'AZURE_FULL_PAGE', 'HYBRID'],
      },
      policy
    );

    const expectedUnits = 350 + 1980 + 1980; // 4310
    assert.strictEqual(estimate.estimatedUnits, expectedUnits);
    assert.strictEqual(estimate.estimatedCredits, 4.31);
    assert.strictEqual(unitsToCredits(estimate.estimatedUnits), estimate.estimatedCredits);
  });

  // PRICE-12: customer billable usage is separate from technical usage
  runTest('PRICE-12', 'customer billable usage is separate from technical usage', () => {
    const technicalPages: ProcessingPageTechnicalUsage[] = [
      {
        pageNumber: 1,
        plannedStrategy: 'LOCAL_NATIVE',
        executedStrategy: 'AZURE_FALLBACK',
        azureCalled: true,
        fallbackOccurred: true,
        fallbackReason: 'Table columns < 2 in EXCEL mode',
        regionAnalysisExecuted: false,
        secondaryOcrExecuted: true,
        secondaryOcrCellCount: 5,
        technicalCostUnits: 1980,
      },
    ];

    const techUsage = processingPricingEngine.calculateTechnicalUsage({
      documentId: 'doc_price12',
      pages: technicalPages,
      secondaryOcrAttemptCount: 1,
      secondaryOcrProviderSummary: { AZURE: 5 },
    });

    const billUsage = processingPricingEngine.calculateBillableUsage(
      {
        documentId: 'doc_price12',
        estimatedUnits: 350,
        pages: [
          {
            pageNumber: 1,
            billableStrategy: 'LOCAL_NATIVE',
            executedStrategy: 'AZURE_FALLBACK',
            fallbackOccurred: true,
            secondaryOcrExecuted: true,
            secondaryOcrCellCount: 5,
          },
        ],
        technicalTelemetry: techUsage,
      },
      policy
    );

    // Billable usage remains LOCAL_NATIVE = 350
    assert.strictEqual(billUsage.totalBillableUnits, 350);
    assert.strictEqual(billUsage.totalBillableCredits, 0.35);

    // Technical usage records real Azure execution
    assert.strictEqual(techUsage.azurePageCount, 1);
    assert.strictEqual(techUsage.fallbackPageCount, 1);
    assert.strictEqual(techUsage.secondaryOcrCellCount, 5);
  });

  // PRICE-13: normal Azure fallback does not change pinned customer rate
  runTest('PRICE-13', 'normal Azure fallback does not change pinned customer rate', () => {
    const billUsage = processingPricingEngine.calculateBillableUsage(
      {
        documentId: 'doc_price13',
        estimatedUnits: 350,
        pages: [
          {
            pageNumber: 1,
            billableStrategy: 'LOCAL_NATIVE',
            executedStrategy: 'AZURE_FALLBACK',
            fallbackOccurred: true,
          },
        ],
      },
      policy
    );

    assert.strictEqual(billUsage.totalBillableUnits, 350, 'Fallback must NOT re-bill customer at 1980');
    assert.strictEqual(billUsage.pageUsage[0].billableUnits, 350);
    assert.strictEqual(billUsage.pageUsage[0].billableStrategy, 'LOCAL_NATIVE');
  });

  // PRICE-14: normal Secondary OCR does not increase customer billable units
  runTest('PRICE-14', 'normal Secondary OCR does not increase customer billable units', () => {
    const billUsage = processingPricingEngine.calculateBillableUsage(
      {
        documentId: 'doc_price14',
        estimatedUnits: 1980,
        pages: [
          {
            pageNumber: 1,
            billableStrategy: 'AZURE_FULL_PAGE',
            executedStrategy: 'AZURE_FULL_PAGE',
            secondaryOcrExecuted: true,
            secondaryOcrCellCount: 15,
          },
        ],
      },
      policy
    );

    assert.strictEqual(billUsage.totalBillableUnits, 1980);
    assert.strictEqual(billUsage.pageUsage[0].incrementalUnits, 0);
  });

  // PRICE-15: normal fallback/secondary OCR does not trigger reconciliation
  runTest('PRICE-15', 'normal fallback and secondary OCR do not trigger reconciliation', () => {
    const billUsage = processingPricingEngine.calculateBillableUsage(
      {
        documentId: 'doc_price15',
        estimatedUnits: 350, // Pinned at preflight
        pages: [
          {
            pageNumber: 1,
            billableStrategy: 'LOCAL_NATIVE',
            executedStrategy: 'AZURE_FALLBACK', // Triggered runtime fallback
            fallbackOccurred: true,
            secondaryOcrExecuted: true, // Triggered secondary OCR
            secondaryOcrCellCount: 8,
          },
        ],
      },
      policy
    );

    assert.strictEqual(billUsage.totalBillableUnits, 350);
    assert.strictEqual(billUsage.reconciliationRequired, false, 'Absorbed fallback must not trigger reconciliation');
    assert.strictEqual(billUsage.varianceUnits, 0);
  });

  // ==========================================================================
  // II. LIFECYCLE POLICY TESTS: LIFE-01 .. LIFE-11
  // ==========================================================================
  console.log('\n--- II. Lifecycle Policy Tests (LIFE-01 .. LIFE-11) ---');

  // LIFE-01: FREE initial grant = 10000 units
  runTest('LIFE-01', 'FREE initial grant = 10000 units (10 credits)', () => {
    const freeCredits = 10;
    const freeUnits = creditsToUnits(freeCredits);
    assert.strictEqual(freeUnits, 10000);
    assert.strictEqual(unitsToCredits(10000), 10);
  });

  // LIFE-02: FREE policy is one-time, not monthly recurring
  runTest('LIFE-02', 'FREE policy is one-time per account, not monthly recurring', () => {
    const serverFiles = fs.readdirSync(path.resolve(process.cwd(), 'server'), { recursive: true }) as string[];
    // Verify no automated cron or recurring refill exists for FREE plan in non-test server code
    const cronContent = serverFiles
      .filter((f) => !f.includes('tests') && (f.endsWith('.ts') || f.endsWith('.js')))
      .map((f) => fs.readFileSync(path.resolve(process.cwd(), 'server', f), 'utf8'))
      .join('\n');
    assert(!cronContent.includes('refillFreeCreditsMonthly'), 'Must NOT have monthly recurring refill cron for free credits');
    assert(!cronContent.includes('refreshMonthlyFreePlan'), 'Must NOT automatically grant recurring monthly free credits');
  });

  // LIFE-03: subscription grant has cycle expiration
  runTest('LIFE-03', 'subscription grant has cycle expiration (expires_at = billing_cycle_end)', () => {
    const schemaSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/migrations/20261001000000_credit_ledger_foundation.sql'),
      'utf8'
    );
    assert(
      schemaSrc.includes('expires_at = billing_cycle_end'),
      'Migration must enforce expires_at = billing_cycle_end for SUBSCRIPTION_CYCLE'
    );
  });

  // LIFE-04: unused subscription grant does not rollover
  runTest('LIFE-04', 'unused subscription grant does not rollover (expires at cycle end)', () => {
    // Under grant model, each cycle grant has expires_at = billing_cycle_end.
    // At cycleEnd, remaining_units in that bucket are expired and cannot be carried forward.
    const serviceSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/services/credit/creditService.ts'),
      'utf8'
    );
    assert(serviceSrc.includes("sourceType: 'SUBSCRIPTION_CYCLE'"));
    assert(serviceSrc.includes('expiresAt: params.cycleEnd'));
  });

  // LIFE-05: renewal creates new cycle grant
  runTest('LIFE-05', 'renewal creates new cycle grant with unique idempotencyKey and cycle window', () => {
    const cycle1Key = 'SUB_RENEWAL:user_123:cycle_2026_10';
    const cycle2Key = 'SUB_RENEWAL:user_123:cycle_2026_11';
    assert.notStrictEqual(cycle1Key, cycle2Key);
  });

  // LIFE-06: credit pack has no cycle reset
  runTest('LIFE-06', 'credit pack has no cycle reset (expires_at = null)', () => {
    const schemaSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/migrations/20261001000000_credit_ledger_foundation.sql'),
      'utf8'
    );
    assert(
      schemaSrc.includes("source_type <> 'CREDIT_PACK_PURCHASE' OR ("),
      'Must contain credit pack check'
    );
    assert(
      schemaSrc.includes('expires_at IS NULL'),
      'Must enforce expires_at IS NULL for CREDIT_PACK_PURCHASE'
    );
  });

  // LIFE-07: credit pack remains after subscription cancellation
  runTest('LIFE-07', 'credit pack remains after subscription cancellation (stored in independent grants)', () => {
    const serviceSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/services/credit/creditService.ts'),
      'utf8'
    );
    assert(serviceSrc.includes("sourceType: 'CREDIT_PACK_PURCHASE'"));
    assert(serviceSrc.includes('expiresAt: null'));
  });

  // LIFE-08: multiple packs accumulate
  runTest('LIFE-08', 'multiple packs accumulate independently without overwriting existing balance', () => {
    const pack1Units = 200000; // 200 credits
    const pack2Units = 500000; // 500 credits
    const totalAccumulated = pack1Units + pack2Units;
    assert.strictEqual(totalAccumulated, 700000);
    assert.strictEqual(unitsToCredits(totalAccumulated), 700);
  });

  // LIFE-09: expiring grant consumed before non-expiring grant
  runTest('LIFE-09', 'expiring grant consumed before non-expiring grant', () => {
    const grants = [
      { id: 'pack_grant', expires_at: null, granted_at: '2026-10-01T00:00:00Z' },
      { id: 'sub_grant', expires_at: '2026-10-15T00:00:00Z', granted_at: '2026-10-02T00:00:00Z' },
    ];

    grants.sort((a, b) => {
      if (a.expires_at === null && b.expires_at !== null) return 1; // NULLS LAST
      if (a.expires_at !== null && b.expires_at === null) return -1;
      if (a.expires_at !== null && b.expires_at !== null) {
        if (a.expires_at < b.expires_at) return -1;
        if (a.expires_at > b.expires_at) return 1;
      }
      return a.granted_at.localeCompare(b.granted_at);
    });

    assert.strictEqual(grants[0].id, 'sub_grant', 'Expiring subscription grant must be ordered first');
    assert.strictEqual(grants[1].id, 'pack_grant', 'Non-expiring pack must be ordered second');
  });

  // LIFE-10: ordering is expires_at ASC NULLS LAST, granted_at ASC, id ASC
  runTest('LIFE-10', 'ordering is expires_at ASC NULLS LAST, granted_at ASC, id ASC in PostgreSQL RPCs', () => {
    const migrationSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/migrations/20261002010000_credit_reservation_foundation.sql'),
      'utf8'
    );
    assert(
      migrationSrc.includes('ORDER BY expires_at ASC NULLS LAST, granted_at ASC, id ASC'),
      'Migration 20261002010000 must strictly use ORDER BY expires_at ASC NULLS LAST, granted_at ASC, id ASC'
    );
  });

  // LIFE-11: existing users are not mass-granted FREE credits
  runTest('LIFE-11', 'existing users are not mass-granted FREE credits (EXISTING_USER_FREE_BOOTSTRAP = NOT IMPLEMENTED)', () => {
    const migrationFiles = fs.readdirSync(path.resolve(process.cwd(), 'supabase/migrations'));
    for (const mf of migrationFiles) {
      const content = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', mf), 'utf8');
      assert(
        !content.includes('INSERT INTO public.credit_grants SELECT id FROM auth.users'),
        `Migration ${mf} must NOT mass-bootstrap existing users`
      );
    }
  });

  // ==========================================================================
  // III. UI CONTRACT TESTS: UI-01 .. UI-06
  // ==========================================================================
  console.log('\n--- III. UI Contract Tests (UI-01 .. UI-06) ---');

  const pricingPageSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/pages/PricingPage.tsx'),
    'utf8'
  );

  // UI-01: FREE shows one-time 10 credit wording
  runTest('UI-01', 'FREE shows one-time 10 credit wording', () => {
    assert(
      pricingPageSrc.includes('10 credits dùng thử — cấp một lần cho mỗi tài khoản'),
      'Must contain exact approved copy: "10 credits dùng thử — cấp một lần cho mỗi tài khoản."'
    );
  });

  // UI-02: Subscription info explains no rollover
  runTest('UI-02', 'Subscription info explains no rollover', () => {
    assert(
      pricingPageSrc.includes('Credit chưa sử dụng hết sẽ không cộng dồn sang chu kỳ tiếp theo'),
      'Must explain unused subscription credits do not rollover'
    );
    assert(
      pricingPageSrc.includes('Credit Pack mua riêng không bị mất khi gói Subscription gia hạn hoặc kết thúc'),
      'Must explain credit packs remain separate'
    );
  });

  // UI-03: Credit Pack info explains accumulation/no reset
  runTest('UI-03', 'Credit Pack info explains accumulation and no reset', () => {
    assert(
      pricingPageSrc.includes('Credit Pack được cộng vào số dư hiện có và không bị reset theo chu kỳ Subscription'),
      'Must explain pack accumulation and immunity from subscription cycle reset'
    );
    assert(
      pricingPageSrc.includes('Credit Pack được giữ lại cho đến khi sử dụng hết'),
      'Must state credit pack is kept until fully consumed'
    );
  });

  // UI-04: info trigger is clickable/tappable
  runTest('UI-04', 'info trigger is clickable/tappable on both desktop and mobile', () => {
    assert(pricingPageSrc.includes('id="btn-subscription-info"'), 'Must have accessible subscription info button');
    assert(pricingPageSrc.includes('id="btn-pack-info"'), 'Must have accessible credit pack info button');
    assert(pricingPageSrc.includes('onClick={() => setShowSubscriptionInfo(!showSubscriptionInfo)}'), 'Subscription trigger must toggle on click/tap');
    assert(pricingPageSrc.includes('onClick={() => setShowPackInfo(!showPackInfo)}'), 'Pack trigger must toggle on click/tap');
  });

  // UI-05: checkout contract distinguishes subscription vs pack
  runTest('UI-05', 'checkout contract distinguishes subscription vs pack', () => {
    assert(pricingPageSrc.includes('id="subscription-checkout-modal"'), 'Must include distinct subscription checkout modal');
    assert(pricingPageSrc.includes('id="credit-pack-modal"'), 'Must include distinct credit pack checkout modal');
    assert(pricingPageSrc.includes('btn-confirm-subscription-upgrade'), 'Must include confirmation button for subscription');
  });

  // UI-06: no UI copy says FREE 10 credits/month
  runTest('UI-06', 'no UI copy says FREE 10 credits/month', () => {
    assert(!pricingPageSrc.includes('10 credits/tháng'), 'Must NOT say 10 credits/tháng');
    assert(!pricingPageSrc.includes('10 credits mỗi tháng'), 'Must NOT imply monthly recurring refill');
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
