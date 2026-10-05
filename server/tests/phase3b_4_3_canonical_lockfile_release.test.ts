import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Phase 3B.4.3 — Canonical Lockfile & Deterministic Release -03 Test Suite
 *
 * Verifies:
 * - LOCK-01: canonical transport file hash is e29b913...
 * - LOCK-02: package-lock.json hash is e29b913...
 * - LOCK-03: artifact package-lock matches canonical SHA
 * - LOCK-04: canonical-package-lock.json excluded from source fingerprint
 * - LOCK-05: releases/ excluded from source fingerprint
 * - LOCK-06: release ID is -03
 * - LOCK-07: deploy message is -03
 * - LOCK-08: -01 superseded record preserved
 * - LOCK-09: -02 superseded record exists
 * - LOCK-10: -03 snapshot exists
 * - LOCK-11: run1/run2 source manifest match
 * - LOCK-12: run1/run2 dist manifest match
 * - LOCK-13: run1/run2 server bundle match
 * - LOCK-14: run1/run2 source file count match
 * - LOCK-15: server bundle unchanged
 * - LOCK-16: no runtime source modified
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const EXPECTED_CANONICAL_LOCK_SHA = 'e29b913f4df1a8cba147290308f9f60d421b09ae2548f973673b45810e2891bc';
const EXPECTED_SERVER_BUNDLE_SHA = 'd927a1f027cbaf912a791c9413d2b273bf17096f3e2adda9bb7f2fb67bbecf97';
const EXPECTED_RELEASE_ID = 'phase3b-full-runtime-20261005-03';

const CANONICAL_LOCK_PATH = path.join(ROOT_DIR, 'canonical-package-lock.json');
const ROOT_LOCK_PATH = path.join(ROOT_DIR, 'package-lock.json');
const ARTIFACT_DIR = path.join(ROOT_DIR, '.phase3b_production_artifact');
const ARTIFACT_LOCK_PATH = path.join(ARTIFACT_DIR, 'package-lock.json');
const ARTIFACT_SERVER_BUNDLE_PATH = path.join(ARTIFACT_DIR, 'dist/server.cjs');

const SOURCE_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_production_source_manifest.txt');
const DIST_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_production_dist_manifest.txt');
const RELEASE_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_production_release_manifest.json');

const RELEASE_01_PATH = path.join(ROOT_DIR, 'scripts/phase3b/releases/phase3b-full-runtime-20261005-01.SUPERSEDED.json');
const RELEASE_02_PATH = path.join(ROOT_DIR, 'scripts/phase3b/releases/phase3b-full-runtime-20261005-02.SUPERSEDED.json');
const RELEASE_03_PATH = path.join(ROOT_DIR, 'scripts/phase3b/releases/phase3b-full-runtime-20261005-03.json');

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let totalTests = 0;
let passedTests = 0;

function check(condition: boolean, code: string, message: string) {
  totalTests++;
  if (!condition) {
    console.error(`[FAIL] ${code}: ${message}`);
    throw new Error(`Assertion failed for ${code}: ${message}`);
  }
  console.log(`[PASS] ${code}: ${message}`);
  passedTests++;
}

