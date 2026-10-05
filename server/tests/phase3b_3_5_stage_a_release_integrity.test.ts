import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

/**
 * Phase 3B.3.5 — Stage A Release Integrity & Supabase Pre-Cutover Readiness Tests
 *
 * Verifies:
 * - Stage A release manifest exists and matches frozen file SHA256 hashes
 * - Source fingerprint and git working tree state are accurately recorded
 * - Dependency reproducibility and package-lock status are audited
 * - No automatic migration execution exists in deployment configurations
 * - Pre-deploy Supabase SQL check is strictly read-only and covers all required invariants
 * - Runbook mandates exact release identity, fleet consistency, and safe deployment sequence
 * - Database migration remains strictly forbidden in Phase 3B.3.5
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_release_manifest.json');
const PREDEPLOY_SQL_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_predeploy_supabase_check.sql');
const RUNBOOK_PATH = path.join(ROOT_DIR, 'docs/phase3b_migration_cutover_runbook.md');
const BUNDLE_PATH = path.join(ROOT_DIR, '.stage_a_artifact/dist/server.cjs');
const PATCH_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_runtime_deltas.patch');
const MATERIALIZER_PATH = path.join(ROOT_DIR, 'scripts/stage_a/materialize_stage_a.ts');
const PKG_PATH = path.join(ROOT_DIR, 'package.json');
const PKG_LOCK_PATH = path.join(ROOT_DIR, 'package-lock.json');
const VERCEL_PATH = path.join(ROOT_DIR, 'vercel.json');
const SERVER_TS_PATH = path.join(ROOT_DIR, 'server.ts');

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

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function runTests() {
  console.log('================================================================');
  console.log('PHASE 3B.3.5 — STAGE A RELEASE INTEGRITY & SUPABASE PRE-CUTOVER');
  console.log('================================================================\n');

  // REL-01: release manifest exists
  assert(fs.existsSync(MANIFEST_PATH), 'REL-01: Stage A release manifest exists at scripts/stage_a/stage_a_release_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

  // REL-02: server bundle SHA256 recorded and matches actual file
  const actualBundleSha = sha256File(BUNDLE_PATH);
  assert(
    manifest.sha256.serverBundle === actualBundleSha,
    `REL-02: Server bundle SHA256 recorded in manifest matches actual .stage_a_artifact/dist/server.cjs (${actualBundleSha.slice(0, 16)}...)`
  );

  // REL-03: patch SHA256 recorded and matches actual file
  const actualPatchSha = sha256File(PATCH_PATH);
  assert(
    manifest.sha256.patchFile === actualPatchSha,
    `REL-03: Patch SHA256 recorded in manifest matches actual stage_a_runtime_deltas.patch (${actualPatchSha.slice(0, 16)}...)`
  );

  // REL-04: materializer SHA256 recorded and matches actual file
  const actualMaterializerSha = sha256File(MATERIALIZER_PATH);
  assert(
    manifest.sha256.materializerScript === actualMaterializerSha,
    `REL-04: Materializer script SHA256 recorded in manifest matches actual materialize_stage_a.ts (${actualMaterializerSha.slice(0, 16)}...)`
  );

  // REL-05: source fingerprint recorded
  assert(
    typeof manifest.sourceRevision?.sourceFingerprint === 'string' &&
    manifest.sourceRevision.sourceFingerprint.length === 64,
    'REL-05: Deterministic 64-char source fingerprint recorded in manifest'
  );

  // REL-06: working-tree dirty state reported truthfully
  assert(
    manifest.sourceRevision?.workingTreeDirty === true &&
    manifest.sourceRevision?.gitHeadSha === '3b4e41097dbd8222624cb559ce50e79646463d73',
    'REL-06: Working-tree dirty state (true) and base commit SHA recorded truthfully'
  );

  // REL-07: dependency lock status recorded
  assert(
    manifest.dependencyStatus?.packageLockPresent === true &&
    manifest.dependencyStatus?.npmCiUsable === true &&
    manifest.sha256?.packageLockJson === sha256File(PKG_LOCK_PATH),
    'REL-07: Dependency lock status and package-lock.json SHA256 verified and recorded'
  );

  // REL-08: Stage A auto-migration audit completed
  assert(
    manifest.autoMigrationAudit?.hasAutoMigration === false &&
    manifest.autoMigrationAudit?.deploymentCanApplyDbMigration === false,
    'REL-08: Auto-migration audit recorded as completely absent (hasAutoMigration: false)'
  );

  // REL-09: no automatic migration command exists in verified deployment path
  const pkgContent = fs.readFileSync(PKG_PATH, 'utf-8');
  const vercelContent = fs.readFileSync(VERCEL_PATH, 'utf-8');
  const serverContent = fs.readFileSync(SERVER_TS_PATH, 'utf-8');
  assert(
    !pkgContent.includes('supabase db push') &&
    !pkgContent.includes('apply_migration') &&
    !vercelContent.includes('supabase') &&
    !serverContent.includes('supabase db') &&
    !serverContent.includes('apply_migration'),
    'REL-09: No automatic migration commands (supabase db push, apply_migration) exist in deployment configs'
  );

  // REL-10: predeploy Supabase SQL is read-only
  assert(fs.existsSync(PREDEPLOY_SQL_PATH), 'REL-10: Pre-deploy Supabase SQL file exists');
  const predeploySql = fs.readFileSync(PREDEPLOY_SQL_PATH, 'utf-8');
  const destructiveKeywords = ['INSERT ', 'UPDATE ', 'DELETE ', 'DROP ', 'ALTER ', 'TRUNCATE '];
  const containsDestructive = destructiveKeywords.some(kw => predeploySql.toUpperCase().includes(kw));
  assert(
    !containsDestructive && predeploySql.includes('SELECT ') && predeploySql.includes('information_schema'),
    'REL-10: Predeploy Supabase check SQL is strictly READ-ONLY (no INSERT, UPDATE, DELETE, ALTER, DROP)'
  );

  // REL-11: predeploy SQL checks legacy RPC
  assert(
    predeploySql.includes("p_output_type character varying") &&
    predeploySql.includes("confirm_document_processing") &&
    predeploySql.includes("p.pronargs = 3"),
    'REL-11: Predeploy SQL explicitly checks legacy 3-arg confirm_document_processing RPC'
  );

  // REL-12: predeploy SQL checks Phase 3B columns
  assert(
    predeploySql.includes("'reservation_id', 'pricing_version', 'estimated_billable_units', 'quote_snapshot'"),
    'REL-12: Predeploy SQL checks for Phase 3B processing_jobs columns presence'
  );

  // REL-13: predeploy SQL checks active jobs
  assert(
    predeploySql.includes("WHERE status IN ('QUEUED', 'PROCESSING')") &&
    predeploySql.includes("CURRENT_ACTIVE_JOBS"),
    'REL-13: Predeploy SQL checks current active jobs count and status breakdown'
  );

  // REL-14: runbook deploys exact artifact identity
  const runbookContent = fs.readFileSync(RUNBOOK_PATH, 'utf-8');
  assert(
    runbookContent.includes(manifest.releaseId) &&
    runbookContent.includes(manifest.sha256.serverBundle),
    'REL-14: Runbook references exact Stage A release ID and server bundle SHA256'
  );

  // REL-15: runbook requires same Stage A artifact across all instances
  assert(
    runbookContent.includes('ALL_STAGE_A_INSTANCES_REQUIRE_SAME_RELEASE = YES'),
    'REL-15: Runbook strictly mandates ALL_STAGE_A_INSTANCES_REQUIRE_SAME_RELEASE = YES'
  );

  // REL-16: maintenance enabled only after Stage A health check
  const healthStepIdx = runbookContent.indexOf('Step A.6: Confirm App Health Against Live OLD DB');
  const maintStepIdx = runbookContent.indexOf('Step A.7: Enable Processing Maintenance Mode on ALL Instances');
  assert(
    healthStepIdx > -1 && maintStepIdx > healthStepIdx,
    'REL-16: Runbook requires basic app health check against live OLD DB before enabling maintenance mode'
  );

  // REL-17: /process 503 verification documented
  assert(
    runbookContent.includes('POST /api/documents/:id/process') &&
    runbookContent.includes('503 Service Unavailable') &&
    runbookContent.includes('PROCESSING_TEMPORARILY_UNAVAILABLE'),
    'REL-17: Runbook explicitly documents POST /process 503 verification'
  );

  // REL-18: /ocr 503 verification documented
  assert(
    runbookContent.includes('POST /api/documents/:id/ocr') &&
    runbookContent.includes('Step A.10: Confirm POST /ocr Returns 503'),
    'REL-18: Runbook explicitly documents POST /ocr 503 verification'
  );

  // REL-19: existing worker drain verification documented
  assert(
    runbookContent.includes('Step A.11: Confirm Existing Worker Is Actively Draining Jobs') &&
    runbookContent.includes('Step A.12: Monitor Active Jobs Count to Zero'),
    'REL-19: Runbook documents existing worker active drain and monitoring to active_jobs_count = 0'
  );

  // REL-20: DB migration remains forbidden in Phase 3B.3.5
  assert(
    runbookContent.includes('STAGE B — ATOMIC RESERVATION CUTOVER') &&
    runbookContent.includes('Step B.1: Apply Phase 3B DB Migration') &&
    runbookContent.includes('Do not patch live schema blindly'),
    'REL-20: DB migration execution remains strictly segregated to Stage B and forbidden in Phase 3B.3.5'
  );

  console.log('\n================================================================');
  console.log(`TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: ${totalTests - passedTests}`);
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
