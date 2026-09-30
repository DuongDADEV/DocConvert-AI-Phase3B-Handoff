import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function check() {
  const client = getSupabaseAdminClient();
  const { data, error } = await client.rpc('save_document_analysis_atomic', {
    p_document_id: '00000000-0000-0000-0000-000000000000',
    p_user_id: '00000000-0000-0000-0000-000000000000',
    p_payload: {}
  });
  console.log('RPC test:', { data, error });
}

check().catch(console.error);
