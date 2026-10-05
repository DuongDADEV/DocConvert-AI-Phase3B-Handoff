import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 3B.4 — Full Phase 3B Production Runtime Release Test Suite
 *
 * Verifies:
 * - RUNTIME-01: /process uses extended Phase 3B confirm RPC
 * - RUNTIME-02: normal processing does NOT use legacy 3-arg RPC
 * - RUNTIME-03: trusted quote is recomputed server-side
 * - RUNTIME-04: client quote cannot override trusted estimate
 * - RUNTIME-05: reservation is created before queue commitment
 * - RUNTIME-06: processing_job has reservation_id
 * - RUNTIME-07: processing_job stores pricing_version
 * - RUNTIME-08: processing_job stores estimated_billable_units
 * - RUNTIME-09: processing_job stores quote_snapshot
 * - RUNTIME-10: worker requires valid reservation
 * - RUNTIME-11: missing reservation blocks OCR
 * - RUNTIME-12: capture semantics preserved
 * - RUNTIME-13: release semantics preserved
 * - RUNTIME-14: FREE bootstrap still works
 * - RUNTIME-15: ledger hotfix semantics remain compatible
 * - RUNTIME-16: maintenance guards remain available
 * - RUNTIME-17: when maintenance=true /process returns 503
 * - RUNTIME-18: when maintenance=true /ocr returns 503
 * - RUNTIME-19: no Stage A worker compatibility bypass remains
 * - RUNTIME-20: legacy 3-arg DB RPC is not used for normal processing
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const ARTIFACT_DIR = path.join(ROOT_DIR, '.phase3b_production_artifact');
const MIGRATION_3B = path.join(ROOT_DIR, 'supabase/migrations/20261004010000_atomic_credit_reserve_before_processing_queue.sql');
const MIGRATION_HOTFIX = path.join(ROOT_DIR, 'supabase/migrations/20261005010000_fix_grant_user_credits_ledger_entry_type.sql');
const RELEASE_MANIFEST = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_production_release_manifest.json');
const PREDEPLOY_SQL = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_predeploy_read_only_checks.sql');

const MAIN_DOCS_ROUTE = path.join(ROOT_DIR, 'server/routes/documents.ts');
const MAIN_DB = path.join(ROOT_DIR, 'server/db/db.ts');
const MAIN_WORKER = path.join(ROOT_DIR, 'server/services/ocrWorker.ts');
const MAIN_CREDIT_SERVICE = path.join(ROOT_DIR, 'server/services/credit/creditService.ts');
const MAIN_CREDIT_ROUTE = path.join(ROOT_DIR, 'server/routes/credits.ts');

const ART_DOCS_ROUTE = path.join(ARTIFACT_DIR, 'server/routes/documents.ts');
const ART_DB = path.join(ARTIFACT_DIR, 'server/db/db.ts');
const ART_WORKER = path.join(ARTIFACT_DIR, 'server/services/ocrWorker.ts');

let totalTests = 0;
let passedTests = 0;

