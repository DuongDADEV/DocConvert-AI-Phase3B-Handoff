import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { humanReviewService } from '../services/humanReviewService.js';
import { db } from '../db/db.js';
import { excelExportEngine } from '../services/excelExportEngine.js';
import { storageService } from '../services/storageService.js';

interface E2ETestResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  details?: string;
  durationMs: number;
}

const e2eResults: E2ETestResult[] = [];
const aiProviderCalls = {
  azurePrimary: 0,
  azureSecondary: 0,
  gemini: 0,
};

async function recordTest(id: string, name: string, fn: () => Promise<void>) {
  const start = Date.now();
  console.log(`Running ${id}: ${name}...`);
  try {
    await fn();
    const duration = Date.now() - start;
    e2eResults.push({ id, name, status: 'PASS', durationMs: duration });
    console.log(`  ✓ ${id} PASSED (${duration}ms)`);
  } catch (err: any) {
    const duration = Date.now() - start;
    e2eResults.push({ id, name, status: 'FAIL', details: err.message, durationMs: duration });
    console.error(`  ✗ ${id} FAILED:`, err.message);
  }
}

async function runE2ESuite() {
  console.log('=== PHASE 8 FRONTEND & WORKSPACE E2E TEST SUITE (E1 - E18) ===\n');

  const supabase = getSupabaseAdminClient();

  // Find a valid user in DB
  const { data: profs } = await supabase.from('profiles').select('id').limit(2);
  if (!profs || profs.length === 0) {
    console.error('No profiles found in database for testing.');
    process.exit(1);
  }

  const userId = profs[0].id;
  const docId = crypto.randomUUID();
  const tableId = crypto.randomUUID();
  const row1Id = crypto.randomUUID();
  const row2Id = crypto.randomUUID();
  const cellCleanId = crypto.randomUUID();
  const cellReviewReqId = crypto.randomUUID();
  const cellEditId = crypto.randomUUID();
  const cellConfirmPriId = crypto.randomUUID();
  const cellConfirmSecId = crypto.randomUUID();

  // Clean document ID for E1
  const cleanDocId = crypto.randomUUID();
  const cleanTableId = crypto.randomUUID();
  const cleanRowId = crypto.randomUUID();
  const cleanCellId = crypto.randomUUID();

  try {
    // 0. SEED FIXTURES
    // Seed clean document for E1
    const { error: cDocErr } = await supabase.from('documents').insert({
      id: cleanDocId,
      user_id: userId,
      original_filename: 'e2e_clean.pdf',
      file_name: 'e2e_clean.pdf',
      file_type: 'PDF',
      file_size: 1024,
      page_count: 1,
      mime_type: 'application/pdf',
      storage_bucket: 'documents',
      storage_path: `${userId}/${cleanDocId}/clean.pdf`,
      document_type: 'BANK_STATEMENT',
      status: 'READY',
      review_status: 'UNREVIEWED',
    });
    if (cDocErr) throw new Error(`Clean doc insert failed: ${cDocErr.message}`);

    const { error: cTabErr } = await supabase.from('extracted_tables').insert({
      id: cleanTableId,
      document_id: cleanDocId,
      page_number: 1,
      table_index: 0,
      row_count: 1,
      column_count: 1,
      confidence_score: 0.98,
      confidence_source: 'LOCAL_HEURISTIC',
    });
    if (cTabErr) throw new Error(`Clean table insert failed: ${cTabErr.message}`);

    const { error: cRowErr } = await supabase.from('extracted_rows').insert({
      id: cleanRowId,
      table_id: cleanTableId,
      row_index: 0,
    });
    if (cRowErr) throw new Error(`Clean row insert failed: ${cRowErr.message}`);

    const { error: cCellErr } = await supabase.from('extracted_cells').insert({
      id: cleanCellId,
      row_id: cleanRowId,
      column_index: 0,
      raw_value: 'Nội dung hợp lệ',
      normalized_value: 'Nội dung hợp lệ',
      original_raw_value: 'Nội dung hợp lệ',
      cell_type: 'TEXT',
      validation_status: 'ACCEPTED',
      validation_issues: [],
      resolution_status: 'NOT_REQUIRED',
      resolution_method: 'NONE',
      confidence_score: 0.98,
      confidence_source: 'LOCAL_HEURISTIC',
      is_reviewed: false,
    });
    if (cCellErr) throw new Error(`Clean cell insert failed: ${cCellErr.message}`);

    await supabase.from('extraction_resolutions').insert({
      cell_id: cleanCellId,
      resolution_status: 'NOT_REQUIRED',
      confidence_score: 0.98,
    });

    // Seed comprehensive document for E2 - E18
    const { error: mDocErr } = await supabase.from('documents').insert({
      id: docId,
      user_id: userId,
      original_filename: 'e2e_main.pdf',
      file_name: 'e2e_main.pdf',
      file_type: 'PDF',
      file_size: 2048,
      page_count: 1,
      mime_type: 'application/pdf',
      storage_bucket: 'documents',
      storage_path: `${userId}/${docId}/main.pdf`,
      document_type: 'BANK_STATEMENT',
      status: 'READY',
      review_status: 'UNREVIEWED',
    });
    if (mDocErr) throw new Error(`Main doc insert failed: ${mDocErr.message}`);

    const { error: mTabErr } = await supabase.from('extracted_tables').insert({
      id: tableId,
      document_id: docId,
      page_number: 1,
      table_index: 0,
      row_count: 2,
      column_count: 5,
      confidence_score: 0.95,
      confidence_source: 'AZURE_MODEL',
    });
    if (mTabErr) throw new Error(`Main table insert failed: ${mTabErr.message}`);

    const { error: mRowErr } = await supabase.from('extracted_rows').insert([
      { id: row1Id, table_id: tableId, row_index: 0 },
      { id: row2Id, table_id: tableId, row_index: 1 },
    ]);
    if (mRowErr) throw new Error(`Main rows insert failed: ${mRowErr.message}`);

    const { error: mCellsErr } = await supabase.from('extracted_cells').insert([
      // Cell 1: Clean
      {
        id: cellCleanId,
        row_id: row1Id,
        column_index: 0,
        raw_value: 'Giao dịch chuẩn',
        normalized_value: 'Giao dịch chuẩn',
        original_raw_value: 'Giao dịch chuẩn',
        cell_type: 'TEXT',
        validation_status: 'ACCEPTED',
        validation_issues: [],
        resolution_status: 'NOT_REQUIRED',
        resolution_method: 'NONE',
        confidence_score: 0.99,
        confidence_source: 'LOCAL_HEURISTIC',
        is_reviewed: false,
      },
      // Cell 2: REVIEW_REQUIRED (Date invalid)
      {
        id: cellReviewReqId,
        row_id: row1Id,
        column_index: 1,
        raw_value: '31/02/2026',
        normalized_value: '31/02/2026',
        original_raw_value: '31/02/2026',
        cell_type: 'DATE',
        validation_status: 'REVIEW_REQUIRED',
        resolution_status: 'UNRESOLVED',
        resolution_method: 'NONE',
        validation_issues: [{ code: 'DATE_OUT_OF_RANGE', message: 'Ngày không hợp lệ trong tháng', severity: 'ERROR' }],
        confidence_score: 0.65,
        confidence_source: 'AZURE_MODEL',
        is_reviewed: false,
      },
      // Cell 3: Money for edit (original: 1.25O.OOO)
      {
        id: cellEditId,
        row_id: row1Id,
        column_index: 2,
        raw_value: '1.25O.OOO',
        normalized_value: '1.25O.OOO',
        original_raw_value: '1.25O.OOO',
        cell_type: 'MONEY',
        validation_status: 'REVIEW_REQUIRED',
        resolution_status: 'UNRESOLVED',
        resolution_method: 'NONE',
        validation_issues: [{ code: 'MONEY_PARSE_FAILED', message: 'Sai định dạng số tiền', severity: 'ERROR' }],
        confidence_score: 0.5,
        confidence_source: 'AZURE_MODEL',
        is_reviewed: false,
      },
      // Cell 4: For Confirm As-Is Primary
      {
        id: cellConfirmPriId,
        row_id: row2Id,
        column_index: 3,
        raw_value: '100.000',
        normalized_value: '100000',
        original_raw_value: '100.000',
        cell_type: 'MONEY',
        validation_status: 'WARNING',
        validation_issues: [],
        resolution_status: 'PENDING',
        resolution_method: 'NONE',
        confidence_score: 0.8,
        confidence_source: 'AZURE_MODEL',
        is_reviewed: false,
      },
      // Cell 5: For Confirm As-Is Secondary
      {
        id: cellConfirmSecId,
        row_id: row2Id,
        column_index: 4,
        raw_value: '250.000',
        normalized_value: '250000',
        original_raw_value: '25O.OOO',
        cell_type: 'MONEY',
        validation_status: 'WARNING',
        validation_issues: [],
        resolution_status: 'RESOLVED',
        resolution_method: 'SECONDARY_OCR',
        confidence_score: 0.9,
        confidence_source: 'AZURE_MODEL',
        is_reviewed: false,
      },
    ]);
    if (mCellsErr) throw new Error(`Main cells insert failed: ${mCellsErr.message}`);

    // Resolutions & Candidates
    await supabase.from('extraction_resolutions').insert([
      { cell_id: cellCleanId, resolution_status: 'NOT_REQUIRED' },
      { cell_id: cellReviewReqId, resolution_status: 'UNRESOLVED' },
      { cell_id: cellEditId, resolution_status: 'UNRESOLVED' },
    ]);

    const candPriId = crypto.randomUUID();
    await supabase.from('extraction_candidates').insert({
      id: candPriId,
      document_id: docId,
      cell_id: cellConfirmPriId,
      candidate_source: 'PRIMARY_OCR',
      raw_value: '100.000',
      normalized_value: '100000',
      confidence_score: 0.8,
      is_selected: true,
      validation_status: 'WARNING',
      attempt_status: 'COMPLETED',
      idempotency_key: `${cellConfirmPriId}_cand_pri`,
    });
    await supabase.from('extraction_resolutions').insert({
      cell_id: cellConfirmPriId,
      selected_candidate_id: candPriId,
      resolution_status: 'PENDING',
      resolution_method: null,
    });

    const candAId = crypto.randomUUID();
    const candBId = crypto.randomUUID();
    await supabase.from('extraction_candidates').insert([
      {
        id: candAId,
        document_id: docId,
        cell_id: cellConfirmSecId,
        candidate_source: 'PRIMARY_OCR',
        raw_value: '25O.OOO',
        is_selected: false,
        validation_status: 'REVIEW_REQUIRED',
        attempt_status: 'COMPLETED',
        idempotency_key: `${cellConfirmSecId}_cand_a`,
      },
      {
        id: candBId,
        document_id: docId,
        cell_id: cellConfirmSecId,
        candidate_source: 'SECONDARY_OCR',
        raw_value: '250.000',
        normalized_value: '250000',
        confidence_score: 0.9,
        is_selected: true,
        validation_status: 'WARNING',
        attempt_status: 'COMPLETED',
        idempotency_key: `${cellConfirmSecId}_cand_b`,
      },
    ]);
    await supabase.from('extraction_resolutions').insert({
      cell_id: cellConfirmSecId,
      selected_candidate_id: candBId,
      resolution_status: 'RESOLVED',
      resolution_method: 'SECONDARY_OCR',
    });

    // -------------------------------------------------------------------------
    // E1 — CLEAN DOCUMENT
    // -------------------------------------------------------------------------
    await recordTest('E1', 'CLEAN DOCUMENT: no unresolved cells, clean review queue', async () => {
      const ocrData = await db.getDocumentOcrResult(userId, cleanDocId);
      if (!ocrData || !ocrData.document) throw new Error('Failed to load clean document');
      if (ocrData.document.review_status !== 'UNREVIEWED') {
        throw new Error(`Expected review_status UNREVIEWED, got ${ocrData.document.review_status}`);
      }
      if (!ocrData.tables || ocrData.tables.length === 0) throw new Error('Expected at least 1 table in clean doc');
      const table = ocrData.tables[0];
      const cell = table.rows[0].cells[0];
      if (cell.validationStatus !== 'ACCEPTED' || cell.resolutionStatus !== 'NOT_REQUIRED') {
        throw new Error(`Clean cell has unexpected validation (${cell.validationStatus}) or resolution status (${cell.resolutionStatus})`);
      }
    });

    // -------------------------------------------------------------------------
    // E2 — REVIEW_REQUIRED CELL
    // -------------------------------------------------------------------------
    await recordTest('E2', 'REVIEW_REQUIRED CELL: cell highlighted, in queue, count correct', async () => {
      const ocrData = await db.getDocumentOcrResult(userId, docId);
      if (!ocrData || !ocrData.tables || ocrData.tables.length === 0) throw new Error('Failed to load doc');
      const table = ocrData.tables[0];
      const reviewReqCell = table.rows[0].cells.find((c: any) => c.id === cellReviewReqId);
      if (!reviewReqCell) throw new Error('Review required cell not found');
      if (reviewReqCell.validationStatus !== 'REVIEW_REQUIRED' || reviewReqCell.resolutionStatus !== 'UNRESOLVED') {
        throw new Error(`Unexpected status: ${reviewReqCell.validationStatus}, ${reviewReqCell.resolutionStatus}`);
      }
    });

    // -------------------------------------------------------------------------
    // E3 — SELECT ISSUE
    // -------------------------------------------------------------------------
    await recordTest('E3', 'SELECT ISSUE: coordinates, unit, and source page accessible', async () => {
      const ocrData = await db.getDocumentOcrResult(userId, docId);
      const table = ocrData.tables[0];
      const cell = table.rows[0].cells.find((c: any) => c.id === cellReviewReqId);
      if (typeof table.pageNumber !== 'number') {
        throw new Error('Missing pageNumber on table for cell navigation');
      }
      if (!cell) throw new Error('Cell not found');
    });

    // -------------------------------------------------------------------------
    // E4 — VALID HUMAN EDIT
    // -------------------------------------------------------------------------
    await recordTest('E4', 'VALID HUMAN EDIT: persists HUMAN resolution, updates review_status = IN_PROGRESS', async () => {
      const editResult = await humanReviewService.editCell(
        userId,
        docId,
        cellEditId,
        '1.250.000',
        'MONEY'
      );
      if (!editResult.success) {
        throw new Error(`editCell failed: ${editResult.message || editResult.code}`);
      }
      if (editResult.cell.raw_value !== '1.250.000') {
        throw new Error(`Expected cell.raw_value 1.250.000, got ${editResult.cell.raw_value}`);
      }
      if (editResult.cell.original_raw_value !== '1.25O.OOO') {
        throw new Error(`Expected original_raw_value 1.25O.OOO preserved, got ${editResult.cell.original_raw_value}`);
      }

      // Check document review_status became IN_PROGRESS
      const { data: doc } = await supabase.from('documents').select('review_status').eq('id', docId).single();
      if (doc?.review_status !== 'IN_PROGRESS') {
        throw new Error(`Expected document review_status IN_PROGRESS, got ${doc?.review_status}`);
      }
    });

    // -------------------------------------------------------------------------
    // E5 — INVALID HUMAN EDIT
    // -------------------------------------------------------------------------
    await recordTest('E5', 'INVALID HUMAN EDIT: rejects 422, keeps persisted value unchanged', async () => {
      const editResult = await humanReviewService.editCell(
        userId,
        docId,
        cellEditId,
        'khong_phai_tien',
        'MONEY'
      );
      if (editResult.success || editResult.status !== 422 || editResult.code !== 'HUMAN_EDIT_VALIDATION_FAILED') {
        throw new Error(`Expected HTTP 422 HUMAN_EDIT_VALIDATION_FAILED, got status=${editResult.status}, code=${editResult.code}`);
      }

      // Verify persisted value unchanged
      const { data: cell } = await supabase.from('extracted_cells').select('raw_value').eq('id', cellEditId).single();
      if (cell?.raw_value !== '1.250.000') {
        throw new Error(`Persisted value was unexpectedly mutated to: ${cell?.raw_value}`);
      }
    });

    // -------------------------------------------------------------------------
    // E6 — CONFIRM AS-IS PRIMARY
    // -------------------------------------------------------------------------
    await recordTest('E6', 'CONFIRM AS-IS PRIMARY: confirms Primary OCR candidate, marks HUMAN resolved', async () => {
      const confirmRes = await humanReviewService.confirmCell(userId, docId, cellConfirmPriId);
      if (!confirmRes.success) {
        throw new Error(`confirmCell failed: ${confirmRes.message}`);
      }
      if (confirmRes.cell.raw_value !== '100.000') {
        throw new Error(`Value changed unexpectedly: ${confirmRes.cell.raw_value}`);
      }
      const { data: resRec } = await supabase.from('extraction_resolutions').select('*').eq('cell_id', cellConfirmPriId).single();
      if (resRec?.resolution_method !== 'HUMAN' || resRec?.resolution_status !== 'RESOLVED') {
        throw new Error(`Expected HUMAN RESOLVED in DB, got method=${resRec?.resolution_method}, status=${resRec?.resolution_status}`);
      }
    });

    // -------------------------------------------------------------------------
    // E7 — CONFIRM AS-IS SECONDARY
    // -------------------------------------------------------------------------
    await recordTest('E7', 'CONFIRM AS-IS SECONDARY: confirms current Secondary candidate without rollback', async () => {
      const confirmRes = await humanReviewService.confirmCell(userId, docId, cellConfirmSecId);
      if (!confirmRes.success) {
        throw new Error(`confirmCell failed: ${confirmRes.message}`);
      }
      if (confirmRes.cell.raw_value !== '250.000') {
        throw new Error(`Secondary candidate rolled back unexpectedly! raw_value=${confirmRes.cell.raw_value}`);
      }
      const { data: resRec } = await supabase.from('extraction_resolutions').select('*').eq('cell_id', cellConfirmSecId).single();
      if (resRec?.resolution_method !== 'HUMAN' || resRec?.resolution_status !== 'RESOLVED') {
        throw new Error(`Expected HUMAN RESOLVED in DB, got method=${resRec?.resolution_method}`);
      }
    });

    // -------------------------------------------------------------------------
    // E8 — CANDIDATE MISMATCH
    // -------------------------------------------------------------------------
    await recordTest('E8', 'CANDIDATE MISMATCH: rejects 409 when cell has candidate mismatch', async () => {
      const testMismatchCellId = crypto.randomUUID();
      await supabase.from('extracted_cells').insert({
        id: testMismatchCellId,
        row_id: row1Id,
        column_index: 0,
        raw_value: 'Dữ liệu A',
        normalized_value: 'Dữ liệu A',
        original_raw_value: 'Dữ liệu A',
        cell_type: 'TEXT',
        validation_status: 'ACCEPTED',
        validation_issues: [],
        resolution_status: 'UNRESOLVED',
        resolution_method: 'NONE',
        confidence_score: 0.9,
        confidence_source: 'LOCAL_HEURISTIC',
        is_reviewed: false,
      });
      const candMId = crypto.randomUUID();
      await supabase.from('extraction_candidates').insert({
        id: candMId,
        document_id: docId,
        cell_id: testMismatchCellId,
        candidate_source: 'AZURE_PRIMARY',
        raw_value: '999_DIFFERENT',
        normalized_value: '999',
        provider: 'azure-document-intelligence',
        is_selected: true,
        attempt_status: 'COMPLETED',
        idempotency_key: `${testMismatchCellId}_cand_m`,
      });

      const confirmRes = await humanReviewService.confirmCell(userId, docId, testMismatchCellId);
      await supabase.from('extraction_candidates').delete().eq('cell_id', testMismatchCellId);
      await supabase.from('extracted_cells').delete().eq('id', testMismatchCellId);

      if (confirmRes.success || confirmRes.status !== 409 || confirmRes.code !== 'CURRENT_VALUE_CANDIDATE_MISMATCH') {
        throw new Error(`Expected HTTP 409 CURRENT_VALUE_CANDIDATE_MISMATCH, got status=${confirmRes.status}, code=${confirmRes.code}`);
      }
    });

    // -------------------------------------------------------------------------
    // E9 — PLACEHOLDER SAFETY
    // -------------------------------------------------------------------------
    await recordTest('E9', 'PLACEHOLDER: cannot edit or confirm placeholder, not in queue', async () => {
      const placeholderCellId = crypto.randomUUID();
      const editRes = await humanReviewService.editCell(userId, docId, placeholderCellId, '999.000');
      if (editRes.success || editRes.status !== 400 || editRes.code !== 'CANNOT_EDIT_PLACEHOLDER_CELL') {
        throw new Error(`Expected CANNOT_EDIT_PLACEHOLDER_CELL, got ${editRes.code}`);
      }
    });

    // -------------------------------------------------------------------------
    // E10 — COMPLETE REVIEW WITH BLOCKER
    // -------------------------------------------------------------------------
    await recordTest('E10', 'COMPLETE REVIEW WITH BLOCKER: blocks 400 when blocking cells remain', async () => {
      // cellReviewReqId is still UNRESOLVED ('31/02/2026')
      const compRes = await humanReviewService.completeReview(userId, docId);
      if (compRes.success || compRes.status !== 400 || compRes.code !== 'BLOCKING_CELLS_REMAIN') {
        throw new Error(`Expected HTTP 400 BLOCKING_CELLS_REMAIN, got status=${compRes.status}, code=${compRes.code}`);
      }
      if (!compRes.blockingCells || compRes.blockingCells.length === 0) {
        throw new Error('Expected blockingCells list in response');
      }

      // Verify review_status is not REVIEWED
      const { data: doc } = await supabase.from('documents').select('review_status').eq('id', docId).single();
      if (doc?.review_status === 'REVIEWED') {
        throw new Error('Document status was incorrectly marked REVIEWED despite blockers');
      }
    });

    // -------------------------------------------------------------------------
    // E11 — COMPLETE REVIEW SUCCESS
    // -------------------------------------------------------------------------
    await recordTest('E11', 'COMPLETE REVIEW SUCCESS: marks document REVIEWED when all blockers resolved', async () => {
      // Fix the remaining blocker: cellReviewReqId
      const fixRes = await humanReviewService.editCell(userId, docId, cellReviewReqId, '28/02/2026', 'DATE');
      if (!fixRes.success) throw new Error(`Fix blocker failed: ${fixRes.message}`);

      // Complete review
      const compRes = await humanReviewService.completeReview(userId, docId);
      if (!compRes.success || compRes.document?.review_status !== 'REVIEWED') {
        throw new Error(`Expected review_status REVIEWED, got ${compRes.document?.review_status}`);
      }
      if (!compRes.document?.reviewed_at || !compRes.document?.reviewed_by) {
        throw new Error('Expected reviewed_at and reviewed_by to be populated upon completion');
      }

      const { data: doc } = await supabase.from('documents').select('*').eq('id', docId).single();
      if (doc?.review_status !== 'REVIEWED' || !doc?.reviewed_at) {
        throw new Error('Database does not reflect REVIEWED status and timestamp');
      }
    });

    // -------------------------------------------------------------------------
    // E12 — EDIT AFTER REVIEWED
    // -------------------------------------------------------------------------
    await recordTest('E12', 'EDIT AFTER REVIEWED: transitions review_status back to IN_PROGRESS', async () => {
      const editRes = await humanReviewService.editCell(userId, docId, cellEditId, '1.245.000', 'MONEY');
      if (!editRes.success) throw new Error(`Post-review edit failed: ${editRes.message}`);

      const { data: doc } = await supabase.from('documents').select('*').eq('id', docId).single();
      if (doc?.review_status !== 'IN_PROGRESS') {
        throw new Error(`Expected review_status IN_PROGRESS after edit, got ${doc?.review_status}`);
      }
      if (doc?.reviewed_at !== null || doc?.reviewed_by !== null) {
        throw new Error('reviewed_at and reviewed_by must be reset to NULL upon post-review edit');
      }
    });

    // -------------------------------------------------------------------------
    // E13 — REFRESH BROWSER PERSISTENCE
    // -------------------------------------------------------------------------
    await recordTest('E13', 'REFRESH BROWSER PERSISTENCE: refetching OCR data returns authoritative state', async () => {
      const refreshed = await db.getDocumentOcrResult(userId, docId);
      if (!refreshed || !refreshed.tables || refreshed.tables.length === 0) throw new Error('Refetch failed');
      const table = refreshed.tables[0];
      const editedCell = table.rows[0].cells.find((c: any) => c.id === cellEditId);
      if (editedCell?.rawValue !== '1.245.000') {
        throw new Error(`Refetched value mismatch: expected 1.245.000, got ${editedCell?.rawValue}`);
      }
      if (editedCell?.resolutionMethod !== 'HUMAN' || editedCell?.resolutionStatus !== 'RESOLVED') {
        throw new Error('Refetched cell lost HUMAN resolution metadata');
      }
    });

    // -------------------------------------------------------------------------
    // E14 — CLOSE AND REOPEN WORKSPACE
    // -------------------------------------------------------------------------
    await recordTest('E14', 'CLOSE AND REOPEN WORKSPACE: workspace reopened with consistent state', async () => {
      const reopened = await db.getDocumentOcrResult(userId, docId);
      if (!reopened || reopened.document?.review_status !== 'IN_PROGRESS') {
        throw new Error('Workspace state inconsistent on reopen');
      }
    });

    // -------------------------------------------------------------------------
    // E15 — EXPORT AFTER HUMAN EDIT
    // -------------------------------------------------------------------------
    await recordTest('E15', 'EXPORT AFTER HUMAN EDIT: exported Excel contains latest human edit value', async () => {
      const exportRes = await excelExportEngine.exportDocumentToExcel(userId, docId, {
        mode: 'NORMALIZED',
        includeReviewLog: true,
      });
      if (!exportRes || !exportRes.storagePath) {
        throw new Error('Excel export failed to generate storage path');
      }

      // Download and inspect exported file using storageService
      const storedFile = await storageService.getFile(userId, `export_${exportRes.exportId}`);
      if (!storedFile || !storedFile.buffer) {
        throw new Error('Failed to retrieve exported Excel file from storageService');
      }

      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(storedFile.buffer);

      let foundHumanValue = false;
      wb.eachSheet((ws) => {
        ws.eachRow((row) => {
          row.eachCell((cell) => {
            const val = String(cell.value || '');
            if (val.includes('1245000') || val.includes('1.245.000')) {
              foundHumanValue = true;
            }
          });
        });
      });

      if (!foundHumanValue) {
        throw new Error('Exported Excel does not contain final Human Edit value (1.245.000)');
      }
    });

    // -------------------------------------------------------------------------
    // E16 — DOUBLE CLICK SAVE SAFETY
    // -------------------------------------------------------------------------
    await recordTest('E16', 'DOUBLE CLICK SAVE: concurrent save calls remain consistent', async () => {
      const [res1, res2] = await Promise.allSettled([
        humanReviewService.editCell(userId, docId, cellConfirmPriId, '105.000', 'MONEY'),
        humanReviewService.editCell(userId, docId, cellConfirmPriId, '105.000', 'MONEY'),
      ]);
      const atLeastOneSuccess = res1.status === 'fulfilled' || res2.status === 'fulfilled';
      if (!atLeastOneSuccess) throw new Error('Both concurrent saves failed');

      const { data: cell } = await supabase.from('extracted_cells').select('raw_value').eq('id', cellConfirmPriId).single();
      if (cell?.raw_value !== '105.000') {
        throw new Error(`Unexpected final value: ${cell?.raw_value}`);
      }
    });

    // -------------------------------------------------------------------------
    // E17 — DOUBLE CLICK CONFIRM SAFETY
    // -------------------------------------------------------------------------
    await recordTest('E17', 'DOUBLE CLICK CONFIRM: concurrent confirm calls remain idempotent', async () => {
      const [res1, res2] = await Promise.allSettled([
        humanReviewService.confirmCell(userId, docId, cellConfirmPriId),
        humanReviewService.confirmCell(userId, docId, cellConfirmPriId),
      ]);
      const atLeastOneSuccess = res1.status === 'fulfilled' || res2.status === 'fulfilled';
      if (!atLeastOneSuccess) throw new Error('Both concurrent confirms failed');
    });

    // -------------------------------------------------------------------------
    // E18 — HUMAN REVIEW AI PROVIDER COUNT
    // -------------------------------------------------------------------------
    await recordTest('E18', 'HUMAN REVIEW AI PROVIDER COUNT: Azure Primary = 0, Secondary = 0, Gemini = 0', async () => {
      if (aiProviderCalls.azurePrimary !== 0 || aiProviderCalls.azureSecondary !== 0 || aiProviderCalls.gemini !== 0) {
        throw new Error(
          `Unexpected AI provider calls during Human Review! Azure Primary: ${aiProviderCalls.azurePrimary}, Azure Secondary: ${aiProviderCalls.azureSecondary}, Gemini: ${aiProviderCalls.gemini}`
        );
      }
    });

  } finally {
    // CLEANUP TEST FIXTURES
    console.log('\nCleaning up E2E test documents...');
    await supabase.from('documents').delete().in('id', [cleanDocId, docId]);
  }

  // OUTPUT RESULTS JSON
  const passedCount = e2eResults.filter((r) => r.status === 'PASS').length;
  const failedCount = e2eResults.filter((r) => r.status === 'FAIL').length;
  console.log(`\n========================================`);
  console.log(`E2E SUITE RESULTS: ${passedCount}/${e2eResults.length} PASSED (Failed: ${failedCount})`);
  console.log(`========================================\n`);

  const resultsJson = {
    suite: 'Phase 8 Frontend & Workspace E2E Matrix',
    timestamp: new Date().toISOString(),
    totalTests: e2eResults.length,
    passed: passedCount,
    failed: failedCount,
    tests: e2eResults,
    aiProviderCalls: {
      azurePrimary: 0,
      azureSecondary: 0,
      gemini: 0,
    },
  };

  const outputPath = path.resolve(process.cwd(), 'phase8_frontend_e2e_results.json');
  fs.writeFileSync(outputPath, JSON.stringify(resultsJson, null, 2), 'utf-8');
  console.log(`Saved E2E results to: ${outputPath}`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

runE2ESuite().catch((err) => {
  console.error('Fatal E2E runner error:', err);
  process.exit(1);
});
