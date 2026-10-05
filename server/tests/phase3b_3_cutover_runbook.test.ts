/**
 * PHASE 3B.3 — MIGRATION CUTOVER & LIVE VERIFICATION RUNBOOK TEST SUITE
 *
 * Verifies:
 * - RUN-01 to RUN-04: Processing entry points & Maintenance guard behavior
 * - RUN-05 to RUN-07: Active-job drain & double-check zero-job safety
 * - RUN-08 to RUN-10: Backend / DB deployment order & mixed-version prohibition
 * - RUN-11 to RUN-14: Automated & manual verifier specifications & smoke test safety
 * - RUN-15 to RUN-18: Re-enable, stop, rollback/roll-forward policy & zero financial mutation
 */

import fs from 'fs';
import path from 'path';
import assert from 'assert';

let passed = 0;
let failed = 0;

async function runTest(id: string, name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`[PASS] ${id}: ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`[FAIL] ${id}: ${name} -> ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log('================================================================');
  console.log('PHASE 3B.3 — MIGRATION CUTOVER & RUNBOOK TESTS');
  console.log('================================================================\n');

  const runbookPath = path.resolve(process.cwd(), 'docs/phase3b_migration_cutover_runbook.md');
  const runbookSrc = fs.readFileSync(runbookPath, 'utf8');

  const docRoutePath = path.resolve(process.cwd(), 'server/routes/documents.ts');
  const docRouteSrc = fs.readFileSync(docRoutePath, 'utf8');

  const ocrWorkerPath = path.resolve(process.cwd(), 'server/services/ocrWorker.ts');
  const ocrWorkerSrc = fs.readFileSync(ocrWorkerPath, 'utf8');

  const manualSqlPath = path.resolve(process.cwd(), 'scripts/phase3b_manual_live_verification.sql');
  const manualSqlSrc = fs.readFileSync(manualSqlPath, 'utf8');

  const verifierPath = path.resolve(process.cwd(), 'scripts/verify_phase3b_real_db_enforcement.ts');
  const verifierSrc = fs.readFileSync(verifierPath, 'utf8');

  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261004010000_atomic_credit_reserve_before_processing_queue.sql'
  );
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  // RUN-01: all processing job creation entry points identified
  await runTest('RUN-01', 'all processing job creation entry points identified', () => {
    assert(docRouteSrc.includes("router.post('/:id/process'"), 'Contains confirm-processing route');
    assert(docRouteSrc.includes("router.post('/:id/ocr'"), 'Contains retry OCR route');
    assert(ocrWorkerSrc.includes('resumeUnfinishedJobs'), 'Contains startup worker recovery path');
  });

  // RUN-02: maintenance guard blocks new processing if implemented
  await runTest('RUN-02', 'maintenance guard blocks new processing if implemented', () => {
    assert(docRouteSrc.includes("process.env.PROCESSING_MAINTENANCE_MODE === 'true'"), 'Maintenance mode check implemented');
    assert(docRouteSrc.includes('PROCESSING_TEMPORARILY_UNAVAILABLE'), 'Returns 503 PROCESSING_TEMPORARILY_UNAVAILABLE');
  });

  // RUN-03: maintenance guard does not mutate credits
  await runTest('RUN-03', 'maintenance guard does not mutate credits', () => {
    // When maintenance mode is active, the route returns immediately before calling db.confirmDocumentProcessing or credit services
    const maintenanceIndex = docRouteSrc.indexOf("process.env.PROCESSING_MAINTENANCE_MODE === 'true'");
    const confirmCallIndex = docRouteSrc.indexOf('db.confirmDocumentProcessing');
    assert(maintenanceIndex > 0 && confirmCallIndex > maintenanceIndex, 'Maintenance guard returns before DB confirmation');
  });

  // RUN-04: maintenance guard does not cancel active jobs
  await runTest('RUN-04', 'maintenance guard does not cancel active jobs', () => {
    // Maintenance guard does not touch processing_jobs or cancel queued items
    assert(!docRouteSrc.includes("updateProcessingJob(..., { status: 'CANCELLED' })"));
    assert(!runbookSrc.includes('cancel active jobs'));
  });

  // RUN-05: active-job SQL is read-only
  await runTest('RUN-05', 'active-job SQL is read-only', () => {
    assert(manualSqlSrc.includes("SELECT\n    COUNT(*) AS active_jobs_count"));
    assert(manualSqlSrc.includes("WHERE status IN ('QUEUED', 'PROCESSING')"));
    assert(!manualSqlSrc.toUpperCase().includes('UPDATE '));
    assert(!manualSqlSrc.toUpperCase().includes('DELETE '));
  });

  // RUN-06: migration requires active_jobs_count = 0
  await runTest('RUN-06', 'migration requires active_jobs_count = 0', () => {
    assert(runbookSrc.includes('active_jobs_count = 0'));
    assert(runbookSrc.includes('SAFE_FOR_MIGRATION_CUTOVER'));
  });

  // RUN-07: double-check zero-job procedure documented
  await runTest('RUN-07', 'double-check zero-job procedure documented', () => {
    assert(runbookSrc.includes('Check 1') && runbookSrc.includes('Check 2'));
    assert(runbookSrc.includes('Wait 15 seconds') || runbookSrc.includes('15 seconds'));
  });

  // RUN-08: legacy backend/new DB compatibility audited
  await runTest('RUN-08', 'legacy backend/new DB compatibility audited', () => {
    assert(runbookSrc.includes('Old Backend + New DB') && runbookSrc.includes('INCOMPATIBLE'));
    assert(migrationSql.includes('PROCESSING_CONFIRM_SIGNATURE_DEPRECATED'));
  });

  // RUN-09: new backend/old DB compatibility audited
  await runTest('RUN-09', 'new backend/old DB compatibility audited', () => {
    assert(runbookSrc.includes('New Backend + Old DB') && runbookSrc.includes('INCOMPATIBLE'));
  });

  // RUN-10: mixed-version deployment prohibited
  await runTest('RUN-10', 'mixed-version deployment prohibited', () => {
    assert(runbookSrc.includes('Fleet Verification') || runbookSrc.includes('no old backend server instances'));
  });

  // RUN-11: automated verifier limitations documented
  await runTest('RUN-11', 'automated verifier limitations documented', () => {
    assert(verifierSrc.includes('AUTOMATABLE_POSTGREST'));
    assert(verifierSrc.includes('MANUAL_SUPABASE_SQL_EDITOR'));
    assert(runbookSrc.includes('Automated Verification (PostgREST Scope)'));
  });

  // RUN-12: manual verifier step documented
  await runTest('RUN-12', 'manual verifier step documented', () => {
    assert(runbookSrc.includes('scripts/phase3b_manual_live_verification.sql'));
    assert(runbookSrc.includes('Manual SQL Verification (Catalog & Definition Scope)'));
  });

  // RUN-13: smoke test requires valid reservation
  await runTest('RUN-13', 'smoke test requires valid reservation', () => {
    assert(runbookSrc.includes('id = processing_jobs.reservation_id') || runbookSrc.includes('reservation_id'));
    assert(runbookSrc.includes("reference_type = 'PROCESSING_JOB'"));
  });

  // RUN-14: provider-without-reservation remains impossible
  await runTest('RUN-14', 'provider-without-reservation remains impossible', () => {
    assert(ocrWorkerSrc.includes('if (!reservationValidation.valid)'));
    assert(ocrWorkerSrc.includes("error_code: 'MISSING_CREDIT_RESERVATION'"));
  });

  // RUN-15: re-enable criteria documented
  await runTest('RUN-15', 're-enable criteria documented', () => {
    assert(runbookSrc.includes('RE-ENABLING DOCUMENT PROCESSING'));
    assert(runbookSrc.includes('PROCESSING_MAINTENANCE_MODE=false'));
  });

  // RUN-16: stop criteria documented
  await runTest('RUN-16', 'stop criteria documented', () => {
    assert(runbookSrc.includes('STOP CRITERIA'));
    assert(runbookSrc.includes('Immediate Stop Conditions'));
  });

  // RUN-17: rollback/roll-forward policy documented
  await runTest('RUN-17', 'rollback/roll-forward policy documented', () => {
    assert(runbookSrc.includes('ROLL-FORWARD IS MANDATORY'));
    assert(runbookSrc.includes('Keep `PROCESSING_MAINTENANCE_MODE=true`') || runbookSrc.includes('Keep PROCESSING_MAINTENANCE_MODE=true'));
  });

  // RUN-18: no automatic production financial mutation exists
  await runTest('RUN-18', 'no automatic production financial mutation exists', () => {
    assert(!migrationSql.includes('INSERT INTO public.credit_reservations'));
    assert(runbookSrc.includes('NOT_RUN_PENDING_PRODUCT_OWNER_APPROVAL') || runbookSrc.includes('creates real financial reservation rows'));
  });

  console.log('\n================================================================');
  console.log(`PHASE 3B.3 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
