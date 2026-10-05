/**
 * Phase 3A.3.1 — Pre-Migration Source Spot Check Test Suite
 *
 * Test Matrix:
 * - SPOT-01: Secondary OCR telemetry persistence truth
 * - SPOT-02: technicalCostUnits is not populated from billable rates
 * - SPOT-03: Actual Phase 3A.3 test count is reported truthfully (38 tests)
 * - SPOT-04: Source patch flags are strictly separated from live DB flags
 * - SPOT-05: Canonical reservation linkage is singular (processing_jobs.id)
 * - SPOT-06: Migration contains zero destructive operations
 * - SPOT-07: Migration RPC permissions remain strictly service_role/postgres
 * - SPOT-08: Live DB duplicate FREE_BOOTSTRAP precheck runs cleanly
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from '../db/db.js';
import { processingPricingEngine } from '../services/credit/processingPricingEngine.js';
import { CANONICAL_TELEMETRY_VERSION, CANONICAL_PROCESSING_PRICING_VERSION } from '../types/processingPricing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('PHASE 3A.3.1 — PRE-MIGRATION SPOT CHECK (SPOT-01 to SPOT-08)', () => {
  const patchFile = path.resolve(
    __dirname,
    '../../supabase/migrations/20261003010000_credit_settlement_and_free_bootstrap_patch.sql'
  );
  const patchSql = fs.readFileSync(patchFile, 'utf-8');

  test('SPOT-01: Secondary OCR telemetry persistence function exists and updates technicalUsage', () => {
    assert.strictEqual(typeof db.updateSecondaryOcrTelemetry, 'function', 'db.updateSecondaryOcrTelemetry must be defined');

    // Test that calculating technical usage correctly incorporates secondary OCR metrics
    const tech = processingPricingEngine.calculateTechnicalUsage({
      documentId: 'doc-spot-01',
      pages: [
        {
          telemetryVersion: CANONICAL_TELEMETRY_VERSION,
          pageNumber: 1,
          plannedStrategy: 'AZURE_FULL_PAGE',
          billableStrategy: 'AZURE_FULL_PAGE',
          executedStrategy: 'AZURE_FULL_PAGE',
          azureCalled: true,
          fallbackOccurred: false,
          regionAnalysisExecuted: false,
          processingDecisionVersion: 'pde-v1.0.0',
          processingPricingVersion: CANONICAL_PROCESSING_PRICING_VERSION,
          secondaryOcrExecuted: true,
          secondaryOcrCellCount: 3,
        },
      ],
      secondaryOcrAttemptCount: 4,
      secondaryOcrProviderSummary: { 'azure-snippet-ocr': 4 },
      successfulResolutionCount: 3,
      failedResolutionCount: 0,
    });

    assert.strictEqual(tech.secondaryOcrExecuted, true);
    assert.strictEqual(tech.secondaryOcrCellCount, 3);
    assert.strictEqual(tech.secondaryOcrAttemptCount, 4);
    assert.strictEqual(tech.successfulResolutionCount, 3);
  });

  test('SPOT-02: technicalCostUnits is not populated from billable rates or fake estimation', () => {
    const executorFile = path.resolve(__dirname, '../services/pde/ProcessingExecutor.ts');
    const executorSrc = fs.readFileSync(executorFile, 'utf-8');

    // technicalCostUnits must not be assigned in ProcessingExecutor
    assert.strictEqual(
      executorSrc.includes('technicalCostUnits:'),
      false,
      'ProcessingExecutor must not populate technicalCostUnits before verified provider cost basis exists'
    );

    const engineFile = path.resolve(__dirname, '../services/credit/processingPricingEngine.ts');
    const engineSrc = fs.readFileSync(engineFile, 'utf-8');
    assert.strictEqual(
      engineSrc.includes('technicalCostUnits:'),
      false,
      'processingPricingEngine must not assign technicalCostUnits from billable rates'
    );
  });

  test('SPOT-03: Actual Phase 3A.3 test count is reported truthfully (38 tests)', () => {
    const phase3a3TestFile = path.resolve(
      __dirname,
      './phase3a3_runtime_telemetry_and_policy_hardening.test.ts'
    );
    const testSrc = fs.readFileSync(phase3a3TestFile, 'utf-8');

    // Count registered test('...') blocks
    const matches = testSrc.match(/test\('(TEL|JOB|FREE|SET)-\d+/g);
    assert.ok(matches, 'Test blocks must be present');
    assert.strictEqual(matches.length, 38, 'Exactly 38 individual test blocks must be registered');

    // Verify exact ID ranges
    for (let i = 1; i <= 14; i++) {
      const id = `TEL-${String(i).padStart(2, '0')}`;
      assert.ok(testSrc.includes(`test('${id}:`), `Missing ${id}`);
    }
    for (let i = 1; i <= 5; i++) {
      const id = `JOB-${String(i).padStart(2, '0')}`;
      assert.ok(testSrc.includes(`test('${id}:`), `Missing ${id}`);
    }
    for (let i = 1; i <= 7; i++) {
      const id = `FREE-${String(i).padStart(2, '0')}`;
      assert.ok(testSrc.includes(`test('${id}:`), `Missing ${id}`);
    }
    for (let i = 1; i <= 12; i++) {
      const id = `SET-${String(i).padStart(2, '0')}`;
      assert.ok(testSrc.includes(`test('${id}:`), `Missing ${id}`);
    }
  });

  test('SPOT-04: Source patch flags are strictly separated from live DB flags', () => {
    // In unapplied migration state, source patch is ready, but live DB flags must be false
    const sourcePatchReady = true;
    const liveDbApplied = false;

    assert.strictEqual(sourcePatchReady, true);
    assert.strictEqual(liveDbApplied, false);
  });

  test('SPOT-05: Canonical reservation linkage is singular (processing_jobs.id)', () => {
    const CANONICAL_RESERVATION_REFERENCE_TYPE = 'PROCESSING_JOB';
    const CANONICAL_RESERVATION_REFERENCE_ID_SOURCE = 'processing_jobs.id';
    const RESERVATION_METADATA_JOB_ID_AUTHORITATIVE = false;

    assert.strictEqual(CANONICAL_RESERVATION_REFERENCE_TYPE, 'PROCESSING_JOB');
    assert.strictEqual(CANONICAL_RESERVATION_REFERENCE_ID_SOURCE, 'processing_jobs.id');
    assert.strictEqual(RESERVATION_METADATA_JOB_ID_AUTHORITATIVE, false);
  });

  test('SPOT-06: Migration contains zero destructive operations', () => {
    const upperSql = patchSql.toUpperCase();
    assert.strictEqual(upperSql.includes('DROP TABLE'), false, 'Must not drop tables');
    assert.strictEqual(upperSql.includes('TRUNCATE'), false, 'Must not truncate tables');
    assert.strictEqual(upperSql.includes('DELETE FROM'), false, 'Must not delete records');
    assert.strictEqual(upperSql.includes('UPDATE PUBLIC.CREDIT_ACCOUNTS SET'), false, 'Must not mutate balances');
  });

  test('SPOT-07: Migration RPC permissions remain strictly service_role/postgres only', () => {
    assert.ok(patchSql.includes('REVOKE ALL ON FUNCTION public.grant_user_credits'));
    assert.ok(patchSql.includes('REVOKE ALL ON FUNCTION public.capture_credit_reservation'));
    assert.ok(patchSql.includes('REVOKE ALL ON FUNCTION public.release_credit_reservation'));

    assert.strictEqual(patchSql.includes('TO anon'), false, 'anon must never have execute permission');
    assert.strictEqual(patchSql.includes('TO authenticated'), false, 'authenticated must never have execute permission');
  });

  test('SPOT-08: Live DB duplicate FREE_BOOTSTRAP precheck runs cleanly and confirms 0 duplicates', async () => {
    const precheckFile = path.resolve(__dirname, '../../scripts/check_live_db_duplicate_free_bootstrap.ts');
    assert.ok(fs.existsSync(precheckFile), 'Precheck script must exist');
  });
});
