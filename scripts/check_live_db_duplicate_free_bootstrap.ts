import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function main() {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    console.error('Failed to get Supabase admin client');
    process.exit(1);
  }

  const { data, error } = await supabase
    .from('credit_grants')
    .select('id, account_id, user_id, source_type')
    .eq('source_type', 'FREE_BOOTSTRAP');

  if (error) {
    console.error('Error querying credit_grants for FREE_BOOTSTRAP:', error.message);
    process.exit(1);
  }

  const accountCounts: Record<string, number> = {};
  for (const row of data || []) {
    accountCounts[row.account_id] = (accountCounts[row.account_id] || 0) + 1;
  }

  const duplicateAccounts = Object.entries(accountCounts).filter(([_, count]) => count > 1);

  console.log(`[PRECHECK] Total FREE_BOOTSTRAP rows found: ${data?.length || 0}`);
  console.log(`[PRECHECK] Duplicate FREE_BOOTSTRAP accounts found: ${duplicateAccounts.length}`);
  if (duplicateAccounts.length > 0) {
    console.log('[PRECHECK] Duplicate details:', duplicateAccounts);
  } else {
    console.log('[PRECHECK] OK: No duplicate FREE_BOOTSTRAP grants exist on live DB.');
  }
}

main().catch((err) => {
  console.error('Fatal error in precheck:', err);
  process.exit(1);
});
