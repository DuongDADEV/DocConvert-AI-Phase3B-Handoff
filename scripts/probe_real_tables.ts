import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function probeRealTables() {
  const client = getSupabaseAdminClient();

  const tables = [
    'pricing_versions',
    'billing_products',
    'billing_prices',
    'plan_entitlements',
    'user_subscriptions',
    'product_credit_grants',
    'plans',
    'profiles',
    'documents',
    'processing_jobs',
    'subscriptions',
    'usage',
    'audit_logs',
    'document_metadata',
    'document_pages',
    'export_files',
    'extracted_cells',
    'extracted_rows',
    'extracted_tables',
    'extraction_candidates',
    'extraction_resolution_events',
    'extraction_resolutions',
    'extraction_results',
    'ocr_results',
    'review_actions',
    'validation_issues',
    'validation_runs',
  ];

  console.log('=== REAL TABLE PROBE ON SUPABASE PROJECT ===');
  for (const table of tables) {
    const res = await client.from(table).select('*').limit(1);
    if (res.error) {
      console.log(`❌ [NOT_FOUND] ${table.padEnd(30)}: ${res.error.code} - ${res.error.message}`);
    } else {
      console.log(`✅ [EXISTS]    ${table.padEnd(30)}: Status ${res.status}, Sample rows: ${res.data?.length}`);
    }
  }
}

probeRealTables()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
