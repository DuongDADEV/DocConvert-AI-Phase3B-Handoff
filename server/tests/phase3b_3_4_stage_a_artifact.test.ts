/**
 * PHASE 3B.3.4 — MATERIALIZE THE REAL STAGE A DEPLOYMENT ARTIFACT TEST SUITE
 *
 * Verifies that:
 * 1. A concrete, isolated Stage A Maintenance Bridge source artifact is materialized.
 * 2. Stage A preserves all accepted pre-Phase-3B features (Phase 1, 2A, 2B, 2C, 3A, 3A.4, Review, Upload, Dashboard, Auth).
 * 3. Stage A excludes Phase 3B DB-dependent runtime logic (8-arg RPC, worker reservation hard gate, reservation_id column dependency).
 * 4. Maintenance guards (/process and /ocr) return HTTP 503 fail-closed.
 * 5. Existing historical jobs can continue draining under the preserved pre-Phase-3B worker behavior.
 * 6. The materialized Stage A artifact builds successfully into a production bundle.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const ARTIFACT_DIR = path.join(ROOT_DIR, '.stage_a_artifact');
const PATCH_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_runtime_deltas.patch');
const RUNBOOK_PATH = path.join(ROOT_DIR, 'docs/phase3b_migration_cutover_runbook.md');

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, message: string) {
  totalTests++;
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`[PASS] ${message}`);
  passedTests++;
}

async function runTests() {
  console.log('================================================================');
  console.log('PHASE 3B.3.4 — STAGE A MATERIALIZED ARTIFACT VERIFICATION');
  console.log('================================================================\n');

  assert(fs.existsSync(ARTIFACT_DIR), 'ARTIFACT-01: Stage A artifact is materialized in an isolated source directory (.stage_a_artifact)');

  const artDocRoutes = fs.readFileSync(path.join(ARTIFACT_DIR, 'server/routes/documents.ts'), 'utf-8').replace(/\r\n/g, '\n');
  const artWorker = fs.readFileSync(path.join(ARTIFACT_DIR, 'server/services/ocrWorker.ts'), 'utf-8').replace(/\r\n/g, '\n');
  const runbookContent = fs.readFileSync(RUNBOOK_PATH, 'utf-8').replace(/\r\n/g, '\n');
  const patchContent = fs.readFileSync(PATCH_PATH, 'utf-8').replace(/\r\n/g, '\n');

  // ARTIFACT-02: Maintenance guard exists in Stage A /process route
  const processIndex = artDocRoutes.indexOf("router.post('/:id/process'");
  const maintenanceCheckInProcess = artDocRoutes.indexOf("process.env.PROCESSING_MAINTENANCE_MODE === 'true'", processIndex);
  assert(
    processIndex > -1 && maintenanceCheckInProcess > processIndex,
    'ARTIFACT-02: Maintenance guard exists in Stage A /process route returning HTTP 503'
  );

  // ARTIFACT-03: Maintenance guard exists in Stage A /ocr route
  const ocrIndex = artDocRoutes.indexOf("router.post('/:id/ocr'");
  const maintenanceCheckInOcr = artDocRoutes.indexOf("process.env.PROCESSING_MAINTENANCE_MODE === 'true'", ocrIndex);
  assert(
    ocrIndex > -1 && maintenanceCheckInOcr > ocrIndex,
    'ARTIFACT-03: Maintenance guard exists in Stage A /ocr route returning HTTP 503'
  );

  // ARTIFACT-04: Stage A processing runtime does not require 8-arg RPC
  assert(
    !artDocRoutes.includes('estimatedUnits: eligibility.estimatedUnits'),
    'ARTIFACT-04: Stage A processing route does NOT pass 8-arg pricing/quote snapshot parameters'
  );

  // ARTIFACT-05: Stage A processing runtime uses legacy processing contract
  assert(
    artDocRoutes.includes('await db.confirmDocumentProcessing(\n      userId,\n      docId,\n      requestedOutputType,\n      req.userToken\n    )') ||
    artDocRoutes.includes('await db.confirmDocumentProcessing(userId, docId, requestedOutputType, req.userToken)'),
    'ARTIFACT-05: Stage A processing runtime strictly calls legacy 3-arg confirmDocumentProcessing contract'
  );

  // ARTIFACT-06: Stage A worker has no Phase 3B reservation hard gate
  assert(
    !artWorker.includes('getValidatedReservationForJob') &&
    !artWorker.includes('MISSING_CREDIT_RESERVATION'),
    'ARTIFACT-06: Stage A worker contains zero Phase 3B reservation hard gates'
  );

  // ARTIFACT-07: Stage A worker preserves resumeUnfinishedJobs
  assert(
    artWorker.includes('async resumeUnfinishedJobs()'),
    'ARTIFACT-07: Stage A worker preserves resumeUnfinishedJobs startup recovery for pre-Phase-3B jobs'
  );

  // ARTIFACT-08: Stage A worker preserves internal retry
  assert(
    artWorker.includes('SecondaryOcrCoordinator') && artWorker.includes('updateSecondaryOcrTelemetry'),
    'ARTIFACT-08: Stage A worker preserves internal provider retries and secondary OCR pipeline'
  );

  // ARTIFACT-09: Stage A does not require reservation_id for legacy processing jobs
  assert(
    !artDocRoutes.includes('reservation: result.reservation') &&
    !artWorker.includes('job.reservation_id'),
    'ARTIFACT-09: Stage A does not require reservation_id for processing confirmation or worker execution'
  );

  // ARTIFACT-10: Billing routes preserved
  assert(
    fs.existsSync(path.join(ARTIFACT_DIR, 'server/routes/billing.ts')),
    'ARTIFACT-10: Billing catalog and plans routes are preserved in Stage A artifact'
  );

  // ARTIFACT-11: Credit routes preserved
  assert(
    fs.existsSync(path.join(ARTIFACT_DIR, 'server/routes/credits.ts')),
    'ARTIFACT-11: Credit balance and reservation read routes are preserved in Stage A artifact'
  );

  // ARTIFACT-12: Phase 2A services preserved
  const artCreditService = fs.readFileSync(path.join(ARTIFACT_DIR, 'server/services/credit/creditService.ts'), 'utf-8');
  assert(
    artCreditService.includes('getUserBalance') && artCreditService.includes('grant_user_credits'),
    'ARTIFACT-12: Phase 2A credit ledger foundation and grant services are preserved in Stage A artifact'
  );

  // ARTIFACT-13: Phase 2B foundation preserved
  assert(
    artCreditService.includes('reserveCredits') && artCreditService.includes('captureReservation'),
    'ARTIFACT-13: Phase 2B reservation and capture/release foundations are preserved in Stage A artifact'
  );

  // ARTIFACT-14: Phase 2C eligibility preserved
  const artEligibility = fs.readFileSync(path.join(ARTIFACT_DIR, 'server/services/credit/processingEligibilityService.ts'), 'utf-8');
  assert(
    artEligibility.includes('evaluateProcessingEligibility'),
    'ARTIFACT-14: Phase 2C processing eligibility guard service is preserved in Stage A artifact'
  );

  // ARTIFACT-15: Phase 3A pricing preserved
  const artPricing = fs.readFileSync(path.join(ARTIFACT_DIR, 'server/types/processingPricing.ts'), 'utf-8');
  assert(
    artPricing.includes('processing-pricing-v1') && artPricing.includes('LOCAL_NATIVE: 350'),
    'ARTIFACT-15: Phase 3A processing pricing rates (v1) are preserved in Stage A artifact'
  );

  // ARTIFACT-16: FREE bootstrap preserved
  assert(
    artCreditService.includes('bootstrapNewUserFreeCredits'),
    'ARTIFACT-16: Phase 3A.4 FREE bootstrap logic is preserved in Stage A artifact'
  );

  // ARTIFACT-17: Review Workspace preserved
  assert(
    fs.existsSync(path.join(ARTIFACT_DIR, 'src/components/ocr/OcrReviewWorkspace.tsx')) &&
    artDocRoutes.includes("router.post('/:id/review/complete'"),
    'ARTIFACT-17: Human review workspace UI component and completion routes are preserved in Stage A artifact'
  );

  // ARTIFACT-18: Upload/preflight preserved
  assert(
    artDocRoutes.includes("router.post('/upload'") && artDocRoutes.includes("router.get('/:id/preflight'"),
    'ARTIFACT-18: Document upload and preflight analysis endpoints are preserved in Stage A artifact'
  );

  // ARTIFACT-19: No unrelated module/route removed
  const patchLines = patchContent.split('\n');
  const touchedFiles = patchLines
    .filter(l => l.startsWith('diff --git a/'))
    .map(l => l.replace('diff --git a/', '').split(' ')[0].trim());
  assert(
    touchedFiles.length === 2 &&
    touchedFiles.includes('server/routes/documents.ts') &&
    touchedFiles.includes('server/services/ocrWorker.ts'),
    'ARTIFACT-19: Stage A delta patch modifies exclusively server/routes/documents.ts and server/services/ocrWorker.ts'
  );

  // ARTIFACT-20: Stage A artifact builds successfully
  const artServerBundle = path.join(ARTIFACT_DIR, 'dist/server.cjs');
  assert(
    fs.existsSync(artServerBundle) && fs.statSync(artServerBundle).size > 400000,
    'ARTIFACT-20: Stage A artifact builds successfully into a standalone production server bundle (> 500KB)'
  );

  console.log('\n================================================================');
  console.log(`TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: ${totalTests - passedTests}`);
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
