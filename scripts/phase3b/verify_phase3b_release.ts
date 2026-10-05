import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const SOURCE_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_production_source_manifest.txt');
const DIST_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_production_dist_manifest.txt');
const RELEASE_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_production_release_manifest.json');
const ARTIFACT_DIR = path.join(ROOT_DIR, '.phase3b_production_artifact');
const DIST_DIR = path.join(ARTIFACT_DIR, 'dist');

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passed++;
  } else {
    console.error(`[FAIL] ${message}`);
    failed++;
  }
}

export async function verifyRelease() {
  console.log('================================================================');
  console.log('FULL PHASE 3B PRODUCTION RELEASE INTEGRITY VERIFICATION');
  console.log('================================================================\n');

  // 1. Release manifest
  assert(fs.existsSync(RELEASE_MANIFEST_PATH), 'Release manifest exists');
  const releaseManifest = JSON.parse(fs.readFileSync(RELEASE_MANIFEST_PATH, 'utf-8'));
  assert(
    releaseManifest.releaseId === 'phase3b-full-runtime-20261005-02',
    `Release ID is phase3b-full-runtime-20261005-02 (got: ${releaseManifest.releaseId})`
  );

  // 2. Source manifest
  assert(fs.existsSync(SOURCE_MANIFEST_PATH), 'Source manifest exists');
  const sourceManifestText = fs.readFileSync(SOURCE_MANIFEST_PATH, 'utf-8');
  const computedSourceManifestSha = sha256(sourceManifestText);
  assert(
    computedSourceManifestSha === releaseManifest.sha256.sourceManifest,
    'Source manifest SHA matches release manifest'
  );

  // 3. Dist manifest
  assert(fs.existsSync(DIST_MANIFEST_PATH), 'Dist manifest exists');
  const distManifestText = fs.readFileSync(DIST_MANIFEST_PATH, 'utf-8');
  const computedDistManifestSha = sha256(distManifestText);
  assert(
    computedDistManifestSha === releaseManifest.sha256.distManifest,
    'Dist manifest SHA matches release manifest'
  );

  // 4. Server bundle
  const serverBundlePath = path.join(DIST_DIR, 'server.cjs');
  assert(fs.existsSync(serverBundlePath), 'server.cjs exists in artifact dist');
  const serverBundleSha = sha256(fs.readFileSync(serverBundlePath));
  assert(
    serverBundleSha === releaseManifest.sha256.serverBundle,
    `server.cjs SHA matches release manifest (${serverBundleSha.slice(0, 16)}...)`
  );

  // 5. Package-lock
  const packageLockPath = path.join(ARTIFACT_DIR, 'package-lock.json');
  assert(fs.existsSync(packageLockPath), 'package-lock.json exists in artifact');
  const packageLockSha = sha256(fs.readFileSync(packageLockPath));
  assert(
    packageLockSha === releaseManifest.sha256.packageLockJson,
    'package-lock.json SHA matches release manifest'
  );

  // 6. Runtime fidelity inside artifact
  const artDocRoutes = fs.readFileSync(path.join(ARTIFACT_DIR, 'server/routes/documents.ts'), 'utf-8');
  const artOcrWorker = fs.readFileSync(path.join(ARTIFACT_DIR, 'server/services/ocrWorker.ts'), 'utf-8');
  const artDb = fs.readFileSync(path.join(ARTIFACT_DIR, 'server/db/db.ts'), 'utf-8');

  assert(
    artDocRoutes.includes('estimatedUnits: eligibility.estimatedUnits') &&
      artDocRoutes.includes('pricingVersion: eligibility.processingPricingVersion') &&
      artDocRoutes.includes('quoteSnapshot: {'),
    'Phase 3B extended quote snapshot passed in /process route in artifact'
  );

  assert(
    artDocRoutes.includes('reservation: result.reservation,'),
    'Reservation returned in /process response in artifact'
  );

  assert(
    artOcrWorker.includes('await db.getValidatedReservationForJob(job);') &&
      artOcrWorker.includes("error_code: 'MISSING_CREDIT_RESERVATION'"),
    'Phase 3B reservation hard gate active in ocrWorker in artifact'
  );

  assert(
    artDb.includes("rpcParams.p_estimated_units = options.estimatedUnits;") &&
      artDb.includes("rpcParams.p_pricing_version = options.pricingVersion") &&
      artDb.includes("rpcParams.p_quote_snapshot = options.quoteSnapshot"),
    'Extended confirm RPC parameters mapped in db.ts in artifact'
  );

  // 7. No Stage A patch applied in artifact
  assert(
    !artOcrWorker.includes('// 3b. Phase 3B / 3B.1 Worker Hard Gate: Processing job must have a valid ACTIVE reservation\n      // 4. Update status to PROCESSING'),
    'Stage A hard gate removal is NOT present in Phase 3B artifact'
  );

  console.log('\n================================================================');
  if (failed === 0) {
    console.log(`RELEASE VERIFICATION PASSED: ${passed}/${passed} checks passed`);
  } else {
    console.error(`RELEASE VERIFICATION FAILED: ${failed} checks failed, ${passed} passed`);
    process.exit(1);
  }
  console.log('================================================================\n');
}

if (process.argv[1] && process.argv[1].endsWith('verify_phase3b_release.ts')) {
  verifyRelease().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
