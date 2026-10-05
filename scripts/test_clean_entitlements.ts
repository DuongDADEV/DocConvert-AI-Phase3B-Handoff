import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

if (process.env.ALLOW_DESTRUCTIVE_BILLING_TESTS !== 'true') {
  console.error('[SAFETY ERROR] This script modifies the production billing database directly.');
  console.error('To run, explicitly set ALLOW_DESTRUCTIVE_BILLING_TESTS=true in your environment.');
  process.exit(1);
}

async function testCleanEntitlements() {
  const client = getSupabaseAdminClient();

  // Find credit pack product IDs
  const { data: packs } = await client
    .from('billing_products')
    .select('id, code')
    .eq('product_type', 'CREDIT_PACK');

  console.log('Credit pack products:', packs);

  if (packs && packs.length > 0) {
    const packIds = packs.map((p) => p.id);
    const { data: delData, error: delErr } = await client
      .from('plan_entitlements')
      .delete()
      .in('product_id', packIds)
      .select();

    if (delErr) {
      console.error('Delete error:', delErr);
    } else {
      console.log('Successfully deleted credit pack rows from plan_entitlements:', delData);
    }
  }

  // Check plan_entitlements remaining rows
  const { data: remaining } = await client
    .from('plan_entitlements')
    .select('*, billing_products(code, product_type)');

  console.log('Remaining plan_entitlements count:', remaining?.length);
  remaining?.forEach((r: any) => console.log(' -', r.billing_products?.code, r.billing_products?.product_type));
}

testCleanEntitlements()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
