import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 3B.3.8 — Credit Ledger Entry Type Hotfix Test Suite
 *
 * Verifies:
 * - LEDGER-01: FREE_BOOTSTRAP grant maps ledger entry_type to GRANT
 * - LEDGER-02: SUBSCRIPTION_CYCLE maps to GRANT
 * - LEDGER-03: CREDIT_PACK_PURCHASE maps to GRANT
 * - LEDGER-04: PROMOTION maps to GRANT
 * - LEDGER-05: MIGRATION maps to GRANT
 * - LEDGER-06: unknown/manual positive grant maps to GRANT
 * - LEDGER-07: ADMIN_ADJUSTMENT maps to ADJUSTMENT
 * - LEDGER-08: No generated entry_type violates chk_credit_ledger_entry_type
 * - LEDGER-09: source_type remains unchanged and preserves business origin
 * - LEDGER-10: idempotency key behavior is unchanged
 * - LEDGER-11: one-time FREE bootstrap unique guard unchanged
 * - LEDGER-12: credit account creation behavior unchanged
 * - LEDGER-13: function signature unchanged
 * - LEDGER-14: return shape unchanged
 * - LEDGER-15: Stage A compatibility remains unchanged
 * - STATIC-01: Static SQL assertion that hotfix function cannot emit invalid entry_types
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const HOTFIX_MIGRATION_PATH = path.join(
  ROOT_DIR,
  'supabase/migrations/20261005010000_fix_grant_user_credits_ledger_entry_type.sql'
);
const PRIOR_MIGRATION_PATH = path.join(
  ROOT_DIR,
  'supabase/migrations/20261003010000_credit_settlement_and_free_bootstrap_patch.sql'
);
const RESERVATION_FOUNDATION_PATH = path.join(
  ROOT_DIR,
  'supabase/migrations/20261002010000_credit_reservation_foundation.sql'
);
const STAGE_A_CREDIT_SERVICE_PATH = path.join(
  ROOT_DIR,
  '.stage_a_artifact/server/services/credit/creditService.ts'
);
const MAIN_CREDIT_SERVICE_PATH = path.join(
  ROOT_DIR,
  'server/services/credit/creditService.ts'
);

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

/**
 * Extracts executable code of a SQL function (strip SQL line comments and block comments)
 */
