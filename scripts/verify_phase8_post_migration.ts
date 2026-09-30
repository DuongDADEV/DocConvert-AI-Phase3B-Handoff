import 'dotenv/config';
import crypto from 'crypto';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function main() {
  const supabase = getSupabaseAdminClient();
  console.log('=== PHASE 8 POST-MIGRATION VERIFICATION ===\n');

  // Find a valid user_id from auth.users or profiles or existing documents
  const { data: existingDocs, error: docErr } = await supabase
    .from('documents')
    .select('id, user_id, status, review_status, reviewed_by, reviewed_at')
    .limit(1);

  if (docErr) {
    console.error('Error selecting from documents:', docErr);
    process.exit(1);
  }

  console.log('1. Sample existing document row:');
  if (existingDocs && existingDocs.length > 0) {
    console.log(JSON.stringify(existingDocs[0], null, 2));
  } else {
    console.log('No existing documents found.');
  }

  // Find an existing real user_id
  let testUserId = existingDocs && existingDocs.length > 0 ? existingDocs[0].user_id : null;
  if (!testUserId) {
    const { data: profs } = await supabase.from('profiles').select('id').limit(1);
    if (profs && profs.length > 0) testUserId = profs[0].id;
  }
  if (!testUserId) {
    console.error('Could not find a valid user_id to test foreign keys');
    process.exit(1);
  }
  console.log('\nUsing testUserId:', testUserId);

  // 2. Test Catalog query via exec_sql RPC if available
  try {
    const { data: catData, error: catErr } = await supabase.rpc('exec_sql', {
      query: `
        SELECT conname, pg_get_constraintdef(oid) as def 
        FROM pg_constraint 
        WHERE conrelid = 'public.documents'::regclass 
          AND conname LIKE 'chk_documents_review%';
      `
    });
    if (!catErr) {
      console.log('\n2. Catalog Constraints via exec_sql:');
      console.log(catData);
    }
  } catch (e) {
    // exec_sql might not be enabled, that's fine, we will test via runtime constraints
  }

  const testDocId = crypto.randomUUID();
  console.log(`\n3. Creating temporary test document: ${testDocId}`);

  try {
    // Insert default without specifying review_status
    const { data: insData, error: insErr } = await supabase.from('documents').insert({
      id: testDocId,
      user_id: testUserId,
      original_filename: 'phase8_test.pdf',
      file_name: 'phase8_test.pdf',
      file_type: 'PDF',
      mime_type: 'application/pdf',
      file_size: 1024,
      page_count: 1,
      storage_bucket: 'documents',
      storage_path: `${testUserId}/${testDocId}/phase8_test.pdf`,
      document_type: 'BANK_STATEMENT',
      status: 'READY'
    }).select().single();

    if (insErr) {
      console.error('Failed to insert test document with default values:', insErr);
      process.exit(1);
    }

    console.log('Inserted default record review_status:', insData.review_status);
    console.log('Inserted default record reviewed_by:', insData.reviewed_by);
    console.log('Inserted default record reviewed_at:', insData.reviewed_at);
    console.log('Inserted default record status (AI status):', insData.status);

    // CASE A: review_status = 'UNREVIEWED', reviewed_at = NULL -> MUST SUCCEED
    console.log('\n--- TESTING CASE A: UNREVIEWED + reviewed_at = NULL ---');
    const { error: caseAErr } = await supabase
      .from('documents')
      .update({ review_status: 'UNREVIEWED', reviewed_at: null, reviewed_by: null })
      .eq('id', testDocId);
    console.log('CASE A Result:', caseAErr ? `FAILED: ${caseAErr.message}` : 'PASS (Valid)');

    // CASE B: review_status = 'IN_PROGRESS', reviewed_at = NULL -> MUST SUCCEED
    console.log('\n--- TESTING CASE B: IN_PROGRESS + reviewed_at = NULL ---');
    const { error: caseBErr } = await supabase
      .from('documents')
      .update({ review_status: 'IN_PROGRESS', reviewed_at: null, reviewed_by: null })
      .eq('id', testDocId);
    console.log('CASE B Result:', caseBErr ? `FAILED: ${caseBErr.message}` : 'PASS (Valid)');

    // CASE C: review_status = 'REVIEWED', reviewed_at = NOW() -> MUST SUCCEED
    console.log('\n--- TESTING CASE C: REVIEWED + reviewed_at = NOW() ---');
    const { error: caseCErr } = await supabase
      .from('documents')
      .update({ review_status: 'REVIEWED', reviewed_at: new Date().toISOString(), reviewed_by: testUserId })
      .eq('id', testDocId);
    console.log('CASE C Result:', caseCErr ? `FAILED: ${caseCErr.message}` : 'PASS (Valid)');

    // CASE D: review_status = 'REVIEWED', reviewed_at = NULL -> MUST BE REJECTED
    console.log('\n--- TESTING CASE D: REVIEWED + reviewed_at = NULL (Should be rejected) ---');
    const { error: caseDErr } = await supabase
      .from('documents')
      .update({ review_status: 'REVIEWED', reviewed_at: null })
      .eq('id', testDocId);
    if (caseDErr) {
      console.log('CASE D Result: PASS (Rejected as expected by constraint)');
      console.log('  Constraint error message:', caseDErr.message);
    } else {
      console.error('CASE D Result: FAIL (Constraint failed to reject invalid state!)');
    }

    // CASE E: review_status = 'IN_PROGRESS', reviewed_at = NOW() -> MUST BE REJECTED
    console.log('\n--- TESTING CASE E: IN_PROGRESS + reviewed_at = NOW() (Should be rejected) ---');
    const { error: caseEErr } = await supabase
      .from('documents')
      .update({ review_status: 'IN_PROGRESS', reviewed_at: new Date().toISOString() })
      .eq('id', testDocId);
    if (caseEErr) {
      console.log('CASE E Result: PASS (Rejected as expected by constraint)');
      console.log('  Constraint error message:', caseEErr.message);
    } else {
      console.error('CASE E Result: FAIL (Constraint failed to reject invalid state!)');
    }

    // CHECK CONSTRAINT FOR review_status values: test invalid enum string
    console.log('\n--- TESTING INVALID review_status value (e.g. DRAFT) ---');
    const { error: invErr } = await supabase
      .from('documents')
      .update({ review_status: 'DRAFT', reviewed_at: null })
      .eq('id', testDocId);
    if (invErr) {
      console.log('Invalid value check: PASS (Rejected as expected)');
      console.log('  Constraint error message:', invErr.message);
    } else {
      console.error('Invalid value check: FAIL (Allowed unexpected review_status!)');
    }

    // CHECK FOREIGN KEY CONSTRAINT: test non-existent user UUID
    console.log('\n--- TESTING FOREIGN KEY on reviewed_by (non-existent user) ---');
    const fakeUserId = '00000000-0000-0000-0000-000000000999';
    const { error: fkErr } = await supabase
      .from('documents')
      .update({ review_status: 'REVIEWED', reviewed_at: new Date().toISOString(), reviewed_by: fakeUserId })
      .eq('id', testDocId);
    if (fkErr) {
      console.log('Foreign key check: PASS (Rejected non-existent user as expected)');
      console.log('  FK error message:', fkErr.message);
    } else {
      console.error('Foreign key check: FAIL (Allowed invalid foreign key!)');
    }

    // Check RPC resolve_extraction_cell_atomic presence
    console.log('\n--- TESTING resolve_extraction_cell_atomic RPC existence ---');
    const { error: rpcErr } = await supabase.rpc('resolve_extraction_cell_atomic', {
      p_document_id: '00000000-0000-0000-0000-000000000000',
      p_user_id: '00000000-0000-0000-0000-000000000000',
      p_cell_id: '00000000-0000-0000-0000-000000000000',
      p_candidate: null,
      p_resolution: {},
      p_cell_updates: {}
    });
    // If RPC exists, it will throw DOCUMENT_NOT_FOUND_OR_UNAUTHORIZED or similar
    console.log('resolve_extraction_cell_atomic error message:', rpcErr?.message);
    const rpcIntact = rpcErr && (rpcErr.message.includes('DOCUMENT_NOT_FOUND') || rpcErr.message.includes('RESOLUTION_EVENT_KEY_REQUIRED'));
    console.log('resolve_extraction_cell_atomic status:', rpcIntact ? 'PASS (Intact & Callable)' : 'CHECK FAILED');

  } finally {
    // 4. CLEANUP: Delete temporary test document
    console.log(`\n4. Cleaning up test document ${testDocId}...`);
    const { error: delErr } = await supabase.from('documents').delete().eq('id', testDocId);
    if (delErr) {
      console.error('Warning: could not delete test document:', delErr);
    } else {
      console.log('Cleanup successful: No test rows left in database.');
    }
  }
}

main().catch(console.error);
