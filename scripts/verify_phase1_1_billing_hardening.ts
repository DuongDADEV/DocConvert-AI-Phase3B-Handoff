import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';
import { billingService } from '../server/services/billing/billingService.js';

interface CheckItem {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  details?: string;
}

const checks: CheckItem[] = [];

function recordCheck(id: string, name: string, condition: boolean, details?: string) {
  if (condition) {
    checks.push({ id, name, status: 'PASS' });
    console.log(`[PASS] ${id}: ${name}`);
  } else {
    checks.push({ id, name, status: 'FAIL', details });
    console.error(`[FAIL] ${id}: ${name} -> ${details}`);
  }
}

async function main() {
  console.log('================================================================');
  console.log('PHASE 1.1 — POST-MIGRATION DATABASE & RUNTIME VERIFICATION');
  console.log('================================================================\n');

  const supabase = getSupabaseAdminClient();

  // 1. Verify pricing-v1 exists
  const version = await billingService.getPricingVersion('pricing-v1');
  recordCheck(
    'CHK-01',
    'Pricing version "pricing-v1" exists and is active',
    !!version && version.code === 'pricing-v1' && version.active === true
  );

  // 2. Query WEB products (must be exactly 8)
  const webPlans = await billingService.getActivePricingPlans('WEB');
  const webPacks = await billingService.getCreditPacks('WEB');
  const totalWebProducts = webPlans.length + webPacks.length;
  recordCheck(
    'CHK-02',
    'Exactly 8 active WEB products in billing catalog',
    totalWebProducts === 8,
    `Found ${totalWebProducts} products`
  );

  // 3. Exactly 4 SUBSCRIPTION plans
  recordCheck(
    'CHK-03',
    'Exactly 4 SUBSCRIPTION products (FREE, BASIC, PRO, BUSINESS)',
    webPlans.length === 4 &&
      webPlans.every((p) => p.product_type === 'SUBSCRIPTION') &&
      ['FREE', 'BASIC', 'PRO', 'BUSINESS'].every((code) => webPlans.some((p) => p.code === code)),
    `Codes found: ${webPlans.map((p) => p.code).join(', ')}`
  );

  // 4. Exactly 4 CREDIT_PACK products
  recordCheck(
    'CHK-04',
    'Exactly 4 CREDIT_PACK products (PACK_50, PACK_200, PACK_500, PACK_2000)',
    webPacks.length === 4 &&
      webPacks.every((p) => p.product_type === 'CREDIT_PACK') &&
      ['PACK_50', 'PACK_200', 'PACK_500', 'PACK_2000'].every((code) => webPacks.some((p) => p.code === code)),
    `Codes found: ${webPacks.map((p) => p.code).join(', ')}`
  );

  // 5. Prices verification
  const priceMap = new Map<string, number>();
  webPlans.forEach((p) => priceMap.set(p.code, p.price));
  webPacks.forEach((pk) => priceMap.set(pk.code, pk.price));

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

  let allPricesMatch = true;
  for (const [code, expectedPrice] of Object.entries(expectedPrices)) {
    const actual = priceMap.get(code);
    if (actual !== expectedPrice) {
      allPricesMatch = false;
      console.error(`Price mismatch for ${code}: expected ${expectedPrice}, got ${actual}`);
    }
  }
  recordCheck(
    'CHK-05',
    'All 8 products have exact official commercial prices (VND integer minor units)',
    allPricesMatch
  );

  // 6. Entitlements for 4 subscription plans
  const free = webPlans.find((p) => p.code === 'FREE');
  const basic = webPlans.find((p) => p.code === 'BASIC');
  const pro = webPlans.find((p) => p.code === 'PRO');
  const biz = webPlans.find((p) => p.code === 'BUSINESS');

  const entitlementsMatch =
    free?.entitlements.included_credits === 10 &&
    free?.entitlements.max_file_mb === 20 &&
    free?.entitlements.api_access === 'NONE' &&
    basic?.entitlements.included_credits === 120 &&
    basic?.entitlements.max_file_mb === 50 &&
    basic?.entitlements.retention_days === 7 &&
    pro?.entitlements.included_credits === 450 &&
    pro?.entitlements.batch_enabled === true &&
    pro?.entitlements.api_access === 'BETA' &&
    biz?.entitlements.included_credits === 1400 &&
    biz?.entitlements.api_access === 'FULL' &&
    biz?.entitlements.max_file_mb === 200;

  recordCheck('CHK-06', 'All 4 subscription plans have verified entitlements', !!entitlementsMatch);

  // 7. No duplicate active price per product
  const allCodes = [...webPlans.map((p) => p.code), ...webPacks.map((p) => p.code)];
  const uniqueCodes = new Set(allCodes);
  recordCheck(
    'CHK-07',
    'Product code uniqueness across catalog',
    allCodes.length === uniqueCodes.size && allCodes.length === 8
  );

  // 8. Legacy document quota is NOT conflated with included credits
  // Legacy FREE document_quota is 3 (documents), while FREE included_credits is 10 (credits)
  recordCheck(
    'CHK-08',
    'Semantic boundary enforced: included_credits is distinct from document_quota',
    free?.credits === 10 && (free as any).document_quota === undefined
  );

  // 9. API channel currently returns [] validly
  const apiPlans = await billingService.getActivePricingPlans('API');
  recordCheck(
    'CHK-09',
    'API channel currently returns [] without error',
    Array.isArray(apiPlans) && apiPlans.length === 0
  );

  // 10. Runtime HTTP API status
  try {
    const plansRes = await fetch('http://localhost:3000/api/billing/plans?channel=WEB');
    const plansJson = await plansRes.json();
    const packsRes = await fetch('http://localhost:3000/api/billing/credit-packs?channel=WEB');
    const packsJson = await packsRes.json();

    const httpValid =
      plansJson.success === true &&
      plansJson.plans.length === 4 &&
      packsJson.success === true &&
      packsJson.creditPacks.length === 4;

    recordCheck('CHK-10', 'Live HTTP REST endpoints /api/billing/plans and credit-packs respond 200 OK', httpValid);
  } catch (err: any) {
    recordCheck('CHK-10', 'Live HTTP REST endpoints reachable', false, err.message);
  }

  console.log('\n================================================================');
  const passCount = checks.filter((c) => c.status === 'PASS').length;
  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  console.log(`TOTAL: ${checks.length} | PASS: ${passCount} | FAIL: ${failCount}`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
