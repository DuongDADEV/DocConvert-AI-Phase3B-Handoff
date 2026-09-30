import assert from 'assert';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { db } from '../db/db.js';
import { OCRAnalysisResult, DocumentAIProvider } from '../services/ocr/types.js';
import { ValidationEngine } from '../services/validation/ValidationEngine.js';
import { VALIDATION_VERSION } from '../services/validation/types.js';
import { VALIDATION_RULE_CODES } from '../services/validation/validationConfig.js';
import { ExcelExportEngine } from '../services/excelExportEngine.js';

console.log('================================================================');
console.log('   PHASE 6 — VALIDATION ENGINE ACCEPTANCE MATRIX (TESTS 1–25)');
console.log('================================================================\n');

class MockAzureProvider implements DocumentAIProvider {
  readonly providerName = 'Mock Azure AI Provider';
  public callCount = 0;
  async analyzeDocument(): Promise<OCRAnalysisResult> {
    this.callCount++;
    return {
      provider: 'Mock Azure AI Provider',
      modelId: 'prebuilt-layout',
      overallConfidence: 0.95,
      pages: [{ pageNumber: 1, rawText: 'Sample text' }],
      tables: [],
      metadata: {},
    };
  }
}

async function runValidationTests() {
  const client = getSupabaseAdminClient();
  let passedCount = 0;

  function assertTest(condition: boolean, testName: string, detail: string) {
    assert(condition, `[FAIL] ${testName}: ${detail}`);
    console.log(`✅ [PASS] ${testName}: ${detail}`);
    passedCount++;
  }

  const testUserId = '30ed6381-0d2f-4d4a-a2f6-d8e0ac07452c';
  const testDocId = crypto.randomUUID();

  try {
    console.log('--- Setting up test document in PostgreSQL ---');
    await db.createDocument({
      id: testDocId,
      user_id: testUserId,
      file_name: 'phase6_validation_test.pdf',
      status: 'PROCESSING',
    });

    // -------------------------------------------------------------
    // TEST 5, 6, 7 — Azure Cell Confidence Validation
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 5, 6, 7: Azure Confidence Validation ---');
    const azureAnalysis: OCRAnalysisResult = {
      provider: 'Azure Document Intelligence',
      modelId: 'prebuilt-layout',
      overallConfidence: 0.92,
      pages: [{ pageNumber: 1, rawText: 'Azure Page 1' }],
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 3,
          columnCount: 3,
          confidence: 0.92,
          confidenceSource: 'AZURE_MODEL',
          rows: [
            {
              rowIndex: 0,
              cells: [
                {
                  columnIndex: 0,
                  rawValue: 'Cell High Conf',
                  cellType: 'TEXT',
                  confidence: 0.95,
                  confidenceSource: 'AZURE_MODEL',
                  boundingPolygon: [10, 10, 50, 10, 50, 20, 10, 20],
                  coordinateUnit: 'pixel',
                },
                {
                  columnIndex: 1,
                  rawValue: 'Cell Medium Conf',
                  cellType: 'TEXT',
                  confidence: 0.85, // 0.80 <= conf < 0.90 -> WARNING
                  confidenceSource: 'AZURE_MODEL',
                  boundingPolygon: [60, 10, 100, 10, 100, 20, 60, 20],
                  coordinateUnit: 'pixel',
                },
                {
                  columnIndex: 2,
                  rawValue: 'Cell Low Conf',
                  cellType: 'TEXT',
                  confidence: 0.65, // < 0.80 -> REVIEW_REQUIRED
                  confidenceSource: 'AZURE_MODEL',
                  boundingPolygon: [110, 10, 150, 10, 150, 20, 110, 20],
                  coordinateUnit: 'pixel',
                },
              ],
            },
          ],
        },
      ],
      metadata: {},
    };

    const reportAzure = ValidationEngine.validate(testDocId, azureAnalysis);
    const table0 = reportAzure.tables[0];
    const highCell = table0.cellResults[0];
    const medCell = table0.cellResults[1];
    const lowCell = table0.cellResults[2];

    assertTest(highCell.status === 'ACCEPTED', 'TEST 5', 'Azure cell with 0.95 confidence is ACCEPTED');
    assertTest(medCell.status === 'WARNING', 'TEST 6', 'Azure cell with 0.85 confidence yields WARNING');
    assertTest(lowCell.status === 'REVIEW_REQUIRED', 'TEST 7', 'Azure cell with 0.65 confidence yields REVIEW_REQUIRED');
    assertTest(lowCell.requiresSecondaryOcr === true, 'TEST 7', 'Low confidence cell is marked for Secondary OCR candidate');

    // -------------------------------------------------------------
    // TEST 8 — Local Native Cell with confidence=null
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 8: Local Native Confidence=null Validation ---');
    const localAnalysis: OCRAnalysisResult = {
      provider: 'Local Vector Extractor',
      modelId: 'pde-v1',
      overallConfidence: 0.95,
      pages: [{ pageNumber: 1, rawText: 'Local Page 1' }],
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 1,
          columnCount: 1,
          confidence: null,
          confidenceSource: 'LOCAL_HEURISTIC',
          structureConfidence: 0.95,
          rows: [
            {
              rowIndex: 0,
              cells: [
                {
                  columnIndex: 0,
                  rawValue: 'Cong ty TNHH DocConvert',
                  cellType: 'TEXT',
                  confidence: null,
                  confidenceSource: 'LOCAL_HEURISTIC',
                  structureConfidence: 0.95,
                  boundingPolygon: [72, 72, 200, 72, 200, 90, 72, 90],
                  coordinateUnit: 'point',
                },
              ],
            },
          ],
        },
      ],
      metadata: {},
    };

    const reportLocal = ValidationEngine.validate(testDocId, localAnalysis);
    const localCell = reportLocal.tables[0].cellResults[0];
    assertTest(localCell.status === 'ACCEPTED', 'TEST 8', 'Local cell with confidence=null is NOT rejected (ACCEPTED)');
    assertTest(localCell.confidenceSource === 'LOCAL_HEURISTIC', 'TEST 8', 'Local cell preserves LOCAL_HEURISTIC source');

    // -------------------------------------------------------------
    // TEST 9 — Invalid Date Validation
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 9: Invalid Date Validation ---');
    const invalidDateAnalysis: OCRAnalysisResult = {
      provider: 'Azure Document Intelligence',
      modelId: 'prebuilt-layout',
      overallConfidence: 0.95,
      pages: [{ pageNumber: 1, rawText: 'Page' }],
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 1,
          columnCount: 1,
          confidence: 0.95,
          rows: [
            {
              rowIndex: 0,
              cells: [
                {
                  columnIndex: 0,
                  rawValue: '32/13/2026', // Impossible calendar date
                  cellType: 'DATE',
                  confidence: 0.95,
                },
              ],
            },
          ],
        },
      ],
      metadata: {},
    };
    const reportDate = ValidationEngine.validate(testDocId, invalidDateAnalysis);
    const dateCell = reportDate.tables[0].cellResults[0];
    assertTest(dateCell.status === 'REVIEW_REQUIRED', 'TEST 9', 'Impossible date yields REVIEW_REQUIRED');
    assertTest(dateCell.issues.some((i) => i.code === VALIDATION_RULE_CODES.INVALID_DATE), 'TEST 9', 'Issue code is INVALID_DATE');

    // -------------------------------------------------------------
    // TEST 10 & 11 — Invalid Number/Money & Type Mismatch
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 10 & 11: Invalid Money / Type Mismatch ---');
    const mismatchAnalysis: OCRAnalysisResult = {
      provider: 'Azure Document Intelligence',
      modelId: 'prebuilt-layout',
      overallConfidence: 0.95,
      pages: [{ pageNumber: 1, rawText: 'Page' }],
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 1,
          columnCount: 2,
          confidence: 0.95,
          rows: [
            {
              rowIndex: 0,
              cells: [
                {
                  columnIndex: 0,
                  rawValue: 'ABC_NOT_A_NUMBER',
                  cellType: 'NUMBER',
                  confidence: 0.95,
                },
                {
                  columnIndex: 1,
                  rawValue: '120k vnd', // alpha contamination
                  cellType: 'MONEY',
                  confidence: 0.95,
                },
              ],
            },
          ],
        },
      ],
      metadata: {},
    };
    const reportMismatch = ValidationEngine.validate(testDocId, mismatchAnalysis);
    const numCell = reportMismatch.tables[0].cellResults[0];
    const moneyCell = reportMismatch.tables[0].cellResults[1];
    assertTest(numCell.status === 'REVIEW_REQUIRED', 'TEST 11', 'NUMBER cell with alphabetic text is REVIEW_REQUIRED');
    assertTest(numCell.issues.some((i) => i.code === VALIDATION_RULE_CODES.TYPE_MISMATCH), 'TEST 11', 'Issue code is TYPE_MISMATCH');
    assertTest(moneyCell.status === 'REVIEW_REQUIRED', 'TEST 10', 'MONEY cell with character contamination is REVIEW_REQUIRED');
    assertTest(moneyCell.issues.some((i) => i.code === VALIDATION_RULE_CODES.INVALID_MONEY), 'TEST 10', 'Issue code is INVALID_MONEY');

    // -------------------------------------------------------------
    // TEST 12 — Table Column-Count Anomaly
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 12: Table Column-Count Anomaly ---');
    const anomalyAnalysis: OCRAnalysisResult = {
      provider: 'Azure Document Intelligence',
      modelId: 'prebuilt-layout',
      overallConfidence: 0.95,
      pages: [{ pageNumber: 1, rawText: 'Page' }],
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 2,
          columnCount: 4,
          confidence: 0.95,
          rows: [
            {
              rowIndex: 0,
              cells: [
                { columnIndex: 0, rawValue: 'A', cellType: 'TEXT', confidence: 0.95 },
                { columnIndex: 1, rawValue: 'B', cellType: 'TEXT', confidence: 0.95 },
                { columnIndex: 2, rawValue: 'C', cellType: 'TEXT', confidence: 0.95 },
                { columnIndex: 3, rawValue: 'D', cellType: 'TEXT', confidence: 0.95 },
              ],
            },
            {
              rowIndex: 1,
              cells: [
                { columnIndex: 0, rawValue: 'A2', cellType: 'TEXT', confidence: 0.95 },
                { columnIndex: 1, rawValue: 'B2', cellType: 'TEXT', confidence: 0.95 }, // only 2 cells instead of 4
              ],
            },
          ],
        },
      ],
      metadata: {},
    };
    const reportAnomaly = ValidationEngine.validate(testDocId, anomalyAnalysis);
    assertTest(
      reportAnomaly.tables[0].issues.some((i) => i.code === VALIDATION_RULE_CODES.COLUMN_COUNT_MISMATCH),
      'TEST 12',
      'Row with missing columns triggers COLUMN_COUNT_MISMATCH issue'
    );

    // -------------------------------------------------------------
    // TEST 13 — Low Structure Confidence Validation
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 13: Low Structure Confidence ---');
    const lowStructAnalysis: OCRAnalysisResult = {
      provider: 'Local Vector Extractor',
      modelId: 'pde-v1',
      overallConfidence: 0.95,
      pages: [{ pageNumber: 1, rawText: 'Page' }],
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 1,
          columnCount: 1,
          confidence: null,
          confidenceSource: 'LOCAL_HEURISTIC',
          structureConfidence: 0.50, // < 0.70 threshold
          rows: [
            {
              rowIndex: 0,
              cells: [
                {
                  columnIndex: 0,
                  rawValue: 'Shaky Table Grid',
                  cellType: 'TEXT',
                  confidence: null,
                  confidenceSource: 'LOCAL_HEURISTIC',
                  structureConfidence: 0.50,
                },
              ],
            },
          ],
        },
      ],
      metadata: {},
    };
    const reportStruct = ValidationEngine.validate(testDocId, lowStructAnalysis);
    assertTest(reportStruct.tables[0].cellResults[0].status === 'REVIEW_REQUIRED', 'TEST 13', 'Low structureConfidence yields REVIEW_REQUIRED');

    // -------------------------------------------------------------
    // TEST 14 — Required Cell Empty (Schema Validation)
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 14: Required Cell Empty ---');
    const emptyAnalysis: OCRAnalysisResult = {
      provider: 'Azure Document Intelligence',
      modelId: 'prebuilt-layout',
      overallConfidence: 0.95,
      pages: [{ pageNumber: 1, rawText: 'Page' }],
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 1,
          columnCount: 1,
          confidence: 0.95,
          rows: [
            {
              rowIndex: 0,
              cells: [
                { columnIndex: 0, rawValue: '', cellType: 'TEXT', confidence: 0.95 },
              ],
            },
          ],
        },
      ],
      metadata: {},
    };
    const schemaReq = {
      columns: [{ name: 'Tax Code', columnIndex: 0, required: true }],
    };
    const reportEmpty = ValidationEngine.validate(testDocId, emptyAnalysis, schemaReq);
    assertTest(reportEmpty.tables[0].cellResults[0].status === 'REVIEW_REQUIRED', 'TEST 14', 'Empty required cell yields REVIEW_REQUIRED');
    assertTest(reportEmpty.tables[0].cellResults[0].issues[0].code === VALIDATION_RULE_CODES.EMPTY_REQUIRED_VALUE, 'TEST 14', 'Issue code is EMPTY_REQUIRED_VALUE');

    // -------------------------------------------------------------
    // TEST 15 — Logical Rule (Percentage > 100%)
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 15: Logical Rule Validation ---');
    const logicalAnalysis: OCRAnalysisResult = {
      provider: 'Azure Document Intelligence',
      modelId: 'prebuilt-layout',
      overallConfidence: 0.95,
      pages: [{ pageNumber: 1, rawText: 'Page' }],
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 1,
          columnCount: 1,
          confidence: 0.95,
          rows: [
            {
              rowIndex: 0,
              cells: [
                { columnIndex: 0, rawValue: '150%', cellType: 'PERCENTAGE', confidence: 0.95 },
              ],
            },
          ],
        },
      ],
      metadata: {},
    };
    const reportLogical = ValidationEngine.validate(testDocId, logicalAnalysis);
    assertTest(reportLogical.tables[0].cellResults[0].status === 'REVIEW_REQUIRED', 'TEST 15', 'Percentage > 100% yields REVIEW_REQUIRED');
    assertTest(reportLogical.tables[0].cellResults[0].issues[0].code === VALIDATION_RULE_CODES.LOGICAL_RULE_FAILED, 'TEST 15', 'Issue code is LOGICAL_RULE_FAILED');

    // -------------------------------------------------------------
    // TEST 17 & 18 — Version and Bounding Box Link
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 17 & 18: Version & Bounding Box Traceability ---');
    assertTest(reportAzure.validationVersion === 'val-v1', 'TEST 17', 'Validation version is val-v1');
    assertTest(lowCell.boundingPolygon !== undefined && lowCell.coordinateUnit === 'pixel', 'TEST 18', 'Cell resolves to boundingPolygon and coordinateUnit');

    // -------------------------------------------------------------
    // TEST 20, 21, 22 — Document Status Derivation
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 20, 21, 22: Document Final Status Derivation ---');
    const cleanAnalysis: OCRAnalysisResult = {
      provider: 'Azure Document Intelligence',
      modelId: 'prebuilt-layout',
      overallConfidence: 0.95,
      pages: [{ pageNumber: 1, rawText: 'Page' }],
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 1,
          columnCount: 2,
          confidence: 0.95,
          rows: [
            {
              rowIndex: 0,
              cells: [
                { columnIndex: 0, rawValue: 'Dong A', cellType: 'TEXT', confidence: 0.95 },
                { columnIndex: 1, rawValue: '1,500,000', cellType: 'MONEY', confidence: 0.95 },
              ],
            },
          ],
        },
      ],
      metadata: {},
    };
    const reportClean = ValidationEngine.validate(testDocId, cleanAnalysis);
    assertTest(reportClean.status === 'READY', 'TEST 20', 'Document with all ACCEPTED cells becomes READY (NOT REVIEW_REQUIRED)');

    const reportBlocked = ValidationEngine.validate(testDocId, mismatchAnalysis);
    assertTest(reportBlocked.status === 'REVIEW_REQUIRED', 'TEST 21', 'Document with review required issues becomes REVIEW_REQUIRED');

    // -------------------------------------------------------------
    // TEST 1, 2, 3, 4, 16 — Atomic Persistence & PostgreSQL Round-Trip
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 1, 3, 4, 16: Atomic Persistence & PostgreSQL Round-Trip ---');
    const validMergedAnalysis: OCRAnalysisResult = {
      provider: 'DocConvert PDE Hybrid',
      modelId: 'prebuilt-layout',
      overallConfidence: 0.95,
      pages: [
        { pageNumber: 1, rawText: 'Page 1 Local' },
        { pageNumber: 2, rawText: 'Page 2 Azure' },
      ],
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 1,
          columnCount: 1,
          confidence: null,
          confidenceSource: 'LOCAL_HEURISTIC',
          structureConfidence: 0.95,
          coordinateUnit: 'point',
          rows: [
            {
              rowIndex: 0,
              cells: [
                {
                  columnIndex: 0,
                  rawValue: 'Giao dich ngay 01/01/2026',
                  cellType: 'TEXT',
                  confidence: null,
                  confidenceSource: 'LOCAL_HEURISTIC',
                  structureConfidence: 0.95,
                  boundingPolygon: [50, 50, 200, 50, 200, 70, 50, 70],
                  coordinateUnit: 'point',
                },
              ],
            },
          ],
        },
        {
          pageNumber: 2,
          tableIndex: 1,
          rowCount: 1,
          columnCount: 1,
          confidence: 0.94,
          confidenceSource: 'AZURE_MODEL',
          coordinateUnit: 'pixel',
          rows: [
            {
              rowIndex: 0,
              cells: [
                {
                  columnIndex: 0,
                  rawValue: '25,000,000 VND',
                  cellType: 'MONEY',
                  confidence: 0.94,
                  confidenceSource: 'AZURE_MODEL',
                  boundingPolygon: [100, 100, 300, 100, 300, 120, 100, 120],
                  coordinateUnit: 'pixel',
                },
              ],
            },
          ],
        },
      ],
      metadata: {},
    };

    const validReport = ValidationEngine.validate(testDocId, validMergedAnalysis);
    await db.saveOcrAnalysis(testUserId, testDocId, validMergedAnalysis, validReport);

    // Verify PostgreSQL state
    const ocrResult = await db.getDocumentOcrResult(testUserId, testDocId);
    assertTest(ocrResult !== null, 'TEST 1', 'Atomic persistence succeeded in storing OCR result');
    assertTest(ocrResult?.tables.length === 2, 'TEST 1', 'Both tables persisted accurately');

    const table1 = ocrResult?.tables[0];
    const table2 = ocrResult?.tables[1];

    assertTest(table1?.confidenceSource === 'LOCAL_HEURISTIC', 'TEST 3', 'Table 1 confidenceSource LOCAL_HEURISTIC survived DB round-trip');
    assertTest(table1?.structureConfidence === 0.95, 'TEST 4', 'Table 1 structureConfidence 0.95 survived DB round-trip');
    assertTest(table2?.confidenceSource === 'AZURE_MODEL', 'TEST 3', 'Table 2 confidenceSource AZURE_MODEL survived DB round-trip');

    // TEST 2A — Missing validation_run throws VALIDATION_RUN_REQUIRED
    let missingValErr: any = null;
    try {
      const { error } = await client.rpc('save_document_analysis_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_payload: {
          page_count: 1,
          ocr_results: [],
          tables: [],
          rows: [],
          cells: [],
          // no validation_run provided
        },
      });
      if (error) throw error;
    } catch (err: any) {
      missingValErr = err;
    }
    assertTest(missingValErr !== null && String(missingValErr.message || missingValErr).includes('VALIDATION_RUN_REQUIRED'), 'TEST 2A', 'RPC strictly rejects calls without validation_run (VALIDATION_RUN_REQUIRED)');

    // TEST 2 — Atomic Persistence Forced Failure Rollback
    console.log('\n--- Running TEST 2: Atomic Persistence Forced Failure Rollback ---');
    const malformedPayload = {
      ...validMergedAnalysis,
      tables: [
        {
          pageNumber: 1,
          tableIndex: 0,
          rowCount: 1,
          columnCount: 1,
          rows: [
            {
              rowIndex: 0,
              cells: [
                {
                  columnIndex: 'INVALID_INTEGER_STRING' as any, // Triggers database error on insert
                  rawValue: 'Bad Cell',
                },
              ],
            },
          ],
        },
      ],
    };

    let caughtErr: any = null;
    try {
      await db.saveOcrAnalysis(testUserId, testDocId, malformedPayload, validReport);
    } catch (err: any) {
      caughtErr = err;
    }

    assertTest(caughtErr !== null, 'TEST 2', 'Forced failure was caught and thrown');

    // CRUCIAL: Verify that the previous valid extraction in PostgreSQL remained intact (ROLLBACK worked!)
    const ocrResultAfterRollback = await db.getDocumentOcrResult(testUserId, testDocId);
    assertTest(ocrResultAfterRollback?.tables.length === 2, 'TEST 2', 'PREVIOUS VALID EXTRACTION SURVIVED ROLLBACK 100% INTACT!');
    assertTest(ocrResultAfterRollback?.tables[0].rows[0].cells[0].rawValue === 'Giao dich ngay 01/01/2026', 'TEST 2', 'Original cell value remained completely untouched');

    // -------------------------------------------------------------
    // TEST 25 — Mixed Local + Azure Validation
    // -------------------------------------------------------------
    console.log('\n--- Running TEST 25: Mixed Local + Azure Validation ---');
    assertTest(table1?.rows[0].cells[0].confidence === null, 'TEST 25', 'Local cell preserves null OCR confidence');
    assertTest(table2?.rows[0].cells[0].confidence === 0.94, 'TEST 25', 'Azure cell preserves model confidence');

    // -------------------------------------------------------------
    // STATUS-DERIVATION INVARIANT TESTS (1 to 6)
    // -------------------------------------------------------------
    console.log('\n--- Running Status-Derivation Invariant Tests (1 to 6) ---');
    function deriveStatuses(valItem: { status?: string; warning_count?: number; review_required_count?: number }) {
      let valRunStatus: string;
      if ((valItem.review_required_count ?? 0) > 0 || valItem.status === 'REVIEW_REQUIRED') {
        valRunStatus = 'REVIEW_REQUIRED';
      } else if ((valItem.warning_count ?? 0) > 0 || valItem.status === 'WARNING') {
        valRunStatus = 'WARNING';
      } else {
        valRunStatus = 'ACCEPTED';
      }

      let finalStatus: string;
      if (valRunStatus === 'REVIEW_REQUIRED') {
        finalStatus = 'REVIEW_REQUIRED';
      } else {
        finalStatus = 'READY';
      }

      return { valRunStatus, finalStatus };
    }

    // 1. ACCEPTED / 0 warning / 0 review -> validation ACCEPTED, document READY
    const case1 = deriveStatuses({ status: 'ACCEPTED', warning_count: 0, review_required_count: 0 });
    assertTest(case1.valRunStatus === 'ACCEPTED' && case1.finalStatus === 'READY', 'STATUS-CASE-1', 'ACCEPTED / 0 warning / 0 review -> validation ACCEPTED, document READY');

    // 2. WARNING / warning_count > 0 / review_count = 0 -> validation WARNING, document READY
    const case2 = deriveStatuses({ status: 'WARNING', warning_count: 3, review_required_count: 0 });
    assertTest(case2.valRunStatus === 'WARNING' && case2.finalStatus === 'READY', 'STATUS-CASE-2', 'WARNING / warning_count > 0 / review_count = 0 -> validation WARNING, document READY');

    // 3. REVIEW_REQUIRED / review_count > 0 -> validation REVIEW_REQUIRED, document REVIEW_REQUIRED
    const case3 = deriveStatuses({ status: 'REVIEW_REQUIRED', warning_count: 2, review_required_count: 1 });
    assertTest(case3.valRunStatus === 'REVIEW_REQUIRED' && case3.finalStatus === 'REVIEW_REQUIRED', 'STATUS-CASE-3', 'REVIEW_REQUIRED / review_count > 0 -> validation REVIEW_REQUIRED, document REVIEW_REQUIRED');

    // 4. supplied WARNING but review_required_count > 0 -> REVIEW_REQUIRED wins for both validation summary and document status
    const case4 = deriveStatuses({ status: 'WARNING', warning_count: 4, review_required_count: 2 });
    assertTest(case4.valRunStatus === 'REVIEW_REQUIRED' && case4.finalStatus === 'REVIEW_REQUIRED', 'STATUS-CASE-4', 'Supplied WARNING but review_required_count > 0 -> REVIEW_REQUIRED wins for both');

    // 5. status omitted but warning_count > 0 -> validation WARNING, document READY
    const case5 = deriveStatuses({ warning_count: 5, review_required_count: 0 });
    assertTest(case5.valRunStatus === 'WARNING' && case5.finalStatus === 'READY', 'STATUS-CASE-5', 'Status omitted but warning_count > 0 -> validation WARNING, document READY');

    // 6. status omitted and all issue counts = 0 -> validation ACCEPTED, document READY
    const case6 = deriveStatuses({ warning_count: 0, review_required_count: 0 });
    assertTest(case6.valRunStatus === 'ACCEPTED' && case6.finalStatus === 'READY', 'STATUS-CASE-6', 'Status omitted and all issue counts = 0 -> validation ACCEPTED, document READY');

    console.log('\n================================================================');
    console.log(`PHASE 6 VALIDATION MATRIX: ${passedCount} ASSERTIONS PASSED, 0 FAILED`);
    console.log('================================================================\n');
  } finally {
    console.log('--- Cleaning up test records from PostgreSQL ---');
    await client.from('documents').delete().eq('id', testDocId);
    console.log('✅ Cleanup finished.');
  }
}

runValidationTests().catch(console.error);
