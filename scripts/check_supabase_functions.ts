import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function listRoutines() {
  const client = getSupabaseAdminClient();
  
  // Can we query any tables? Let's check
  const { data: plans } = await client.from('plans').select('*');
  console.log('Plans:', plans?.map(p => p.id));

  // Let's check if there are other RPCs or if supabase CLI is available
}

listRoutines().catch(console.error);
