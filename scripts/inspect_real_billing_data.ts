import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function inspectRealBilling() {
  const client = getSupabaseAdminClient();

  console.log('=== 1. PRICING VERSIONS ===');
  const { data: versions, error: vErr } = await client.from('pricing_versions').select('*');
  if (vErr) console.error('Error fetching pricing_versions:', vErr.message);
  else console.log(JSON.stringify(versions, null, 2));

  console.log('\n=== 2. BILLING PRODUCTS ===');
  const { data: products, error: pErr } = await client.from('billing_products').select('*').order('code');
  if (pErr) console.error('Error fetching billing_products:', pErr.message);
  else {
    console.log(`Total products: ${products?.length}`);
    products?.forEach((p) => {
      console.log(` - ${p.code.padEnd(12)} | type: ${p.product_type.padEnd(15)} | channel: ${p.pricing_channel.padEnd(10)} | active: ${p.active}`);
    });
  }

  console.log('\n=== 3. BILLING PRICES ===');
  const { data: prices, error: prErr } = await client
    .from('billing_prices')
    .select('*, billing_products(code, name), pricing_versions(code)')
    .order('amount_minor');
  if (prErr) console.error('Error fetching billing_prices:', prErr.message);
  else {
    console.log(`Total prices: ${prices?.length}`);
    prices?.forEach((pr: any) => {
      console.log(` - ${pr.billing_products?.code.padEnd(12)}: ${pr.amount_minor} ${pr.currency} / interval: ${pr.billing_interval} (${pr.interval_count}) | version: ${pr.pricing_versions?.code} | active: ${pr.active}`);
    });
  }

  console.log('\n=== 4. PLAN ENTITLEMENTS ===');
  const { data: entitlements, error: eErr } = await client
    .from('plan_entitlements')
    .select('*, billing_products(code, product_type), pricing_versions(code)');
  if (eErr) console.error('Error fetching plan_entitlements:', eErr.message);
  else {
    console.log(`Total entitlements: ${entitlements?.length}`);
    entitlements?.forEach((en: any) => {
      console.log(` - ${en.billing_products?.code.padEnd(12)} (${en.billing_products?.product_type}): credits=${en.included_credits}, max_mb=${en.max_file_mb}, batch=${en.batch_enabled}, priority=${en.priority_queue}, api=${en.api_access}, retention=${en.retention_days}`);
    });
  }

  console.log('\n=== 5. PRODUCT CREDIT GRANTS ===');
  const { data: grants, error: gErr } = await client
    .from('product_credit_grants')
    .select('*, billing_products(code), pricing_versions(code)')
    .order('credits_granted');
  if (gErr) console.error('Error fetching product_credit_grants:', gErr.message);
  else {
    console.log(`Total credit grants: ${grants?.length}`);
    grants?.forEach((g: any) => {
      console.log(` - ${g.billing_products?.code.padEnd(12)}: ${g.credits_granted} credits | grant_type: ${g.grant_type} | version: ${g.pricing_versions?.code}`);
    });
  }

  console.log('\n=== 6. LEGACY PLANS TABLE ===');
  const { data: legacyPlans, error: lpErr } = await client.from('plans').select('*');
  if (lpErr) console.error('Error fetching plans:', lpErr.message);
  else console.log(JSON.stringify(legacyPlans, null, 2));

  console.log('\n=== 7. PROFILES COUNT BY current_plan_id ===');
  const { data: profiles, error: profErr } = await client.from('profiles').select('id, current_plan_id');
  if (profErr) console.error('Error fetching profiles:', profErr.message);
  else {
    const counts: Record<string, number> = {};
    profiles?.forEach((p) => {
      counts[p.current_plan_id] = (counts[p.current_plan_id] || 0) + 1;
    });
    console.log(`Total profiles: ${profiles?.length}`, counts);
  }
}

inspectRealBilling()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
