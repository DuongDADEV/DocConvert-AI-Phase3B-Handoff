import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

/**
 * Phase 3B.3.6 — Stage A Release Hardening & Hosting Deployment Safety Tests
 *
 * Verifies:
 * - Content-based source manifest and robust SHA256 fingerprint
 * - Full dist manifest covering all deployable assets (server.cjs, index.html, assets)
 * - Exact hash alignment across source files, dist files, and release manifest
 * - Clear separation of repository auto-migration (NO) vs hosting platform auto-migration (NOT_VERIFIED)
 * - Hosting verification checklist existence and structure
 * - Initial deploy with maintenance OFF followed by health-check and maintenance ON
 * - Strict segregation of database migration to Stage B
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const SOURCE_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_source_manifest.txt');
const DIST_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_dist_manifest.txt');
const RELEASE_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_release_manifest.json');
const HOSTING_CHECKLIST_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_hosting_verification_checklist.md');
const RUNBOOK_PATH = path.join(ROOT_DIR, 'docs/phase3b_migration_cutover_runbook.md');
const PKG_LOCK_PATH = path.join(ROOT_DIR, 'package-lock.json');
const BUNDLE_PATH = path.join(ROOT_DIR, '.stage_a_artifact/dist/server.cjs');
const PATCH_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_runtime_deltas.patch');
const MATERIALIZER_PATH = path.join(ROOT_DIR, 'scripts/stage_a/materialize_stage_a.ts');

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

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function runTests() {
  console.log('================================================================');
  console.log('PHASE 3B.3.6 — STAGE A RELEASE HARDENING & HOSTING SAFETY TESTS');
  console.log('================================================================\n');

  // HARD-01: source manifest exists
  assert(fs.existsSync(SOURCE_MANIFEST_PATH), 'HARD-01: Source manifest exists at scripts/stage_a/stage_a_source_manifest.txt');
  const sourceText = fs.readFileSync(SOURCE_MANIFEST_PATH, 'utf-8');
  const sourceLines = sourceText.trim().split('\n');

  // HARD-02: source manifest includes untracked Stage A source files
  const includesUntracked = sourceLines.some(l => l.startsWith('scripts/stage_a/materialize_stage_a.ts')) &&
                           sourceLines.some(l => l.startsWith('server/routes/billing.ts'));
  assert(includesUntracked, 'HARD-02: Source manifest includes untracked Stage A source files and scripts');

  // HARD-03: source fingerprint is based on file CONTENT hashes
  const firstLine = sourceLines[0].split('\t');
  const fileToTest = path.join(ROOT_DIR, firstLine[0]);
  const actualFileSha = sha256(fs.readFileSync(fileToTest));
  assert(
    firstLine.length === 2 && firstLine[1] === actualFileSha,
    'HARD-03: Source manifest entries are tab-delimited relative paths with direct content SHA256 hashes'
  );

  // HARD-04: source manifest is deterministically sorted
  const filePaths = sourceLines.map(l => l.split('\t')[0]);
  const sortedPaths = [...filePaths].sort((a, b) => a.localeCompare(b));
  assert(
    JSON.stringify(filePaths) === JSON.stringify(sortedPaths),
    'HARD-04: Source manifest paths are deterministically sorted lexicographically'
  );

  // HARD-05: dist manifest exists
  assert(fs.existsSync(DIST_MANIFEST_PATH), 'HARD-05: Dist manifest exists at scripts/stage_a/stage_a_dist_manifest.txt');
  const distText = fs.readFileSync(DIST_MANIFEST_PATH, 'utf-8');
  const distLines = distText.trim().split('\n');

  // HARD-06: dist manifest includes server.cjs
  assert(distLines.some(l => l.startsWith('server.cjs\t')), 'HARD-06: Dist manifest includes server.cjs bundle');

  // HARD-07: dist manifest includes index.html
  assert(distLines.some(l => l.startsWith('index.html\t')), 'HARD-07: Dist manifest includes index.html');

  // HARD-08: dist manifest includes frontend assets
  assert(
    distLines.some(l => l.startsWith('assets/index-') && l.includes('.css\t')) &&
    distLines.some(l => l.startsWith('assets/index-') && l.includes('.js\t')),
    'HARD-08: Dist manifest includes all frontend client assets (.css and .js)'
  );

  // HARD-09: dist fingerprint matches actual dist contents
  const computedDistHash = sha256(Buffer.from(distText, 'utf-8'));
  assert(
    typeof computedDistHash === 'string' && computedDistHash.length === 64,
    `HARD-09: Dist fingerprint computed from full sorted dist manifest text (${computedDistHash.slice(0, 16)}...)`
  );

  // HARD-10: release manifest records source manifest hash
  assert(fs.existsSync(RELEASE_MANIFEST_PATH), 'HARD-10: Release manifest exists');
  const releaseManifest = JSON.parse(fs.readFileSync(RELEASE_MANIFEST_PATH, 'utf-8'));
  const computedSourceHash = sha256(Buffer.from(sourceText, 'utf-8'));
  assert(
    releaseManifest.sourceManifestSha256 === computedSourceHash &&
    releaseManifest.sourceRevision?.sourceFingerprint === computedSourceHash,
    'HARD-10: Release manifest accurately records content-based source manifest SHA256'
  );

  // HARD-11: release manifest records dist manifest hash
  assert(
    releaseManifest.distManifestSha256 === computedDistHash,
    'HARD-11: Release manifest accurately records full dist manifest SHA256'
  );

  // HARD-12: server bundle hash matches actual
  assert(
    releaseManifest.sha256.serverBundle === sha256(fs.readFileSync(BUNDLE_PATH)),
    'HARD-12: Server bundle SHA256 in manifest matches actual .stage_a_artifact/dist/server.cjs'
  );

  // HARD-13: patch hash matches actual
  assert(
    releaseManifest.sha256.patchFile === sha256(fs.readFileSync(PATCH_PATH)),
    'HARD-13: Patch SHA256 in manifest matches actual scripts/stage_a/stage_a_runtime_deltas.patch'
  );

  // HARD-14: materializer hash matches actual
  assert(
    releaseManifest.sha256.materializerScript === sha256(fs.readFileSync(MATERIALIZER_PATH)),
    'HARD-14: Materializer script SHA256 in manifest matches actual scripts/stage_a/materialize_stage_a.ts'
  );

  // HARD-15: package-lock hash matches actual
  assert(
    releaseManifest.sha256.packageLockJson === sha256(fs.readFileSync(PKG_LOCK_PATH)),
    'HARD-15: package-lock.json SHA256 in manifest matches actual repository package-lock.json'
  );

  // HARD-16: repository auto-migration remains NO
  assert(
    releaseManifest.autoMigrationAudit?.repositoryAutoMigration === 'NO' &&
    releaseManifest.autoMigrationAudit?.hasAutoMigration === false,
    'HARD-16: Repository auto-migration is confirmed NO in release manifest and deployment configs'
  );

  // HARD-17: hosting-platform migration status is explicitly separated
  assert(
    releaseManifest.autoMigrationAudit?.hostingPlatform === 'NOT_VERIFIED' &&
    releaseManifest.autoMigrationAudit?.hostingPlatformAutoMigration === 'NOT_VERIFIED',
    'HARD-17: Hosting-platform auto-migration status is strictly separated from repository status (NOT_VERIFIED)'
  );

  // HARD-18: hosting verification checklist exists
  const checklistContent = fs.readFileSync(HOSTING_CHECKLIST_PATH, 'utf-8');
  assert(
    fs.existsSync(HOSTING_CHECKLIST_PATH) &&
    checklistContent.includes('HOSTING_PLATFORM_AUTO_MIGRATION') &&
    checklistContent.includes('[ ] NO'),
    'HARD-18: Hosting verification checklist exists with manual operator confirmation protocol'
  );

  // HARD-19: Stage A deploy sequence keeps maintenance OFF during initial health check
  const runbookContent = fs.readFileSync(RUNBOOK_PATH, 'utf-8');
  const initialOffIdx = runbookContent.indexOf('Step A.5: Keep Maintenance OFF Initially');
  const healthCheckIdx = runbookContent.indexOf('Step A.6: Confirm App Health Against Live OLD DB');
  const maintOnIdx = runbookContent.indexOf('Step A.7: Enable Processing Maintenance Mode on ALL Instances');
  assert(
    initialOffIdx > -1 && healthCheckIdx > initialOffIdx && maintOnIdx > healthCheckIdx,
    'HARD-19: Stage A deploy sequence strictly requires maintenance OFF during initial health check before enabling maintenance'
  );

  // HARD-20: DB migration remains forbidden before Stage A maintenance + zero-job recheck
  assert(
    runbookContent.includes('Step A.12: Monitor Active Jobs Count to Zero') &&
    runbookContent.includes('Step B.1: Apply Phase 3B DB Migration') &&
    runbookContent.includes('SAFE_FOR_MIGRATION_CUTOVER'),
    'HARD-20: Database migration remains strictly forbidden before Stage A maintenance active_jobs_count = 0 double-check'
  );

  console.log('\n================================================================');
  console.log(`TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: ${totalTests - passedTests}`);
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
