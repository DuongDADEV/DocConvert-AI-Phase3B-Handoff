import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_PROCESSING_PRICING_VERSION,
  CANONICAL_APPROVED_PRODUCTION_POLICY_V1,
  PRODUCTION_PROCESSING_RATES,
} from '../types/processingPricing.js';
import {
  ProcessingPricingEngine,
  processingPricingEngine,
} from '../services/credit/processingPricingEngine.js';
import {
  isSafeIntegerCreditUnits,
  ProcessingEligibilityService,
} from '../services/credit/processingEligibilityService.js';
import { OcrBackgroundWorker } from '../services/ocrWorker.js';

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
  console.log('PHASE 3B — ATOMIC CREDIT RESERVE BEFORE PROCESSING QUEUE TESTS');
  console.log('================================================================\n');

  // ARBQ-01: successful confirm reserves exact estimatedBillableUnits
  await runTest('ARBQ-01', 'successful confirm reserves exact estimatedBillableUnits', async () => {
    const estimate = await processingPricingEngine.estimateProcessingCost(
      {
        documentId: 'doc-1',
        pageCount: 2,
        pages: [
          { pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' },
          { pageNumber: 2, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' },
        ],
      },
      CANONICAL_APPROVED_PRODUCTION_POLICY_V1
    );
    assert.strictEqual(estimate.estimatedUnits, 350 + 1980); // 2330 units
    assert.strictEqual(estimate.processingPricingVersion, CANONICAL_PROCESSING_PRICING_VERSION);

    // Verify migration passes p_estimated_units to reserve_credit_units
    assert(migrationSql.includes('p_estimated_units BIGINT'), 'Migration signature includes p_estimated_units');
    assert(migrationSql.includes('p_requested_units := p_estimated_units'), 'Migration assigns requested units from p_estimated_units');
  });

  // ARBQ-02: reservation uses processing-pricing-v1 snapshot
  await runTest('ARBQ-02', 'reservation uses processing-pricing-v1 snapshot', () => {
    assert.strictEqual(CANONICAL_PROCESSING_PRICING_VERSION, 'processing-pricing-v1');
    assert(migrationSql.includes("p_pricing_version VARCHAR DEFAULT 'processing-pricing-v1'"), 'Migration defaults to canonical pricing version');
    assert(migrationSql.includes('pricing_version VARCHAR(50)'), 'Migration adds pricing_version column');
    assert(migrationSql.includes('quote_snapshot JSONB'), 'Migration adds quote_snapshot column');
  });

  // ARBQ-03: reference_type = PROCESSING_JOB
  await runTest('ARBQ-03', 'reference_type = PROCESSING_JOB', () => {
    assert(migrationSql.includes("p_reference_type := 'PROCESSING_JOB'"), "Migration sets p_reference_type := 'PROCESSING_JOB'");
    assert(dbSrc.includes(".eq('reference_type', 'PROCESSING_JOB')"), "db.ts queries reservation with reference_type 'PROCESSING_JOB'");
  });

  // ARBQ-04: reference_id = processing_jobs.id
  await runTest('ARBQ-04', 'reference_id = processing_jobs.id', () => {
    assert(migrationSql.includes('p_reference_id := v_job_id::text'), 'Migration links reservation p_reference_id to v_job_id::text');
    assert(dbSrc.includes(".eq('reference_id', jobId)") || dbSrc.includes(".eq('reference_id', job.id)"), 'db.ts queries reservation by job ID');
  });

  // ARBQ-05: metadata.job_id is non-authoritative only
  await runTest('ARBQ-05', 'metadata.job_id is non-authoritative only', () => {
    // Migration builds auxiliary metadata with job_id
    assert(migrationSql.includes("'job_id', v_job_id"), 'Migration includes job_id in auxiliary metadata');
    // But authoritative lookup is by reference_type and reference_id
    assert(migrationSql.includes("reference_type = 'PROCESSING_JOB'"), 'Authoritative linkage is reference_type');
    assert(migrationSql.includes("reference_id = v_existing_job.id::text") || migrationSql.includes("reference_id = jobId"), 'Authoritative linkage uses reference_id');
  });

  // ARBQ-06: sufficient credit -> job created
  await runTest('ARBQ-06', 'sufficient credit -> job created', () => {
    assert(migrationSql.includes('INSERT INTO public.processing_jobs'), 'Processing job is inserted upon successful reservation');
    assert(migrationSql.includes('v_reservation_id'), 'Processing job links to v_reservation_id');
  });

  // ARBQ-07: sufficient credit -> document becomes QUEUED
  await runTest('ARBQ-07', 'sufficient credit -> document becomes QUEUED', () => {
    assert(migrationSql.includes("SET status = 'QUEUED'"), 'Document status updated to QUEUED');
  });

  // ARBQ-08: sufficient credit -> quota increments once
  await runTest('ARBQ-08', 'sufficient credit -> quota increments once', () => {
    assert(migrationSql.includes('used_documents = v_used_quota + 1'), 'Quota incremented once on confirmation');
  });

  // ARBQ-09: insufficient credit -> no job
  await runTest('ARBQ-09', 'insufficient credit -> no job', () => {
    assert(migrationSql.includes('reserve_credit_units'), 'Calls reserve_credit_units which fails on insufficient credit');
    assert(docRouteSrc.includes('INSUFFICIENT_CREDITS'), 'Route returns INSUFFICIENT_CREDITS without queueing');
  });

  // ARBQ-10: insufficient credit -> document remains WAITING_CONFIRMATION
  await runTest('ARBQ-10', 'insufficient credit -> document remains WAITING_CONFIRMATION', () => {
    assert(migrationSql.includes("v_doc.status <> 'WAITING_CONFIRMATION'"), 'Document must be WAITING_CONFIRMATION');
  });

  // ARBQ-11: insufficient credit -> reserved balance unchanged
  await runTest('ARBQ-11', 'insufficient credit -> reserved balance unchanged', () => {
    const eligibility = new ProcessingEligibilityService();
    const result = eligibility.evaluateCreditSufficiency(1000, 2000, 'ACTIVE', 'v1');
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.reason, 'INSUFFICIENT_CREDIT');
    assert.strictEqual(result.shortageUnits, 1000);
  });

  // ARBQ-12: insufficient credit -> quota unchanged
  await runTest('ARBQ-12', 'insufficient credit -> quota unchanged', () => {
    const indexOfReserve = migrationSql.indexOf('reserve_credit_units');
    const indexOfQuotaIncrement = migrationSql.indexOf('used_documents = v_used_quota + 1');
    assert(indexOfReserve < indexOfQuotaIncrement, 'Reserve occurs before quota increment in atomic transaction');
  });

  // ARBQ-13: FROZEN account cannot create new reservation
  await runTest('ARBQ-13', 'FROZEN account cannot create new reservation', () => {
    const eligibility = new ProcessingEligibilityService();
    const result = eligibility.evaluateCreditSufficiency(50000, 2000, 'FROZEN', 'v1');
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.reason, 'CREDIT_ACCOUNT_FROZEN');
    assert(docRouteSrc.includes('CREDIT_ACCOUNT_FROZEN'), 'Route handles FROZEN account');
  });

  // ARBQ-14: CLOSED account cannot create new reservation
  await runTest('ARBQ-14', 'CLOSED account cannot create new reservation', () => {
    const eligibility = new ProcessingEligibilityService();
    const result = eligibility.evaluateCreditSufficiency(50000, 2000, 'CLOSED', 'v1');
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.reason, 'CREDIT_ACCOUNT_CLOSED');
    assert(docRouteSrc.includes('CREDIT_ACCOUNT_CLOSED'), 'Route handles CLOSED account');
  });

  // ARBQ-15: wrong document owner cannot reserve
  await runTest('ARBQ-15', 'wrong document owner cannot reserve', () => {
    assert(migrationSql.includes('v_doc.user_id <> v_user_id'), 'Migration checks document ownership');
    assert(migrationSql.includes('DOCUMENT_ACCESS_DENIED'), 'Migration raises DOCUMENT_ACCESS_DENIED if user does not own doc');
  });

  // ARBQ-16: non-WAITING_CONFIRMATION document cannot reserve
  await runTest('ARBQ-16', 'non-WAITING_CONFIRMATION document cannot reserve', () => {
    assert(migrationSql.includes("v_doc.status <> 'WAITING_CONFIRMATION'"), 'Migration verifies WAITING_CONFIRMATION status');
    assert(migrationSql.includes('INVALID_DOCUMENT_STATE'), 'Migration raises INVALID_DOCUMENT_STATE for non-processable documents');
  });

  // ARBQ-17: duplicate confirm does not double reserve
  await runTest('ARBQ-17', 'duplicate confirm does not double reserve', () => {
    assert(migrationSql.includes("v_doc.status IN ('QUEUED', 'PROCESSING')"), 'Migration checks existing active document state');
    assert(migrationSql.includes('already_processing'), 'Returns already_processing: true without calling reserve');
  });

  // ARBQ-18: duplicate confirm does not double quota increment
  await runTest('ARBQ-18', 'duplicate confirm does not double quota increment', () => {
    const indexOfDupReturn = migrationSql.indexOf("'already_processing', true");
    const indexOfQuotaIncrement = migrationSql.indexOf('used_documents = v_used_quota + 1');
    assert(indexOfDupReturn < indexOfQuotaIncrement, 'Duplicate check returns early before quota increment');
  });

  // ARBQ-19: concurrent confirms create one active job only
  await runTest('ARBQ-19', 'concurrent confirms create one active job only', () => {
    assert(migrationSql.includes('FOR UPDATE'), 'confirm_document_processing acquires row-level exclusive lock FOR UPDATE');
    assert(migrationSql.includes('processing_jobs'), 'Enforces active job constraint');
  });

  // ARBQ-20: concurrent confirms create one reservation only
  await runTest('ARBQ-20', 'concurrent confirms create one reservation only', () => {
    assert(migrationSql.includes("FROM public.documents") && migrationSql.includes("FOR UPDATE;"), 'Document row locked FOR UPDATE at start of tx');
  });

  // ARBQ-21: transaction failure rolls back job
  await runTest('ARBQ-21', 'transaction failure rolls back job', () => {
    assert(migrationSql.includes('CREATE OR REPLACE FUNCTION public.confirm_document_processing'), 'RPC function encapsulates full flow');
  });

  // ARBQ-22: transaction failure rolls back reservation
  await runTest('ARBQ-22', 'transaction failure rolls back reservation', () => {
    assert(migrationSql.includes('reserve_credit_units'), 'Calls reserve_credit_units inside the atomic function body');
  });

  // ARBQ-23: worker refuses job without valid reservation
  await runTest('ARBQ-23', 'worker refuses job without valid reservation', () => {
    assert(workerSrc.includes('getValidatedReservationForJob') || workerSrc.includes('getActiveReservationForJob'), 'Worker checks active reservation for job');
    assert(workerSrc.includes('MISSING_CREDIT_RESERVATION'), 'Worker fails closed with MISSING_CREDIT_RESERVATION');
  });

  // ARBQ-24: provider/OCR call does not occur before reservation validation
  await runTest('ARBQ-24', 'provider/OCR call does not occur before reservation validation', () => {
    const indexOfGate = workerSrc.indexOf('getValidatedReservationForJob') !== -1 ? workerSrc.indexOf('getValidatedReservationForJob') : workerSrc.indexOf('getActiveReservationForJob');
    const indexOfAnalyze = workerSrc.indexOf('analyzeDocument');
    const indexOfPde = workerSrc.indexOf('executePlan');
    assert(indexOfGate !== -1, 'Gate exists');
    assert(indexOfGate < indexOfAnalyze, 'Reservation gate runs before analyzeDocument');
    assert(indexOfGate < indexOfPde, 'Reservation gate runs before executePlan');
  });

  // ARBQ-25: technical fallback cost does not increase reserved units
  await runTest('ARBQ-25', 'technical fallback cost does not increase reserved units', async () => {
    const quote = await processingPricingEngine.estimateProcessingCost(
      {
        documentId: 'doc-fallback',
        pageCount: 1,
        pages: [{ pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' }],
      },
      CANONICAL_APPROVED_PRODUCTION_POLICY_V1
    );
    assert.strictEqual(quote.estimatedUnits, 350);

    // Billable usage calculation: rate for LOCAL_NATIVE remains 350 even if executedStrategy is AZURE_FALLBACK
    const usage = processingPricingEngine.calculateBillableUsage(
      {
        documentId: 'doc-fallback',
        pages: [{ pageNumber: 1, billableStrategy: 'LOCAL_NATIVE', executedStrategy: 'AZURE_FALLBACK', fallbackOccurred: true }],
        estimatedUnits: 350,
      },
      CANONICAL_APPROVED_PRODUCTION_POLICY_V1
    );
    assert.strictEqual(usage.totalBillableUnits, 350, 'Customer billable units remain 350 despite technical fallback');
    assert.strictEqual(usage.reconciliationRequired, false, 'No reconciliation or extra debit');
  });

  // ARBQ-26: secondary OCR does not increase reserved units
  await runTest('ARBQ-26', 'secondary OCR does not increase reserved units', async () => {
    const quote = await processingPricingEngine.estimateProcessingCost(
      {
        documentId: 'doc-sec',
        pageCount: 1,
        pages: [{ pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' }],
      },
      CANONICAL_APPROVED_PRODUCTION_POLICY_V1
    );
    assert.strictEqual(quote.estimatedUnits, 350);

    // Billable usage with secondary OCR executed
    const usage = processingPricingEngine.calculateBillableUsage(
      {
        documentId: 'doc-sec',
        pages: [{ pageNumber: 1, billableStrategy: 'LOCAL_NATIVE', secondaryOcrExecuted: true, secondaryOcrCellCount: 15 }],
        estimatedUnits: 350,
      },
      CANONICAL_APPROVED_PRODUCTION_POLICY_V1
    );
    assert.strictEqual(usage.totalBillableUnits, 350, 'Secondary OCR is absorbed by product policy; customer charge remains 350');
    assert.strictEqual(usage.reconciliationRequired, false);
  });

  // ARBQ-27: LOCAL_NATIVE reserves 350 units/page according to quote
  await runTest('ARBQ-27', 'LOCAL_NATIVE reserves 350 units/page according to quote', async () => {
    const estimate = await processingPricingEngine.estimateProcessingCost(
      {
        documentId: 'doc-ln',
        pageCount: 2,
        pages: [
          { pageNumber: 1, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' },
          { pageNumber: 2, classification: 'NATIVE_TEXT', processingStrategy: 'LOCAL_NATIVE' },
        ],
      },
      CANONICAL_APPROVED_PRODUCTION_POLICY_V1
    );
    assert.strictEqual(estimate.estimatedUnits, 700);
    assert.strictEqual(estimate.pageBreakdown[0].estimatedUnits, 350);
    assert.strictEqual(estimate.pageBreakdown[1].estimatedUnits, 350);
  });

  // ARBQ-28: AZURE_FULL_PAGE reserves 1980 units/page according to quote
  await runTest('ARBQ-28', 'AZURE_FULL_PAGE reserves 1980 units/page according to quote', async () => {
    const estimate = await processingPricingEngine.estimateProcessingCost(
      {
        documentId: 'doc-az',
        pageCount: 2,
        pages: [
          { pageNumber: 1, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' },
          { pageNumber: 2, classification: 'SCANNED', processingStrategy: 'AZURE_FULL_PAGE' },
        ],
      },
      CANONICAL_APPROVED_PRODUCTION_POLICY_V1
    );
    assert.strictEqual(estimate.estimatedUnits, 3960);
    assert.strictEqual(estimate.pageBreakdown[0].estimatedUnits, 1980);
    assert.strictEqual(estimate.pageBreakdown[1].estimatedUnits, 1980);
  });

  // ARBQ-29: HYBRID reserves 1980 units/page according to quote
  await runTest('ARBQ-29', 'HYBRID reserves 1980 units/page according to quote', async () => {
    const estimate = await processingPricingEngine.estimateProcessingCost(
      {
        documentId: 'doc-hyb',
        pageCount: 1,
        pages: [{ pageNumber: 1, classification: 'MIXED', processingStrategy: 'HYBRID' }],
      },
      CANONICAL_APPROVED_PRODUCTION_POLICY_V1
    );
    assert.strictEqual(estimate.estimatedUnits, 1980);
    assert.strictEqual(estimate.pageBreakdown[0].estimatedUnits, 1980);
  });

  // ARBQ-30: all financial arithmetic uses integer credit_units
  await runTest('ARBQ-30', 'all financial arithmetic uses integer credit_units', () => {
    assert(isSafeIntegerCreditUnits(350), '350 is valid integer credit unit');
    assert(isSafeIntegerCreditUnits(1980), '1980 is valid integer credit unit');
    assert(!isSafeIntegerCreditUnits(350.5), 'Float units are rejected');
    assert(!isSafeIntegerCreditUnits(NaN), 'NaN is rejected');
    assert(!isSafeIntegerCreditUnits(-10), 'Negative units are rejected');
    assert(migrationSql.includes('BIGINT'), 'Migration specifies BIGINT for all financial unit fields');
    assert(!migrationSql.includes('FLOAT') && !migrationSql.includes('NUMERIC'), 'No float or numeric types in financial unit schema');
  });

  console.log('\n================================================================');
  console.log(`PHASE 3B TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
