import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

if (process.env.ALLOW_DESTRUCTIVE_BILLING_TESTS !== 'true') {
  console.error('[SAFETY ERROR] This script modifies the production billing database directly.');
  console.error('To run, explicitly set ALLOW_DESTRUCTIVE_BILLING_TESTS=true in your environment.');
  process.exit(1);
}

async function lockPricingV1() {
  const client = getSupabaseAdminClient();

  console.log('Attempting to update pricing-v1 is_locked = true via admin client...');
  const { data, error } = await client
    .from('pricing_versions')
    .update({ is_locked: true })
    .eq('code', 'pricing-v1')
    .eq('active', true)
    .eq('is_locked', false)
    .select();

  if (error) {
    console.error('Update failed:', error);
  } else {
    console.log('Update result:', data);
  }

  // Verify
  const { data: ver } = await client.from('pricing_versions').select('*').eq('code', 'pricing-v1').single();
  console.log('Current pricing-v1 in DB:', ver);
}

lockPricingV1()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
