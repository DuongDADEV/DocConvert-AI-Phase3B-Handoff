import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function testTables() {
  const client = getSupabaseAdminClient();

  console.log('--- TEST 1: select("*") on pricing_versions ---');
  const res1 = await client.from('pricing_versions').select('*');
  console.log('pricing_versions res:', {
    data: res1.data,
    error: res1.error,
    status: res1.status,
    statusText: res1.statusText,
  });

  console.log('\n--- TEST 2: select("*") on definitely_non_existent_table_xyz ---');
  const res2 = await client.from('definitely_non_existent_table_xyz').select('*');
  console.log('fake table res:', {
    data: res2.data,
    error: res2.error,
    status: res2.status,
  });

  console.log('\n--- TEST 3: select("*", { count: "exact", head: true }) on fake table ---');
  const res3 = await client.from('definitely_non_existent_table_xyz').select('*', { count: 'exact', head: true });
  console.log('fake table head res:', {
    count: res3.count,
    error: res3.error,
    status: res3.status,
  });
}

testTables()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
