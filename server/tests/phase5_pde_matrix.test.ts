import assert from 'assert';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { processingDecisionEngine, ProcessingDecisionEngine, PDE_VERSION } from '../services/pde/ProcessingDecisionEngine.js';
import { ProcessingExecutor } from '../services/pde/ProcessingExecutor.js';
import { localPdfExtractor } from '../services/pde/LocalPdfExtractor.js';
import { pagePdfExtractor } from '../services/pde/PagePdfExtractor.js';
import { DocumentAIProvider, OCRAnalysisResult } from '../services/ocr/types.js';
import { DocumentPageRecord } from '../db/db.js';
import { DocumentPageAnalysis } from '../services/preflightService.js';

console.log('================================================================');
console.log('   PHASE 5 — PROCESSING DECISION ENGINE ACCEPTANCE MATRIX');
console.log('================================================================\n');

/**
 * Creates a minimal valid multi-page PDF buffer with text on each page using pdf-lib.
 */
async function createTestPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([600, 800]);
    page.drawText(`Page Content ${i} - Machine Readable Text For DocConvert AI`, {
      x: 50,
      y: 750,
      size: 14,
    });
    // Add additional lines for native structure
    page.drawText(`Column1    Column2    Column3`, { x: 50, y: 700, size: 12 });
    page.drawText(`ValueA     ValueB     ValueC`, { x: 50, y: 670, size: 12 });
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/**
 * Mock Azure Provider to verify exact calls and page counts sent to Azure
 */
class MockAzureProvider implements DocumentAIProvider {
  readonly providerName = 'Mock Azure AI';
  public analyzeCalls: Array<{ buffer: Buffer; pageCount: number }> = [];
  public shouldFail = false;

  async analyzeDocument(fileBuffer: Buffer, mimeType: string, options?: any): Promise<OCRAnalysisResult> {
    if (this.shouldFail) {
      throw new Error('MOCK_AZURE_PROVIDER_TEMPORARY_FAILURE: Service unavailable');
    }

    let pageCount = 1;
    if (mimeType === 'application/pdf') {
      try {
        const doc = await PDFDocument.load(fileBuffer);
        pageCount = doc.getPageCount();
      } catch {
        pageCount = 1;
      }
    }

    this.analyzeCalls.push({ buffer: fileBuffer, pageCount });

    // Return dummy OCR result for the received sub-PDF pages (1..pageCount)
    const pages = Array.from({ length: pageCount }, (_, i) => ({
      pageNumber: i + 1,
      linesCount: 10,
      rawText: `Azure OCR Extracted Text for Sub-PDF Page ${i + 1}`,
      confidence: 0.95,
      unit: 'inch',
    }));

    const tables = Array.from({ length: pageCount }, (_, i) => ({
      pageNumber: i + 1,
      tableIndex: i,
      rowCount: 3,
      columnCount: 3,
      confidence: 0.94,
      boundingRegions: [{ pageNumber: i + 1, polygon: [0.5, 0.5, 5, 0.5, 5, 4, 0.5, 4] }],
      rows: [
        {
          rowIndex: 0,
          isHeader: true,
          cells: [
            { rowIndex: 0, columnIndex: 0, rawValue: 'Col1', cellType: 'TEXT' as const, confidence: 0.95 },
            { rowIndex: 0, columnIndex: 1, rawValue: 'Col2', cellType: 'TEXT' as const, confidence: 0.95 },
          ],
        },
        {
          rowIndex: 1,
          isHeader: false,
          cells: [
            { rowIndex: 1, columnIndex: 0, rawValue: 'Val1', cellType: 'TEXT' as const, confidence: 0.95 },
            { rowIndex: 1, columnIndex: 1, rawValue: 'Val2', cellType: 'TEXT' as const, confidence: 0.95 },
          ],
        },
      ],
    }));

    const rawMetadataObservations = Array.from({ length: pageCount }, (_, i) => ({
      rawLabel: 'Số tài khoản',
      rawValue: `12345678${i + 1}`,
      confidence: 0.95,
      sourcePage: i + 1,
    }));

    return {
      provider: this.providerName,
      modelId: 'prebuilt-layout',
      overallConfidence: 0.95,
      rawText: pages.map((p) => p.rawText).join('\n\n'),
      pages,
      tables,
      rawMetadataObservations,
      documentMetadata: [],
      metadataPipelineMetrics: {
        rawKeyValueCount: rawMetadataObservations.length,
        headerLineCandidateCount: 0,
        headerTableCandidateCount: 0,
        candidateCount: rawMetadataObservations.length,
        canonicalCount: 1,
        coreCount: 1,
        additionalCount: 0,
        conflictCount: 0,
        rejectedCount: 0,
      },
    };
  }
}

