import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function checkCompatibility() {
  const client = getSupabaseAdminClient();
  const { count: tableCount } = await client.from('extracted_tables').select('*', { count: 'exact', head: true });
  const { count: cellCount } = await client.from('extracted_cells').select('*', { count: 'exact', head: true });
  const { count: docCount } = await client.from('documents').select('*', { count: 'exact', head: true });
  console.log(`Current DB rows: documents=${docCount}, tables=${tableCount}, cells=${cellCount}`);
}

checkCompatibility().catch(console.error);
