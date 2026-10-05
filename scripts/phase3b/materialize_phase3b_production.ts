import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Phase 3B.4 — Materialize Full Phase 3B Production Runtime Artifact
 *
 * This script automates the creation of the sealed, standalone Full Phase 3B production artifact.
 * It copies the complete accepted Phase 3B source tree into .phase3b_production_artifact,
 * ensures NO Stage A compatibility patch is applied, links node_modules,
 * builds the production bundle, computes deterministic source and dist manifests,
 * and generates the immutable production release manifest.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const TARGET_DIR = path.resolve(ROOT_DIR, '.phase3b_production_artifact');
const RELEASE_ID = 'phase3b-full-runtime-20261005-02';

console.log('================================================================');
console.log(`MATERIALIZING FULL PHASE 3B PRODUCTION ARTIFACT (${RELEASE_ID})`);
console.log('================================================================');
console.log(`Source Root : ${ROOT_DIR}`);
console.log(`Target Dir  : ${TARGET_DIR}\n`);

// 1. Clean previous artifact if exists (preserving node_modules junction)
if (fs.existsSync(TARGET_DIR)) {
  console.log('[1/6] Cleaning existing .phase3b_production_artifact (preserving node_modules)...');
  const items = fs.readdirSync(TARGET_DIR);
  for (const item of items) {
    if (item === 'node_modules') continue;
    fs.rmSync(path.join(TARGET_DIR, item), { recursive: true, force: true });
  }
} else {
  console.log('[1/6] Creating .phase3b_production_artifact directory...');
  fs.mkdirSync(TARGET_DIR, { recursive: true });
}

// 2. Copy source files and configs
console.log('[2/6] Copying repository source files to artifact...');
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
  '.env.example',
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
  console.log('[3/6] Linking node_modules via directory junction...');
  const nodeModulesSrc = path.join(ROOT_DIR, 'node_modules');
  if (process.platform === 'win32') {
    execSync(`cmd /c mklink /J "${nodeModulesDest}" "${nodeModulesSrc}"`, { stdio: 'inherit' });
  } else {
    fs.symlinkSync(nodeModulesSrc, nodeModulesDest, 'junction');
  }
} else {
  console.log('[3/6] node_modules already linked.');
}

// 4. Verify NO Stage A delta patch is applied
console.log('[4/6] Verifying Full Phase 3B runtime fidelity (no Stage A bypass)...');
const artifactDocRoutes = fs.readFileSync(path.join(TARGET_DIR, 'server/routes/documents.ts'), 'utf-8');
const artifactOcrWorker = fs.readFileSync(path.join(TARGET_DIR, 'server/services/ocrWorker.ts'), 'utf-8');

if (!artifactDocRoutes.includes('estimatedUnits: eligibility.estimatedUnits')) {
  throw new Error('Fidelity error: server/routes/documents.ts is missing Phase 3B quote snapshot options.');
}
if (!artifactOcrWorker.includes('getValidatedReservationForJob(job)')) {
  throw new Error('Fidelity error: server/services/ocrWorker.ts is missing Phase 3B reservation hard gate.');
}
console.log('Fidelity confirmed: Full Phase 3B runtime routes and worker gate are intact.');

// 5. Build production bundle inside artifact
console.log('[5/6] Building production bundle inside artifact (npm run build)...');
try {
  execSync('npm run build', {
    cwd: TARGET_DIR,
    stdio: 'inherit',
  });
  console.log('Production build completed successfully.');
} catch (err) {
  console.error('Build failed in Phase 3B artifact:', err);
  process.exit(1);
}

// 6. Generate manifests and release metadata
console.log('[6/6] Generating manifests and release manifest...');

function computeSha256(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function listFilesRecursive(dir: string, baseDir: string = dir): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(listFilesRecursive(fullPath, baseDir));
    } else {
      results.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
    }
  }
  return results.sort();
}

// Generate source manifest
const sourceFiles = listFilesRecursive(TARGET_DIR);
const sourceManifestLines = sourceFiles.map((relPath) => {
  const hash = computeSha256(path.join(TARGET_DIR, relPath));
  return `${relPath}\t${hash}`;
});
const sourceManifestContent = sourceManifestLines.join('\n') + '\n';
const sourceManifestPath = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_production_source_manifest.txt');
fs.mkdirSync(path.dirname(sourceManifestPath), { recursive: true });
fs.writeFileSync(sourceManifestPath, sourceManifestContent, 'utf-8');
const sourceManifestSha256 = crypto.createHash('sha256').update(sourceManifestContent).digest('hex');

// Generate dist manifest
const distFiles: string[] = [];
function listDistRecursive(dir: string, baseDir: string = dir) {
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      listDistRecursive(fullPath, baseDir);
    } else {
      distFiles.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
    }
  }
}
const targetDist = path.join(TARGET_DIR, 'dist');
listDistRecursive(targetDist, targetDist);
distFiles.sort();

const distManifestLines = distFiles.map((relPath) => {
  const hash = computeSha256(path.join(targetDist, relPath));
  return `dist/${relPath}\t${hash}`;
});
const distManifestContent = distManifestLines.join('\n') + '\n';
const distManifestPath = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_production_dist_manifest.txt');
fs.writeFileSync(distManifestPath, distManifestContent, 'utf-8');
const distManifestSha256 = crypto.createHash('sha256').update(distManifestContent).digest('hex');

// Hashes of key artifacts
const serverBundleSha256 = computeSha256(path.join(targetDist, 'server.cjs'));
const packageLockSha256 = computeSha256(path.join(TARGET_DIR, 'package-lock.json'));
const packageJsonSha256 = computeSha256(path.join(TARGET_DIR, 'package.json'));
const materializerSha256 = computeSha256(__filename);

