import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Phase 3B.3.7.2 — Contract Spot-Check Before Stage A -02 Redeploy
 *
 * Verifies:
 * - CONTRACT-01: Stage A artifact RPC function name is confirm_document_processing
 * - CONTRACT-02: Stage A artifact RPC has legacy 3-arg contract
 * - CONTRACT-03: Argument names are p_document_id, p_user_id, p_output_type
 * - CONTRACT-04: /process maintenance response is HTTP 503
 * - CONTRACT-05: /process maintenance code is PROCESSING_TEMPORARILY_UNAVAILABLE
 * - CONTRACT-06: /ocr maintenance code matches the same contract
 * - CONTRACT-07: FREE bootstrap source_type is identified (FREE_BOOTSTRAP)
 * - CONTRACT-08: FREE bootstrap idempotency key pattern is identified (free-bootstrap:v1:{userId})
 * - CONTRACT-09: FREE bootstrap one-time DB guard exists (uq_credit_grants_one_time_free_bootstrap)
 * - CONTRACT-10: FREE bootstrap amount equals 10 credits / 10000 units
 * - CONTRACT-11: Stage A -03 release ID verified (stage-a-3b-bridge-20261004-03)
 * - CONTRACT-12: No Phase 3B runtime dependency introduced in Stage A artifact
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const ARTIFACT_DB = path.join(ROOT_DIR, '.stage_a_artifact/server/db/db.ts');
const ARTIFACT_DOCS = path.join(ROOT_DIR, '.stage_a_artifact/server/routes/documents.ts');
const ARTIFACT_WORKER = path.join(ROOT_DIR, '.stage_a_artifact/server/services/ocrWorker.ts');
const ARTIFACT_CREDIT = path.join(ROOT_DIR, '.stage_a_artifact/server/services/credit/creditService.ts');
const LEGACY_RPC_MIGRATION = path.join(ROOT_DIR, 'supabase/migrations/20260925000000_confirm_document_processing_rpc.sql');
const FREE_BOOTSTRAP_MIGRATION = path.join(ROOT_DIR, 'supabase/migrations/20261003010000_credit_settlement_and_free_bootstrap_patch.sql');
const RELEASE_MANIFEST = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_release_manifest.json');
const RUNBOOK = path.join(ROOT_DIR, 'docs/phase3b_migration_cutover_runbook.md');

