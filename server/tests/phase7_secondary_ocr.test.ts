import assert from 'assert';
import crypto from 'crypto';
import { PDFDocument, rgb } from 'pdf-lib';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { db } from '../db/db.js';
import { PageRenderer } from '../services/secondaryOcr/PageRenderer.js';
import { RegionExtractor } from '../services/secondaryOcr/RegionExtractor.js';
import { CandidateRevalidator } from '../services/secondaryOcr/CandidateRevalidator.js';
import { ConflictResolutionEngine } from '../services/secondaryOcr/ConflictResolutionEngine.js';
import { MockSecondaryOcrProvider } from '../services/secondaryOcr/SecondaryOcrProvider.js';
import { SecondaryOcrCoordinator } from '../services/secondaryOcr/SecondaryOcrCoordinator.js';

console.log('================================================================');
console.log('   PHASE 7 — SECONDARY OCR & CONFLICT RESOLUTION MATRIX');
console.log('================================================================\n');

async function runPhase7Tests() {
  const client = getSupabaseAdminClient();
  let passedCount = 0;

  function assertTest(condition: boolean, testName: string, detail: string) {
    assert(condition, `[FAIL] ${testName}: ${detail}`);
    console.log(`✅ [PASS] ${testName}: ${detail}`);
    passedCount++;
  }

  // 1. Create a dummy test PDF in memory
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([300, 300]);
  page.drawText('INV-2026-001', { x: 50, y: 150, size: 18, color: rgb(0, 0, 0) });
  const pdfBuffer = Buffer.from(await pdfDoc.save());

  const testDocId = crypto.randomUUID();
  const testUserId = '30ed6381-0d2f-4d4a-a2f6-d8e0ac07452c';

  try {
    // =========================================================================
    // 1. PageRenderer Tests
    // =========================================================================
    console.log('--- Testing PageRenderer ---');
    const renderer = new PageRenderer();
    const rendered150 = await renderer.renderPage(testDocId, pdfBuffer, 'application/pdf', {
      pageNumber: 1,
      dpi: 150,
    });

    assertTest(rendered150.width > 0 && rendered150.height > 0, 'PageRenderer', 'Renders page with positive dimensions');
    assertTest(rendered150.imageBuffer.length > 500, 'PageRenderer Buffer', 'Generates valid PNG buffer (>500 bytes)');
    assertTest(rendered150.dpi === 150, 'PageRenderer DPI', 'Preserves target DPI = 150');

    // Test caching
    const cachedRender = await renderer.renderPage(testDocId, pdfBuffer, 'application/pdf', {
      pageNumber: 1,
      dpi: 150,
    });
    assertTest(cachedRender === rendered150, 'PageRenderer Caching', 'Returns cached RenderedPage instance');

    // =========================================================================
    // 2. RegionExtractor Tests
    // =========================================================================
    console.log('\n--- Testing RegionExtractor ---');
    const extractor = new RegionExtractor();
    const snippetOrig = await extractor.extractRegion(
      'cell-1',
      rendered150,
      { x: 50, y: 120, width: 120, height: 40, unit: 'point' },
      { variant: 'original', paddingPx: 6 }
    );

    assertTest(snippetOrig.imageBuffer.length > 100, 'RegionExtractor Original', 'Crops region to PNG buffer');
    assertTest(snippetOrig.cropBox.width > 120, 'RegionExtractor Padding', 'Includes padding in cropbox');

    // Test variants
    const snippetEnhanced = await extractor.extractRegion(
      'cell-1',
      rendered150,
      { x: 50, y: 120, width: 120, height: 40, unit: 'point' },
      { variant: 'enhanced_contrast' }
    );
    assertTest(snippetEnhanced.variant === 'enhanced_contrast', 'RegionExtractor Enhanced', 'Generates enhanced contrast variant');

    const snippetBinarized = await extractor.extractRegion(
      'cell-1',
      rendered150,
      { x: 50, y: 120, width: 120, height: 40, unit: 'point' },
      { variant: 'binarized_otsu' }
    );
    assertTest(snippetBinarized.variant === 'binarized_otsu', 'RegionExtractor Binarized', 'Generates binarized Otsu variant');

    // =========================================================================
    // 3. CandidateRevalidator Tests
    // =========================================================================
    console.log('\n--- Testing CandidateRevalidator ---');
    const validNumber = CandidateRevalidator.revalidate('1500000', 'NUMBER', 0.95);
    assertTest(validNumber.isValid === true, 'CandidateRevalidator Valid Number', 'Accepts valid formatted number');
    assertTest(validNumber.normalizedValue === '1500000', 'CandidateRevalidator Normalizer', 'Normalizes to 1500000');

    const invalidDate = CandidateRevalidator.revalidate('32/13/2026', 'DATE', 0.95);
    assertTest(invalidDate.isValid === false, 'CandidateRevalidator Invalid Date', 'Rejects impossible calendar date');
    assertTest(invalidDate.validationStatus === 'REVIEW_REQUIRED', 'CandidateRevalidator Status', 'Assigns REVIEW_REQUIRED on error');

    // =========================================================================
    // 4. ConflictResolutionEngine Tests
    // =========================================================================
    console.log('\n--- Testing ConflictResolutionEngine ---');
    const engine = new ConflictResolutionEngine();

    // Test A: Exact match
    const matchRes = await engine.resolve({
      candidateA: {
        source: 'AZURE_PRIMARY',
        rawValue: '100',
        validationStatus: 'ACCEPTED',
      },
      candidateB: {
        provider: 'mock-ocr',
        providerVersion: 'v1',
        rawValue: '100',
        confidenceScore: 0.98,
        confidenceSource: 'AZURE_MODEL',
        attemptStatus: 'COMPLETED',
      },
      cellType: 'NUMBER',
      context: { cellId: 'c1', documentId: testDocId, pageNumber: 1, rowIndex: 0, columnIndex: 0 },
    });
    assertTest(matchRes.resolutionStatus === 'RESOLVED' && matchRes.reasonCode === 'EXACT_MATCH', 'ConflictEngine Exact Match', 'Resolves deterministically on exact match');

    // Test B: Secondary OCR fixes defect (Candidate A was "1OO" -> Candidate B is "100")
    const fixRes = await engine.resolve({
      candidateA: {
        source: 'AZURE_PRIMARY',
        rawValue: '1OO', // Letter O instead of zero
        validationStatus: 'REVIEW_REQUIRED',
      },
      candidateB: {
        provider: 'mock-ocr',
        providerVersion: 'v1',
        rawValue: '100',
        confidenceScore: 0.99,
        confidenceSource: 'AZURE_MODEL',
        attemptStatus: 'COMPLETED',
      },
      cellType: 'NUMBER',
      context: { cellId: 'c2', documentId: testDocId, pageNumber: 1, rowIndex: 0, columnIndex: 0 },
    });
    assertTest(
      fixRes.resolutionStatus === 'RESOLVED' && fixRes.reasonCode === 'SECONDARY_OCR_CORRECTED_DEFECT',
      'ConflictEngine Defect Fix',
      'Selects Candidate B when it resolves validation error'
    );
    assertTest(fixRes.finalRawValue === '100', 'ConflictEngine Corrected Value', 'Sets finalRawValue to 100');

    // =========================================================================
    // 5. SecondaryOcrCoordinator Live Integration on Supabase
    // =========================================================================
    console.log('\n--- Testing SecondaryOcrCoordinator Live on Supabase ---');
    await db.createDocument({
      id: testDocId,
      user_id: testUserId,
      file_name: 'test_secondary_ocr.pdf',
      status: 'REVIEW_REQUIRED',
    });

    const tableId = crypto.randomUUID();
    await client.from('extracted_tables').insert({
      id: tableId,
      document_id: testDocId,
      page_number: 1,
      table_index: 0,
      row_count: 1,
      column_count: 1,
      confidence_score: 0.85,
    });

    const rowId = crypto.randomUUID();
    await client.from('extracted_rows').insert({
      id: rowId,
      table_id: tableId,
      row_index: 0,
    });

    const cellId = crypto.randomUUID();
    await client.from('extracted_cells').insert({
      id: cellId,
      row_id: rowId,
      column_index: 0,
      cell_type: 'NUMBER',
      raw_value: '5OO', // Flawed primary OCR with 'O'
      original_raw_value: '5OO',
      confidence_score: 0.65,
      confidence_source: 'AZURE_CELL',
      validation_status: 'REVIEW_REQUIRED',
      requires_secondary_ocr: true,
      bounding_box: { x: 50, y: 120, width: 120, height: 40, unit: 'point' },
    });

    // Create validation run
    const runId = crypto.randomUUID();
    await client.from('validation_runs').insert({
      id: runId,
      document_id: testDocId,
      status: 'REVIEW_REQUIRED',
      review_required_count: 1,
      warning_count: 0,
      accepted_count: 0,
      validation_version: 'val-v1',
    });

    // Configure mock provider that recognizes "500"
    const mockProvider = new MockSecondaryOcrProvider();
    mockProvider.setMockResponse(cellId, {
      provider: 'mock-test-ocr',
      providerVersion: 'v1.0',
      rawValue: '500',
      confidenceScore: 0.99,
      confidenceSource: 'AZURE_MODEL',
      attemptStatus: 'COMPLETED',
    });

    const coordinator = new SecondaryOcrCoordinator({ provider: mockProvider });
    const coordSummary = await coordinator.processDocumentCells(
      testUserId,
      testDocId,
      pdfBuffer,
      'application/pdf'
    );

    assertTest(coordSummary.processedCount === 1, 'Coordinator Process Count', 'Processed exactly 1 target cell');
    assertTest(coordSummary.resolvedCount === 1, 'Coordinator Resolved Count', 'Resolved exactly 1 cell');

    // Verify cell state in database
    const { data: updatedCell } = await client
      .from('extracted_cells')
      .select('raw_value, original_raw_value, validation_status, resolution_status, resolution_method, requires_secondary_ocr')
      .eq('id', cellId)
      .single();

    assertTest(updatedCell?.raw_value === '500', 'Database Cell Updated', 'raw_value corrected to "500"');
    assertTest(updatedCell?.original_raw_value === '5OO', 'Database Original Preserved', 'original_raw_value kept as "5OO"');
    assertTest(updatedCell?.resolution_status === 'RESOLVED', 'Database Resolution Status', 'resolution_status is RESOLVED');
    assertTest(updatedCell?.resolution_method === 'SECONDARY_OCR', 'Database Resolution Method', 'resolution_method is SECONDARY_OCR');
    assertTest(updatedCell?.validation_status === 'ACCEPTED', 'Database Validation Status', 'validation_status is ACCEPTED');
    assertTest(updatedCell?.requires_secondary_ocr === false, 'Database Secondary Flag', 'requires_secondary_ocr is cleared');

    // Verify candidates in database
    const { data: candidates } = await client
      .from('extraction_candidates')
      .select('candidate_source, raw_value, is_selected')
      .eq('cell_id', cellId);

    assertTest(candidates?.length === 2, 'Candidates Audit Log', 'Audit contains 2 candidates (Primary A and Secondary B)');
    const selectedCand = candidates?.find((c) => c.is_selected);
    assertTest(selectedCand?.candidate_source === 'SECONDARY_OCR' && selectedCand?.raw_value === '500', 'Selected Candidate', 'Secondary candidate B is marked selected');

    // Verify resolution event in database
    const { data: events } = await client
      .from('extraction_resolution_events')
      .select('*')
      .eq('cell_id', cellId);

    assertTest(events?.length === 1, 'Resolution Event Log', 'Event recorded in append-only log');
    assertTest(events?.[0].resolution_method === 'SECONDARY_OCR', 'Event Method', 'Event recorded method as SECONDARY_OCR');

    console.log(`\n================================================================`);
    console.log(`   ALL PHASE 7 SECONDARY OCR TESTS PASSED: ${passedCount}/${passedCount}`);
    console.log(`================================================================\n`);
  } finally {
    // Cleanup
    await client.from('documents').delete().eq('id', testDocId);
    console.log('Cleanup finished.\n');
  }
}

runPhase7Tests().catch((err) => {
  console.error('\n❌ PHASE 7 TEST RUNNER CRASHED:', err);
  process.exit(1);
});