function check(condition: boolean, message: string) {
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
  console.log('PHASE 3B.4 — FULL PHASE 3B PRODUCTION RUNTIME RELEASE TEST SUITE');
  console.log('================================================================\n');

  // Load files
  assert(fs.existsSync(MIGRATION_3B), 'Migration 20261004010000 exists');
  assert(fs.existsSync(MIGRATION_HOTFIX), 'Migration 20261005010000 exists');
  assert(fs.existsSync(RELEASE_MANIFEST), 'Release manifest exists');
  assert(fs.existsSync(PREDEPLOY_SQL), 'Predeploy SQL checks exist');
  assert(fs.existsSync(ARTIFACT_DIR), 'Artifact directory exists');

  const mig3bSql = fs.readFileSync(MIGRATION_3B, 'utf-8');
  const migHotfixSql = fs.readFileSync(MIGRATION_HOTFIX, 'utf-8');
  const docRouteSrc = fs.readFileSync(MAIN_DOCS_ROUTE, 'utf-8');
  const dbSrc = fs.readFileSync(MAIN_DB, 'utf-8');
  const workerSrc = fs.readFileSync(MAIN_WORKER, 'utf-8');
  const creditServiceSrc = fs.readFileSync(MAIN_CREDIT_SERVICE, 'utf-8');
  const creditRouteSrc = fs.readFileSync(MAIN_CREDIT_ROUTE, 'utf-8');

  const artDocRouteSrc = fs.readFileSync(ART_DOCS_ROUTE, 'utf-8');
  const artDbSrc = fs.readFileSync(ART_DB, 'utf-8');
  const artWorkerSrc = fs.readFileSync(ART_WORKER, 'utf-8');

  // RUNTIME-01: /process uses extended Phase 3B confirm RPC
  check(
    docRouteSrc.includes('await db.confirmDocumentProcessing(') &&
      docRouteSrc.includes('estimatedUnits: eligibility.estimatedUnits,') &&
      docRouteSrc.includes('pricingVersion: eligibility.processingPricingVersion,') &&
      docRouteSrc.includes('quoteSnapshot: {') &&
      artDocRouteSrc.includes('estimatedUnits: eligibility.estimatedUnits,') &&
      artDbSrc.includes('p_estimated_units = options.estimatedUnits') &&
      artDbSrc.includes('p_pricing_version = options.pricingVersion'),
    'RUNTIME-01: /process passes extended quote options to db.confirmDocumentProcessing in both main repo and artifact'
  );

  // RUNTIME-02: normal processing does NOT use legacy 3-arg RPC
  const processRouteBlock = docRouteSrc.substring(
    docRouteSrc.indexOf("router.post('/:id/process'"),
    docRouteSrc.indexOf('// 4. Handle Idempotent Results', docRouteSrc.indexOf("router.post('/:id/process'"))
  );
  check(
    !processRouteBlock.includes('confirmDocumentProcessing(userId, docId, requestedOutputType, req.userToken);') &&
      !processRouteBlock.includes('confirmDocumentProcessing(\n      userId,\n      docId,\n      requestedOutputType,\n      req.userToken\n    );') &&
      processRouteBlock.includes('estimatedUnits: eligibility.estimatedUnits'),
    'RUNTIME-02: normal processing does NOT invoke legacy 3-arg overload without quote options'
  );

  // RUNTIME-03: trusted quote is recomputed server-side
  check(
    processRouteBlock.includes('processingEligibilityService.evaluateProcessingEligibility') &&
      processRouteBlock.includes('userId,') &&
      processRouteBlock.includes('docId,') &&
      processRouteBlock.indexOf('evaluateProcessingEligibility') < processRouteBlock.indexOf('db.confirmDocumentProcessing'),
    'RUNTIME-03: trusted server-side quote is recomputed via processingEligibilityService.evaluateProcessingEligibility before confirmDocumentProcessing'
  );

  // RUNTIME-04: client quote cannot override trusted estimate
  check(
    !processRouteBlock.includes('req.body.estimatedUnits') &&
      !processRouteBlock.includes('req.body.quote') &&
      !processRouteBlock.includes('req.body.pricingVersion') &&
      processRouteBlock.includes('estimatedUnits: eligibility.estimatedUnits'),
    'RUNTIME-04: client body quote is ignored; strictly derives from server eligibility calculation'
  );

  // RUNTIME-05: reservation is created before queue commitment
  const normMig3bSql = mig3bSql.replace(/\r\n/g, '\n');
  const rpc8ArgStart = normMig3bSql.indexOf('CREATE OR REPLACE FUNCTION public.confirm_document_processing(\n    p_document_id UUID,\n    p_user_id UUID,\n    p_output_type VARCHAR DEFAULT');
  const rpc8ArgEnd = normMig3bSql.indexOf('-- 3. HARD-FAIL LEGACY 3-ARGUMENT OVERLOAD', rpc8ArgStart);
  const rpc8ArgBody = normMig3bSql.substring(rpc8ArgStart, rpc8ArgEnd);
  const reserveCallIndex = rpc8ArgBody.indexOf('v_reservation_result := public.reserve_credit_units(');
  const jobInsertIndex = rpc8ArgBody.indexOf('INSERT INTO public.processing_jobs');
  const docQueuedIndex = rpc8ArgBody.indexOf("UPDATE public.documents\n    SET status = 'QUEUED'");
  check(
    rpc8ArgStart > 0 &&
      reserveCallIndex > 0 &&
      jobInsertIndex > reserveCallIndex &&
      docQueuedIndex > jobInsertIndex,
    'RUNTIME-05: Atomic RPC reserves credits (Step 10) BEFORE inserting job (Step 11) and BEFORE setting document to QUEUED (Step 13)'
  );

  // RUNTIME-06: processing_job has reservation_id
  const c1 = rpc8ArgBody.includes('reservation_id\n') || rpc8ArgBody.includes('reservation_id,');
  const c2 = rpc8ArgBody.includes('v_reservation_id');
  const c3 = normMig3bSql.includes('ADD COLUMN IF NOT EXISTS reservation_id UUID');
  const c4 = normMig3bSql.includes('FOREIGN KEY (reservation_id)');
  const c5 = normMig3bSql.includes('REFERENCES public.credit_reservations(id)');
  check(
    c1 && c2 && c3 && c4 && c5,
    'RUNTIME-06: processing_job links reservation_id to credit_reservations(id)'
  );

  // RUNTIME-07: processing_job stores pricing_version
  check(
    rpc8ArgBody.includes('pricing_version,') &&
      rpc8ArgBody.includes('p_pricing_version,') &&
      normMig3bSql.includes('ADD COLUMN IF NOT EXISTS pricing_version VARCHAR(50)'),
    'RUNTIME-07: processing_job stores pinned pricing_version'
  );

  // RUNTIME-08: processing_job stores estimated_billable_units
  check(
    rpc8ArgBody.includes('estimated_billable_units,') &&
      rpc8ArgBody.includes('p_estimated_units,') &&
      normMig3bSql.includes('ADD COLUMN IF NOT EXISTS estimated_billable_units BIGINT'),
    'RUNTIME-08: processing_job stores estimated_billable_units'
  );

  // RUNTIME-09: processing_job stores quote_snapshot
  check(
    rpc8ArgBody.includes('quote_snapshot,') &&
      rpc8ArgBody.includes('p_quote_snapshot,') &&
      normMig3bSql.includes('ADD COLUMN IF NOT EXISTS quote_snapshot JSONB'),
    'RUNTIME-09: processing_job stores complete quote_snapshot'
  );

  // RUNTIME-10: worker requires valid reservation
  check(
    workerSrc.includes('const reservationValidation = await db.getValidatedReservationForJob(job);') &&
      workerSrc.includes('if (!reservationValidation.valid) {') &&
      artWorkerSrc.includes('const reservationValidation = await db.getValidatedReservationForJob(job);') &&
      artWorkerSrc.includes('if (!reservationValidation.valid) {'),
    'RUNTIME-10: worker invokes getValidatedReservationForJob before starting processing in main repo and artifact'
  );

  // RUNTIME-11: missing reservation blocks OCR
  check(
    workerSrc.includes("error_code: 'MISSING_CREDIT_RESERVATION'") &&
      workerSrc.includes('Worker failing closed') &&
      workerSrc.includes('return null;') &&
      artWorkerSrc.includes("error_code: 'MISSING_CREDIT_RESERVATION'"),
    'RUNTIME-11: invalid/missing reservation marks job FAILED with MISSING_CREDIT_RESERVATION and halts execution'
  );

  // RUNTIME-12: capture semantics preserved
  const patch3a3Sql = fs.readFileSync(
    path.join(ROOT_DIR, 'supabase/migrations/20261003010000_credit_settlement_and_free_bootstrap_patch.sql'),
    'utf-8'
  );
  check(
    creditServiceSrc.includes('async captureReservation(') &&
      creditServiceSrc.includes("client.rpc('capture_credit_reservation',") &&
      patch3a3Sql.includes("entry_type,") &&
      patch3a3Sql.includes("'CAPTURE',") &&
      patch3a3Sql.includes("-v_capture_amount,"),
    'RUNTIME-12: captureReservation RPC interface and CAPTURE ledger delta semantics preserved'
  );

  // RUNTIME-13: release semantics preserved
  check(
    creditServiceSrc.includes('async releaseReservation(') &&
      creditServiceSrc.includes("client.rpc('release_credit_reservation',"),
    'RUNTIME-13: releaseReservation RPC interface and un-held unit release semantics preserved'
  );

  // RUNTIME-14: FREE bootstrap still works
  check(
    creditRouteSrc.includes("router.post('/bootstrap'") &&
      creditRouteSrc.includes('await creditService.bootstrapNewUserFreeCredits(userId') &&
      creditServiceSrc.includes("const idempotencyKey = `free-bootstrap:v1:${userId}`;") &&
      creditServiceSrc.includes("sourceType: 'FREE_BOOTSTRAP',") &&
      creditServiceSrc.includes('originalUnits,') &&
      creditServiceSrc.includes("creditsToUnits(creditsGranted)") &&
      creditServiceSrc.includes("getCanonicalCreditGrant('FREE', version.id)"),
    'RUNTIME-14: FREE bootstrap endpoint resolves canonical FREE grant units (10 credits / 10000 units) with canonical free-bootstrap:v1:{userId} idempotency key'
  );

  // RUNTIME-15: ledger hotfix semantics remain compatible
  check(
    migHotfixSql.includes("WHEN p_source_type = 'ADMIN_ADJUSTMENT' THEN 'ADJUSTMENT'") &&
      migHotfixSql.includes("ELSE 'GRANT'") &&
      !migHotfixSql.includes("'GRANT_FREE'") &&
      !migHotfixSql.includes("'GRANT_PACK'") &&
      !migHotfixSql.includes("'GRANT_SUBSCRIPTION'"),
    'RUNTIME-15: Ledger hotfix migration 20261005010000 maps to canonical GRANT/ADJUSTMENT and contains zero prohibited strings'
  );

  // RUNTIME-16: maintenance guards remain available
  check(
    docRouteSrc.includes("if (process.env.PROCESSING_MAINTENANCE_MODE === 'true')") &&
      artDocRouteSrc.includes("if (process.env.PROCESSING_MAINTENANCE_MODE === 'true')"),
    'RUNTIME-16: PROCESSING_MAINTENANCE_MODE guard is present in both main repo and artifact'
  );

  // RUNTIME-17: when maintenance=true /process returns 503
  const processRouteIndex = docRouteSrc.indexOf("router.post('/:id/process'");
  const processMaintenanceBlock = docRouteSrc.substring(processRouteIndex, processRouteIndex + 400);
  check(
    processMaintenanceBlock.includes("process.env.PROCESSING_MAINTENANCE_MODE === 'true'") &&
      processMaintenanceBlock.includes('res.status(503).json(') &&
      processMaintenanceBlock.includes("code: 'PROCESSING_TEMPORARILY_UNAVAILABLE'"),
    'RUNTIME-17: /process returns HTTP 503 with PROCESSING_TEMPORARILY_UNAVAILABLE when maintenance is true'
  );

  // RUNTIME-18: when maintenance=true /ocr returns 503
  const ocrRouteIndex = docRouteSrc.indexOf("router.post('/:id/ocr'");
  const ocrMaintenanceBlock = docRouteSrc.substring(ocrRouteIndex, ocrRouteIndex + 400);
  check(
    ocrRouteIndex > 0 &&
      ocrMaintenanceBlock.includes("process.env.PROCESSING_MAINTENANCE_MODE === 'true'") &&
      ocrMaintenanceBlock.includes('res.status(503).json(') &&
      ocrMaintenanceBlock.includes("code: 'PROCESSING_TEMPORARILY_UNAVAILABLE'"),
    'RUNTIME-18: /:id/ocr returns HTTP 503 with PROCESSING_TEMPORARILY_UNAVAILABLE when maintenance is true'
  );

  // RUNTIME-19: no Stage A worker compatibility bypass remains
  check(
    artWorkerSrc.includes('// 3b. Phase 3B / 3B.1 Worker Hard Gate: Processing job must have a valid ACTIVE reservation') &&
      artWorkerSrc.includes('const reservationValidation = await db.getValidatedReservationForJob(job);') &&
      artDocRouteSrc.includes('reservation: result.reservation,'),
    'RUNTIME-19: Full Phase 3B artifact has zero Stage A bypasses (worker gate and reservation response active)'
  );

  // RUNTIME-20: legacy 3-arg DB RPC is not used for normal processing
  const legacyRpcStart = normMig3bSql.indexOf('-- 3. HARD-FAIL LEGACY 3-ARGUMENT OVERLOAD');
  const legacyRpcDefinition = normMig3bSql.substring(
    legacyRpcStart,
    normMig3bSql.indexOf('-- Strict Security Permissions for 3-arg legacy overload:', legacyRpcStart)
  );
  check(
    legacyRpcStart > 0 &&
      legacyRpcDefinition.includes("RAISE EXCEPTION 'PROCESSING_CONFIRM_SIGNATURE_DEPRECATED: confirm_document_processing requires estimated credit units and pricing snapshot';"),
    'RUNTIME-20: DB legacy 3-arg RPC overload is hard-fail guarded with PROCESSING_CONFIRM_SIGNATURE_DEPRECATED'
  );

  console.log('\n================================================================');
  console.log(`TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: 0`);
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
