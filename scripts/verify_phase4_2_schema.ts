import 'dotenv/config';
import crypto from 'crypto';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';
import { createClient } from '@supabase/supabase-js';

async function checkSchema() {
  const adminClient = getSupabaseAdminClient();
  const anonClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

  console.log('--- 1. Testing RPC presence via service_role client ---');
  const dummyDocId = '00000000-0000-0000-0000-000000000001';
  const dummyUserId = '30ed6381-0d2f-4d4a-a2f6-d8e0ac07452c';
  const { data: adminRes, error: adminErr } = await adminClient.rpc('confirm_document_processing', {
    p_document_id: dummyDocId,
    p_user_id: dummyUserId,
    p_output_type: 'EXCEL'
  });
  console.log('service_role RPC call result:', { adminRes, adminErr: adminErr?.message });

  console.log('\n--- 2. Testing RPC permissions via anon client ---');
  const { data: anonRes, error: anonErr } = await anonClient.rpc('confirm_document_processing', {
    p_document_id: dummyDocId,
    p_user_id: dummyUserId,
    p_output_type: 'EXCEL'
  });
  console.log('anon RPC call result:', { anonRes, anonErr: anonErr?.message, code: anonErr?.code });

  console.log('\n--- 3. Testing partial unique index idx_processing_jobs_active_doc ---');
  const testDocId = crypto.randomUUID();
  const job1Id = crypto.randomUUID();
  const job2Id = crypto.randomUUID();
  const job3Id = crypto.randomUUID();

  // Create real test document
  await adminClient.from('documents').insert({
    id: testDocId,
    user_id: dummyUserId,
    original_filename: 'test_index.pdf',
    file_name: 'test_index.pdf',
    file_type: 'PDF',
    mime_type: 'application/pdf',
    file_size: 1024,
    page_count: 1,
    storage_bucket: 'documents',
    storage_path: `${dummyUserId}/${testDocId}/test.pdf`,
    document_type: 'BANK_STATEMENT',
    status: 'WAITING_CONFIRMATION',
    output_type: 'EXCEL',
  });

  const { error: ins1Err } = await adminClient.from('processing_jobs').insert({
    id: job1Id,
    document_id: testDocId,
    user_id: dummyUserId,
    status: 'QUEUED',
    attempt_count: 1
  });
  console.log('First active (QUEUED) job insert error:', ins1Err?.message || 'None (Success)');

  const { error: ins2Err } = await adminClient.from('processing_jobs').insert({
    id: job2Id,
    document_id: testDocId,
    user_id: dummyUserId,
    status: 'PROCESSING',
    attempt_count: 1
  });
  console.log('Second active (PROCESSING) job insert error (expected idx_processing_jobs_active_doc violation):', ins2Err?.message);

  // Test inserting a terminal job (should NOT be blocked by partial unique index)
  const { error: ins3Err } = await adminClient.from('processing_jobs').insert({
    id: job3Id,
    document_id: testDocId,
    user_id: dummyUserId,
    status: 'READY',
    attempt_count: 1
  });
  console.log('Terminal (READY) job insert error (expected none):', ins3Err?.message || 'None (Success)');

  // Clean up
  await adminClient.from('processing_jobs').delete().eq('document_id', testDocId);
  await adminClient.from('documents').delete().eq('id', testDocId);

  console.log('\n--- 4. Checking existing active jobs in production ---');
  const activeStatuses = ['QUEUED', 'PROCESSING', 'VALIDATING', 'UPLOADING', 'PARSING', 'VALIDATING_RESULT'];
  const { data: allActiveJobs } = await adminClient
    .from('processing_jobs')
    .select('id, document_id, status, created_at')
    .in('status', activeStatuses);
  console.log('Active jobs count in DB:', allActiveJobs?.length || 0);

  const docCountMap = new Map<string, number>();
  let duplicateActiveFound = false;
  for (const j of allActiveJobs || []) {
    const c = (docCountMap.get(j.document_id) || 0) + 1;
    docCountMap.set(j.document_id, c);
    if (c > 1) {
      duplicateActiveFound = true;
      console.error(`DUPLICATE ACTIVE JOB FOUND for doc ${j.document_id}: job ${j.id}`);
    }
  }
  if (!duplicateActiveFound) {
    console.log('✅ ZERO duplicate active jobs exist in database.');
  }
}

checkSchema().catch(console.error);
