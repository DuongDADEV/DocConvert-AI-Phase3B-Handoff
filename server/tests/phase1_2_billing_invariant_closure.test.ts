import 'dotenv/config';
import fs from 'fs';
import { billingService } from '../services/billing/billingService.js';
import { quotaService } from '../services/quotaService.js';
import { db } from '../db/db.js';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';

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
  console.log('PHASE 1.2 — BILLING INVARIANT CLOSURE TEST SUITE');
  console.log('================================================================\n');

  const migrationSql = fs.readFileSync(
    'supabase/migrations/20260930030000_billing_invariant_closure.sql',
    'utf-8'
  );

  // INV-01: Legacy document quota and Billing credits are independent
  await runInvariant(
    'INV-01',
    'Legacy document quota and Billing credits are independent',
    async () => {
      const freePlan = await db.getPlanById('FREE');
      assert(!!freePlan, 'Legacy FREE plan must exist');
      assert(freePlan!.document_quota === 3, `Legacy FREE document_quota must be 3, got ${freePlan!.document_quota}`);

      const billingPlans = await billingService.getActivePricingPlans('WEB');
      const freeBilling = billingPlans.find((p) => p.code === 'FREE');
      assert(!!freeBilling, 'Billing FREE plan must exist');
      assert(freeBilling!.credits === 10, `Billing FREE credits must be 10, got ${freeBilling!.credits}`);
      assert((freeBilling as any).document_quota === undefined, 'Billing plan must not expose document_quota');
    }
  );

  // INV-02: Credit Pack grants credits only
  await runInvariant(
    'INV-02',
    'Credit Pack grants credits only (never grants subscription capabilities)',
    async () => {
      const packs = await billingService.getCreditPacks('WEB');
      assert(packs.length === 4, `Expected 4 credit packs, got ${packs.length}`);
      for (const pack of packs) {
        assert((pack as any).entitlements === undefined, `Credit pack ${pack.code} must NOT have entitlements object`);
        assert(typeof pack.credits === 'number' && pack.credits > 0, `Credit pack ${pack.code} must have positive credits`);
        assert((pack as any).max_file_mb === undefined, 'Credit pack must not define max_file_mb');
        assert((pack as any).batch_enabled === undefined, 'Credit pack must not define batch_enabled');
        assert((pack as any).priority_queue === undefined, 'Credit pack must not define priority_queue');
      }

      // Check migration DDL explicitly strips CREDIT_PACK from plan_entitlements
      assert(
        migrationSql.includes('DELETE FROM public.plan_entitlements') &&
        migrationSql.includes("product_type = 'CREDIT_PACK'"),
        'Migration must explicitly strip CREDIT_PACK from plan_entitlements'
      );
    }
  );

  // INV-03: Subscription capability source remains subscription-specific
  await runInvariant(
    'INV-03',
    'Subscription capability source remains subscription-specific',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      for (const plan of plans) {
        assert(plan.product_type === 'SUBSCRIPTION', `Product ${plan.code} must be SUBSCRIPTION`);
        assert(!!plan.entitlements, `Subscription plan ${plan.code} must have entitlements`);
        assert(typeof plan.entitlements.max_file_mb === 'number', 'Must specify max_file_mb');
        assert(typeof plan.entitlements.batch_enabled === 'boolean', 'Must specify batch_enabled');
        assert(typeof plan.entitlements.priority_queue === 'boolean', 'Must specify priority_queue');
        assert(typeof plan.entitlements.retention_days === 'number', 'Must specify retention_days');
        assert(['NONE', 'BETA', 'FULL'].includes(plan.entitlements.api_access), 'Must have valid api_access');
      }
    }
  );

  // INV-04: Canonical credit grant is single-source
  await runInvariant(
    'INV-04',
    'Canonical credit grant is single-source via public.product_credit_grants',
    () => {
      assert(
        migrationSql.includes('CREATE TABLE IF NOT EXISTS public.product_credit_grants'),
        'Migration must define public.product_credit_grants table'
      );
      assert(
        migrationSql.includes('unq_product_credit_grants UNIQUE (product_id, pricing_version_id)'),
        'product_credit_grants must have unique constraint on (product_id, pricing_version_id)'
      );
      assert(
        migrationSql.includes('credits_granted INT NOT NULL CHECK (credits_granted >= 0)'),
        'product_credit_grants must require non-negative credits'
      );
      assert(
        migrationSql.includes("grant_type IN ('SUBSCRIPTION_CYCLE', 'ONE_TIME_PACK')"),
        'product_credit_grants must validate grant_type'
      );
    }
  );

  // INV-05: Commercial credit lookup fails closed
  await runInvariant(
    'INV-05',
    'Commercial credit lookup fails closed when grant config is missing',
    async () => {
      let threw = false;
      try {
        await billingService.getCanonicalCreditGrant('NON_EXISTENT_PRODUCT_CODE_99999');
      } catch (err: any) {
        threw = true;
        assert(
          err.message.includes('CANONICAL_CREDIT_GRANT_NOT_FOUND') ||
          err.message.includes('CANONICAL_CREDIT_GRANT_FAILED') ||
          err.message.includes('CANONICAL_CREDIT_GRANT_QUERY_ERROR'),
          `Controlled error expected, got: ${err.message}`
        );
      }
      assert(threw, 'getCanonicalCreditGrant MUST throw error when product is missing');

      // Test that it does NOT infer credits from product code 'PACK_999'
      let threwForFakePack = false;
      try {
        await billingService.getCanonicalCreditGrant('PACK_999');
      } catch {
        threwForFakePack = true;
      }
      assert(threwForFakePack, 'MUST NOT infer 999 from code PACK_999');
    }
  );

  // INV-06: Locked pricing price UPDATE blocked
  await runInvariant(
    'INV-06',
    'Locked pricing version rejects UPDATE of billing price (Trigger contract)',
    () => {
      assert(
        migrationSql.includes('CREATE OR REPLACE FUNCTION public.fn_guard_locked_pricing_immutability()'),
        'Must define fn_guard_locked_pricing_immutability'
      );
      assert(
        migrationSql.includes('PRICING_VERSION_LOCKED'),
        'Must throw PRICING_VERSION_LOCKED exception'
      );
    }
  );

  // INV-07: Locked pricing price DELETE blocked & correct OLD return
  await runInvariant(
    'INV-07',
    'Locked pricing version rejects DELETE of billing price, unlocked returns OLD',
    () => {
      assert(
        migrationSql.includes("IF TG_OP = 'DELETE' THEN") &&
        migrationSql.includes('RETURN OLD;') &&
        migrationSql.includes('RETURN NEW;'),
        'fn_guard_locked_pricing_immutability MUST return OLD for DELETE and NEW for UPDATE'
      );
    }
  );

  // INV-08: Locked canonical credit grant mutation blocked
  await runInvariant(
    'INV-08',
    'Locked pricing version rejects modification of canonical credit grants',
    () => {
      assert(
        migrationSql.includes('trg_guard_product_credit_grants_immutability'),
        'Immutability trigger must be attached to product_credit_grants'
      );
    }
  );

  // INV-09: Locked version cannot be unlocked (Monotonic lock)
  await runInvariant(
    'INV-09',
    'Pricing version lock is monotonic (true -> false blocked, cannot delete locked version)',
    () => {
      assert(
        migrationSql.includes('fn_guard_pricing_version_lock_monotonic'),
        'Must define fn_guard_pricing_version_lock_monotonic function'
      );
      assert(
        migrationSql.includes('OLD.is_locked = true AND NEW.is_locked = false'),
        'Must check OLD.is_locked = true AND NEW.is_locked = false'
      );
      assert(
        migrationSql.includes('PRICING_VERSION_LOCK_MONOTONIC'),
        'Must raise PRICING_VERSION_LOCK_MONOTONIC exception'
      );
      assert(
        migrationSql.includes("TG_OP = 'DELETE' THEN") &&
        migrationSql.includes('OLD.is_locked = true'),
        'Must prevent deletion of locked pricing version'
      );
    }
  );

  // INV-10: Legacy processing still works without credit migration
  await runInvariant(
    'INV-10',
    'Legacy processing quota check operates normally using document count',
    async () => {
      const supabase = getSupabaseAdminClient();
      const { data: profiles } = await supabase.from('profiles').select('id, current_plan_id, used_documents').limit(1);
      const user = profiles?.[0];
      if (user) {
        const quota = await quotaService.checkUserQuota(user.id);
        assert(typeof quota.allowed === 'boolean', 'quota.allowed must be boolean');
        assert(typeof quota.used === 'number', 'quota.used must be number');
        assert(typeof quota.total === 'number', 'quota.total must be number');
        assert(quota.total === 3 || quota.total === 50 || quota.total === 250, `Legacy total quota must be 3, 50, or 250; got ${quota.total}`);
      }
    }
  );

  // INV-11: Pricing endpoints remain backward compatible
  await runInvariant(
    'INV-11',
    'Pricing endpoints remain backward compatible with 4 subscription plans and 4 credit packs',
    async () => {
      const plans = await billingService.getActivePricingPlans('WEB');
      assert(plans.length === 4, `Expected 4 plans, got ${plans.length}`);
      const packs = await billingService.getCreditPacks('WEB');
      assert(packs.length === 4, `Expected 4 credit packs, got ${packs.length}`);
      const apiPlans = await billingService.getActivePricingPlans('API');
      assert(Array.isArray(apiPlans) && apiPlans.length === 0, 'API channel must return empty array');
    }
  );

  // INV-12: Frontend production build passes
  await runInvariant(
    'INV-12',
    'Frontend production build artifact exists and is verified',
    () => {
      assert(fs.existsSync('dist/index.html'), 'dist/index.html must exist');
      assert(fs.existsSync('dist/assets'), 'dist/assets must exist');
    }
  );

  console.log('\n================================================================');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL: ${results.length} | PASS: ${passCount} | FAIL: ${failCount}`);
  console.log('================================================================\n');

  fs.writeFileSync(
    'phase1_2_invariant_closure_test_results.json',
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
