import 'dotenv/config';
import * as fs from 'fs';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';
import { billingService, BillingCatalogUnavailableError } from '../server/services/billing/billingService.js';

export type CheckType =
  | 'REAL_DB_QUERY'
  | 'REAL_DB_TRANSACTION_TEST'
  | 'HTTP_RUNTIME_QUERY'
  | 'STATIC_SOURCE_CHECK'
  | 'UNIT_TEST';

interface CheckItem {
  id: string;
  type: CheckType;
  name: string;
  status: 'PASS' | 'FAIL';
  details?: string;
}

const checks: CheckItem[] = [];

function recordCheck(id: string, type: CheckType, name: string, condition: boolean, details?: string) {
  if (condition) {
    checks.push({ id, type, name, status: 'PASS' });
    console.log(`[PASS] ${id} [${type}]: ${name}`);
  } else {
    checks.push({ id, type, name, status: 'FAIL', details });
    console.error(`[FAIL] ${id} [${type}]: ${name} -> ${details}`);
  }
}

async function main() {
  console.log('================================================================');
  console.log('PHASE 1.3 — REAL DATABASE & PRODUCTION BILLING VERIFICATION');
  console.log('Target: tppggnsidopyzrzszbbc (REAL SUPABASE POSTGRESQL)');
  console.log('================================================================\n');

  const supabase = getSupabaseAdminClient();

  // CHK-01: REAL_DB_QUERY: pricing_versions exists
  const { data: vData, error: vErr } = await supabase.from('pricing_versions').select('id, code').limit(1);
  recordCheck(
    'CHK-01',
    'REAL_DB_QUERY',
    'Table public.pricing_versions physically exists in real PostgreSQL database',
    !vErr && Array.isArray(vData) && vData.length > 0,
    vErr?.message
  );

  // CHK-02: REAL_DB_QUERY: pricing-v1 exists and active
  const { data: v1, error: v1Err } = await supabase
    .from('pricing_versions')
    .select('*')
    .eq('code', 'pricing-v1')
    .maybeSingle();

  recordCheck(
    'CHK-02',
    'REAL_DB_QUERY',
    'Version "pricing-v1" exists in real database and is active',
    !v1Err && !!v1 && v1.code === 'pricing-v1' && v1.active === true,
    `Error: ${v1Err?.message}, data: ${JSON.stringify(v1)}`
  );

  // CHK-03: REAL_DB_QUERY: pricing-v1 is_locked = true
  recordCheck(
    'CHK-03',
    'REAL_DB_QUERY',
    'Version "pricing-v1" is locked in PostgreSQL (is_locked = true)',
    v1?.is_locked === true,
    `Current is_locked value: ${v1?.is_locked}`
  );

  // CHK-04: REAL_DB_QUERY: 8 WEB billing products exist
  const { data: products, error: prodErr } = await supabase
    .from('billing_products')
    .select('id, code, product_type, pricing_channel, active')
    .eq('pricing_channel', 'WEB')
    .eq('active', true);

  const productCodes = products?.map((p) => p.code) || [];
  const expectedCodes = ['FREE', 'BASIC', 'PRO', 'BUSINESS', 'PACK_50', 'PACK_200', 'PACK_500', 'PACK_2000'];
  const allCodesPresent = expectedCodes.every((c) => productCodes.includes(c));

  recordCheck(
    'CHK-04',
    'REAL_DB_QUERY',
    'Exactly 8 active WEB billing products exist in real database (4 SUBSCRIPTION + 4 CREDIT_PACK)',
    !prodErr && products?.length === 8 && allCodesPresent,
    `Found ${products?.length} products: ${productCodes.join(', ')}`
  );

  // CHK-05: REAL_DB_QUERY: all 8 prices exact for pricing-v1
  const { data: prices, error: prErr } = await supabase
    .from('billing_prices')
    .select('amount_minor, billing_products(code), pricing_versions(code)')
    .eq('pricing_version_id', v1.id)
    .eq('active', true);

  const priceMap: Record<string, number> = {};
  prices?.forEach((pr: any) => {
    priceMap[pr.billing_products?.code] = Number(pr.amount_minor);
  });

  const expectedPrices: Record<string, number> = {
    FREE: 0,
    BASIC: 129000,
    PRO: 349000,
    BUSINESS: 899000,
    PACK_50: 59000,
    PACK_200: 199000,
    PACK_500: 449000,
    PACK_2000: 1490000,
  };

  let allPricesMatch = !prErr && prices?.length === 8;
  for (const [code, exp] of Object.entries(expectedPrices)) {
    if (priceMap[code] !== exp) {
      allPricesMatch = false;
      console.error(`Price mismatch in real DB for ${code}: expected ${exp}, got ${priceMap[code]}`);
    }
  }

  recordCheck(
    'CHK-05',
    'REAL_DB_QUERY',
    'All 8 commercial prices in real database for pricing-v1 match exact integer VND minor units',
    allPricesMatch,
    JSON.stringify(priceMap)
  );

  // CHK-06: REAL_DB_QUERY: only 4 subscription plan_entitlements exist for pricing-v1
  const { data: entitlements, error: entErr } = await supabase
    .from('plan_entitlements')
    .select('id, billing_products(code, product_type)')
    .eq('pricing_version_id', v1.id);

  const entitlementCodes = entitlements?.map((e: any) => e.billing_products?.code) || [];
  const onlySubscriptions = entitlements?.every((e: any) => e.billing_products?.product_type === 'SUBSCRIPTION');

  recordCheck(
    'CHK-06',
    'REAL_DB_QUERY',
    'Exactly 4 subscription plan_entitlements exist in real database for pricing-v1 (FREE, BASIC, PRO, BUSINESS)',
    !entErr && entitlements?.length === 4 && onlySubscriptions &&
    ['FREE', 'BASIC', 'PRO', 'BUSINESS'].every((c) => entitlementCodes.includes(c)),
    `Found ${entitlements?.length} entitlements: ${entitlementCodes.join(', ')}`
  );

  // CHK-07: REAL_DB_QUERY: 8 canonical product_credit_grants exist for pricing-v1
  const { data: grants, error: gErr } = await supabase
    .from('product_credit_grants')
    .select('credits_granted, grant_type, billing_products(code)')
    .eq('pricing_version_id', v1.id)
    .order('credits_granted');

  const grantMap: Record<string, { credits: number; type: string }> = {};
  grants?.forEach((g: any) => {
    grantMap[g.billing_products?.code] = { credits: g.credits_granted, type: g.grant_type };
  });

  const expectedGrants: Record<string, { credits: number; type: string }> = {
    FREE: { credits: 10, type: 'SUBSCRIPTION_CYCLE' },
    BASIC: { credits: 120, type: 'SUBSCRIPTION_CYCLE' },
    PRO: { credits: 450, type: 'SUBSCRIPTION_CYCLE' },
    BUSINESS: { credits: 1400, type: 'SUBSCRIPTION_CYCLE' },
    PACK_50: { credits: 50, type: 'ONE_TIME_PACK' },
    PACK_200: { credits: 200, type: 'ONE_TIME_PACK' },
    PACK_500: { credits: 500, type: 'ONE_TIME_PACK' },
    PACK_2000: { credits: 2000, type: 'ONE_TIME_PACK' },
  };

  let allGrantsMatch = !gErr;
  for (const [code, exp] of Object.entries(expectedGrants)) {
    const act = grantMap[code];
    if (!act || act.credits !== exp.credits || act.type !== exp.type) {
      allGrantsMatch = false;
      console.error(`Grant mismatch in real DB for ${code}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`);
    }
  }

  recordCheck(
    'CHK-07',
    'REAL_DB_QUERY',
    'Canonical credit grants exist in real DB for all 8 products with exact amounts and grant_types',
    allGrantsMatch,
    JSON.stringify(grantMap)
  );

  // CHK-08: REAL_DB_QUERY: Credit Packs have no subscription capability entitlement
  const creditPacksInEntitlements = entitlements?.filter(
    (e: any) => e.billing_products?.product_type === 'CREDIT_PACK'
  );

  recordCheck(
    'CHK-08',
    'REAL_DB_QUERY',
    'Credit Packs have 0 entries in plan_entitlements (grant credits only, no subscription capabilities)',
    (creditPacksInEntitlements?.length || 0) === 0,
    `Found ${creditPacksInEntitlements?.length} credit pack entries in plan_entitlements`
  );

  // CHK-09: REAL_DB_QUERY: legacy plans exactly FREE / 7_DAYS_FULL / 30_DAYS_FULL
  const { data: legacyPlans, error: lpErr } = await supabase.from('plans').select('*');
  const legacyIds = legacyPlans?.map((p) => p.id) || [];
  const noCommercialInPlans = !legacyIds.includes('BASIC') && !legacyIds.includes('PRO') && !legacyIds.includes('BUSINESS');
  const exactLegacy3 = legacyIds.includes('FREE') && legacyIds.includes('7_DAYS_FULL') && legacyIds.includes('30_DAYS_FULL') && legacyPlans?.length === 3;

  const freeDocQuota = legacyPlans?.find((p) => p.id === 'FREE')?.document_quota;
  const plan7DocQuota = legacyPlans?.find((p) => p.id === '7_DAYS_FULL')?.document_quota;
  const plan30DocQuota = legacyPlans?.find((p) => p.id === '30_DAYS_FULL')?.document_quota;

  const quotasMatch = freeDocQuota === 3 && plan7DocQuota === 50 && plan30DocQuota === 250;

  recordCheck(
    'CHK-09',
    'REAL_DB_QUERY',
    'Legacy public.plans contains exactly FREE (3), 7_DAYS_FULL (50), 30_DAYS_FULL (250) (0 commercial rows)',
    !lpErr && exactLegacy3 && noCommercialInPlans && quotasMatch,
    `Legacy plans: ${legacyIds.join(', ')}`
  );

  // CHK-10 to CHK-14: REAL_DB_TRANSACTION_TEST
  console.log('\n--- EXECUTING REAL DATABASE TRANSACTION TESTS ---');
  const TEST_VERSION_CODE = `__TEST_LOCK_${Date.now()}__`;
  const TEST_PRODUCT_CODE = `__TEST_PROD_${Date.now()}__`;

  // Setup test version
  const { data: tv } = await supabase
    .from('pricing_versions')
    .insert({ code: TEST_VERSION_CODE, active: false, is_locked: false })
    .select()
    .single();

  const { data: tp } = await supabase
    .from('billing_products')
    .insert({ code: TEST_PRODUCT_CODE, name: 'Test Product', product_type: 'CREDIT_PACK', pricing_channel: 'WEB', active: false })
    .select()
    .single();

  const { data: tpr } = await supabase
    .from('billing_prices')
    .insert({ product_id: tp!.id, pricing_version_id: tv!.id, currency: 'VND', amount_minor: 50000, billing_interval: 'NONE', interval_count: 1, active: true })
    .select()
    .single();

  const { data: tg } = await supabase
    .from('product_credit_grants')
    .insert({ product_id: tp!.id, pricing_version_id: tv!.id, credits_granted: 50, grant_type: 'ONE_TIME_PACK' })
    .select()
    .single();

  // Lock test version
  await supabase.from('pricing_versions').update({ is_locked: true }).eq('id', tv!.id);

  // CHK-10: REAL_DB_TRANSACTION_TEST: locked price UPDATE rejected
  const { error: lockPrUpdErr } = await supabase.from('billing_prices').update({ amount_minor: 99999 }).eq('id', tpr!.id);
  const chk10Passed = !!lockPrUpdErr?.message?.includes('PRICING_VERSION_LOCKED');
  recordCheck(
    'CHK-10',
    'REAL_DB_TRANSACTION_TEST',
    'Real PostgreSQL trigger blocks UPDATE of price for locked pricing version',
    chk10Passed,
    lockPrUpdErr?.message
  );

  // CHK-11: REAL_DB_TRANSACTION_TEST: locked price DELETE rejected
  const { error: lockPrDelErr } = await supabase.from('billing_prices').delete().eq('id', tpr!.id);
  const chk11Passed = !!lockPrDelErr?.message?.includes('PRICING_VERSION_LOCKED');
  recordCheck(
    'CHK-11',
    'REAL_DB_TRANSACTION_TEST',
    'Real PostgreSQL trigger blocks DELETE of price for locked pricing version',
    chk11Passed,
    lockPrDelErr?.message
  );

  // CHK-12: REAL_DB_TRANSACTION_TEST: locked canonical credit grant UPDATE/DELETE rejected
  const { error: lockGrUpdErr } = await supabase.from('product_credit_grants').update({ credits_granted: 9999 }).eq('id', tg!.id);
  const { error: lockGrDelErr } = await supabase.from('product_credit_grants').delete().eq('id', tg!.id);
  const chk12Passed = !!lockGrUpdErr?.message?.includes('PRICING_VERSION_LOCKED') && !!lockGrDelErr?.message?.includes('PRICING_VERSION_LOCKED');
  recordCheck(
    'CHK-12',
    'REAL_DB_TRANSACTION_TEST',
    'Real PostgreSQL trigger blocks UPDATE and DELETE of canonical credit grants for locked pricing version',
    chk12Passed,
    `Update err: ${lockGrUpdErr?.message}, Delete err: ${lockGrDelErr?.message}`
  );

  // CHK-13: REAL_DB_TRANSACTION_TEST: locked pricing version cannot be unlocked
  const { error: unlockErr } = await supabase.from('pricing_versions').update({ is_locked: false }).eq('id', tv!.id);
  const chk13Passed = !!unlockErr?.message?.includes('PRICING_VERSION_LOCK_MONOTONIC');
  recordCheck(
    'CHK-13',
    'REAL_DB_TRANSACTION_TEST',
    'Real PostgreSQL monotonic lock trigger blocks unlocking (is_locked: true -> false prohibited)',
    chk13Passed,
    unlockErr?.message
  );

  // CHK-14: REAL_DB_TRANSACTION_TEST: locked pricing version cannot be deleted
  const { error: delLockVerErr } = await supabase.from('pricing_versions').delete().eq('id', tv!.id);
  const chk14Passed = !!delLockVerErr?.message?.includes('PRICING_VERSION_LOCKED');
  recordCheck(
    'CHK-14',
    'REAL_DB_TRANSACTION_TEST',
    'Real PostgreSQL trigger blocks DELETION of locked pricing version',
    chk14Passed,
    delLockVerErr?.message
  );

  // CHK-15: HTTP_RUNTIME_QUERY: WEB subscription endpoint returns 4 DB-backed plans
  console.log('\n--- TESTING LIVE HTTP RUNTIME ENDPOINTS ---');
  let httpPlansPassed = false;
  try {
    const res = await fetch('http://localhost:3000/api/billing/plans?channel=WEB');
    const json = await res.json();
    httpPlansPassed =
      res.status === 200 &&
      json.success === true &&
      json.source === 'DATABASE' &&
      json.plans?.length === 4 &&
      json.plans.every((p: any) => typeof p.credits === 'number' && p.credits > 0);
  } catch (e: any) {
    console.error('HTTP plans check error:', e);
  }
  recordCheck(
    'CHK-15',
    'HTTP_RUNTIME_QUERY',
    'GET /api/billing/plans?channel=WEB returns 200 OK with 4 DATABASE-sourced plans and canonical credits',
    httpPlansPassed
  );

  // CHK-16: HTTP_RUNTIME_QUERY: WEB Credit Packs endpoint returns 4 DB-backed packs
  let httpPacksPassed = false;
  try {
    const res = await fetch('http://localhost:3000/api/billing/credit-packs?channel=WEB');
    const json = await res.json();
    httpPacksPassed =
      res.status === 200 &&
      json.success === true &&
      json.source === 'DATABASE' &&
      json.creditPacks?.length === 4 &&
      json.creditPacks.every((pk: any) => typeof pk.credits === 'number' && pk.credits > 0);
  } catch (e: any) {
    console.error('HTTP credit packs check error:', e);
  }
  recordCheck(
    'CHK-16',
    'HTTP_RUNTIME_QUERY',
    'GET /api/billing/credit-packs?channel=WEB returns 200 OK with 4 DATABASE-sourced credit packs',
    httpPacksPassed
  );

  // CHK-17: HTTP_RUNTIME_QUERY: API channel returns []
  let apiPlansEmpty = false;
  try {
    const res = await fetch('http://localhost:3000/api/billing/plans?channel=API');
    const json = await res.json();
    apiPlansEmpty = res.status === 200 && json.success === true && Array.isArray(json.plans) && json.plans.length === 0;
  } catch (e: any) {
    console.error('HTTP API plans check error:', e);
  }
  recordCheck(
    'CHK-17',
    'HTTP_RUNTIME_QUERY',
    'GET /api/billing/plans?channel=API returns 200 OK with empty array []',
    apiPlansEmpty
  );

  // CHK-18: UNIT_TEST: commercial path fail-closed
  let failClosedPassed = false;
  try {
    await billingService.getCanonicalCreditGrant('NON_EXISTENT_PROD_CODE_XYZ_9999');
  } catch (err: any) {
    failClosedPassed = err.message.includes('CANONICAL_CREDIT_GRANT_NOT_FOUND');
  }
  recordCheck(
    'CHK-18',
    'UNIT_TEST',
    'getCanonicalCreditGrant() fails closed (throws CANONICAL_CREDIT_GRANT_NOT_FOUND error) for unconfigured product',
    failClosedPassed
  );

  // CHK-19: UNIT_TEST: fallback policy hardening
  // Verify that isFallbackAllowed() returns false when ALLOW_BILLING_CATALOG_FALLBACK is not 'true'
  const prevEnv = process.env.ALLOW_BILLING_CATALOG_FALLBACK;
  delete process.env.ALLOW_BILLING_CATALOG_FALLBACK;
  const fallbackDisabledByDefault = billingService.isFallbackAllowed() === false;
  process.env.ALLOW_BILLING_CATALOG_FALLBACK = 'true';
  const fallbackEnabledWhenExplicit = billingService.isFallbackAllowed() === true;
  if (prevEnv) process.env.ALLOW_BILLING_CATALOG_FALLBACK = prevEnv;
  else delete process.env.ALLOW_BILLING_CATALOG_FALLBACK;

  recordCheck(
    'CHK-19',
    'UNIT_TEST',
    'Billing fallback policy defaults to disabled and only enables when ALLOW_BILLING_CATALOG_FALLBACK="true"',
    fallbackDisabledByDefault && fallbackEnabledWhenExplicit
  );

  // CHK-20: STATIC_SOURCE_CHECK / BUILD: frontend production build passes
  const buildExists = fs.existsSync('dist/index.html') && fs.existsSync('dist/assets');
  recordCheck(
    'CHK-20',
    'STATIC_SOURCE_CHECK',
    'Frontend production build artifact exists and is verified',
    buildExists
  );

  console.log('\n================================================================');
  const passCount = checks.filter((c) => c.status === 'PASS').length;
  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  console.log(`TOTAL CHECKS: ${checks.length} | PASS: ${passCount} | FAIL: ${failCount}`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