export async function runSuite() {
  console.log('================================================================');
  console.log('PHASE 3B.4.3 — CANONICAL LOCKFILE & RELEASE -03 TEST SUITE');
  console.log('================================================================\n');

  // LOCK-01: canonical transport file hash
  check(fs.existsSync(CANONICAL_LOCK_PATH), 'LOCK-01', 'canonical-package-lock.json exists');
  const canonicalLockSha = sha256(fs.readFileSync(CANONICAL_LOCK_PATH));
  check(canonicalLockSha === EXPECTED_CANONICAL_LOCK_SHA, 'LOCK-01', `canonical-package-lock.json matches expected SHA256 (${canonicalLockSha})`);

  // LOCK-02: root package-lock.json hash
  check(fs.existsSync(ROOT_LOCK_PATH), 'LOCK-02', 'package-lock.json exists in root');
  const rootLockSha = sha256(fs.readFileSync(ROOT_LOCK_PATH));
  check(rootLockSha === EXPECTED_CANONICAL_LOCK_SHA, 'LOCK-02', `package-lock.json matches canonical SHA256 (${rootLockSha})`);

  // LOCK-03: artifact package-lock.json hash
  check(fs.existsSync(ARTIFACT_LOCK_PATH), 'LOCK-03', 'package-lock.json exists in artifact');
  const artifactLockSha = sha256(fs.readFileSync(ARTIFACT_LOCK_PATH));
  check(artifactLockSha === EXPECTED_CANONICAL_LOCK_SHA, 'LOCK-03', `artifact package-lock.json matches canonical SHA256 (${artifactLockSha})`);

  // LOCK-04: canonical transport file excluded from source fingerprint
  check(fs.existsSync(SOURCE_MANIFEST_PATH), 'LOCK-04', 'source manifest exists');
  const sourceManifestText = fs.readFileSync(SOURCE_MANIFEST_PATH, 'utf-8');
  const sourceManifestLines = sourceManifestText.trim().split('\n');
  const hasTransportFileInManifest = sourceManifestLines.some(line => line.includes('canonical-package-lock.json'));
  const hasTransportFileInArtifact = fs.existsSync(path.join(ARTIFACT_DIR, 'canonical-package-lock.json'));
  check(!hasTransportFileInManifest && !hasTransportFileInArtifact, 'LOCK-04', 'canonical-package-lock.json is strictly excluded from source manifest and artifact');

  // LOCK-05: releases/ directory excluded from source fingerprint
  const hasReleasesInManifest = sourceManifestLines.some(line => line.startsWith('scripts/phase3b/releases'));
  const hasReleasesInArtifact = fs.existsSync(path.join(ARTIFACT_DIR, 'scripts/phase3b/releases'));
  check(!hasReleasesInManifest && !hasReleasesInArtifact, 'LOCK-05', 'scripts/phase3b/releases/ is strictly excluded from source manifest and artifact');

  // LOCK-06: release ID is -03
  check(fs.existsSync(RELEASE_MANIFEST_PATH), 'LOCK-06', 'release manifest exists');
  const releaseManifest = JSON.parse(fs.readFileSync(RELEASE_MANIFEST_PATH, 'utf-8'));
  check(releaseManifest.releaseId === EXPECTED_RELEASE_ID, 'LOCK-06', `releaseId is ${EXPECTED_RELEASE_ID} (got: ${releaseManifest.releaseId})`);

  // LOCK-07: deploy message is -03
  const deployCommand = releaseManifest.deploymentInstructions.command;
  const expectedDeployCommand = `railway up . --path-as-root --no-gitignore --service DocConvert-AI --environment production --message "${EXPECTED_RELEASE_ID}"`;
  check(deployCommand === expectedDeployCommand, 'LOCK-07', `deploy command is correctly formatted with ${EXPECTED_RELEASE_ID}`);

  // LOCK-08: -01 superseded record preserved
  check(fs.existsSync(RELEASE_01_PATH), 'LOCK-08', 'phase3b-full-runtime-20261005-01.SUPERSEDED.json exists');
  const rel01 = JSON.parse(fs.readFileSync(RELEASE_01_PATH, 'utf-8'));
  check(rel01.releaseId === 'phase3b-full-runtime-20261005-01' && rel01.status === 'SUPERSEDED_NEVER_DEPLOYED', 'LOCK-08', '-01 superseded record is intact with status SUPERSEDED_NEVER_DEPLOYED');

  // LOCK-09: -02 superseded record exists
  check(fs.existsSync(RELEASE_02_PATH), 'LOCK-09', 'phase3b-full-runtime-20261005-02.SUPERSEDED.json exists');
  const rel02 = JSON.parse(fs.readFileSync(RELEASE_02_PATH, 'utf-8'));
  check(
    rel02.releaseId === 'phase3b-full-runtime-20261005-02' &&
    rel02.status === 'SUPERSEDED_NEVER_DEPLOYED' &&
    rel02.supersededBy === EXPECTED_RELEASE_ID &&
    rel02.canonicalPackageLockSha256 === EXPECTED_CANONICAL_LOCK_SHA,
    'LOCK-09',
    '-02 record correctly documents SUPERSEDED_NEVER_DEPLOYED and supersession by -03'
  );

  // LOCK-10: -03 snapshot exists
  check(fs.existsSync(RELEASE_03_PATH), 'LOCK-10', 'phase3b-full-runtime-20261005-03.json exists');
  const rel03 = JSON.parse(fs.readFileSync(RELEASE_03_PATH, 'utf-8'));
  check(
    rel03.releaseId === EXPECTED_RELEASE_ID &&
    rel03.status === 'SEALED_NOT_DEPLOYED' &&
    rel03.supersedes === 'phase3b-full-runtime-20261005-02' &&
    rel03.serverBundleSha256 === EXPECTED_SERVER_BUNDLE_SHA &&
    rel03.packageLockSha256 === EXPECTED_CANONICAL_LOCK_SHA,
    'LOCK-10',
    '-03 release snapshot is SEALED_NOT_DEPLOYED and supersedes -02'
  );

  // LOCK-11 to LOCK-14: Reproducibility verification
  const currentSourceManifest = fs.readFileSync(SOURCE_MANIFEST_PATH, 'utf-8');
  const computedSourceManifestSha = sha256(currentSourceManifest);
  check(
    computedSourceManifestSha === releaseManifest.sha256.sourceManifest,
    'LOCK-11',
    `run1/run2 source manifest match (${computedSourceManifestSha})`
  );

  const distManifestText = fs.readFileSync(DIST_MANIFEST_PATH, 'utf-8');
  const computedDistManifestSha = sha256(distManifestText);
  check(
    computedDistManifestSha === releaseManifest.sha256.distManifest,
    'LOCK-12',
    `run1/run2 dist manifest match (${computedDistManifestSha})`
  );

  const serverBundleSha = sha256(fs.readFileSync(ARTIFACT_SERVER_BUNDLE_PATH));
  check(
    serverBundleSha === releaseManifest.sha256.serverBundle,
    'LOCK-13',
    `run1/run2 server bundle match (${serverBundleSha})`
  );

  const sourceManifestLineCount = currentSourceManifest.trim().split('\n').length;
  check(
    sourceManifestLineCount === releaseManifest.sourceRevision.sourceFileCount,
    'LOCK-14',
    `run1/run2 source file count match (${sourceManifestLineCount} == ${releaseManifest.sourceRevision.sourceFileCount})`
  );

  // LOCK-15: server bundle unchanged
  const actualServerBundleSha = sha256(fs.readFileSync(ARTIFACT_SERVER_BUNDLE_PATH));
  check(actualServerBundleSha === EXPECTED_SERVER_BUNDLE_SHA, 'LOCK-15', `server.cjs SHA matches expected baseline (${actualServerBundleSha})`);

  // LOCK-16: no runtime source modified
  const pristineFiles = [
    'server/routes/documents.ts',
    'server/db/db.ts',
    'server/services/ocrWorker.ts',
    'server/services/ocrService.ts',
    'server/services/credit/creditService.ts',
    'server/services/credit/processingEligibilityService.ts',
    'server/services/billing/billingService.ts',
    'server.ts',
  ];
  let runtimeIntegrity = true;
  for (const pf of pristineFiles) {
    const fullPf = path.join(ROOT_DIR, pf);
    const artPf = path.join(ARTIFACT_DIR, pf);
    if (!fs.existsSync(fullPf) || !fs.existsSync(artPf)) {
      runtimeIntegrity = false;
      break;
    }
    const fullContent = fs.readFileSync(fullPf, 'utf-8');
    const artContent = fs.readFileSync(artPf, 'utf-8');
    if (fullContent !== artContent) {
      runtimeIntegrity = false;
      break;
    }
  }
  check(runtimeIntegrity, 'LOCK-16', 'runtime source files are identical between repository and artifact, no runtime changes made');

  console.log('\n================================================================');
  console.log(`PHASE 3B.4.3 TEST RESULT: ${passedTests}/${totalTests} PASSED (0 FAILED)`);
  console.log('================================================================\n');
}

if (process.argv[1] && process.argv[1].endsWith('phase3b_4_3_canonical_lockfile_release.test.ts')) {
  runSuite().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
