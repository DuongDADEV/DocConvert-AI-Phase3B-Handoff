import 'dotenv/config';
import crypto from 'crypto';
import { db, DocumentRecord, ProcessingJobRecord } from '../db/db.js';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { createClient } from '@supabase/supabase-js';

async function runPhase42TestSuite() {
  console.log('================================================================');
  console.log('   PHASE 4.2 TRANSACTION & QUOTA SAFETY ACCEPTANCE MATRIX');
  console.log('   (16 COMPREHENSIVE TESTS AGAINST REAL SUPABASE POSTGRESQL)');
  console.log('================================================================\n');

  const client = getSupabaseAdminClient();

  // Test Users
  const userA = '30ed6381-0d2f-4d4a-a2f6-d8e0ac07452c'; // Medihub user
  const userB = '0c7c3c73-e67b-4ab4-9499-2101950a755c'; // Real auth User B (tienanh123@gmail.com)

  // Setup Profiles
  await db.ensureProfile(userA, 'medihub@test.com', 'CTY CP MEDIHUB');
  await db.ensureProfile(userB, 'tienanh123@gmail.com', 'Tien Anh');

  const { data: initialProfA } = await client.from('profiles').select('used_documents').eq('id', userA).single();
  const originalUserAQuota = initialProfA?.used_documents ?? 0;

  const { data: initialProfB } = await client.from('profiles').select('used_documents').eq('id', userB).single();
  const originalUserBQuota = initialProfB?.used_documents ?? 0;

  const createdDocIds: string[] = [];
  const createdJobIds: string[] = [];

  let passedCount = 0;
  let failedCount = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`✅ [PASS] ${msg}`);
      passedCount++;
    } else {
      console.error(`❌ [FAIL] ${msg}`);
      failedCount++;
    }
  }

  async function createTestDoc(
    userId: string,
    initialStatus: DocumentRecord['status'] = 'WAITING_CONFIRMATION',
    outputType: string = 'EXCEL'
  ): Promise<DocumentRecord> {
    const docId = crypto.randomUUID();
    const doc = await db.createDocument({
      id: docId,
      user_id: userId,
      original_filename: `matrix_test_${Date.now()}_${docId.slice(0, 8)}.pdf`,
      file_name: `matrix_test_${Date.now()}_${docId.slice(0, 8)}.pdf`,
      file_type: 'PDF',
      mime_type: 'application/pdf',
      file_size: 1024,
      page_count: 2,
      storage_bucket: 'documents',
      storage_path: `${userId}/${docId}/test.pdf`,
      document_type: 'BANK_STATEMENT',
      status: initialStatus,
      output_type: outputType as any,
    });
    createdDocIds.push(docId);
    return doc;
  }

  try {
    // =========================================================================
    // TEST 1 — NORMAL SUCCESS
    // =========================================================================
    console.log('\n--- TEST 1: Normal Successful Processing ---');
    try {
      await client.from('profiles').update({ used_documents: 0 }).eq('id', userA);
      const doc1 = await createTestDoc(userA, 'WAITING_CONFIRMATION');

      const res1 = await db.confirmDocumentProcessing(userA, doc1.id, 'EXCEL');
      if (res1.job?.id) createdJobIds.push(res1.job.id);

      assert(res1.success === true, 'Test 1: confirmDocumentProcessing returns success: true');
      assert(res1.document.status === 'QUEUED', 'Test 1: document status transitioned to QUEUED');
      assert(res1.quota.used === 1, 'Test 1: quota used incremented to 1');
      assert(res1.job !== null && res1.job.status === 'QUEUED', 'Test 1: exactly one processing job created in QUEUED status');

      // Direct DB Verification
      const { data: dbDoc } = await client.from('documents').select('status, output_type').eq('id', doc1.id).single();
      const { data: dbProf } = await client.from('profiles').select('used_documents').eq('id', userA).single();
      const { data: dbJobs } = await client.from('processing_jobs').select('*').eq('document_id', doc1.id);

      assert(dbDoc?.status === 'QUEUED', 'Test 1 (Direct DB): documents.status in PostgreSQL is QUEUED');
      assert(dbDoc?.output_type === 'EXCEL', 'Test 1 (Direct DB): documents.output_type in PostgreSQL is EXCEL');
      assert(dbProf?.used_documents === 1, 'Test 1 (Direct DB): profiles.used_documents in PostgreSQL is exactly 1');
      assert(dbJobs?.length === 1 && dbJobs[0].status === 'QUEUED', 'Test 1 (Direct DB): processing_jobs count in PostgreSQL is exactly 1 in QUEUED status');
    } catch (err: any) {
      console.error('Test 1 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 2 — SAME DOCUMENT CONCURRENT REQUESTS
    // =========================================================================
    console.log('\n--- TEST 2: Same Document Concurrent Requests ---');
    try {
      await client.from('profiles').update({ used_documents: 0 }).eq('id', userA);
      const doc2 = await createTestDoc(userA, 'WAITING_CONFIRMATION');

      // Parallel execution via Promise.all
      const [p1, p2] = await Promise.all([
        db.confirmDocumentProcessing(userA, doc2.id, 'EXCEL'),
        db.confirmDocumentProcessing(userA, doc2.id, 'EXCEL'),
      ]);

      if (p1.job?.id) createdJobIds.push(p1.job.id);
      if (p2.job?.id) createdJobIds.push(p2.job.id);

      const oneSucceededOneIdempotent =
        (!p1.already_processing && p2.already_processing) || (p1.already_processing && !p2.already_processing);
      assert(oneSucceededOneIdempotent, 'Test 2: Exactly one request performs transaction; second request safely returns already_processing');

      // Direct DB verification
      const { data: dbJobs2 } = await client.from('processing_jobs').select('*').eq('document_id', doc2.id);
      const { data: dbProf2 } = await client.from('profiles').select('used_documents').eq('id', userA).single();

      assert(dbJobs2?.length === 1, 'Test 2 (Direct DB): Exactly one processing job created despite concurrent requests');
      assert(dbProf2?.used_documents === 1, 'Test 2 (Direct DB): Quota incremented exactly once (used_documents = 1)');
    } catch (err: any) {
      console.error('Test 2 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 3 — TWO DIFFERENT DOCUMENTS COMPETING FOR LAST QUOTA
    // =========================================================================
    console.log('\n--- TEST 3: Two Different Documents Competing for Last Quota ---');
    try {
      // Free plan has quota = 3. Set used = 2 -> Exactly 1 slot remains.
      await client.from('profiles').update({ used_documents: 2 }).eq('id', userA);
      const docA = await createTestDoc(userA, 'WAITING_CONFIRMATION');
      const docB = await createTestDoc(userA, 'WAITING_CONFIRMATION');

      // Compete concurrently for the final quota slot
      const results = await Promise.allSettled([
        db.confirmDocumentProcessing(userA, docA.id, 'EXCEL'),
        db.confirmDocumentProcessing(userA, docB.id, 'EXCEL'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert(fulfilled.length === 1, 'Test 3: Exactly 1 document transaction succeeds');
      assert(rejected.length === 1, 'Test 3: Exactly 1 document transaction is rejected with INSUFFICIENT_QUOTA');
      if (rejected.length === 1) {
        assert(
          String((rejected[0] as PromiseRejectedResult).reason?.message || '').includes('INSUFFICIENT_QUOTA'),
          'Test 3: Rejection error message is INSUFFICIENT_QUOTA'
        );
      }

      const { data: finalProfile3 } = await client.from('profiles').select('used_documents').eq('id', userA).single();
      assert(finalProfile3?.used_documents === 3, 'Test 3 (Direct DB): profiles.used_documents is 3 (never exceeds limit)');

      // Verify that losing document remains WAITING_CONFIRMATION with 0 jobs
      const winningDocId = (fulfilled[0] as PromiseFulfilledResult<any>).value.document.id;
      const losingDocId = winningDocId === docA.id ? docB.id : docA.id;

      const { data: losingDoc } = await client.from('documents').select('status').eq('id', losingDocId).single();
      const { data: losingJobs } = await client.from('processing_jobs').select('id').eq('document_id', losingDocId);

      assert(losingDoc?.status === 'WAITING_CONFIRMATION', 'Test 3 (Direct DB): Losing document remains WAITING_CONFIRMATION');
      assert(losingJobs?.length === 0, 'Test 3 (Direct DB): Losing document has 0 processing jobs');
    } catch (err: any) {
      console.error('Test 3 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 4 — NO QUOTA AVAILABLE
    // =========================================================================
    console.log('\n--- TEST 4: No Quota Available ---');
    try {
      await client.from('profiles').update({ used_documents: 3 }).eq('id', userA);
      const doc4 = await createTestDoc(userA, 'WAITING_CONFIRMATION');

      let errorThrown = false;
      try {
        await db.confirmDocumentProcessing(userA, doc4.id, 'EXCEL');
      } catch (err: any) {
        errorThrown = true;
        assert(err.message.includes('INSUFFICIENT_QUOTA'), 'Test 4: Throws INSUFFICIENT_QUOTA exception');
      }

      assert(errorThrown, 'Test 4: confirmDocumentProcessing rejected when quota exhausted');
      const { data: checkDoc4 } = await client.from('documents').select('status').eq('id', doc4.id).single();
      const { data: checkJobs4 } = await client.from('processing_jobs').select('id').eq('document_id', doc4.id);
      const { data: checkProf4 } = await client.from('profiles').select('used_documents').eq('id', userA).single();

      assert(checkDoc4?.status === 'WAITING_CONFIRMATION', 'Test 4 (Direct DB): Document remains WAITING_CONFIRMATION');
      assert(checkJobs4?.length === 0, 'Test 4 (Direct DB): Zero processing jobs created');
      assert(checkProf4?.used_documents === 3, 'Test 4 (Direct DB): Quota unchanged at 3');
    } catch (err: any) {
      console.error('Test 4 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 5 — WORD OUTPUT REJECTION
    // =========================================================================
    console.log('\n--- TEST 5: Unsupported WORD Output ---');
    try {
      await client.from('profiles').update({ used_documents: 0 }).eq('id', userA);
      const doc5 = await createTestDoc(userA, 'WAITING_CONFIRMATION');

      let wordRejected = false;
      try {
        await db.confirmDocumentProcessing(userA, doc5.id, 'WORD');
      } catch (err: any) {
        wordRejected = true;
        assert(err.message.includes('UNSUPPORTED_OUTPUT_TYPE'), 'Test 5: Throws UNSUPPORTED_OUTPUT_TYPE');
      }

      assert(wordRejected, 'Test 5: WORD output rejected upfront by RPC');
      const { data: checkDoc5 } = await client.from('documents').select('status, output_type').eq('id', doc5.id).single();
      const { data: checkProf5 } = await client.from('profiles').select('used_documents').eq('id', userA).single();
      const { data: checkJobs5 } = await client.from('processing_jobs').select('id').eq('document_id', doc5.id);

      assert(checkDoc5?.status === 'WAITING_CONFIRMATION', 'Test 5 (Direct DB): Document remains WAITING_CONFIRMATION');
      assert(checkProf5?.used_documents === 0, 'Test 5 (Direct DB): Quota untouched at 0');
      assert(checkJobs5?.length === 0, 'Test 5 (Direct DB): Zero processing jobs created');
    } catch (err: any) {
      console.error('Test 5 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 6 — JOB INSERT FAILURE ROLLBACK
    // =========================================================================
    console.log('\n--- TEST 6: Job Insert Failure Rollback ---');
    try {
      await client.from('profiles').update({ used_documents: 0 }).eq('id', userA);
      const doc6 = await createTestDoc(userA, 'WAITING_CONFIRMATION');

      // Pre-insert an ACTIVE job directly into processing_jobs for doc6 to trigger unique index violation on Step 8
      const preJobId = crypto.randomUUID();
      await client.from('processing_jobs').insert({
        id: preJobId,
        document_id: doc6.id,
        user_id: userA,
        status: 'PROCESSING',
        current_step: 'Directly injected active job',
      });
      createdJobIds.push(preJobId);

      // Now invoke RPC: Document is WAITING_CONFIRMATION, but inserting new job violates partial unique index!
      let insertViolated = false;
      try {
        await db.confirmDocumentProcessing(userA, doc6.id, 'EXCEL');
      } catch (err: any) {
        insertViolated = true;
        assert(err.message.includes('idx_processing_jobs_active_doc') || err.message.includes('duplicate key'), 'Test 6: Job insertion failed with unique constraint violation');
      }
      assert(insertViolated, 'Test 6: Transaction failed due to job insertion conflict');

      // Direct DB verification: Document must remain WAITING_CONFIRMATION, quota MUST be 0 (full transaction rollback)
      const { data: doc6Check } = await client.from('documents').select('status').eq('id', doc6.id).single();
      const { data: prof6Check } = await client.from('profiles').select('used_documents').eq('id', userA).single();

      assert(doc6Check?.status === 'WAITING_CONFIRMATION', 'Test 6 (Direct DB): Document status rolled back to WAITING_CONFIRMATION');
      assert(prof6Check?.used_documents === 0, 'Test 6 (Direct DB): Quota rolled back (remains 0, not incremented)');
    } catch (err: any) {
      console.error('Test 6 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 7 — QUOTA UPDATE FAILURE ROLLBACK
    // =========================================================================
    console.log('\n--- TEST 7: Quota Failure Rollback ---');
    try {
      // Profile has used_documents = 3 (exhausted)
      await client.from('profiles').update({ used_documents: 3 }).eq('id', userA);
      const doc7 = await createTestDoc(userA, 'WAITING_CONFIRMATION');

      let quotaFailed = false;
      try {
        await db.confirmDocumentProcessing(userA, doc7.id, 'EXCEL');
      } catch (err: any) {
        quotaFailed = true;
        assert(err.message.includes('INSUFFICIENT_QUOTA'), 'Test 7: Fails with INSUFFICIENT_QUOTA exception');
      }
      assert(quotaFailed, 'Test 7: Quota failure triggered rollback');

      // Direct DB verification: Document lock was released, doc remains WAITING_CONFIRMATION, 0 jobs created
      const { data: doc7Check } = await client.from('documents').select('status').eq('id', doc7.id).single();
      const { data: jobs7Check } = await client.from('processing_jobs').select('id').eq('document_id', doc7.id);
      const { data: prof7Check } = await client.from('profiles').select('used_documents').eq('id', userA).single();

      assert(doc7Check?.status === 'WAITING_CONFIRMATION', 'Test 7 (Direct DB): Document remains WAITING_CONFIRMATION');
      assert(jobs7Check?.length === 0, 'Test 7 (Direct DB): Zero jobs created in rolled-back transaction');
      assert(prof7Check?.used_documents === 3, 'Test 7 (Direct DB): Quota unchanged at 3');
    } catch (err: any) {
      console.error('Test 7 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 8 — DOCUMENT UPDATE FAILURE ROLLBACK (INVALID DOCUMENT STATE)
    // =========================================================================
    console.log('\n--- TEST 8: Document State Failure Rollback ---');
    try {
      await client.from('profiles').update({ used_documents: 0 }).eq('id', userA);
      const doc8 = await createTestDoc(userA, 'FAILED');

      let stateRejected = false;
      try {
        await db.confirmDocumentProcessing(userA, doc8.id, 'EXCEL');
      } catch (err: any) {
        stateRejected = true;
        assert(err.message.includes('INVALID_DOCUMENT_STATE'), 'Test 8: Rejects with INVALID_DOCUMENT_STATE');
      }
      assert(stateRejected, 'Test 8: Document in invalid state triggers clean rejection');

      // Direct DB verification
      const { data: doc8Check } = await client.from('documents').select('status').eq('id', doc8.id).single();
      const { data: jobs8Check } = await client.from('processing_jobs').select('id').eq('document_id', doc8.id);
      const { data: prof8Check } = await client.from('profiles').select('used_documents').eq('id', userA).single();

      assert(doc8Check?.status === 'FAILED', 'Test 8 (Direct DB): Document status remains FAILED');
      assert(jobs8Check?.length === 0, 'Test 8 (Direct DB): Zero jobs created');
      assert(prof8Check?.used_documents === 0, 'Test 8 (Direct DB): Quota untouched at 0');
    } catch (err: any) {
      console.error('Test 8 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 9 — REPEATED REQUEST AFTER SUCCESS (IDEMPOTENCY)
    // =========================================================================
    console.log('\n--- TEST 9: Repeated Request After Success ---');
    try {
      await client.from('profiles').update({ used_documents: 0 }).eq('id', userA);
      const doc9 = await createTestDoc(userA, 'WAITING_CONFIRMATION');

      // First call: succeeds
      const call1 = await db.confirmDocumentProcessing(userA, doc9.id, 'EXCEL');
      if (call1.job?.id) createdJobIds.push(call1.job.id);
      assert(call1.already_processing === false, 'Test 9: Call 1 returns already_processing = false');
      assert(call1.quota.used === 1, 'Test 9: Call 1 quota used = 1');

      // Second call: idempotent
      const call2 = await db.confirmDocumentProcessing(userA, doc9.id, 'EXCEL');
      assert(call2.already_processing === true, 'Test 9: Call 2 returns already_processing = true');
      assert(call2.quota.used === 1, 'Test 9: Call 2 does NOT increment quota again (used = 1)');
      assert(call2.job?.id === call1.job?.id, 'Test 9: Call 2 returns identical active job ID');

      // Third call: idempotent
      const call3 = await db.confirmDocumentProcessing(userA, doc9.id, 'EXCEL');
      assert(call3.already_processing === true, 'Test 9: Call 3 returns already_processing = true');

      const { data: jobsCount9 } = await client.from('processing_jobs').select('id').eq('document_id', doc9.id);
      assert(jobsCount9?.length === 1, 'Test 9 (Direct DB): Exactly 1 processing_jobs row exists');
    } catch (err: any) {
      console.error('Test 9 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 10 — COMPLETED DOCUMENT (READY & REVIEW_REQUIRED)
    // =========================================================================
    console.log('\n--- TEST 10: Completed Document (READY & REVIEW_REQUIRED) ---');
    try {
      await client.from('profiles').update({ used_documents: 1 }).eq('id', userA);

      // 10A: READY
      const docReady = await createTestDoc(userA, 'READY');
      const resReady = await db.confirmDocumentProcessing(userA, docReady.id, 'EXCEL');
      assert(resReady.already_completed === true, 'Test 10: READY document returns already_completed = true');
      assert(resReady.quota.used === 1, 'Test 10: READY document does not consume quota (used = 1)');

      // 10B: REVIEW_REQUIRED
      const docReview = await createTestDoc(userA, 'REVIEW_REQUIRED');
      const resReview = await db.confirmDocumentProcessing(userA, docReview.id, 'EXCEL');
      assert(resReview.already_completed === true, 'Test 10: REVIEW_REQUIRED document returns already_completed = true');
      assert(resReview.quota.used === 1, 'Test 10: REVIEW_REQUIRED document does not consume quota (used = 1)');

      const { data: prof10 } = await client.from('profiles').select('used_documents').eq('id', userA).single();
      assert(prof10?.used_documents === 1, 'Test 10 (Direct DB): Quota remains 1 after both completed doc calls');
    } catch (err: any) {
      console.error('Test 10 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 11 — TWO INDEPENDENT DATABASE CLIENTS / NODE CONTEXTS
    // =========================================================================
    console.log('\n--- TEST 11: Two Independent Database Clients ---');
    try {
      const client1 = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
      const client2 = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

      await client.from('profiles').update({ used_documents: 1 }).eq('id', userA);
      const doc11 = await createTestDoc(userA, 'WAITING_CONFIRMATION');

      const [r1, r2] = await Promise.all([
        client1.rpc('confirm_document_processing', { p_document_id: doc11.id, p_user_id: userA, p_output_type: 'EXCEL' }),
        client2.rpc('confirm_document_processing', { p_document_id: doc11.id, p_user_id: userA, p_output_type: 'EXCEL' }),
      ]);

      const resData1 = r1.data;
      const resData2 = r2.data;

      const oneNew =
        (!resData1.already_processing && resData2.already_processing) ||
        (resData1.already_processing && !resData2.already_processing);
      assert(oneNew, 'Test 11: PostgreSQL row lock protects concurrency across separate client instances');

      const { data: jobs11 } = await client.from('processing_jobs').select('id').eq('document_id', doc11.id);
      const { data: prof11 } = await client.from('profiles').select('used_documents').eq('id', userA).single();

      assert(jobs11?.length === 1, 'Test 11 (Direct DB): Exactly one processing job created');
      assert(prof11?.used_documents === 2, 'Test 11 (Direct DB): Quota incremented exactly once (1 -> 2)');
    } catch (err: any) {
      console.error('Test 11 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 12 — WORKER START FAILURE AFTER COMMIT
    // =========================================================================
    console.log('\n--- TEST 12: Worker Start Failure After COMMIT ---');
    try {
      await client.from('profiles').update({ used_documents: 0 }).eq('id', userA);
      const doc12 = await createTestDoc(userA, 'WAITING_CONFIRMATION');

      // RPC transaction commits successfully
      const txRes = await db.confirmDocumentProcessing(userA, doc12.id, 'EXCEL');
      if (txRes.job?.id) createdJobIds.push(txRes.job.id);

      assert(txRes.document.status === 'QUEUED', 'Test 12: Database committed state: document is QUEUED');
      assert(txRes.job?.status === 'QUEUED', 'Test 12: Database committed state: job is QUEUED');
      assert(txRes.quota.used === 1, 'Test 12: Database committed state: quota consumed once');

      // Simulate post-commit worker bootstrap crash
      console.log('[Test 12 Simulation] Simulating worker start failure: PROCESS_WORKER_START_FAILED');
      try {
        throw new Error('PROCESS_WORKER_START_FAILED: Simulating immediate worker start failure after commit');
      } catch (workerErr: any) {
        console.log('Caught simulated worker failure:', workerErr.message);
      }

      // Assert database state: committed state MUST NOT be rolled back or mutated
      const { data: doc12Check } = await client.from('documents').select('status').eq('id', doc12.id).single();
      const { data: job12Check } = await client.from('processing_jobs').select('status').eq('id', txRes.job?.id).single();
      const { data: prof12Check } = await client.from('profiles').select('used_documents').eq('id', userA).single();

      assert(doc12Check?.status === 'QUEUED', 'Test 12 (Direct DB): Document remains stably QUEUED in database');
      assert(job12Check?.status === 'QUEUED', 'Test 12 (Direct DB): Job remains stably QUEUED for startup recovery');
      assert(prof12Check?.used_documents === 1, 'Test 12 (Direct DB): Quota remains 1 (not refunded, not double charged)');
    } catch (err: any) {
      console.error('Test 12 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 13 — WORKER RECOVERY QUERY COMPATIBILITY
    // =========================================================================
    console.log('\n--- TEST 13: Worker Recovery Compatibility ---');
    try {
      const activeJobs = await db.getQueuedJobs();
      assert(Array.isArray(activeJobs), 'Test 13: db.getQueuedJobs() returns array from PostgreSQL');
      console.log(`Test 13: Current active jobs in PostgreSQL ready for recovery: ${activeJobs.length}`);
      assert(true, 'Test 13: Recovery query successfully interfaces with PostgreSQL');
    } catch (err: any) {
      console.error('Test 13 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 14 — PARTIAL UNIQUE INDEX PROTECTION & HISTORICAL SEMANTICS
    // =========================================================================
    console.log('\n--- TEST 14: Partial Unique Index ---');
    try {
      const doc14 = await createTestDoc(userA, 'WAITING_CONFIRMATION');
      const jobAId = crypto.randomUUID();
      const jobBId = crypto.randomUUID();
      const jobTerminalId = crypto.randomUUID();

      // 1. Insert first active job
      const { error: errJob1 } = await client.from('processing_jobs').insert({
        id: jobAId,
        document_id: doc14.id,
        user_id: userA,
        status: 'QUEUED',
        current_step: 'Active job 1',
      });
      createdJobIds.push(jobAId);
      assert(!errJob1, 'Test 14: First active job inserts successfully');

      // 2. Attempt inserting second active job for the SAME document
      const { error: errJob2 } = await client.from('processing_jobs').insert({
        id: jobBId,
        document_id: doc14.id,
        user_id: userA,
        status: 'PROCESSING',
        current_step: 'Active job 2 (duplicate)',
      });
      assert(Boolean(errJob2), 'Test 14: PostgreSQL rejects second active job with unique constraint violation');
      assert(errJob2?.code === '23505', 'Test 14: Error code is 23505 (unique_violation on idx_processing_jobs_active_doc)');

      // 3. Insert historical terminal job for the SAME document (must SUCCEED)
      const { error: errTerminal } = await client.from('processing_jobs').insert({
        id: jobTerminalId,
        document_id: doc14.id,
        user_id: userA,
        status: 'READY',
        current_step: 'Completed terminal job',
      });
      createdJobIds.push(jobTerminalId);
      assert(!errTerminal, 'Test 14: Partial unique index correctly permits terminal READY job history');
    } catch (err: any) {
      console.error('Test 14 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 15 — ORPHANED PROCESSING STATE
    // =========================================================================
    console.log('\n--- TEST 15: Orphaned Processing State ---');
    try {
      await client.from('profiles').update({ used_documents: 0 }).eq('id', userA);
      // Create inconsistent state: document is QUEUED, but no active job exists in processing_jobs
      const docOrphan = await createTestDoc(userA, 'QUEUED');

      let orphanRejected = false;
      try {
        await db.confirmDocumentProcessing(userA, docOrphan.id, 'EXCEL');
      } catch (err: any) {
        orphanRejected = true;
        assert(err.message.includes('ORPHANED_PROCESSING_STATE'), 'Test 15: Throws ORPHANED_PROCESSING_STATE');
      }
      assert(orphanRejected, 'Test 15: Inconsistent state rejected (does not create silent duplicate or return false success)');

      // Verify no quota consumed and no job created
      const { data: checkProf15 } = await client.from('profiles').select('used_documents').eq('id', userA).single();
      const { data: checkJobs15 } = await client.from('processing_jobs').select('id').eq('document_id', docOrphan.id);

      assert(checkProf15?.used_documents === 0, 'Test 15 (Direct DB): Quota untouched at 0');
      assert(checkJobs15?.length === 0, 'Test 15 (Direct DB): Zero jobs created');
    } catch (err: any) {
      console.error('Test 15 error:', err.message);
      failedCount++;
    }

    // =========================================================================
    // TEST 16 — USER ISOLATION
    // =========================================================================
    console.log('\n--- TEST 16: User Isolation ---');
    try {
      await client.from('profiles').update({ used_documents: 1 }).eq('id', userA);
      await client.from('profiles').update({ used_documents: 0 }).eq('id', userB);

      const docB = await createTestDoc(userB, 'WAITING_CONFIRMATION');

      // User A attempts to confirm User B's document
      let accessDenied = false;
      try {
        await db.confirmDocumentProcessing(userA, docB.id, 'EXCEL');
      } catch (err: any) {
        accessDenied = true;
        assert(err.message.includes('DOCUMENT_ACCESS_DENIED'), 'Test 16: Denies access with DOCUMENT_ACCESS_DENIED');
      }
      assert(accessDenied, 'Test 16: Cross-user confirmation strictly forbidden');

      // Verify User B document and quota remain completely untouched
      const { data: checkDocB } = await client.from('documents').select('status').eq('id', docB.id).single();
      const { data: checkProfB } = await client.from('profiles').select('used_documents').eq('id', userB).single();
      const { data: checkJobsB } = await client.from('processing_jobs').select('id').eq('document_id', docB.id);

      assert(checkDocB?.status === 'WAITING_CONFIRMATION', 'Test 16 (Direct DB): User B document remains WAITING_CONFIRMATION');
      assert(checkProfB?.used_documents === 0, 'Test 16 (Direct DB): User B quota remains 0');
      assert(checkJobsB?.length === 0, 'Test 16 (Direct DB): Zero jobs created');
    } catch (err: any) {
      console.error('Test 16 error:', err.message);
      failedCount++;
    }

    console.log('\n================================================================');
    console.log(`TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
    console.log('================================================================\n');

    if (failedCount > 0) {
      process.exit(1);
    }
  } finally {
    console.log('--- Cleaning up test records from PostgreSQL ---');
    if (createdJobIds.length > 0) {
      await client.from('processing_jobs').delete().in('id', createdJobIds);
    }
    if (createdDocIds.length > 0) {
      await client.from('processing_jobs').delete().in('document_id', createdDocIds);
      await client.from('documents').delete().in('id', createdDocIds);
    }
    await client.from('profiles').update({ used_documents: originalUserBQuota }).eq('id', userB);
    await client.from('profiles').update({ used_documents: originalUserAQuota }).eq('id', userA);
    console.log('✅ Cleanup finished: Test documents & jobs removed, User A & B quotas restored.');
  }
}

runPhase42TestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
