import 'dotenv/config';
import fs from 'fs';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function applyMigration() {
  const client = getSupabaseAdminClient();
  const sql = fs.readFileSync('supabase/migrations/20260930010000_billing_foundation.sql', 'utf-8');

  console.log('Attempting migration via rpc exec_sql...');
  try {
    const res = await client.rpc('exec_sql', { query: sql });
    if (res.error) {
      console.log('RPC exec_sql error or not available:', res.error.message);
    } else {
      console.log('Migration applied successfully via exec_sql RPC!');
      return;
    }
  } catch (err: any) {
    console.log('exec_sql caught exception:', err.message);
  }

  // Also check if tables are accessible
  const { data: prods, error: pErr } = await client.from('billing_products').select('count');
  if (pErr) {
    console.log('Note: billing_products table status:', pErr.message);
  } else {
    console.log('billing_products table already exists! Row count probe:', prods);
  }
}

applyMigration()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
