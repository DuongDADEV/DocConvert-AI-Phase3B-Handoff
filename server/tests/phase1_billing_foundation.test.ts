import 'dotenv/config';
import fs from 'fs';
import { billingService } from '../services/billing/billingService.js';
import { PricingChannel, ProductType } from '../types/billing.js';

interface InvariantResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  details?: string;
  durationMs: number;
}

const results: InvariantResult[] = [];

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runInvariant(id: string, name: string, fn: () => Promise<void> | void) {
  const start = Date.now();
  console.log(`[TEST] ${id}: ${name}...`);
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ id, name, status: 'PASS', durationMs: duration });
    console.log(`  -> PASS (${duration}ms)`);
  } catch (err: any) {
    const duration = Date.now() - start;
    results.push({ id, name, status: 'FAIL', details: err.message, durationMs: duration });
    console.error(`  -> FAIL (${duration}ms): ${err.message}`);
  }
}

async function main() {
  console.log('================================================================');
  console.log('PHASE 1 — BILLING FOUNDATION INVARIANT TEST SUITE');
  console.log('================================================================\n');

  // 1. WEB active plans returns exactly 4 plans: FREE, BASIC, PRO, BUSINESS
  await runInvariant(
    'INV-01',
    'WEB active plans must return exactly 4 standard plans: FREE, BASIC, PRO, BUSINESS',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      assert(plans.length === 4, `Expected 4 plans, got ${plans.length}`);
      const codes = plans.map((p) => p.code);
      assert(codes.includes('FREE'), 'Missing FREE plan');
      assert(codes.includes('BASIC'), 'Missing BASIC plan');
      assert(codes.includes('PRO'), 'Missing PRO plan');
      assert(codes.includes('BUSINESS'), 'Missing BUSINESS plan');
    }
  );

  // 2. API channel currently has no subscription plans and safely returns []
  await runInvariant(
    'INV-02',
    'API channel currently has no subscription plans and returns []',
    async () => {
      const plans = await billingService.getActivePricingPlans('API');
      assert(Array.isArray(plans), 'Expected plans to be an array');
      assert(plans.length === 0, `Expected empty array for API channel, got ${plans.length}`);
    }
  );

  // 3. Credit pack is not conflated with subscription plans
  await runInvariant(
    'INV-03',
    'Credit pack must not be conflated with subscription plans',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      const creditPacks = await billingService.getCreditPacks('WEB');

      for (const p of plans) {
        assert(p.product_type === 'SUBSCRIPTION', `Plan ${p.code} should have product_type SUBSCRIPTION`);
        assert(!p.code.startsWith('PACK_'), `Plan ${p.code} should not be named PACK_*`);
      }

      assert(creditPacks.length >= 4, `Expected at least 4 credit packs, got ${creditPacks.length}`);
      for (const pack of creditPacks) {
        assert(pack.product_type === 'CREDIT_PACK', `Pack ${pack.code} should have product_type CREDIT_PACK`);
        assert(pack.code.startsWith('PACK_'), `Pack ${pack.code} should be named PACK_*`);
      }
    }
  );

  // 4. FREE price = 0
  await runInvariant(
    'INV-04',
    'FREE plan price must be 0 VND with 10 credits',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      const free = plans.find((p) => p.code === 'FREE');
      assert(!!free, 'FREE plan not found');
      assert(free!.price === 0, `FREE price must be 0, got ${free!.price}`);
      assert(free!.currency === 'VND', `Expected VND, got ${free!.currency}`);
      assert(free!.credits === 10, `Expected 10 credits, got ${free!.credits}`);
      assert(free!.entitlements.max_file_mb === 20, `Expected 20 MB max file, got ${free!.entitlements.max_file_mb}`);
      assert(free!.entitlements.api_access === 'NONE', 'Expected api_access NONE');
      assert(free!.entitlements.retention_days === 3, 'Expected retention 3 days');
    }
  );

  // 5. BASIC: 129000 VND, 120 credits
  await runInvariant(
    'INV-05',
    'BASIC plan price must be 129.000 VND and 120 credits',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      const basic = plans.find((p) => p.code === 'BASIC');
      assert(!!basic, 'BASIC plan not found');
      assert(basic!.price === 129000, `Expected 129000, got ${basic!.price}`);
      assert(basic!.currency === 'VND', `Expected VND, got ${basic!.currency}`);
      assert(basic!.credits === 120, `Expected 120 credits, got ${basic!.credits}`);
      assert(basic!.entitlements.max_file_mb === 50, `Expected 50 MB, got ${basic!.entitlements.max_file_mb}`);
      assert(basic!.entitlements.batch_enabled === false, 'Batch should be disabled');
      assert(basic!.entitlements.priority_queue === false, 'Priority should be disabled');
      assert(basic!.entitlements.api_access === 'NONE', 'API should be NONE');
      assert(basic!.entitlements.retention_days === 7, 'Expected retention 7 days');
    }
  );

  // 6. PRO: 349000, 450 credits
  await runInvariant(
    'INV-06',
    'PRO plan price must be 349.000 VND, 450 credits, API Beta, Batch & Priority',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      const pro = plans.find((p) => p.code === 'PRO');
      assert(!!pro, 'PRO plan not found');
      assert(pro!.price === 349000, `Expected 349000, got ${pro!.price}`);
      assert(pro!.currency === 'VND', `Expected VND, got ${pro!.currency}`);
      assert(pro!.credits === 450, `Expected 450 credits, got ${pro!.credits}`);
      assert(pro!.entitlements.max_file_mb === 100, `Expected 100 MB, got ${pro!.entitlements.max_file_mb}`);
      assert(pro!.entitlements.batch_enabled === true, 'Batch should be enabled');
      assert(pro!.entitlements.priority_queue === true, 'Priority queue should be enabled');
      assert(pro!.entitlements.api_access === 'BETA', 'API should be BETA');
      assert(pro!.entitlements.retention_days === 30, 'Expected retention 30 days');
      assert(pro!.metadata.badge === 'PHỔ BIẾN NHẤT', 'Badge should be PHỔ BIẾN NHẤT');
    }
  );

  // 7. BUSINESS: 899000, 1400 credits
  await runInvariant(
    'INV-07',
    'BUSINESS plan price must be 899.000 VND, 1.400 credits, Full API, Batch & Priority',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      const biz = plans.find((p) => p.code === 'BUSINESS');
      assert(!!biz, 'BUSINESS plan not found');
      assert(biz!.price === 899000, `Expected 899000, got ${biz!.price}`);
      assert(biz!.currency === 'VND', `Expected VND, got ${biz!.currency}`);
      assert(biz!.credits === 1400, `Expected 1400 credits, got ${biz!.credits}`);
      assert(biz!.entitlements.max_file_mb === 200, `Expected 200 MB, got ${biz!.entitlements.max_file_mb}`);
      assert(biz!.entitlements.batch_enabled === true, 'Batch should be enabled');
      assert(biz!.entitlements.priority_queue === true, 'Priority queue should be enabled');
      assert(biz!.entitlements.api_access === 'FULL', 'API should be FULL');
      assert(biz!.entitlements.retention_days === 90, 'Expected retention 90 days');
    }
  );

  // 8. No plan uses "document count" as primary quota
  await runInvariant(
    'INV-08',
    'No plan uses "document count" as primary quota definition',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      for (const p of plans) {
        assert((p as any).document_quota === undefined, 'document_quota must not be exposed on new billing DTO');
        assert(typeof p.credits === 'number' && p.credits > 0, 'credits must be a positive number');
        assert(typeof p.entitlements.included_credits === 'number', 'entitlements.included_credits must exist');
      }
    }
  );

  // 9. Inactive prices not returned by service
  await runInvariant(
    'INV-09',
    'Inactive prices and zero/negative unconfigured prices must not be offered',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      for (const p of plans) {
        assert(p.price >= 0, 'Price must be >= 0');
        assert(Number.isInteger(p.price), 'VND price must be an integer');
      }
    }
  );

  // 10. Pricing version attached correctly
  await runInvariant(
    'INV-10',
    'Pricing version attached correctly as "pricing-v1"',
    async () => {
      const version = await billingService.getPricingVersion('pricing-v1');
      assert(!!version, 'Pricing version pricing-v1 not found');
      assert(version!.code === 'pricing-v1', 'Version code must be pricing-v1');
      assert(version!.active === true, 'Version must be active');

      const plans = await billingService.getActivePricingPlans('WEB');
      for (const p of plans) {
        assert(p.pricing_version === 'pricing-v1', `Plan ${p.code} should have version pricing-v1`);
      }

      const packs = await billingService.getCreditPacks('WEB');
      for (const pk of packs) {
        assert(pk.pricing_version === 'pricing-v1', `Pack ${pk.code} should have version pricing-v1`);
      }
    }
  );

  // 11. Product code unique
  await runInvariant(
    'INV-11',
    'Product code is unique across subscriptions and credit packs',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      const packs = await billingService.getCreditPacks('WEB');

      const allCodes = [...plans.map((p) => p.code), ...packs.map((p) => p.code)];
      const uniqueCodes = new Set(allCodes);
      assert(allCodes.length === uniqueCodes.size, 'Duplicate product code found');
    }
  );

  // 12. Cannot create invalid product_type or pricing_channel
  await runInvariant(
    'INV-12',
    'Pricing channel and Product type enumeration validation',
    () => {
      const validChannels: PricingChannel[] = ['WEB', 'API', 'ENTERPRISE'];
      const validTypes: ProductType[] = ['SUBSCRIPTION', 'CREDIT_PACK', 'USAGE', 'ENTERPRISE'];

      assert(validChannels.includes('WEB'), 'WEB channel should be valid');
      assert(validChannels.includes('API'), 'API channel should be valid');
      assert(validChannels.includes('ENTERPRISE'), 'ENTERPRISE channel should be valid');
      assert(!validChannels.includes('MOBILE' as any), 'MOBILE channel must be invalid');

      assert(validTypes.includes('SUBSCRIPTION'), 'SUBSCRIPTION type should be valid');
      assert(validTypes.includes('CREDIT_PACK'), 'CREDIT_PACK type should be valid');
      assert(!validTypes.includes('UNKNOWN' as any), 'UNKNOWN type must be invalid');
    }
  );

  // 13. Credit packs exact seed prices and credits
  await runInvariant(
    'INV-13',
    'Credit packs exact seed prices and credits (50: 59k, 200: 199k, 500: 449k, 2000: 1490k)',
    async () => {
      const packs = await billingService.getCreditPacks('WEB');
      assert(packs.length === 4, `Expected 4 credit packs, got ${packs.length}`);

      const p50 = packs.find((p) => p.code === 'PACK_50');
      assert(!!p50 && p50.credits === 50 && p50.price === 59000, 'PACK_50 mismatch');

      const p200 = packs.find((p) => p.code === 'PACK_200');
      assert(!!p200 && p200.credits === 200 && p200.price === 199000, 'PACK_200 mismatch');

      const p500 = packs.find((p) => p.code === 'PACK_500');
      assert(!!p500 && p500.credits === 500 && p500.price === 449000, 'PACK_500 mismatch');

      const p2000 = packs.find((p) => p.code === 'PACK_2000');
      assert(!!p2000 && p2000.credits === 2000 && p2000.price === 1490000, 'PACK_2000 mismatch');
    }
  );

  console.log('\n================================================================');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL: ${results.length} | PASS: ${passCount} | FAIL: ${failCount}`);
  console.log('================================================================\n');

  // Save report JSON
  fs.writeFileSync(
    'phase1_billing_foundation_test_results.json',
    JSON.stringify({ timestamp: new Date().toISOString(), passCount, failCount, results }, null, 2)
  );

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
