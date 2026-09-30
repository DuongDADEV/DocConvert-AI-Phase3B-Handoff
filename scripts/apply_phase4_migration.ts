import 'dotenv/config';
import fs from 'fs';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function applyMigration() {
  const client = getSupabaseAdminClient();
  const sql = fs.readFileSync('supabase/migrations/20260925000000_confirm_document_processing_rpc.sql', 'utf-8');

  console.log('Testing exec_sql with { query } parameter...');
  const res1 = await client.rpc('exec_sql', { query: sql });
  if (res1.error) {
    console.error('Error with { query }:', res1.error);
    // Let's also check if postgres endpoint or fetch works
    const url = process.env.SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const res = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });
    console.log('Direct fetch status:', res.status);
    const body = await res.text();
    console.log('Direct fetch body:', body);
  } else {
    console.log('Migration succeeded via { query }:', res1.data);
  }
}

applyMigration().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
