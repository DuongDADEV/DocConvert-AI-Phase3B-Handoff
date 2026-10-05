import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Phase 3B.3.4 — Materialize Stage A Deployment Artifact
 *
 * This script automates the exact reproduction of the Stage A Maintenance Bridge artifact.
 * It copies the current accepted source tree into an isolated directory (.stage_a_artifact),
 * applies scripts/stage_a/stage_a_runtime_deltas.patch to exclude Phase 3B DB-dependent runtime deltas,
 * links node_modules, and verifies the standalone production build.
 */

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const TARGET_DIR = path.resolve(ROOT_DIR, '.stage_a_artifact');
const PATCH_FILE = path.resolve(ROOT_DIR, 'scripts/stage_a/stage_a_runtime_deltas.patch');

console.log('=== MATERIALIZING STAGE A MAINTENANCE BRIDGE ARTIFACT ===');
console.log(`Source Root : ${ROOT_DIR}`);
console.log(`Target Dir  : ${TARGET_DIR}`);
console.log(`Patch File  : ${PATCH_FILE}`);

// 1. Clean previous artifact if exists (except node_modules junction)
if (fs.existsSync(TARGET_DIR)) {
  console.log('[1/5] Cleaning existing .stage_a_artifact (preserving node_modules junction if present)...');
  const items = fs.readdirSync(TARGET_DIR);
  for (const item of items) {
    if (item === 'node_modules') continue;
    fs.rmSync(path.join(TARGET_DIR, item), { recursive: true, force: true });
  }
} else {
  console.log('[1/5] Creating .stage_a_artifact directory...');
  fs.mkdirSync(TARGET_DIR, { recursive: true });
}

// 2. Copy source files and configs
console.log('[2/5] Copying repository source files to artifact...');
const copyDirs = ['server', 'src', 'scripts', 'supabase', 'docs', 'public'];
const copyFiles = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'index.html',
  'server.ts',
  'vercel.json',
  '.env.example'
];

for (const dir of copyDirs) {
  const src = path.join(ROOT_DIR, dir);
  const dest = path.join(TARGET_DIR, dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true });
  }
}

for (const file of copyFiles) {
  const src = path.join(ROOT_DIR, file);
  const dest = path.join(TARGET_DIR, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

// 3. Link node_modules if not already present
const nodeModulesDest = path.join(TARGET_DIR, 'node_modules');
if (!fs.existsSync(nodeModulesDest)) {
  console.log('[3/5] Linking node_modules via directory junction...');
  const nodeModulesSrc = path.join(ROOT_DIR, 'node_modules');
  if (process.platform === 'win32') {
    execSync(`cmd /c mklink /J "${nodeModulesDest}" "${nodeModulesSrc}"`, { stdio: 'inherit' });
  } else {
    fs.symlinkSync(nodeModulesSrc, nodeModulesDest, 'junction');
  }
} else {
  console.log('[3/5] node_modules already linked.');
}

// 4. Apply Stage A patch
console.log('[4/5] Applying Stage A runtime delta patch...');
try {
  execSync(`git apply --whitespace=nowarn --directory=.stage_a_artifact "${PATCH_FILE}"`, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  console.log('Patch applied successfully.');
} catch (err) {
  console.error('Failed to apply patch with git apply:', err);
  process.exit(1);
}

// 5. Build verification
console.log('[5/5] Building Stage A artifact (npm run build)...');
try {
  execSync('npm run build', {
    cwd: TARGET_DIR,
    stdio: 'inherit',
  });
  console.log('=== STAGE A ARTIFACT MATERIALIZED & VERIFIED SUCCESSFULLY ===');
} catch (err) {
  console.error('Build failed in Stage A artifact:', err);
  process.exit(1);
}
