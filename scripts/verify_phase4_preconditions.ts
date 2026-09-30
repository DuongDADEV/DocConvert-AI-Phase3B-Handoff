import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function verifyPreconditions() {
  console.log('=== PHASE 4.2 PRECONDITION VERIFICATION ===\n');

  const client = getSupabaseAdminClient();

  // A. Query distinct job statuses in Supabase
  const { data: allJobs, error: err1 } = await client
    .from('processing_jobs')
    .select('id, document_id, user_id, status, created_at');

  if (err1) {
    console.error('Error querying processing_jobs:', err1);
    return;
  }

  const statusCounts: Record<string, number> = {};
  for (const job of allJobs || []) {
    statusCounts[job.status] = (statusCounts[job.status] || 0) + 1;
  }
  console.log('1. Database job status distribution (total:', (allJobs || []).length, '):');
  console.log(JSON.stringify(statusCounts, null, 2));

  // Check for active job duplicates
  const activeStatuses = ['QUEUED', 'PROCESSING', 'VALIDATING', 'UPLOADING', 'PARSING', 'VALIDATING_RESULT'];
  const activeJobs = (allJobs || []).filter((j) => activeStatuses.includes(j.status));

  console.log('\n2. Active jobs count:', activeJobs.length);
  const byDoc: Record<string, any[]> = {};
  for (const j of activeJobs) {
    byDoc[j.document_id] = (byDoc[j.document_id] || []).concat(j);
  }

  const duplicates = Object.entries(byDoc).filter(([_docId, jobs]) => jobs.length > 1);
  console.log('3. Duplicate active jobs per document_id:', duplicates.length);
  if (duplicates.length > 0) {
    console.log('DUPLICATE RECORDS FOUND:', JSON.stringify(duplicates, null, 2));
  } else {
    console.log('✅ ZERO duplicate active jobs found in database!');
  }
}

verifyPreconditions().catch(console.error);