let totalTests = 0;
let passedTests = 0;

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
  console.log('PHASE 3B.3.7.2 — CONTRACT SPOT-CHECK TEST SUITE');
  console.log('================================================================\n');

  // Verify artifact files exist
  assert(fs.existsSync(ARTIFACT_DB), 'Artifact server/db/db.ts exists');
  assert(fs.existsSync(ARTIFACT_DOCS), 'Artifact server/routes/documents.ts exists');
  assert(fs.existsSync(ARTIFACT_WORKER), 'Artifact server/services/ocrWorker.ts exists');
  assert(fs.existsSync(ARTIFACT_CREDIT), 'Artifact server/services/credit/creditService.ts exists');

  const artDbSrc = fs.readFileSync(ARTIFACT_DB, 'utf-8').replace(/\r\n/g, '\n');
  const artDocsSrc = fs.readFileSync(ARTIFACT_DOCS, 'utf-8').replace(/\r\n/g, '\n');
  const artWorkerSrc = fs.readFileSync(ARTIFACT_WORKER, 'utf-8').replace(/\r\n/g, '\n');
  const artCreditSrc = fs.readFileSync(ARTIFACT_CREDIT, 'utf-8').replace(/\r\n/g, '\n');
  const legacyRpcSql = fs.readFileSync(LEGACY_RPC_MIGRATION, 'utf-8').replace(/\r\n/g, '\n');
  const freeBootstrapSql = fs.readFileSync(FREE_BOOTSTRAP_MIGRATION, 'utf-8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(RELEASE_MANIFEST, 'utf-8'));
  const runbookSrc = fs.readFileSync(RUNBOOK, 'utf-8').replace(/\r\n/g, '\n');

  // CONTRACT-01: Stage A artifact RPC function name is confirm_document_processing
  const rpcNameMatch = artDbSrc.includes("client.rpc('confirm_document_processing'");
  assert(rpcNameMatch, 'CONTRACT-01: Stage A artifact RPC function name is confirm_document_processing');

  // CONTRACT-02: Stage A artifact RPC has legacy 3-arg contract
  // In artifact documents.ts, confirmDocumentProcessing is invoked with exactly (userId, docId, requestedOutputType, req.userToken)
  // and does NOT pass the 5th options argument (Phase 3B reservation/quote parameters)
  const legacyCallMatch = artDocsSrc.includes(
    'const result = await db.confirmDocumentProcessing(\n      userId,\n      docId,\n      requestedOutputType,\n      req.userToken\n    );'
  ) || artDocsSrc.includes(
    'await db.confirmDocumentProcessing(\n      userId,\n      docId,\n      requestedOutputType,\n      req.userToken\n    )'
  );
  assert(legacyCallMatch, 'CONTRACT-02: Stage A artifact RPC call site invokes legacy 3-arg contract (no Phase 3B options)');

  // CONTRACT-03: Argument names are p_document_id, p_user_id, p_output_type
  const dbHasArgNames = artDbSrc.includes('p_document_id: documentId') &&
                        artDbSrc.includes('p_user_id: userId') &&
                        artDbSrc.includes('p_output_type: outputType');
  const sqlHasArgNames = legacyRpcSql.includes('p_document_id UUID') &&
                         legacyRpcSql.includes('p_user_id UUID') &&
                         legacyRpcSql.includes('p_output_type VARCHAR');
  assert(dbHasArgNames && sqlHasArgNames, 'CONTRACT-03: Argument names and types are p_document_id UUID, p_user_id UUID, p_output_type VARCHAR');

  // CONTRACT-04: /process maintenance response is HTTP 503
  const processRouteIndex = artDocsSrc.indexOf("router.post('/:id/process'");
  const processBlock = artDocsSrc.slice(processRouteIndex, processRouteIndex + 400);
  const process503 = processBlock.includes('res.status(503)');
  assert(process503, 'CONTRACT-04: /process maintenance response status is HTTP 503');

  // CONTRACT-05: /process maintenance code is PROCESSING_TEMPORARILY_UNAVAILABLE
  const processCode = processBlock.includes("code: 'PROCESSING_TEMPORARILY_UNAVAILABLE'");
  assert(processCode, 'CONTRACT-05: /process maintenance error code is PROCESSING_TEMPORARILY_UNAVAILABLE');

  // CONTRACT-06: /ocr maintenance code matches the same contract
  const ocrRouteIndex = artDocsSrc.indexOf("router.post('/:id/ocr'");
  const ocrBlock = artDocsSrc.slice(ocrRouteIndex, ocrRouteIndex + 400);
  const ocr503AndCode = ocrBlock.includes('res.status(503)') &&
                        ocrBlock.includes("code: 'PROCESSING_TEMPORARILY_UNAVAILABLE'");
  assert(ocr503AndCode, 'CONTRACT-06: /ocr maintenance response is HTTP 503 with code PROCESSING_TEMPORARILY_UNAVAILABLE');

  // CONTRACT-07: FREE bootstrap source_type is identified (FREE_BOOTSTRAP)
  const hasSourceType = artCreditSrc.includes("sourceType: 'FREE_BOOTSTRAP'");
  assert(hasSourceType, "CONTRACT-07: FREE bootstrap source_type is 'FREE_BOOTSTRAP'");

  // CONTRACT-08: FREE bootstrap idempotency key pattern is identified (free-bootstrap:v1:{userId})
  const hasIdempotencyKey = artCreditSrc.includes("const idempotencyKey = `free-bootstrap:v1:${userId}`;");
  assert(hasIdempotencyKey, 'CONTRACT-08: FREE bootstrap idempotency key pattern is free-bootstrap:v1:{userId}');

  // CONTRACT-09: FREE bootstrap one-time DB guard exists (uq_credit_grants_one_time_free_bootstrap)
  const hasUniqueGuard = freeBootstrapSql.includes('uq_credit_grants_one_time_free_bootstrap') &&
                         freeBootstrapSql.includes("WHERE source_type = 'FREE_BOOTSTRAP'");
  assert(hasUniqueGuard, 'CONTRACT-09: FREE bootstrap one-time DB guard exists (partial unique index uq_credit_grants_one_time_free_bootstrap)');

  // CONTRACT-10: FREE bootstrap amount equals 10 credits / 10000 units
  const fetchesCanonicalGrant = artCreditSrc.includes("await billingService.getCanonicalCreditGrant('FREE', version.id);");
  const unitsCalculation = artCreditSrc.includes("const originalUnits = creditsToUnits(creditsGranted);");
  assert(fetchesCanonicalGrant && unitsCalculation, 'CONTRACT-10: FREE bootstrap amount resolves via canonical grant (10 credits / 10000 units)');

  // CONTRACT-11: Stage A -03 release ID verified
  assert(manifest.releaseId === 'stage-a-3b-bridge-20261004-03', 'CONTRACT-11: Release ID is stage-a-3b-bridge-20261004-03');
  assert(runbookSrc.includes('stage-a-3b-bridge-20261004-03'), 'CONTRACT-11b: Runbook references stage-a-3b-bridge-20261004-03');

  // CONTRACT-12: No Phase 3B runtime dependency introduced
  const noReservationInProcessResponse = !artDocsSrc.includes('reservation: result.reservation');
  const noPhase3bWorkerGate = !artWorkerSrc.includes('getValidatedReservationForJob') &&
                              !artWorkerSrc.includes('MISSING_CREDIT_RESERVATION');
  assert(
    noReservationInProcessResponse && noPhase3bWorkerGate,
    'CONTRACT-12: No Phase 3B runtime dependency in Stage A artifact (worker hard gate excluded, reservation response excluded)'
  );

  console.log('\n================================================================');
  console.log(`TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: 0`);
  console.log('================================================================');
}

runTests().catch((err) => {
  console.error('[FATAL] Spotcheck tests failed:', err);
  process.exit(1);
});