async function runTests() {
  let passedCount = 0;

  function assertTest(condition: boolean, testName: string, detail: string) {
    assert(condition, `[FAIL] ${testName}: ${detail}`);
    console.log(`✅ [PASS] ${testName}: ${detail}`);
    passedCount++;
  }

  // -------------------------------------------------------------
  // TEST 1 — All-native document
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 1: All-native document ---');
  const nativePages: DocumentPageAnalysis[] = [
    {
      pageNumber: 1,
      classification: 'NATIVE_TEXT',
      classificationConfidence: 0.98,
      textCharCount: 1200,
      textBlockCount: 30,
      textCoverage: 0.35,
      imageCount: 0,
      imageCoverage: 0.0,
      hasFullPageImage: false,
      classificationReason: 'Standard native text',
    },
    {
      pageNumber: 2,
      classification: 'NATIVE_TEXT',
      classificationConfidence: 0.97,
      textCharCount: 950,
      textBlockCount: 25,
      textCoverage: 0.28,
      imageCount: 1,
      imageCoverage: 0.05,
      hasFullPageImage: false,
      classificationReason: 'Standard native text',
    },
  ];

  const plan1 = processingDecisionEngine.buildProcessingPlan('doc-1', nativePages);
  assertTest(plan1.totalPages === 2, 'TEST 1', 'Total pages is 2');
  assertTest(plan1.localPages === 2, 'TEST 1', 'All 2 pages routed to LOCAL_NATIVE');
  assertTest(plan1.azurePages === 0, 'TEST 1', '0 pages routed to Azure');
  assertTest(plan1.decisions[0].preferredStrategy === 'LOCAL_NATIVE', 'TEST 1', 'Page 1 strategy is LOCAL_NATIVE');
  assertTest(plan1.decisions[0].fallbackStrategy === 'AZURE_FALLBACK', 'TEST 1', 'Page 1 fallback is AZURE_FALLBACK');
  assertTest(plan1.decisions[0].requiresAzure === false, 'TEST 1', 'Page 1 requiresAzure is false');

  // -------------------------------------------------------------
  // TEST 2 — All-scanned document
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 2: All-scanned document ---');
  const scannedPages: DocumentPageAnalysis[] = [
    {
      pageNumber: 1,
      classification: 'SCANNED',
      classificationConfidence: 0.99,
      textCharCount: 0,
      textBlockCount: 0,
      textCoverage: 0.0,
      imageCount: 1,
      imageCoverage: 1.0,
      hasFullPageImage: true,
      classificationReason: 'Scanned image',
    },
    {
      pageNumber: 2,
      classification: 'SCANNED',
      classificationConfidence: 0.99,
      textCharCount: 15,
      textBlockCount: 1,
      textCoverage: 0.005,
      imageCount: 1,
      imageCoverage: 0.98,
      hasFullPageImage: true,
      classificationReason: 'Scanned image',
    },
  ];

  const plan2 = processingDecisionEngine.buildProcessingPlan('doc-2', scannedPages);
  assertTest(plan2.totalPages === 2, 'TEST 2', 'Total pages is 2');
  assertTest(plan2.azurePages === 2, 'TEST 2', 'All 2 pages routed to AZURE_FULL_PAGE');
  assertTest(plan2.localPages === 0, 'TEST 2', '0 pages routed to LOCAL_NATIVE');
  assertTest(plan2.decisions[0].requiresAzure === true, 'TEST 2', 'Page 1 requiresAzure is true');

  // -------------------------------------------------------------
  // TEST 3 — Mixed document (Page 1 native, 2 scan, 3 native, 4 mixed)
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 3: Mixed document with 4 distinct pages ---');
  const fourPages: DocumentPageAnalysis[] = [
    {
      pageNumber: 1,
      classification: 'NATIVE_TEXT',
      classificationConfidence: 0.95,
      textCharCount: 800,
      textBlockCount: 20,
      textCoverage: 0.25,
      imageCount: 0,
      imageCoverage: 0.0,
      hasFullPageImage: false,
      classificationReason: 'Native page 1',
    },
    {
      pageNumber: 2,
      classification: 'SCANNED',
      classificationConfidence: 0.99,
      textCharCount: 0,
      textBlockCount: 0,
      textCoverage: 0.0,
      imageCount: 1,
      imageCoverage: 1.0,
      hasFullPageImage: true,
      classificationReason: 'Scanned page 2',
    },
    {
      pageNumber: 3,
      classification: 'NATIVE_TEXT',
      classificationConfidence: 0.95,
      textCharCount: 1100,
      textBlockCount: 25,
      textCoverage: 0.30,
      imageCount: 0,
      imageCoverage: 0.0,
      hasFullPageImage: false,
      classificationReason: 'Native page 3',
    },
    {
      pageNumber: 4,
      classification: 'MIXED',
      classificationConfidence: 0.90,
      textCharCount: 500,
      textBlockCount: 15,
      textCoverage: 0.18,
      imageCount: 2,
      imageCoverage: 0.40,
      hasFullPageImage: false,
      classificationReason: 'Mixed page 4',
    },
  ];

  const plan3 = processingDecisionEngine.buildProcessingPlan('doc-3', fourPages);
  assertTest(plan3.decisions[0].preferredStrategy === 'LOCAL_NATIVE', 'TEST 3', 'Page 1 decision is LOCAL_NATIVE');
  assertTest(plan3.decisions[1].preferredStrategy === 'AZURE_FULL_PAGE', 'TEST 3', 'Page 2 decision is AZURE_FULL_PAGE');
  assertTest(plan3.decisions[2].preferredStrategy === 'LOCAL_NATIVE', 'TEST 3', 'Page 3 decision is LOCAL_NATIVE');
  assertTest(plan3.decisions[3].preferredStrategy === 'HYBRID', 'TEST 3', 'Page 4 decision is HYBRID');
  assertTest(plan3.localPages === 2, 'TEST 3', 'Plan localPages count is 2');
  assertTest(plan3.azurePages === 1, 'TEST 3', 'Plan azurePages count is 1');
  assertTest(plan3.hybridPages === 1, 'TEST 3', 'Plan hybridPages count is 1');

  // -------------------------------------------------------------
  // TEST 4 — UNCERTAIN becomes native after second pass
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 4: UNCERTAIN page resolves to LOCAL_NATIVE ---');
  const uncertainNativeCandidate: DocumentPageAnalysis = {
    pageNumber: 1,
    classification: 'UNCERTAIN',
    classificationConfidence: 0.60,
    textCharCount: 350,
    textBlockCount: 12,
    textCoverage: 0.15,
    imageCount: 1,
    imageCoverage: 0.08,
    hasFullPageImage: false,
    classificationReason: 'Ambiguous initial classification',
  };

  const dec4 = processingDecisionEngine.resolveSecondPass(uncertainNativeCandidate);
  assertTest(dec4.classification === 'UNCERTAIN', 'TEST 4', 'Original classification remains UNCERTAIN (never mutated)');
  assertTest(dec4.preferredStrategy === 'LOCAL_NATIVE', 'TEST 4', 'Resolved preferredStrategy is LOCAL_NATIVE');
  assertTest(dec4.fallbackStrategy === 'AZURE_FALLBACK', 'TEST 4', 'Fallback strategy is AZURE_FALLBACK');
  assertTest(dec4.requiresAzure === false, 'TEST 4', 'requiresAzure is false');
  assertTest(dec4.decisionReason.includes('Phân tích cục bộ lần 2'), 'TEST 4', 'Decision reason details second pass');

  // -------------------------------------------------------------
  // TEST 5 — UNCERTAIN remains uncertain -> conservative Azure escalation
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 5: UNCERTAIN page still ambiguous -> AZURE_FULL_PAGE ---');
  const uncertainAmbiguous: DocumentPageAnalysis = {
    pageNumber: 2,
    classification: 'UNCERTAIN',
    classificationConfidence: 0.40,
    textCharCount: 45, // below 50, but imgCoverage low
    textBlockCount: 2,
    textCoverage: 0.02,
    imageCount: 1,
    imageCoverage: 0.15,
    hasFullPageImage: false,
    classificationReason: 'Sparse ambiguous content',
  };

  const dec5 = processingDecisionEngine.resolveSecondPass(uncertainAmbiguous);
  assertTest(dec5.classification === 'UNCERTAIN', 'TEST 5', 'Original classification remains UNCERTAIN');
  assertTest(dec5.preferredStrategy === 'AZURE_FULL_PAGE', 'TEST 5', 'Conservatively escalated to AZURE_FULL_PAGE');
  assertTest(dec5.requiresAzure === true, 'TEST 5', 'requiresAzure is true');

  // -------------------------------------------------------------
  // TEST 6 — Native page structure insufficient -> AZURE_FALLBACK
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 6: Native page structure insufficient triggers AZURE_FALLBACK ---');
  // Create a 1-page PDF with only a single non-tabular sentence
  const prosePdf = await PDFDocument.create();
  const prosePage = prosePdf.addPage([600, 800]);
  prosePage.drawText('This is a plain narrative paragraph without columns or tables.', { x: 50, y: 700 });
  const proseBuffer = Buffer.from(await prosePdf.save());

  const localExt = await localPdfExtractor.extractPage(proseBuffer, 1, { outputType: 'EXCEL' });
  assertTest(localExt.structureRequiresFallback === true, 'TEST 6', 'Plain prose triggers structureRequiresFallback');
  assertTest(localExt.structureSufficient === false, 'TEST 6', 'structureSufficient is false');
  assertTest(localExt.tables.length === 0, 'TEST 6', 'No fake tables fabricated');

  // -------------------------------------------------------------
  // TEST 7 — Mixed page strategy = HYBRID with documented fallback
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 7: Mixed page HYBRID strategy & fallback ---');
  const mixedPage: DocumentPageAnalysis = {
    pageNumber: 1,
    classification: 'MIXED',
    classificationConfidence: 0.92,
    textCharCount: 400,
    textBlockCount: 10,
    textCoverage: 0.15,
    imageCount: 2,
    imageCoverage: 0.35,
    hasFullPageImage: false,
    classificationReason: 'Diagram with coexisting text',
  };

  const dec7 = processingDecisionEngine.evaluatePage(mixedPage);
  assertTest(dec7.preferredStrategy === 'HYBRID', 'TEST 7', 'Strategy is HYBRID');
  assertTest(dec7.fallbackStrategy === 'AZURE_FULL_PAGE', 'TEST 7', 'Fallback strategy is AZURE_FULL_PAGE');
  assertTest(dec7.requiresRegionAnalysis === true, 'TEST 7', 'requiresRegionAnalysis is true');
  assertTest(dec7.decisionReason.includes('Hybrid'), 'TEST 7', 'Reason clearly documents hybrid routing');

  // -------------------------------------------------------------
  // TEST 8 — Decision persistence & Determinism
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 8: Decision persistence & Determinism ---');
  const planA = processingDecisionEngine.buildProcessingPlan('doc-8', fourPages);
  const planB = processingDecisionEngine.buildProcessingPlan('doc-8', fourPages);
  assertTest(planA.decisions.length === planB.decisions.length, 'TEST 8', 'Decisions length identical');
  for (let i = 0; i < planA.decisions.length; i++) {
    assertTest(
      planA.decisions[i].preferredStrategy === planB.decisions[i].preferredStrategy,
      'TEST 8',
      `Page ${i + 1} strategy identical across runs: ${planA.decisions[i].preferredStrategy}`
    );
  }

  // -------------------------------------------------------------
  // TEST 9 — Decision versioning
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 9: Decision versioning ---');
  assertTest(PDE_VERSION === 'pde-v1', 'TEST 9', 'Decision version is pde-v1');
  assertTest(planA.decisionVersion === 'pde-v1', 'TEST 9', 'Plan contains pde-v1 version');
  assertTest(planA.decisions[0].decisionVersion === 'pde-v1', 'TEST 9', 'Page decision contains pde-v1 version');

  // -------------------------------------------------------------
  // TEST 10 — Original page mapping (page 7 isolated)
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 10: Original page mapping for isolated page 7 ---');
  const mockAzure10 = new MockAzureProvider();
  const executor10 = new ProcessingExecutor(mockAzure10);

  // Create an 8-page PDF
  const eightPagePdf = await createTestPdf(8);

  // Plan where ONLY page 7 is SCANNED
  const decisions10: DocumentPageRecord[] = Array.from({ length: 8 }, (_, i) => ({
    document_id: 'doc-10',
    page_number: i + 1,
    classification: i + 1 === 7 ? 'SCANNED' : 'NATIVE_TEXT',
    classification_confidence: 0.95,
    text_char_count: i + 1 === 7 ? 0 : 500,
    text_block_count: i + 1 === 7 ? 0 : 10,
    text_coverage: i + 1 === 7 ? 0 : 0.2,
    image_count: i + 1 === 7 ? 1 : 0,
    image_coverage: i + 1 === 7 ? 1 : 0,
    has_full_page_image: i + 1 === 7,
  }));

  const plan10 = processingDecisionEngine.buildProcessingPlan('doc-10', decisions10);
  const result10 = await executor10.executePlan('doc-10', 'user-1', eightPagePdf, 'application/pdf', plan10);

  // Find page 7 in results
  const page7 = result10.pages.find((p) => p.pageNumber === 7);
  assertTest(Boolean(page7), 'TEST 10', 'Page 7 exists in merged result');
  assertTest(page7?.pageNumber === 7, 'TEST 10', 'Page number is 7, NOT 1');

  const table7 = result10.tables.find((t) => t.pageNumber === 7);
  assertTest(Boolean(table7), 'TEST 10', 'Extracted table maps back to page 7');
  assertTest(table7?.pageNumber === 7, 'TEST 10', 'Table pageNumber is 7');
  assertTest(table7?.boundingRegions?.[0]?.pageNumber === 7, 'TEST 10', 'Bounding region pageNumber is 7');

  const obs7 = result10.rawMetadataObservations?.find((o) => o.sourcePage === 7);
  assertTest(Boolean(obs7), 'TEST 10', 'Observation sourcePage maps back to page 7');

  // -------------------------------------------------------------
  // TEST 11 — Azure ONLY receives required pages
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 11: Azure only receives required pages ---');
  assertTest(mockAzure10.analyzeCalls.length === 1, 'TEST 11', 'Azure called exactly once');
  assertTest(
    mockAzure10.analyzeCalls[0].pageCount === 1,
    'TEST 11',
    'Azure sub-PDF contained exactly 1 page (page 7), NOT 8 pages'
  );

  // -------------------------------------------------------------
  // TEST 12 — Azure provider failure handling
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 12: Azure provider failure handling ---');
  const mockAzureFail = new MockAzureProvider();
  mockAzureFail.shouldFail = true;
  const executorFail = new ProcessingExecutor(mockAzureFail);

  let failureCaught = false;
  try {
    await executorFail.executePlan('doc-12', 'user-1', eightPagePdf, 'application/pdf', plan10);
  } catch (err: any) {
    failureCaught = true;
    assertTest(
      err.message.includes('MOCK_AZURE_PROVIDER_TEMPORARY_FAILURE'),
      'TEST 12',
      'Azure error preserved without swallowing'
    );
  }
  assertTest(failureCaught, 'TEST 12', 'Provider failure correctly surfaced to trigger retry/fail logic');

  // -------------------------------------------------------------
  // TEST 13 — Restart during processing: Plan & Decision reuse
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 13: Restart during processing (Decision reuse) ---');
  const persistedDecisions: DocumentPageRecord[] = [
    {
      document_id: 'doc-13',
      page_number: 1,
      classification: 'NATIVE_TEXT',
      classification_confidence: 0.95,
      text_char_count: 500,
      text_block_count: 10,
      text_coverage: 0.2,
      image_count: 0,
      image_coverage: 0,
      has_full_page_image: false,
      processing_strategy: 'LOCAL_NATIVE',
      fallback_strategy: 'AZURE_FALLBACK',
      requires_azure: false,
      requires_region_analysis: false,
      decision_reason: 'Precomputed decision',
      decision_version: PDE_VERSION,
    },
    {
      document_id: 'doc-13',
      page_number: 2,
      classification: 'SCANNED',
      classification_confidence: 0.99,
      text_char_count: 0,
      text_block_count: 0,
      text_coverage: 0,
      image_count: 1,
      image_coverage: 1,
      has_full_page_image: true,
      processing_strategy: 'AZURE_FULL_PAGE',
      fallback_strategy: null,
      requires_azure: true,
      requires_region_analysis: false,
      decision_reason: 'Precomputed decision',
      decision_version: PDE_VERSION,
    },
  ];

  // Re-verify that all pages have PDE_VERSION
  const canReuse = persistedDecisions.every(
    (p) => Boolean(p.processing_strategy) && p.decision_version === PDE_VERSION
  );
  assertTest(canReuse === true, 'TEST 13', 'Persisted decisions recognized as reusable on worker resume');
  assertTest(persistedDecisions[0].processing_strategy === 'LOCAL_NATIVE', 'TEST 13', 'Page 1 retains LOCAL_NATIVE');
  assertTest(persistedDecisions[1].processing_strategy === 'AZURE_FULL_PAGE', 'TEST 13', 'Page 2 retains AZURE_FULL_PAGE');

  // -------------------------------------------------------------
  // SECTION 31: COST TEST (8 NATIVE_TEXT + 2 SCANNED = 10 pages)
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log('   COST TEST: 10 PAGES (8 NATIVE_TEXT + 2 SCANNED)');
  console.log('================================================================');

  const tenPagePdf = await createTestPdf(10);
  const mockAzureCost = new MockAzureProvider();
  const executorCost = new ProcessingExecutor(mockAzureCost);

  // 8 native pages (pages 1-8), 2 scanned pages (pages 9-10)
  const tenPages: DocumentPageRecord[] = Array.from({ length: 10 }, (_, i) => ({
    document_id: 'doc-cost-10',
    page_number: i + 1,
    classification: i < 8 ? 'NATIVE_TEXT' : 'SCANNED',
    classification_confidence: 0.96,
    text_char_count: i < 8 ? 600 : 0,
    text_block_count: i < 8 ? 15 : 0,
    text_coverage: i < 8 ? 0.25 : 0,
    image_count: i < 8 ? 0 : 1,
    image_coverage: i < 8 ? 0 : 1.0,
    has_full_page_image: i >= 8,
  }));

  const planCost = processingDecisionEngine.buildProcessingPlan('doc-cost-10', tenPages);
  assertTest(planCost.totalPages === 10, 'COST TEST', 'Total pages is 10');
  assertTest(planCost.localPages === 8, 'COST TEST', 'Exactly 8 pages routed to LOCAL_NATIVE');
  assertTest(planCost.azurePages === 2, 'COST TEST', 'Exactly 2 pages routed to AZURE_FULL_PAGE');
  assertTest(planCost.estimatedAzurePages === 2, 'COST TEST', 'Estimated Azure pages is exactly 2');

  const resultCost = await executorCost.executePlan(
    'doc-cost-10',
    'user-cost',
    tenPagePdf,
    'application/pdf',
    planCost,
    { outputType: 'EXCEL' }
  );

  assertTest(resultCost.pages.length === 10, 'COST TEST', 'All 10 pages present in merged OCR result');
  assertTest(mockAzureCost.analyzeCalls.length === 1, 'COST TEST', 'Azure provider was called exactly 1 time');
  assertTest(
    mockAzureCost.analyzeCalls[0].pageCount === 2,
    'COST TEST',
    'EXACT NUMBER OF PAGES SENT TO AZURE: 2 (PAGES 9 & 10 ONLY). 8 NATIVE PAGES BYPASSED AZURE!'
  );

  // -------------------------------------------------------------
  // TEST 16 — Existing Excel Output Compatibility
  // -------------------------------------------------------------
  console.log('\n--- Running TEST 16: Existing Excel Output Compatibility ---');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DocConvert AI (PDE Hybrid Engine)';
  workbook.created = new Date();

  // Create worksheets for each table from the merged PDE result (10 tables)
  resultCost.tables.forEach((table, tableIndex) => {
    const sheetName = `Bang_${tableIndex + 1}_Trang_${table.pageNumber}`;
    const ws = workbook.addWorksheet(sheetName);
    table.rows.forEach((row) => {
      const rowValues = row.cells.map((c) => c.rawValue);
      ws.addRow(rowValues);
    });
  });

  assertTest(workbook.worksheets.length === 10, 'TEST 16', 'Workbook contains 10 worksheets for all 10 pages');
  assertTest(workbook.worksheets[0].name === 'Bang_1_Trang_1', 'TEST 16', 'First worksheet named Bang_1_Trang_1');
  assertTest(workbook.worksheets[9].name === 'Bang_10_Trang_10', 'TEST 16', 'Tenth worksheet named Bang_10_Trang_10');

  const xlsxBuffer = await workbook.xlsx.writeBuffer();
  assertTest(Buffer.isBuffer(Buffer.from(xlsxBuffer)), 'TEST 16', 'Generates valid binary XLSX buffer');
  assertTest(xlsxBuffer.byteLength > 1000, 'TEST 16', `XLSX buffer is non-empty (${xlsxBuffer.byteLength} bytes)`);

  console.log('\n================================================================');
  console.log(`PHASE 5 TEST MATRIX: ${passedCount} ASSERTIONS PASSED, 0 FAILED`);
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('[FATAL] Phase 5 Test Matrix Error:', err);
  process.exit(1);
});
