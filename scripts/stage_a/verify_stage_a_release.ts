import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const SOURCE_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_source_manifest.txt');
const DIST_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_dist_manifest.txt');
const RELEASE_MANIFEST_PATH = path.join(ROOT_DIR, 'scripts/stage_a/stage_a_release_manifest.json');
const DIST_DIR = path.join(ROOT_DIR, '.stage_a_artifact/dist');

export function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function getAllFiles(dir: string, baseDir = ''): Array<{ fullPath: string; relPath: string }> {
  let results: Array<{ fullPath: string; relPath: string }> = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const relPath = (baseDir ? baseDir + '/' + file : file).replace(/\\/g, '/');
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', '.stage_a_artifact', '.git', '.system_generated', 'logs', 'coverage', '.cache'].includes(file)) continue;
      results = results.concat(getAllFiles(filePath, relPath));
    } else {
      results.push({ fullPath: filePath, relPath });
    }
  }
  return results;
}

export function generateSourceManifest(): { manifestText: string; manifestHash: string; fileCount: number } {
  const rootFiles = [
    'server.ts',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.node.json',
    'vite.config.ts',
    'index.html',
    'vercel.json',
    'docs/phase3b_migration_cutover_runbook.md'
  ];

  let allSourceFiles: Array<{ fullPath: string; relPath: string }> = [];
  for (const f of rootFiles) {
    const full = path.join(ROOT_DIR, f);
    if (fs.existsSync(full)) {
      allSourceFiles.push({ fullPath: full, relPath: f.replace(/\\/g, '/') });
    }
  }

  const dirIncludes = ['server', 'src', 'public', 'scripts/stage_a'];
  for (const d of dirIncludes) {
    const fullDir = path.join(ROOT_DIR, d);
    if (fs.existsSync(fullDir)) {
      const files = getAllFiles(fullDir, d);
      for (const file of files) {
        if (file.relPath.endsWith('.txt') || file.relPath.endsWith('.json')) continue; // exclude manifests to prevent circularity
        allSourceFiles.push(file);
      }
    }
  }

  allSourceFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const lines = allSourceFiles.map(f => {
    const content = fs.readFileSync(f.fullPath);
    return f.relPath + '\t' + sha256(content);
  });

  const manifestText = lines.join('\n') + '\n';
  const manifestHash = sha256(Buffer.from(manifestText, 'utf-8'));
  return { manifestText, manifestHash, fileCount: allSourceFiles.length };
}

export function generateDistManifest(): { manifestText: string; manifestHash: string; fileCount: number } {
  const distFiles = getAllFiles(DIST_DIR, '');
  distFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const lines = distFiles.map(f => {
    const content = fs.readFileSync(f.fullPath);
    return f.relPath + '\t' + sha256(content);
  });

  const manifestText = lines.join('\n') + '\n';
  const manifestHash = sha256(Buffer.from(manifestText, 'utf-8'));
  return { manifestText, manifestHash, fileCount: distFiles.length };
}

