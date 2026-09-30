import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function testRpcCall() {
  const client = getSupabaseAdminClient();
  const dummyDocId = '00000000-0000-0000-0000-000000000000';
  const dummyUserId = '00000000-0000-0000-0000-000000000000';

  console.log('Testing RPC call confirm_document_processing...');
  const { data, error } = await client.rpc('confirm_document_processing', {
    p_document_id: dummyDocId,
    p_user_id: dummyUserId,
    p_output_type: 'EXCEL',
  });

  console.log('RPC response:');
  console.log('Data:', data);
  console.log('Error:', error);
}

testRpcCall().then(() => process.exit(0)).catch(console.error);
