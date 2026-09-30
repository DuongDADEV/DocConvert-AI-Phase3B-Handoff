import 'dotenv/config';
import crypto from 'crypto';
import { db, ProcessingJobRecord } from '../db/db.js';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { ocrWorker } from '../services/ocrWorker.js';

async function runRecoveryLifecycleTest() {
  console.log('================================================================');
  console.log('   WORKER RECOVERY LIFECYCLE VERIFICATION TEST');
  console.log('================================================================\n');

  const client = getSupabaseAdminClient();
  const testUserId = '30ed6381-0d2f-4d4a-a2f6-d8e0ac07452c'; // Valid auth user in Supabase

  // Ensure test user has profile with current_plan_id = FREE
  await db.ensureProfile(testUserId, 'medihub@test.com', 'CTY CP MEDIHUB');
  const { data: initialProf } = await client.from('profiles').select('used_documents').eq('id', testUserId).single();
  const originalUsedDocs = initialProf?.used_documents ?? 0;
  await client.from('profiles').update({ used_documents: 1 }).eq('id', testUserId);

  // Clean up any stale test rows from previous runs
  const { data: staleDocs } = await client
    .from('documents')
    .select('id')
    .eq('user_id', testUserId)
    .ilike('original_filename', 'recovery_%');
  if (staleDocs && staleDocs.length > 0) {
    const staleDocIds = staleDocs.map((d) => d.id);
    await client.from('processing_jobs').delete().in('document_id', staleDocIds);
    await client.from('documents').delete().in('id', staleDocIds);
  }

  // Count pre-existing jobs
  const { data: existingJobs } = await client.from('processing_jobs').select('id').eq('user_id', testUserId);
  const baselineJobCount = existingJobs?.length || 0;

  const activeStatuses: ProcessingJobRecord['status'][] = [
    'QUEUED',
    'PROCESSING',
    'VALIDATING',
    'UPLOADING',
    'PARSING',
    'VALIDATING_RESULT',
  ];

  console.log(`1. Setting up 6 test documents and active jobs in PostgreSQL for statuses:`);
  console.log(activeStatuses.join(', '));

  const testJobs: { docId: string; jobId: string; status: ProcessingJobRecord['status'] }[] = [];

  try {
    for (const status of activeStatuses) {
      const docId = crypto.randomUUID();
      const jobId = crypto.randomUUID();

      // Create document
      const { error: docErr } = await client.from('documents').insert({
        id: docId,
        user_id: testUserId,
        original_filename: `recovery_${status.toLowerCase()}.pdf`,
        file_name: `recovery_${status.toLowerCase()}.pdf`,
        file_type: 'PDF',
        mime_type: 'application/pdf',
        file_size: 1024,
        page_count: 1,
        storage_bucket: 'documents',
        storage_path: `${testUserId}/${docId}/test.pdf`,
        document_type: 'BANK_STATEMENT',
        status: status === 'QUEUED' ? 'QUEUED' : 'PROCESSING',
        output_type: 'EXCEL',
      });
      if (docErr) throw new Error(`Error creating test document: ${docErr.message}`);

      // Create active job with exact status
      const { error: jobErr } = await client.from('processing_jobs').insert({
        id: jobId,
        document_id: docId,
        user_id: testUserId,
        status: status,
        current_step: `Persisted active job in ${status} status`,
        progress: 30,
        attempt_count: 1,
        started_at: new Date().toISOString(),
      });
      if (jobErr) throw new Error(`Error creating test job: ${jobErr.message}`);

      testJobs.push({ docId, jobId, status });
    }

    console.log(`\n2. Successfully inserted ${testJobs.length} active jobs directly in Supabase.`);
    const expectedJobIds = new Set(testJobs.map((j) => j.jobId));

    // Verify query from db.getQueuedJobs() returns all 6 active statuses
    const pendingFromDb = await db.getQueuedJobs();
    const ourPendingJobs = pendingFromDb.filter((j) => expectedJobIds.has(j.id));
    console.log(`\n3. db.getQueuedJobs() queried ${ourPendingJobs.length} / ${testJobs.length} test active jobs.`);
    if (ourPendingJobs.length !== 6) {
      console.error('❌ FAIL: db.getQueuedJobs() did not return all 6 active status jobs!');
      process.exit(1);
    } else {
      console.log('✅ PASS: db.getQueuedJobs() successfully includes QUEUED, PROCESSING, VALIDATING, UPLOADING, PARSING, VALIDATING_RESULT.');
    }

    // Intercept processJob to verify deterministic execution, hold in-flight state, and prevent unneeded storage errors
    const jobExecutionCounts = new Map<string, number>();
    let releaseInFlightHold: () => void;
    const holdPromise = new Promise<void>((resolve) => {
      releaseInFlightHold = resolve;
    });

    const originalProcessJob = ocrWorker.processJob.bind(ocrWorker);
    (ocrWorker as any).processJob = async (userId: string, jobId: string, docId: string) => {
      if (expectedJobIds.has(jobId)) {
        jobExecutionCounts.set(jobId, (jobExecutionCounts.get(jobId) || 0) + 1);
        ocrWorker['inFlightJobs'].add(jobId);
        try {
          await holdPromise;
        } finally {
          ocrWorker['inFlightJobs'].delete(jobId);
        }
        return null;
      }
      return originalProcessJob(userId, jobId, docId);
    };

    // --- Step 4: Authoritative Startup Recovery (Run 1) ---
    console.log('\n4. Executing authoritative startup recovery (Run 1)...');
    const initialRecovered = await ocrWorker.resumeUnfinishedJobs();
    const ourRecovered = initialRecovered.filter((j) => expectedJobIds.has(j.id));

    console.log(`   Run 1 recovered ${ourRecovered.length} of our test jobs.`);
    if (ourRecovered.length === 6) {
      console.log('✅ PASS: All 6 active jobs were picked up by resumeUnfinishedJobs().');
    } else {
      console.error(`❌ FAIL: Expected 6 jobs resumed, but got ${ourRecovered.length}`);
      process.exit(1);
    }

    // Verify same job IDs are reused
    for (const recJob of ourRecovered) {
      if (!expectedJobIds.has(recJob.id)) {
        console.error(`❌ FAIL: Unknown job ID resumed: ${recJob.id}`);
        process.exit(1);
      }
    }
    console.log('✅ PASS: The exact same job IDs were reused (no new job rows generated).');

    // Verify each job was started exactly once
    for (const j of testJobs) {
      const execCount = jobExecutionCounts.get(j.jobId) || 0;
      if (execCount !== 1) {
        console.error(`❌ FAIL: Job ${j.jobId} executed ${execCount} times (expected exactly 1)`);
        process.exit(1);
      }
    }
    console.log('✅ PASS: Each recoverable job started exactly once.');

    // Verify Quota was NOT consumed again
    const { data: profAfterRun1 } = await client.from('profiles').select('used_documents').eq('id', testUserId).single();
    if (profAfterRun1?.used_documents === 1) {
      console.log('✅ PASS: User quota was NOT consumed again (used_documents remained 1).');
    } else {
      console.error(`❌ FAIL: Quota mutated during recovery! Expected 1, found ${profAfterRun1?.used_documents}`);
      process.exit(1);
    }

    // --- Step 5: Duplicate Invocations Concurrency Guard (Run 2) ---
    console.log('\n5. Executing immediate duplicate recovery call (Run 2 while jobs in-flight)...');
    const secondRecoveryResult = await ocrWorker.resumeUnfinishedJobs();
    const ourSecondRecovered = secondRecoveryResult.filter((j) => expectedJobIds.has(j.id));

    console.log(`   Run 2 resumed ${ourSecondRecovered.length} duplicate jobs.`);
    if (ourSecondRecovered.length === 0) {
      console.log('✅ PASS: In-flight guard successfully prevented duplicate concurrent execution of all 6 jobs.');
    } else {
      console.error(`❌ FAIL: Jobs were duplicated in second run: ${ourSecondRecovered.length}`);
      process.exit(1);
    }

    // Verify execution counts did not increment
    for (const j of testJobs) {
      const execCount = jobExecutionCounts.get(j.jobId) || 0;
      if (execCount !== 1) {
        console.error(`❌ FAIL: Job ${j.jobId} re-executed during Run 2! Total executions: ${execCount}`);
        process.exit(1);
      }
    }
    console.log('✅ PASS: Execution count remains exactly 1 for all jobs after Run 2.');

    // --- Step 6: Verify total processing_jobs count in database ---
    const { data: dbJobsAfter } = await client.from('processing_jobs').select('id').eq('user_id', testUserId);
    const expectedTotal = baselineJobCount + 6;
    if (dbJobsAfter?.length === expectedTotal) {
      console.log(`✅ PASS: Exactly ${expectedTotal} processing_jobs rows exist in PostgreSQL (baseline ${baselineJobCount} + 6 test jobs, zero duplicates inserted).`);
    } else {
      console.error(`❌ FAIL: Job count changed in database! Expected ${expectedTotal}, found ${dbJobsAfter?.length}`);
      process.exit(1);
    }

    // Release held in-flight executions
    releaseInFlightHold!();
    (ocrWorker as any).processJob = originalProcessJob;

    console.log('\n================================================================');
    console.log('   ALL RECOVERY LIFECYCLE VERIFICATIONS PASSED (6/6 TESTS PASS)');
    console.log('================================================================\n');
  } finally {
    // --- Step 7: Guaranteed Cleanup of test rows and profile restoration ---
    console.log('Cleaning up test documents and jobs, restoring profile...');
    for (const t of testJobs) {
      await client.from('processing_jobs').delete().eq('id', t.jobId);
      await client.from('documents').delete().eq('id', t.docId);
    }
    await client.from('profiles').update({ used_documents: originalUsedDocs }).eq('id', testUserId);
    console.log('✅ Test cleanup and profile restore completed successfully.\n');
  }
}

runRecoveryLifecycleTest().catch((err) => {
  console.error('Fatal recovery test error:', err);
  process.exit(1);
});