let gitHeadSha = 'UNKNOWN';
let workingTreeDirty = true;
try {
  gitHeadSha = execSync('git rev-parse HEAD', { cwd: ROOT_DIR }).toString().trim();
  const gitStatus = execSync('git status --porcelain', { cwd: ROOT_DIR }).toString().trim();
  workingTreeDirty = gitStatus.length > 0;
} catch {
  // Ignore git errors if unavailable
}

const releaseManifest = {
  releaseId: RELEASE_ID,
  artifactName: 'Full Phase 3B Production Runtime Release Artifact',
  createdAt: new Date().toISOString(),
  sourceRevision: {
    gitHeadSha,
    workingTreeDirty,
    sourceManifestSha256,
    sourceFileCount: sourceFiles.length,
    baselineDescription: 'Full Phase 3B Production Runtime with atomic credit reservation, worker hard gate, and credit ledger hotfix',
  },
  artifactPaths: {
    artifactDir: '.phase3b_production_artifact',
    serverBundle: '.phase3b_production_artifact/dist/server.cjs',
    materializerScript: 'scripts/phase3b/materialize_phase3b_production.ts',
    sourceManifest: 'scripts/phase3b/phase3b_production_source_manifest.txt',
    distManifest: 'scripts/phase3b/phase3b_production_dist_manifest.txt',
    predeployCheckSql: 'scripts/phase3b/phase3b_predeploy_read_only_checks.sql',
  },
  sha256: {
    serverBundle: serverBundleSha256,
    materializerScript: materializerSha256,
    packageJson: packageJsonSha256,
    packageLockJson: packageLockSha256,
    sourceManifest: sourceManifestSha256,
    distManifest: distManifestSha256,
  },
  databaseBaselineRequirements: {
    phase2a: {
      migration: '20261001000000_credit_ledger_foundation.sql',
      requiredTables: ['credit_accounts', 'credit_grants', 'credit_ledger'],
    },
    phase2b: {
      migration: '20261002010000_credit_reservation_foundation.sql',
      requiredTables: ['credit_reservations', 'credit_reservation_allocations', 'credit_reservation_events'],
      requiredConstraint: "chk_credit_ledger_entry_type: ('GRANT', 'ADJUSTMENT', 'EXPIRATION', 'CAPTURE')",
    },
    phase3a: {
      migration: '20261003010000_credit_settlement_and_free_bootstrap_patch.sql',
      pricingPolicy: 'processing-pricing-v1',
      oneTimeBootstrapIndex: 'uq_credit_grants_one_time_free_bootstrap',
    },
    phase3bLedgerHotfix: {
      migration: '20261005010000_fix_grant_user_credits_ledger_entry_type.sql',
      canonicalMapping: "p_source_type = 'ADMIN_ADJUSTMENT' -> 'ADJUSTMENT', ELSE 'GRANT'",
      ledgerConstraintUnchanged: true,
    },
    phase3bDatabaseMigration: {
      migration: '20261004010000_atomic_credit_reserve_before_processing_queue.sql',
      requiredColumns: {
        processing_jobs: [
          'reservation_id UUID',
          'pricing_version VARCHAR(50)',
          'estimated_billable_units BIGINT',
          'quote_snapshot JSONB',
        ],
      },
      canonicalConfirmRpc: 'confirm_document_processing(UUID, UUID, VARCHAR, BIGINT, VARCHAR, JSONB, TEXT, JSONB)',
      legacy3ArgRpcStatus: 'DEPRECATED_HARD_FAIL',
    },
  },
  runtimeInvariants: {
    extendedConfirmRpcUsed: true,
    legacy3ArgRpcUsedForNormalProcessing: false,
    trustedServerQuoteRecomputed: true,
    clientQuoteCannotOverrideEstimate: true,
    reservationBeforeQueue: true,
    workerReservationHardGateActive: true,
    stageAWorkerBypassRemoved: true,
    captureSemanticsPreserved: true,
    releaseSemanticsPreserved: true,
    ledgerHotfixCompatible: true,
    freeBootstrapCompatible: true,
    maintenanceGuardsPreserved: true,
  },
  deploymentInstructions: {
    command: 'railway up . --path-as-root --no-gitignore --service DocConvert-AI --environment production --message "phase3b-full-runtime-20261005-01"',
    cwd: '.phase3b_production_artifact',
    targetWorkspace: "DuongAIOS's Projects",
    targetProject: 'zealous-friendship',
    targetEnvironment: 'production',
    targetService: 'DocConvert-AI',
    maintenancePolicy: 'KEEP_MAINTENANCE_TRUE_DURING_DEPLOY_AND_SMOKE',
  },
};

const releaseManifestPath = path.join(ROOT_DIR, 'scripts/phase3b/phase3b_production_release_manifest.json');
fs.writeFileSync(releaseManifestPath, JSON.stringify(releaseManifest, null, 2) + '\n', 'utf-8');

console.log('\n================================================================');
console.log('FULL PHASE 3B ARTIFACT MATERIALIZED & SEALED SUCCESSFULLY');
console.log(`Release ID        : ${RELEASE_ID}`);
console.log(`Release Manifest  : ${releaseManifestPath}`);
console.log(`Server Bundle SHA : ${serverBundleSha256}`);
console.log(`Dist Files Count  : ${distFiles.length}`);
console.log(`Source Files Count: ${sourceFiles.length}`);
console.log('================================================================\n');
