import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, ProcessingJobRecord } from '../db/db.js';
import {
  CANONICAL_PROCESSING_PRICING_VERSION,
  CANONICAL_APPROVED_PRODUCTION_POLICY_V1,
} from '../types/processingPricing.js';

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

const workerPath = path.resolve(__dirname, '../services/ocrWorker.ts');
const workerSrc = fs.readFileSync(workerPath, 'utf-8');

async function main() {
  console.log('================================================================');
  console.log('PHASE 3B.1 — PRE-MIGRATION SAFETY SPOT CHECK & HARDENING TESTS');
  console.log('================================================================\n');

  // SPOT-01: UPLOADED is rejected for new processing confirmation
  await runTest('SPOT-01', 'UPLOADED is rejected for new processing confirmation', () => {
    assert(!migrationSql.includes("status NOT IN ('WAITING_CONFIRMATION', 'UPLOADED')"), 'Migration must NOT accept UPLOADED status');
    assert(migrationSql.includes("v_doc.status <> 'WAITING_CONFIRMATION'"), 'Migration strictly enforces WAITING_CONFIRMATION only');
    assert(migrationSql.includes("INVALID_DOCUMENT_STATE"), 'Migration raises INVALID_DOCUMENT_STATE for non-WAITING_CONFIRMATION');
  });

  // SPOT-02: WAITING_CONFIRMATION is accepted
  await runTest('SPOT-02', 'WAITING_CONFIRMATION is accepted', () => {
    assert(migrationSql.includes("v_doc.status <> 'WAITING_CONFIRMATION'"), 'WAITING_CONFIRMATION is the single allowed state');
  });

  // SPOT-03: QUEUED returns existing job only
  await runTest('SPOT-03', 'QUEUED returns existing job only', () => {
    assert(migrationSql.includes("IF v_doc.status IN ('QUEUED', 'PROCESSING') THEN"), 'QUEUED activates idempotency check');
    assert(migrationSql.includes("'already_processing', true"), 'Returns already_processing: true without new reservation');
  });

  // SPOT-04: PROCESSING returns existing job only
  await runTest('SPOT-04', 'PROCESSING returns existing job only', () => {
    assert(migrationSql.includes("IF v_doc.status IN ('QUEUED', 'PROCESSING') THEN"), 'PROCESSING activates idempotency check');
    const indexOfIdempotentCheck = migrationSql.indexOf("IF v_doc.status IN ('QUEUED', 'PROCESSING') THEN");
    const indexOfReserve = migrationSql.indexOf("public.reserve_credit_units(");
    assert(indexOfIdempotentCheck !== -1 && indexOfReserve !== -1, 'Both statements exist');
    assert(indexOfIdempotentCheck < indexOfReserve, 'Idempotent return happens before reserve call');
  });

  // SPOT-05: legacy 3-arg overload cannot queue with zero units
  await runTest('SPOT-05', 'legacy 3-arg overload cannot queue with zero units', () => {
    assert(migrationSql.includes('PROCESSING_CONFIRM_SIGNATURE_DEPRECATED'), 'Legacy 3-arg overload hard-fails with PROCESSING_CONFIRM_SIGNATURE_DEPRECATED');
    assert(!migrationSql.includes("0::BIGINT"), 'Legacy 3-arg overload does not forward 0 units');
  });

  // SPOT-06: p_estimated_units = 0 fails closed
  await runTest('SPOT-06', 'p_estimated_units = 0 fails closed', () => {
    assert(migrationSql.includes('p_estimated_units <= 0'), 'Migration checks p_estimated_units <= 0');
    assert(migrationSql.includes('INVALID_PROCESSING_ESTIMATE'), 'Raises INVALID_PROCESSING_ESTIMATE on 0 units');
  });

  // SPOT-07: p_estimated_units < 0 fails closed
  await runTest('SPOT-07', 'p_estimated_units < 0 fails closed', () => {
    assert(migrationSql.includes('p_estimated_units <= 0'), 'Migration rejects negative units');
  });

  // SPOT-08: invalid pricing_version fails closed
  await runTest('SPOT-08', 'invalid pricing_version fails closed', () => {
    assert(migrationSql.includes("p_pricing_version <> 'processing-pricing-v1'"), 'Migration verifies exact canonical pricing version');
    assert(migrationSql.includes('INVALID_PROCESSING_PRICING_VERSION'), 'Raises INVALID_PROCESSING_PRICING_VERSION');
  });

  // SPOT-09: empty/invalid quote snapshot fails closed if required by canonical contract
  await runTest('SPOT-09', 'empty/invalid quote snapshot fails closed if required by canonical contract', () => {
    assert(migrationSql.includes("p_quote_snapshot = '{}'::jsonb"), 'Migration rejects empty quote snapshot');
    assert(migrationSql.includes("INVALID_QUOTE_SNAPSHOT"), 'Raises INVALID_QUOTE_SNAPSHOT');
  });

  // SPOT-10: client cannot override estimated units
  await runTest('SPOT-10', 'client cannot override estimated units', () => {
    assert(!docRouteSrc.includes('req.body?.estimatedUnits'), 'Route does not read estimatedUnits from request body');
    assert(!docRouteSrc.includes('req.body.estimatedUnits'), 'Route does not accept estimatedUnits from request body');
    assert(docRouteSrc.includes('eligibility.estimatedUnits'), 'Route derives estimatedUnits strictly from server-side eligibility');
  });

  // SPOT-11: client cannot override pricing version
  await runTest('SPOT-11', 'client cannot override pricing version', () => {
    assert(!docRouteSrc.includes('req.body?.pricingVersion'), 'Route does not read pricingVersion from request body');
    assert(!docRouteSrc.includes('req.body.pricingVersion'), 'Route does not accept pricingVersion from request body');
    assert(docRouteSrc.includes('eligibility.processingPricingVersion'), 'Route derives pricingVersion strictly from server-side eligibility');
  });

  // SPOT-12: worker validates reservation reference_type
  await runTest('SPOT-12', 'worker validates reservation reference_type', () => {
    assert(dbSrc.includes("reservation.reference_type !== 'PROCESSING_JOB'"), 'db.ts validates reference_type == PROCESSING_JOB');
  });

  // SPOT-13: worker validates reservation reference_id
  await runTest('SPOT-13', 'worker validates reservation reference_id', () => {
    assert(dbSrc.includes("reservation.reference_id !== job.id"), 'db.ts validates reference_id == job.id');
  });

  // SPOT-14: worker validates reservation.user_id = job.user_id
  await runTest('SPOT-14', 'worker validates reservation.user_id = job.user_id', () => {
    assert(dbSrc.includes("reservation.user_id !== job.user_id"), 'db.ts validates user_id matches job user_id');
  });

  // SPOT-15: worker validates job.reservation_id = reservation.id
  await runTest('SPOT-15', 'worker validates job.reservation_id = reservation.id', () => {
    assert(dbSrc.includes(".eq('id', job.reservation_id)"), 'db.ts queries reservation by job.reservation_id FK');
  });

  // SPOT-16: worker validates requested/reserved amount against job pinned estimate
  await runTest('SPOT-16', 'worker validates requested/reserved amount against job pinned estimate', () => {
    assert(dbSrc.includes("Number(reservation.requested_units) !== Number(job.estimated_billable_units)"), 'db.ts checks requested_units == estimated_billable_units');
  });

  // SPOT-17: released reservation cannot pass worker gate
  await runTest('SPOT-17', 'released reservation cannot pass worker gate', () => {
    assert(dbSrc.includes("reservation.status !== 'RESERVED' && reservation.status !== 'PARTIALLY_CAPTURED'"), 'db.ts rejects RELEASED reservations');
    assert(dbSrc.includes("heldUnits <= 0"), 'db.ts rejects reservations with no remaining held units');
  });

  // SPOT-18: captured/terminal reservation cannot pass initial worker gate
  await runTest('SPOT-18', 'captured/terminal reservation cannot pass initial worker gate', () => {
    assert(dbSrc.includes("RESERVATION_ALREADY_MUTATED_BEFORE_INITIAL_RUN"), 'db.ts rejects captured reservations before initial run');
  });

  // SPOT-19: historical processing job compatibility remains safe
  await runTest('SPOT-19', 'historical processing job compatibility remains safe', () => {
    assert(migrationSql.includes('pricing_version VARCHAR(50) NULL'), 'Migration creates nullable pricing_version column');
    assert(migrationSql.includes('estimated_billable_units BIGINT NULL'), 'Migration creates nullable estimated_billable_units column');
    assert(migrationSql.includes('reservation_id UUID NULL'), 'Migration creates nullable reservation_id column');
    assert(dbSrc.includes("HISTORICAL_JOB_NO_RESERVATION"), 'db.ts handles historical jobs cleanly');
  });

  // SPOT-20: RPC permissions remain service_role/postgres only
  await runTest('SPOT-20', 'RPC permissions remain service_role/postgres only', () => {
    assert(migrationSql.includes('REVOKE ALL ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR, BIGINT, VARCHAR, JSONB, TEXT, JSONB) FROM PUBLIC, anon, authenticated;'), 'Revokes 8-arg overload from public/anon/auth');
    assert(
      migrationSql.includes('GRANT EXECUTE ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR, BIGINT, VARCHAR, JSONB, TEXT, JSONB) TO service_role, postgres;') ||
      migrationSql.includes('GRANT EXECUTE ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR, BIGINT, VARCHAR, JSONB, TEXT, JSONB) TO service_role;'),
      'Grants 8-arg overload to service_role'
    );
    assert(migrationSql.includes('REVOKE ALL ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR) FROM PUBLIC, anon, authenticated;'), 'Revokes 3-arg overload from public/anon/auth');
    assert(
      migrationSql.includes('GRANT EXECUTE ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR) TO service_role, postgres;') ||
      migrationSql.includes('GRANT EXECUTE ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR) TO service_role;'),
      'Grants 3-arg overload to service_role'
    );
  });

  console.log('\n================================================================');
  console.log(`PHASE 3B.1 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