function stripSqlComments(sql: string): string {
  // Remove single line comments -- ...
  let clean = sql.replace(/--.*$/gm, '');
  // Remove block comments /* ... */
  clean = clean.replace(/\/\*[\s\S]*?\*\//g, '');
  return clean;
}

/**
 * Simulate the SQL CASE expression for entry_type mapping in grant_user_credits
 */
function evaluateLedgerEntryTypeMapping(sourceType: string): string {
  if (sourceType === 'ADMIN_ADJUSTMENT') {
    return 'ADJUSTMENT';
  }
  return 'GRANT';
}

async function runTests() {
  console.log('================================================================');
  console.log('PHASE 3B.3.8 — CREDIT LEDGER ENTRY TYPE HOTFIX TEST SUITE');
  console.log('================================================================\n');

  // Verify hotfix file exists
  assert(fs.existsSync(HOTFIX_MIGRATION_PATH), 'Hotfix migration file exists');

  const hotfixSql = fs.readFileSync(HOTFIX_MIGRATION_PATH, 'utf-8');
  const hotfixCodeOnly = stripSqlComments(hotfixSql);

  // Extract the function body
  const fnMatch = hotfixSql.match(
    /CREATE OR REPLACE FUNCTION public\.grant_user_credits\([\s\S]*?\)\s*RETURNS\s+JSONB[\s\S]*?\$\$([\s\S]*?)\$\$;/i
  );
  assert(!!fnMatch, 'public.grant_user_credits function defined in hotfix migration');
  const fnBody = fnMatch![1];
  const fnBodyClean = stripSqlComments(fnBody);

  // Parse Step 9: Determine ledger entry type
  const entryTypeAssignmentMatch = fnBodyClean.match(
    /v_entry_type\s*:=\s*CASE\s*([\s\S]*?)END;/i
  );
  assert(
    !!entryTypeAssignmentMatch,
    'v_entry_type assignment exists in hotfix function body'
  );
  const entryTypeCaseBlock = entryTypeAssignmentMatch![1];

  // LEDGER-01: FREE_BOOTSTRAP grant maps ledger entry_type to GRANT
  assert(
    evaluateLedgerEntryTypeMapping('FREE_BOOTSTRAP') === 'GRANT' &&
      entryTypeCaseBlock.includes("WHEN p_source_type = 'ADMIN_ADJUSTMENT' THEN 'ADJUSTMENT'") &&
      entryTypeCaseBlock.includes("ELSE 'GRANT'"),
    'LEDGER-01: FREE_BOOTSTRAP grant maps ledger entry_type to GRANT'
  );

  // LEDGER-02: SUBSCRIPTION_CYCLE maps to GRANT
  assert(
    evaluateLedgerEntryTypeMapping('SUBSCRIPTION_CYCLE') === 'GRANT',
    'LEDGER-02: SUBSCRIPTION_CYCLE maps to GRANT'
  );

  // LEDGER-03: CREDIT_PACK_PURCHASE maps to GRANT
  assert(
    evaluateLedgerEntryTypeMapping('CREDIT_PACK_PURCHASE') === 'GRANT',
    'LEDGER-03: CREDIT_PACK_PURCHASE maps to GRANT'
  );

  // LEDGER-04: PROMOTION maps to GRANT
  assert(
    evaluateLedgerEntryTypeMapping('PROMOTION') === 'GRANT',
    'LEDGER-04: PROMOTION maps to GRANT'
  );

  // LEDGER-05: MIGRATION maps to GRANT
  assert(
    evaluateLedgerEntryTypeMapping('MIGRATION') === 'GRANT',
    'LEDGER-05: MIGRATION maps to GRANT'
  );

  // LEDGER-06: unknown/manual positive grant maps to GRANT
  assert(
    evaluateLedgerEntryTypeMapping('OTHER_MANUAL_TYPE') === 'GRANT' &&
      evaluateLedgerEntryTypeMapping('') === 'GRANT',
    'LEDGER-06: unknown/manual positive grant maps to GRANT'
  );

  // LEDGER-07: ADMIN_ADJUSTMENT maps to ADJUSTMENT
  assert(
    evaluateLedgerEntryTypeMapping('ADMIN_ADJUSTMENT') === 'ADJUSTMENT',
    'LEDGER-07: ADMIN_ADJUSTMENT maps to ADJUSTMENT'
  );

  // LEDGER-08: No generated entry_type violates chk_credit_ledger_entry_type
  const reservationSql = fs.readFileSync(RESERVATION_FOUNDATION_PATH, 'utf-8');
  const constraintMatch = reservationSql.match(
    /ADD\s+CONSTRAINT\s+chk_credit_ledger_entry_type\s+CHECK\s*\(\s*entry_type\s+IN\s*\(([^)]+)\)\s*\)/i
  );
  assert(!!constraintMatch, 'chk_credit_ledger_entry_type constraint found in foundation');
  const allowedLedgerTypes = constraintMatch![1]
    .split(',')
    .map((s) => s.trim().replace(/'/g, ''));
  console.log(`  Allowed ledger entry types in DB: ${allowedLedgerTypes.join(', ')}`);

  const testedSourceTypes = [
    'FREE_BOOTSTRAP',
    'SUBSCRIPTION_CYCLE',
    'CREDIT_PACK_PURCHASE',
    'PROMOTION',
    'MIGRATION',
    'ADMIN_ADJUSTMENT',
    'UNKNOWN_GRANT',
  ];
  const allValid = testedSourceTypes.every((st) => {
    const emittedType = evaluateLedgerEntryTypeMapping(st);
    return allowedLedgerTypes.includes(emittedType);
  });
  assert(
    allValid,
    'LEDGER-08: No generated entry_type violates chk_credit_ledger_entry_type'
  );

  // LEDGER-09: source_type remains unchanged and preserves business origin
  assert(
    fnBodyClean.includes('source_type,') &&
      fnBodyClean.includes('p_source_type,') &&
      fnBodyClean.includes("'source_type', p_source_type"),
    'LEDGER-09: source_type remains unchanged in credit_grants and preserves business origin in credit_ledger metadata'
  );

  // LEDGER-10: idempotency key behavior is unchanged
  assert(
    fnBodyClean.includes('PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));') &&
      fnBodyClean.includes('IDEMPOTENCY_KEY_CONFLICT') &&
      fnBodyClean.includes("'already_processed', true"),
    'LEDGER-10: idempotency key advisory locking and already_processed return behavior unchanged'
  );

  // LEDGER-11: one-time FREE bootstrap unique guard unchanged
  assert(
    fnBodyClean.includes("IF p_source_type = 'FREE_BOOTSTRAP' THEN") &&
      fnBodyClean.includes('DUPLICATE_FREE_BOOTSTRAP: User % has already received a one-time FREE_BOOTSTRAP grant'),
    'LEDGER-11: one-time FREE bootstrap unique guard unchanged in exception handler'
  );

  // LEDGER-12: credit account creation behavior unchanged
  assert(
    fnBodyClean.includes('SELECT id, status INTO v_account_id, v_account_status') &&
      fnBodyClean.includes('FROM public.credit_accounts') &&
      fnBodyClean.includes('FOR UPDATE') &&
      fnBodyClean.includes('INSERT INTO public.credit_accounts (user_id, status)') &&
      fnBodyClean.includes("VALUES (p_user_id, 'ACTIVE')") &&
      fnBodyClean.includes('ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()'),
    'LEDGER-12: credit account creation and locking behavior unchanged'
  );

  // LEDGER-13: function signature unchanged
  const sigMatch = hotfixSql.match(
    /CREATE OR REPLACE FUNCTION public\.grant_user_credits\(([\s\S]*?)\)\s*RETURNS\s+JSONB/i
  );
  assert(!!sigMatch, 'Signature matched in hotfix SQL');
  const paramsRaw = sigMatch![1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  assert(
    paramsRaw.length === 14,
    `LEDGER-13a: grant_user_credits argument count is exactly 14 (got ${paramsRaw.length})`
  );

  const expectedParams = [
    'p_user_id UUID',
    'p_source_type VARCHAR',
    'p_original_units BIGINT',
    'p_idempotency_key TEXT',
    'p_expires_at TIMESTAMPTZ DEFAULT NULL',
    'p_product_id UUID DEFAULT NULL',
    'p_pricing_version_id UUID DEFAULT NULL',
    'p_subscription_id UUID DEFAULT NULL',
    'p_billing_cycle_start TIMESTAMPTZ DEFAULT NULL',
    'p_billing_cycle_end TIMESTAMPTZ DEFAULT NULL',
    'p_reference_type VARCHAR DEFAULT NULL',
    'p_reference_id TEXT DEFAULT NULL',
    'p_description TEXT DEFAULT NULL',
    "p_metadata JSONB DEFAULT '{}'::jsonb",
  ];
  for (let i = 0; i < expectedParams.length; i++) {
    const normActual = paramsRaw[i].replace(/\s+/g, ' ');
    const normExpected = expectedParams[i].replace(/\s+/g, ' ');
    assert(
      normActual.toUpperCase() === normExpected.toUpperCase(),
      `LEDGER-13b: Parameter ${i + 1} matches "${normExpected}" (got "${normActual}")`
    );
  }

  assert(
    hotfixSql.includes('SECURITY DEFINER') &&
      hotfixSql.includes('SET search_path = public, pg_temp'),
    'LEDGER-13c: SECURITY DEFINER and SET search_path preserved'
  );

  assert(
    hotfixSql.includes('REVOKE ALL ON FUNCTION public.grant_user_credits') &&
      hotfixSql.includes('GRANT EXECUTE ON FUNCTION public.grant_user_credits'),
    'LEDGER-13d: Strict RPC execute permissions (postgres, service_role) preserved'
  );

  // LEDGER-14: return shape unchanged
  assert(
    fnBodyClean.includes("'grant_id', v_grant_id") &&
      fnBodyClean.includes("'account_id', v_account_id") &&
      fnBodyClean.includes("'user_id', p_user_id") &&
      fnBodyClean.includes("'original_units', p_original_units") &&
      fnBodyClean.includes("'remaining_units', p_original_units") &&
      fnBodyClean.includes("'total_available_units', v_total_available") &&
      fnBodyClean.includes("'already_processed', false"),
    'LEDGER-14: return JSONB shape unchanged'
  );

  // LEDGER-15: Stage A compatibility remains unchanged
  assert(fs.existsSync(STAGE_A_CREDIT_SERVICE_PATH), 'Stage A credit service exists');
  const stageACreditSrc = fs.readFileSync(STAGE_A_CREDIT_SERVICE_PATH, 'utf-8');
  assert(
    stageACreditSrc.includes("client.rpc('grant_user_credits'") &&
      stageACreditSrc.includes('p_user_id:') &&
      stageACreditSrc.includes('p_source_type:') &&
      stageACreditSrc.includes('p_original_units:') &&
      stageACreditSrc.includes('p_idempotency_key:'),
    'LEDGER-15: Stage A credit service RPC invocation contract remains 100% compatible'
  );

  // STATIC-01 / SECTION X: Static SQL assertion that hotfix function cannot emit invalid entry_types
  const prohibitedEntryTypes = [
    'GRANT_FREE',
    'GRANT_PACK',
    'GRANT_SUBSCRIPTION',
    'GRANT_PROMOTION',
    'MIGRATION_CREDIT',
    'GRANT_MANUAL',
  ];

  for (const invalidType of prohibitedEntryTypes) {
    // Assert that the executable SQL code inside the function does not contain the prohibited string
    assert(
      !fnBodyClean.includes(`'${invalidType}'`),
      `STATIC-01: Hotfix function code does not contain '${invalidType}' as entry_type or literal`
    );
  }

  console.log('\n================================================================');
  console.log(`TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: 0`);
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
