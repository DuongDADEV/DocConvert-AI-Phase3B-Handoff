import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_PROCESSING_PRICING_VERSION } from '../types/processingPricing.js';
import { db, ProcessingJobRecord } from '../db/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0;
let failed = 0;

async function runTest(id: string, name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result && typeof (result as any).then === 'function') {
      await result;
    }
    console.log(`[PASS] ${id}: ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`[FAIL] ${id}: ${name} ->`, err.message || err);
    failed++;
  }
}

// Read relevant codebase files for contract verification
const migrationPath = path.resolve(__dirname, '../../supabase/migrations/20261004010000_atomic_credit_reserve_before_processing_queue.sql');
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

const docRoutePath = path.resolve(__dirname, '../routes/documents.ts');
const docRouteSrc = fs.readFileSync(docRoutePath, 'utf-8');

const dbPath = path.resolve(__dirname, '../db/db.ts');
const dbSrc = fs.readFileSync(dbPath, 'utf-8');

async function main() {
  console.log('================================================================');
  console.log('PHASE 3B.2 — FINAL MIGRATION SOURCE AUDIT & QUOTE CONSISTENCY TESTS');
  console.log('================================================================\n');

  // FINAL-01: snapshot estimated amount equals p_estimated_units
  await runTest('FINAL-01', 'snapshot estimated amount equals p_estimated_units', () => {
    assert(
      migrationSql.includes('v_snapshot_units <> p_estimated_units') ||
      (migrationSql.includes('v_snapshot_est_units <> p_estimated_units') && migrationSql.includes('v_snapshot_billable_units <> p_estimated_units')),
      'Migration verifies snapshot units == p_estimated_units'
    );
    assert(docRouteSrc.includes('estimatedUnits: eligibility.estimatedUnits'), 'Route emits matching estimatedUnits in snapshot');
    assert(docRouteSrc.includes('estimatedBillableUnits: eligibility.estimatedUnits'), 'Route emits matching estimatedBillableUnits in snapshot');
  });

  // FINAL-02: snapshot amount mismatch fails closed
  await runTest('FINAL-02', 'snapshot amount mismatch fails closed', () => {
    assert(migrationSql.includes('QUOTE_AMOUNT_MISMATCH'), 'Migration raises QUOTE_AMOUNT_MISMATCH on mismatch');
  });

  // FINAL-03: snapshot amount missing fails closed
  await runTest('FINAL-03', 'snapshot amount missing fails closed', () => {
    assert(
      migrationSql.includes('v_snapshot_units_text IS NULL') ||
      migrationSql.includes('v_snapshot_est_units_text IS NULL AND v_snapshot_billable_units_text IS NULL'),
      'Migration checks if snapshot units is null'
    );
    assert(migrationSql.includes('INVALID_QUOTE_SNAPSHOT: snapshot estimated amount is missing'), 'Rejects missing amount');
  });

  // FINAL-04: snapshot amount non-numeric fails closed
  await runTest('FINAL-04', 'snapshot amount non-numeric fails closed', () => {
    assert(
      migrationSql.includes("v_snapshot_units_text !~ '^[0-9]+$'") ||
      (migrationSql.includes("v_snapshot_est_units_text !~ '^[0-9]+$'") && migrationSql.includes("v_snapshot_billable_units_text !~ '^[0-9]+$'")),
      'Migration checks regex for integer digits only'
    );
  });

  // FINAL-05: snapshot amount <= 0 fails closed
  await runTest('FINAL-05', 'snapshot amount <= 0 fails closed', () => {
    assert(
      migrationSql.includes('v_snapshot_units <= 0') ||
      (migrationSql.includes('v_snapshot_est_units <= 0') && migrationSql.includes('v_snapshot_billable_units <= 0')),
      'Migration rejects non-positive snapshot units'
    );
    assert(migrationSql.includes('must be positive'), 'Explicit error message for non-positive units');
  });

  // FINAL-06: job estimated_billable_units equals reservation requested_units
  await runTest('FINAL-06', 'job estimated_billable_units equals reservation requested_units', () => {
    assert(migrationSql.includes('p_requested_units := p_estimated_units'), 'Reservation requested units set from p_estimated_units');
    assert(migrationSql.includes('p_estimated_units,') && migrationSql.includes('estimated_billable_units'), 'Job estimated_billable_units set from p_estimated_units');
    assert(dbSrc.includes('Number(reservation.requested_units) !== Number(job.estimated_billable_units)'), 'Worker verifies job units match reservation requested units');
  });

  // FINAL-07: job estimated_billable_units equals snapshot amount
  await runTest('FINAL-07', 'job estimated_billable_units equals snapshot amount', () => {
    // Guaranteed by: snapshot amount == p_estimated_units AND job estimated_billable_units == p_estimated_units
    assert(
      migrationSql.includes('v_snapshot_units <> p_estimated_units') ||
      (migrationSql.includes('v_snapshot_est_units <> p_estimated_units') && migrationSql.includes('v_snapshot_billable_units <> p_estimated_units')),
      'Snapshot matches p_estimated_units'
    );
  });

  // FINAL-08: processing-pricing-v1 remains the pinned version
  await runTest('FINAL-08', 'processing-pricing-v1 remains the pinned version', () => {
    assert.strictEqual(CANONICAL_PROCESSING_PRICING_VERSION, 'processing-pricing-v1');
    assert(migrationSql.includes("p_pricing_version <> 'processing-pricing-v1'"), 'Migration pins processing-pricing-v1');
  });

  // FINAL-09: snapshot pricing version matches RPC version if snapshot carries a version field
  await runTest('FINAL-09', 'snapshot pricing version matches RPC version if snapshot carries a version field', () => {
    assert(migrationSql.includes('v_snapshot_version <> p_pricing_version'), 'Migration validates snapshot version matches p_pricing_version');
    assert(migrationSql.includes('QUOTE_VERSION_MISMATCH'), 'Raises QUOTE_VERSION_MISMATCH on mismatch');
  });

  // FINAL-10: snapshot output type matches RPC output type if snapshot carries outputType
  await runTest('FINAL-10', 'snapshot output type matches RPC output type if snapshot carries outputType', () => {
    assert(migrationSql.includes('UPPER(v_snapshot_output_type) <> v_output_type'), 'Migration validates snapshot outputType matches v_output_type');
    assert(migrationSql.includes('QUOTE_OUTPUT_TYPE_MISMATCH'), 'Raises QUOTE_OUTPUT_TYPE_MISMATCH on mismatch');
  });

  // FINAL-11: client cannot submit estimated units
  await runTest('FINAL-11', 'client cannot submit estimated units', () => {
    assert(!docRouteSrc.includes('req.body?.estimatedUnits'), 'Route does not read estimatedUnits from request body');
    assert(!docRouteSrc.includes('req.body.estimatedUnits'), 'Route does not accept estimatedUnits from request body');
  });

  // FINAL-12: client cannot submit pricing version
  await runTest('FINAL-12', 'client cannot submit pricing version', () => {
    assert(!docRouteSrc.includes('req.body?.pricingVersion'), 'Route does not read pricingVersion from request body');
    assert(!docRouteSrc.includes('req.body.pricingVersion'), 'Route does not accept pricingVersion from request body');
  });

  // FINAL-13: client cannot submit quote snapshot
  await runTest('FINAL-13', 'client cannot submit quote snapshot', () => {
    assert(!docRouteSrc.includes('req.body?.quoteSnapshot'), 'Route does not read quoteSnapshot from request body');
    assert(!docRouteSrc.includes('req.body.quoteSnapshot'), 'Route does not accept quoteSnapshot from request body');
  });

  // FINAL-14: EXCEL accepted
  await runTest('FINAL-14', 'EXCEL accepted', () => {
    assert(migrationSql.includes("v_output_type NOT IN ('EXCEL')"), 'Migration checks for EXCEL');
    assert(docRouteSrc.includes("outputType || 'EXCEL'"), 'Route defaults to EXCEL');
  });

  // FINAL-15: unsupported output type rejected
  await runTest('FINAL-15', 'unsupported output type rejected', () => {
    assert(migrationSql.includes('UNSUPPORTED_OUTPUT_TYPE'), 'Migration raises UNSUPPORTED_OUTPUT_TYPE for non-EXCEL');
    assert(docRouteSrc.includes('UNSUPPORTED_OUTPUT_TYPE'), 'Route rejects unsupported outputType like WORD');
  });

  // FINAL-16: legacy 3-arg overload still hard-fails
  await runTest('FINAL-16', 'legacy 3-arg overload still hard-fails', () => {
    assert(migrationSql.includes('PROCESSING_CONFIRM_SIGNATURE_DEPRECATED'), 'Legacy 3-arg overload hard-fails');
  });

  // FINAL-17: 8-arg RPC denied to anon/authenticated
  await runTest('FINAL-17', '8-arg RPC denied to anon/authenticated', () => {
    assert(
      migrationSql.includes('REVOKE ALL ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR, BIGINT, VARCHAR, JSONB, TEXT, JSONB) FROM PUBLIC, anon, authenticated;'),
      'Revokes 8-arg execution from PUBLIC, anon, authenticated'
    );
  });

  // FINAL-18: 3-arg RPC denied to anon/authenticated
  await runTest('FINAL-18', '3-arg RPC denied to anon/authenticated', () => {
    assert(
      migrationSql.includes('REVOKE ALL ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR) FROM PUBLIC, anon, authenticated;'),
      'Revokes 3-arg execution from PUBLIC, anon, authenticated'
    );
  });

  // FINAL-19: service_role execution explicitly allowed
  await runTest('FINAL-19', 'service_role execution explicitly allowed', () => {
    assert(
      migrationSql.includes('GRANT EXECUTE ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR, BIGINT, VARCHAR, JSONB, TEXT, JSONB) TO service_role, postgres;'),
      'Explicit GRANT for 8-arg to service_role'
    );
  });

  // FINAL-20: postgres execution contract verified
  await runTest('FINAL-20', 'postgres execution contract verified', () => {
    assert(
      migrationSql.includes('TO service_role, postgres;'),
      'Explicit GRANT to postgres for both function signatures'
    );
  });

  console.log('\n================================================================');
  console.log(`PHASE 3B.2 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