export function verifyRelease(): boolean {
  console.log('================================================================');
  console.log('STAGE A RELEASE INTEGRITY VERIFICATION');
  console.log('================================================================\n');

  let allPassed = true;
  function check(passed: boolean, msg: string) {
    if (passed) {
      console.log(`[PASS] ${msg}`);
    } else {
      console.error(`[FAIL] ${msg}`);
      allPassed = false;
    }
  }

  check(fs.existsSync(RELEASE_MANIFEST_PATH), 'Release manifest exists');
  const releaseManifest = JSON.parse(fs.readFileSync(RELEASE_MANIFEST_PATH, 'utf-8'));
  check(releaseManifest.releaseId === 'stage-a-3b-bridge-20261004-03', `Release manifest releaseId is stage-a-3b-bridge-20261004-03 (got: ${releaseManifest.releaseId})`);

  // 1. Source manifest verification
  const currentSource = generateSourceManifest();
  check(fs.existsSync(SOURCE_MANIFEST_PATH), 'Source manifest file exists');
  const diskSourceText = fs.readFileSync(SOURCE_MANIFEST_PATH, 'utf-8');
  check(diskSourceText === currentSource.manifestText, `Source manifest matches current file tree (${currentSource.fileCount} files)`);
  check(
    releaseManifest.sourceManifestSha256 === currentSource.manifestHash,
    `Source manifest SHA256 matches release manifest (${currentSource.manifestHash.slice(0, 16)}...)`
  );

  // 2. Dist manifest verification
  const currentDist = generateDistManifest();
  check(fs.existsSync(DIST_MANIFEST_PATH), 'Dist manifest file exists');
  const diskDistText = fs.readFileSync(DIST_MANIFEST_PATH, 'utf-8');
  check(diskDistText === currentDist.manifestText, `Dist manifest matches actual .stage_a_artifact/dist (${currentDist.fileCount} files)`);
  check(
    releaseManifest.distManifestSha256 === currentDist.manifestHash,
    `Dist manifest SHA256 matches release manifest (${currentDist.manifestHash.slice(0, 16)}...)`
  );

  // 3. Artifact individual hashes
  const serverBundlePath = path.join(ROOT_DIR, releaseManifest.artifactPaths.serverBundle);
  check(
    fs.existsSync(serverBundlePath) && sha256(fs.readFileSync(serverBundlePath)) === releaseManifest.sha256.serverBundle,
    'server.cjs SHA256 matches release manifest'
  );

  const patchPath = path.join(ROOT_DIR, releaseManifest.artifactPaths.patchFile);
  check(
    fs.existsSync(patchPath) && sha256(fs.readFileSync(patchPath)) === releaseManifest.sha256.patchFile,
    'Patch SHA256 matches release manifest'
  );

  const materializerPath = path.join(ROOT_DIR, releaseManifest.artifactPaths.materializerScript);
  check(
    fs.existsSync(materializerPath) && sha256(fs.readFileSync(materializerPath)) === releaseManifest.sha256.materializerScript,
    'Materializer script SHA256 matches release manifest'
  );

  const pkgLockPath = path.join(ROOT_DIR, 'package-lock.json');
  check(
    fs.existsSync(pkgLockPath) && sha256(fs.readFileSync(pkgLockPath)) === releaseManifest.sha256.packageLockJson,
    'package-lock.json SHA256 matches release manifest'
  );

  console.log('\n================================================================');
  console.log(`RELEASE VERIFICATION RESULT: ${allPassed ? 'ALL INVARIANTS PASSED' : 'VERIFICATION FAILED'}`);
  console.log('================================================================');
  return allPassed;
}

// CLI Execution:
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--generate')) {
    console.log('Generating Stage A release manifests...');
    const source = generateSourceManifest();
    fs.writeFileSync(SOURCE_MANIFEST_PATH, source.manifestText, 'utf-8');
    console.log(`Wrote source manifest (${source.fileCount} files, SHA256: ${source.manifestHash})`);

    const dist = generateDistManifest();
    fs.writeFileSync(DIST_MANIFEST_PATH, dist.manifestText, 'utf-8');
    console.log(`Wrote dist manifest (${dist.fileCount} files, SHA256: ${dist.manifestHash})`);

    // Update release manifest
    const manifest = JSON.parse(fs.readFileSync(RELEASE_MANIFEST_PATH, 'utf-8'));
    manifest.sourceManifestPath = 'scripts/stage_a/stage_a_source_manifest.txt';
    manifest.sourceManifestSha256 = source.manifestHash;
    manifest.distManifestPath = 'scripts/stage_a/stage_a_dist_manifest.txt';
    manifest.distManifestSha256 = dist.manifestHash;
    manifest.sourceRevision.sourceFingerprint = source.manifestHash; // Robust content-based fingerprint
    const serverBundlePath = path.join(ROOT_DIR, manifest.artifactPaths.serverBundle);
    if (fs.existsSync(serverBundlePath)) {
      manifest.sha256.serverBundle = sha256(fs.readFileSync(serverBundlePath));
    }
    manifest.autoMigrationAudit.repositoryAutoMigration = 'NO';
    manifest.autoMigrationAudit.hostingPlatform = 'NOT_VERIFIED';
    manifest.autoMigrationAudit.hostingPlatformAutoMigration = 'NOT_VERIFIED';
    manifest.autoMigrationAudit.hostingVerificationChecklist = 'scripts/stage_a/stage_a_hosting_verification_checklist.md';

    fs.writeFileSync(RELEASE_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    console.log('Updated scripts/stage_a/stage_a_release_manifest.json with content-based fingerprints.');
  } else {
    const success = verifyRelease();
    if (!success) process.exit(1);
  }
}
