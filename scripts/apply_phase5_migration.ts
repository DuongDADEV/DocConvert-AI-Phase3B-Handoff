import 'dotenv/config';
import fs from 'fs';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function runMigration() {
  const client = getSupabaseAdminClient();
  const sql = fs.readFileSync('supabase/migrations/20260926000000_add_processing_decisions.sql', 'utf-8');

  console.log('Running migration: 20260926000000_add_processing_decisions.sql');
  const { data, error } = await client.rpc('exec_sql', { sql });
  if (error) {
    console.error('Migration error via exec_sql:', error);
  } else {
    console.log('Migration executed successfully via exec_sql:', data);
  }

  // Verify columns on document_pages
  const { data: sample, error: queryErr } = await client
    .from('document_pages')
    .select('id, page_number, classification, processing_strategy, fallback_strategy, requires_azure, requires_region_analysis, decision_reason, decision_version')
    .limit(1);

  if (queryErr) {
    console.error('Verification query error on document_pages:', queryErr.message);
  } else {
    console.log('Verification success! Table document_pages has new decision columns. Sample:', sample);
  }
}

runMigration().catch(console.error);
