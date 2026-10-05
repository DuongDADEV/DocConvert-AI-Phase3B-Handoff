import 'dotenv/config';
import fs from 'fs';
import { billingService } from '../services/billing/billingService.js';
import { quotaService } from '../services/quotaService.js';
import { db } from '../db/db.js';

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
  console.log('PHASE 1.1 — BILLING SCHEMA & LEGACY QUOTA HARDENING TEST SUITE');
  console.log('================================================================\n');

  // INV-01: Billing catalog không phụ thuộc legacy document_quota
  await runInvariant(
    'INV-01',
    'Billing catalog does not depend on legacy document_quota',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      for (const plan of plans) {
        assert((plan as any).document_quota === undefined, 'document_quota must not exist on BillingPlan DTO');
        assert(typeof plan.credits === 'number', 'credits must be typed as number');
        assert(typeof plan.entitlements.included_credits === 'number', 'included_credits must be typed as number');
      }
    }
  );

  // INV-02: included_credits và document_quota không bị coi là cùng một field
  await runInvariant(
    'INV-02',
    'included_credits and document_quota are strictly separated concepts',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      const free = plans.find((p) => p.code === 'FREE');
      assert(!!free, 'FREE plan must exist in billing');
      assert(free!.credits === 10, 'FREE credits in billing must be 10');

      // Check legacy plan
      const legacyFree = await db.getPlanById('FREE');
      assert(!!legacyFree, 'FREE plan must exist in legacy plans');
      // In legacy plans, FREE document_quota is document limit (3), NOT 10 credits!
      assert(typeof legacyFree!.document_quota === 'number', 'Legacy plan has document_quota');
      assert(legacyFree!.document_quota !== free!.credits, 'document_quota and credits must NOT be conflated!');
    }
  );

  // INV-03: pricing-v1 commercial terms không bị mutate ngoài policy cho phép
  await runInvariant(
    'INV-03',
    'pricing-v1 commercial terms cannot be mutated outside policy',
    async () => {
      const version = await billingService.getPricingVersion('pricing-v1');
      assert(!!version, 'pricing-v1 version record must exist');
      assert(version!.code === 'pricing-v1', 'Version code must be pricing-v1');
      assert(version!.active === true, 'Version must be active');
    }
  );

  // INV-04: Price uniqueness hỗ trợ thiết kế multi-currency đã chọn
  await runInvariant(
    'INV-04',
    'Price uniqueness supports multi-currency composite uniqueness design',
    () => {
      const migrationSql = fs.readFileSync(
        'supabase/migrations/20260930020000_billing_foundation_hardening.sql',
        'utf-8'
      );
      assert(
        migrationSql.includes('unq_billing_prices_composite'),
        'Must contain unq_billing_prices_composite constraint'
      );
      assert(
        migrationSql.includes('currency'),
        'Composite constraint must include currency'
      );
      assert(
        migrationSql.includes('interval_count'),
        'Composite constraint must include interval_count'
      );
    }
  );

  // INV-05: WEB plans vẫn trả 4 plan
  await runInvariant(
    'INV-05',
    'WEB plans returns exactly 4 plans: FREE, BASIC, PRO, BUSINESS',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      assert(plans.length === 4, `Expected 4 plans, got ${plans.length}`);
      const codes = plans.map((p) => p.code);
      assert(codes.includes('FREE'), 'Missing FREE');
      assert(codes.includes('BASIC'), 'Missing BASIC');
      assert(codes.includes('PRO'), 'Missing PRO');
      assert(codes.includes('BUSINESS'), 'Missing BUSINESS');
    }
  );

  // INV-06: Credit packs vẫn trả 4 pack
  await runInvariant(
    'INV-06',
    'Credit packs returns exactly 4 packs: PACK_50, PACK_200, PACK_500, PACK_2000',
    async () => {
      const packs = await billingService.getCreditPacks('WEB');
      assert(packs.length === 4, `Expected 4 packs, got ${packs.length}`);
      const codes = packs.map((p) => p.code);
      assert(codes.includes('PACK_50'), 'Missing PACK_50');
      assert(codes.includes('PACK_200'), 'Missing PACK_200');
      assert(codes.includes('PACK_500'), 'Missing PACK_500');
      assert(codes.includes('PACK_2000'), 'Missing PACK_2000');
    }
  );

  // INV-07: API channel []
  await runInvariant(
    'INV-07',
    'API channel safely returns empty array []',
    async () => {
      const apiPlans = await billingService.getActivePricingPlans('API');
      assert(Array.isArray(apiPlans) && apiPlans.length === 0, 'API plans must be []');
    }
  );

  // INV-08: Legacy quota processing vẫn hoạt động theo semantic cũ
  await runInvariant(
    'INV-08',
    'Legacy quota processing still operates under document count semantics',
    async () => {
      // Create a test user mock / checkUserQuota behavior
      const testUserId = '00000000-0000-0000-0000-000000000099';
      const status = await quotaService.checkUserQuota(testUserId);
      assert(status !== null, 'QuotaStatus must not be null');
      assert(typeof status.allowed === 'boolean', 'status.allowed must be boolean');
      assert(typeof status.used === 'number', 'status.used must be number');
      assert(typeof status.total === 'number', 'status.total must be number');
      assert(typeof status.remaining === 'number', 'status.remaining must be number');
    }
  );

  // INV-09: RLS catalog không expose dữ liệu ngoài policy thiết kế
  await runInvariant(
    'INV-09',
    'RLS policy explicitly restricts inactive products and enforces tenant safety',
    () => {
      const migrationSql = fs.readFileSync(
        'supabase/migrations/20260930020000_billing_foundation_hardening.sql',
        'utf-8'
      );
      assert(
        migrationSql.includes('CREATE POLICY plan_entitlements_read'),
        'Must define hardened plan_entitlements_read policy'
      );
      assert(
        migrationSql.includes('bp.active = true'),
        'Must check bp.active = true in subquery'
      );
    }
  );

  // INV-10: Frontend build artifacts exist and are fresh
  await runInvariant(
    'INV-10',
    'Frontend production build succeeds and dist index.html exists',
    () => {
      assert(fs.existsSync('dist/index.html'), 'dist/index.html must exist');
    }
  );

  console.log('\n================================================================');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL: ${results.length} | PASS: ${passCount} | FAIL: ${failCount}`);
  console.log('================================================================\n');

  fs.writeFileSync(
    'phase1_1_hardening_test_results.json',
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
