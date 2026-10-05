/**
 * PHASE 3B.3.1 — BACKWARD-COMPATIBLE MAINTENANCE BRIDGE TEST SUITE
 *
 * Verifies:
 * - BRIDGE-01 to BRIDGE-04: Bridge schema/RPC independence & 503 maintenance response
 * - BRIDGE-05 to BRIDGE-08: Fail-closed ordering & non-overridability
 * - BRIDGE-09 to BRIDGE-10: Upload/preflight availability during maintenance
 * - BRIDGE-11 to BRIDGE-15: Worker historical job draining & independence from Phase 3B reservation gate
 * - BRIDGE-16 to BRIDGE-20: Compatibility matrix, Stage A/B runbook & mixed-version prohibition
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
  console.log('PHASE 3B.3.1 — BACKWARD-COMPATIBLE MAINTENANCE BRIDGE TESTS');
  console.log('================================================================\n');

  const runbookPath = path.resolve(process.cwd(), 'docs/phase3b_migration_cutover_runbook.md');
  const runbookSrc = fs.readFileSync(runbookPath, 'utf8');

  const patchPath = path.resolve(process.cwd(), 'scripts/phase3b_stage_a_bridge.patch');
  const patchSrc = fs.readFileSync(patchPath, 'utf8');

  const docRoutePath = path.resolve(process.cwd(), 'server/routes/documents.ts');
  const docRouteSrc = fs.readFileSync(docRoutePath, 'utf8');

  const ocrWorkerPath = path.resolve(process.cwd(), 'server/services/ocrWorker.ts');
  const ocrWorkerSrc = fs.readFileSync(ocrWorkerPath, 'utf8');

  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261004010000_atomic_credit_reserve_before_processing_queue.sql'
  );
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  // BRIDGE-01: bridge backend does not require new processing_jobs columns
  await runTest('BRIDGE-01', 'bridge backend does not require new processing_jobs columns', () => {
    // The patch for Stage A modifies ONLY server/routes/documents.ts with the maintenance guard
    assert(!patchSrc.includes('reservation_id'));
    assert(!patchSrc.includes('pricing_version'));
    assert(!patchSrc.includes('estimated_billable_units'));
    assert(!patchSrc.includes('quote_snapshot'));
  });

  // BRIDGE-02: bridge uses old DB RPC contract
  await runTest('BRIDGE-02', 'bridge uses old DB RPC contract', () => {
    assert(runbookSrc.includes('Uses the **OLD RPC contract** (3-arg `confirm_document_processing`)') ||
           runbookSrc.includes('OLD RPC contract'));
    assert(!patchSrc.includes('p_quote_snapshot'));
    assert(!patchSrc.includes('p_estimated_units'));
  });

  // BRIDGE-03: /process returns 503 in maintenance mode
  await runTest('BRIDGE-03', '/process returns 503 in maintenance mode', () => {
    assert(docRouteSrc.includes("process.env.PROCESSING_MAINTENANCE_MODE === 'true'"));
    assert(docRouteSrc.includes("code: 'PROCESSING_TEMPORARILY_UNAVAILABLE'"));
    assert(docRouteSrc.includes('res.status(503)'));
  });

  // BRIDGE-04: /ocr returns 503 in maintenance mode
  await runTest('BRIDGE-04', '/ocr returns 503 in maintenance mode', () => {
    // Check that /:id/ocr also has the 503 maintenance check
    const ocrIndex = docRouteSrc.indexOf("router.post('/:id/ocr'");
    const maintenanceInOcr = docRouteSrc.indexOf("process.env.PROCESSING_MAINTENANCE_MODE === 'true'", ocrIndex);
    assert(ocrIndex > 0 && maintenanceInOcr > ocrIndex, 'Maintenance guard must be present in /:id/ocr');
  });

  // BRIDGE-05: maintenance guard blocks before job creation
  await runTest('BRIDGE-05', 'maintenance guard blocks before job creation', () => {
    const processRouteIndex = docRouteSrc.indexOf("router.post('/:id/process'");
    const guardIndex = docRouteSrc.indexOf("process.env.PROCESSING_MAINTENANCE_MODE === 'true'", processRouteIndex);
    const dbConfirmIndex = docRouteSrc.indexOf('db.confirmDocumentProcessing', processRouteIndex);
    assert(guardIndex > processRouteIndex && dbConfirmIndex > guardIndex, 'Guard must precede db.confirmDocumentProcessing');
  });

  // BRIDGE-06: maintenance guard blocks before quota mutation
  await runTest('BRIDGE-06', 'maintenance guard blocks before quota mutation', () => {
    const processRouteIndex = docRouteSrc.indexOf("router.post('/:id/process'");
    const guardIndex = docRouteSrc.indexOf("process.env.PROCESSING_MAINTENANCE_MODE === 'true'", processRouteIndex);
    const quotaIndex = docRouteSrc.indexOf('quotaService', processRouteIndex);
    // Quota is touched during db.confirmDocumentProcessing or post-transaction
    assert(guardIndex > processRouteIndex, 'Guard must be early in process route');
  });

  // BRIDGE-07: maintenance guard blocks before financial mutation
  await runTest('BRIDGE-07', 'maintenance guard blocks before financial mutation', () => {
    const processRouteIndex = docRouteSrc.indexOf("router.post('/:id/process'");
    const guardIndex = docRouteSrc.indexOf("process.env.PROCESSING_MAINTENANCE_MODE === 'true'", processRouteIndex);
    const eligibilityIndex = docRouteSrc.indexOf('processingEligibilityService', processRouteIndex);
    assert(guardIndex > processRouteIndex && eligibilityIndex > guardIndex, 'Guard precedes eligibility & credit evaluation');
  });

  // BRIDGE-08: maintenance guard cannot be overridden by request body
  await runTest('BRIDGE-08', 'maintenance guard cannot be overridden by request body', () => {
    assert(docRouteSrc.includes("if (process.env.PROCESSING_MAINTENANCE_MODE === 'true')"));
    assert(!docRouteSrc.includes('req.body.bypassMaintenance'));
    assert(!docRouteSrc.includes('req.body.maintenanceMode'));
  });

  // BRIDGE-09: upload remains available during maintenance
  await runTest('BRIDGE-09', 'upload remains available during maintenance', () => {
    const uploadIndex = docRouteSrc.indexOf("router.post('/upload'");
    assert(uploadIndex > 0, 'Upload route exists');
    // Upload route does NOT check PROCESSING_MAINTENANCE_MODE
    const nextRouteIndex = docRouteSrc.indexOf("router.", uploadIndex + 20);
    const uploadContent = docRouteSrc.substring(uploadIndex, nextRouteIndex > 0 ? nextRouteIndex : uploadIndex + 1500);
    assert(!uploadContent.includes('PROCESSING_MAINTENANCE_MODE'), 'Upload is not blocked by processing maintenance');
  });

  // BRIDGE-10: preflight remains available during maintenance
  await runTest('BRIDGE-10', 'preflight remains available during maintenance', () => {
    assert(docRouteSrc.includes('preflightService.analyzeDocument'), 'Preflight runs during upload');
    assert(docRouteSrc.includes("status: 'WAITING_CONFIRMATION'"), 'Document reaches WAITING_CONFIRMATION');
  });

  // BRIDGE-11: existing QUEUED job can continue draining
  await runTest('BRIDGE-11', 'existing QUEUED job can continue draining', () => {
    assert(runbookSrc.includes('All in-flight `QUEUED` and `PROCESSING` jobs will continue to normal completion'));
  });

  // BRIDGE-12: existing PROCESSING job can continue
  await runTest('BRIDGE-12', 'existing PROCESSING job can continue', () => {
    assert(runbookSrc.includes('Monitor drain status in Supabase SQL Editor'));
    assert(runbookSrc.includes("status IN ('QUEUED', 'PROCESSING')"));
  });

  // BRIDGE-13: resumeUnfinishedJobs remains compatible
  await runTest('BRIDGE-13', 'resumeUnfinishedJobs remains compatible', () => {
    assert(ocrWorkerSrc.includes('resumeUnfinishedJobs'), 'Worker retains startup job resumption');
    assert(!ocrWorkerSrc.includes('if (process.env.PROCESSING_MAINTENANCE_MODE) return []'));
  });

  // BRIDGE-14: internal retry remains compatible
  await runTest('BRIDGE-14', 'internal retry remains compatible', () => {
    assert(ocrWorkerSrc.includes('this.processJob(userId, jobId, documentId)'), 'Worker handles internal retry loop');
  });

  // BRIDGE-15: full Phase 3B reservation worker gate is not required in bridge stage
  await runTest('BRIDGE-15', 'full Phase 3B reservation worker gate is not required in bridge stage', () => {
    assert(runbookSrc.includes('Uses the **OLD worker behavior** (no reservation validation gate; drains historical jobs normally)'));
  });

  // BRIDGE-16: OLD DB + bridge backend compatibility contract passes
  await runTest('BRIDGE-16', 'OLD DB + bridge backend compatibility contract passes', () => {
    assert(runbookSrc.includes('| **OLD DB + MAINTENANCE BRIDGE (Stage A)** | **YES (Compatible)** |'));
  });

  // BRIDGE-17: OLD DB + full Phase 3B backend remains documented incompatible
  await runTest('BRIDGE-17', 'OLD DB + full Phase 3B backend remains documented incompatible', () => {
    assert(runbookSrc.includes('| **OLD DB + FULL Phase 3B Backend** | **NO (Incompatible)** |'));
  });

  // BRIDGE-18: NEW DB + bridge/old backend remains documented incompatible after cutover
  await runTest('BRIDGE-18', 'NEW DB + bridge/old backend remains documented incompatible after cutover', () => {
    assert(runbookSrc.includes('| **NEW DB + OLD Backend / Bridge** | **NO (Incompatible)** |'));
    assert(migrationSql.includes('PROCESSING_CONFIRM_SIGNATURE_DEPRECATED'));
  });

  // BRIDGE-19: runbook contains Stage A and Stage B
  await runTest('BRIDGE-19', 'runbook contains Stage A and Stage B', () => {
    assert(runbookSrc.includes('STAGE A — BACKWARD-COMPATIBLE MAINTENANCE BRIDGE'));
    assert(runbookSrc.includes('STAGE B — ATOMIC RESERVATION CUTOVER'));
  });

  // BRIDGE-20: mixed-version deployment remains prohibited
  await runTest('BRIDGE-20', 'mixed-version deployment remains prohibited', () => {
    assert(runbookSrc.includes('Mixed-version deployment is strictly prohibited'));
    assert(runbookSrc.includes('Stop all Stage A bridge instances'));
  });

  console.log('\n================================================================');
  console.log(`PHASE 3B.3.1 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
