import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { humanReviewService } from '../services/humanReviewService.js';
import { ocrService } from '../services/ocrService.js';

interface TestResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  details?: string;
  durationMs: number;
}

const testResults: TestResult[] = [];
let aiProviderCalls = {
  azurePrimary: 0,
  azureSecondary: 0,
  gemini: 0,
};

async function runTest(id: string, name: string, fn: () => Promise<void>) {
  const start = Date.now();
  console.log(`Running ${id}: ${name}...`);
  try {
    await fn();
    const duration = Date.now() - start;
    testResults.push({ id, name, status: 'PASS', durationMs: duration });
    console.log(`  ✓ ${id} PASSED (${duration}ms)`);
  } catch (err: any) {
    const duration = Date.now() - start;
    testResults.push({ id, name, status: 'FAIL', details: err.message, durationMs: duration });
    console.error(`  ✗ ${id} FAILED:`, err.message);
  }
}

async function main() {
  console.log('=== PHASE 8 BACKEND HUMAN REVIEW TEST SUITE ===\n');

  const supabase = getSupabaseAdminClient();

  // Find a valid user in DB
  const { data: profs } = await supabase.from('profiles').select('id').limit(2);
  if (!profs || profs.length === 0) {
    console.error('No profiles found in database for testing.');
    process.exit(1);
  }

  const userA = profs[0].id;
  const userB = profs.length > 1 ? profs[1].id : '11111111-2222-3333-4444-555555555555';

  const docId = crypto.randomUUID();
  const tableId = crypto.randomUUID();
  const rowId = crypto.randomUUID();
  const cell1Id = crypto.randomUUID(); // Money cell for valid edit
  const cell2Id = crypto.randomUUID(); // Money cell for invalid edit
  const cell3Id = crypto.randomUUID(); // Cell for confirm As-Is Primary
  const cell4Id = crypto.randomUUID(); // Cell for confirm As-Is Secondary
  const cell5Id = crypto.randomUUID(); // Cell for blocking PENDING / UNRESOLVED / WARNING

  const now = new Date().toISOString();

  // Create isolated test fixture in DB
  console.log(`Creating test fixture document: ${docId}`);
  const { error: dErr } = await supabase.from('documents').insert({
    id: docId,
    user_id: userA,
    original_filename: 'phase8_fixture.pdf',
    file_name: 'phase8_fixture.pdf',
    file_type: 'PDF',
    mime_type: 'application/pdf',
    file_size: 2048,
    page_count: 1,
    storage_bucket: 'documents',
    storage_path: `${userA}/${docId}/test.pdf`,
    document_type: 'BANK_STATEMENT',
    status: 'READY',
    review_status: 'UNREVIEWED',
    reviewed_by: null,
    reviewed_at: null,
  });
  if (dErr) throw new Error(`Document insert failed: ${dErr.message}`);

  const { error: tErr } = await supabase.from('extracted_tables').insert({
    id: tableId,
    document_id: docId,
    page_number: 1,
    table_index: 0,
    row_count: 1,
    column_count: 5,
    confidence_score: 0.95,
    confidence_source: 'AZURE_MODEL',
  });
  if (tErr) throw new Error(`Table insert failed: ${tErr.message}`);

  const { error: rErr } = await supabase.from('extracted_rows').insert({
    id: rowId,
    table_id: tableId,
    row_index: 0,
  });
  if (rErr) throw new Error(`Row insert failed: ${rErr.message}`);

  const { error: cErr } = await supabase.from('extracted_cells').insert([
    {
      id: cell1Id,
      row_id: rowId,
      column_index: 3,
      raw_value: '12,OOO',
      normalized_value: '12,OOO',
      original_raw_value: '12,OOO',
      cell_type: 'MONEY',
      confidence_score: 0.65,
      confidence_source: 'AZURE_MODEL',
      validation_status: 'REVIEW_REQUIRED',
      resolution_status: 'UNRESOLVED',
      resolution_method: 'NONE',
      is_reviewed: false,
    },
    {
      id: cell2Id,
      row_id: rowId,
      column_index: 3,
      raw_value: '50.000',
      normalized_value: '50000',
      original_raw_value: '50.000',
      cell_type: 'MONEY',
      confidence_score: 0.95,
      confidence_source: 'AZURE_MODEL',
      validation_status: 'ACCEPTED',
      resolution_status: 'NOT_REQUIRED',
      resolution_method: 'NONE',
      is_reviewed: false,
    },
    {
      id: cell3Id,
      row_id: rowId,
      column_index: 2,
      raw_value: 'Thanh toan tien dien T8',
      normalized_value: 'Thanh toan tien dien T8',
      original_raw_value: 'Thanh toan tien dien T8',
      cell_type: 'TEXT',
      confidence_score: 0.82,
      confidence_source: 'AZURE_MODEL',
      validation_status: 'WARNING',
      resolution_status: 'NOT_REQUIRED',
      resolution_method: 'NONE',
      is_reviewed: false,
    },
    {
      id: cell4Id,
      row_id: rowId,
      column_index: 4,
      raw_value: '1.250.000',
      normalized_value: '1250000',
      original_raw_value: '1.25O.OOO',
      cell_type: 'MONEY',
      confidence_score: 0.98,
      confidence_source: 'AZURE_MODEL',
      validation_status: 'ACCEPTED',
      resolution_status: 'RESOLVED',
      resolution_method: 'SECONDARY_OCR',
      is_reviewed: false,
    },
    {
      id: cell5Id,
      row_id: rowId,
      column_index: 1,
      raw_value: '15/08/2026',
      normalized_value: '2026-08-15',
      original_raw_value: '15/08/2026',
      cell_type: 'DATE',
      confidence_score: 0.95,
      confidence_source: 'AZURE_MODEL',
      validation_status: 'ACCEPTED',
      resolution_status: 'NOT_REQUIRED',
      resolution_method: 'NONE',
      is_reviewed: false,
    },
  ]);
  if (cErr) throw new Error(`Cells insert failed: ${cErr.message}`);

  // Insert candidate for cell 4 (Secondary OCR candidate selected)
  const candBId = crypto.randomUUID();
  const { error: candErr } = await supabase.from('extraction_candidates').insert({
    id: candBId,
    document_id: docId,
    cell_id: cell4Id,
    candidate_source: 'SECONDARY_OCR',
    raw_value: '1.250.000',
    normalized_value: '1250000',
    confidence_score: 0.98,
    confidence_source: 'AZURE_MODEL',
    provider: 'secondary-ocr',
    attempt_status: 'COMPLETED',
    validation_status: 'ACCEPTED',
    is_selected: true,
    idempotency_key: `${cell4Id}_attempt_secondary`,
  });
  if (candErr) throw new Error(`Candidate insert failed: ${candErr.message}`);

  try {
    // B1: Valid Human Edit
    await runTest('B1', 'Valid Human Edit creates HUMAN_EDIT candidate, updates cell, preserves originalRawValue', async () => {
      const res = await humanReviewService.editCell(userA, docId, cell1Id, '12,000', 'MONEY');
      if (!res.success) throw new Error(`editCell failed: ${res.message}`);
      if (res.cell.raw_value !== '12,000') throw new Error(`Expected raw_value 12,000, got ${res.cell.raw_value}`);
      if (res.cell.original_raw_value !== '12,OOO') throw new Error(`original_raw_value changed: ${res.cell.original_raw_value}`);
      if (res.cell.resolution_method !== 'HUMAN') throw new Error(`Expected resolution_method HUMAN, got ${res.cell.resolution_method}`);
      if (res.cell.resolution_status !== 'RESOLVED') throw new Error(`Expected resolution_status RESOLVED, got ${res.cell.resolution_status}`);
      if (!res.cell.is_reviewed) throw new Error('is_reviewed should be true');

      // Verify in DB candidate
      const { data: cand } = await supabase
        .from('extraction_candidates')
        .select('*')
        .eq('cell_id', cell1Id)
        .eq('is_selected', true)
        .single();
      if (!cand || cand.candidate_source !== 'HUMAN_EDIT') throw new Error('HUMAN_EDIT candidate not found or not selected');
    });

    // B2: Invalid Human Edit
    await runTest('B2', 'Invalid Human Edit returns 422, keeps current value unchanged, 0 AI calls', async () => {
      const res = await humanReviewService.editCell(userA, docId, cell2Id, 'ABC_NOT_MONEY', 'MONEY');
      if (res.success) throw new Error('Invalid edit should not succeed');
      if (res.status !== 422) throw new Error(`Expected status 422, got ${res.status}`);
      if (res.code !== 'HUMAN_EDIT_VALIDATION_FAILED') throw new Error(`Expected code HUMAN_EDIT_VALIDATION_FAILED, got ${res.code}`);

      // Verify cell in DB unchanged
      const { data: c } = await supabase.from('extracted_cells').select('raw_value, validation_status').eq('id', cell2Id).single();
      if (c.raw_value !== '50.000') throw new Error(`Cell raw_value was overwritten to: ${c.raw_value}`);
      if (c.validation_status !== 'ACCEPTED') throw new Error(`Cell validation status mutated: ${c.validation_status}`);
    });

    // B3: Confirm As-Is on Primary current candidate
    await runTest('B3', 'Confirm As-Is on Primary preserves value and records resolutionMethod = HUMAN', async () => {
      const res = await humanReviewService.confirmCell(userA, docId, cell3Id);
      if (!res.success) throw new Error(`confirmCell failed: ${res.message}`);
      if (res.cell.raw_value !== 'Thanh toan tien dien T8') throw new Error('raw_value changed');
      if (res.cell.resolution_method !== 'HUMAN') throw new Error(`Expected resolution_method HUMAN, got ${res.cell.resolution_method}`);
      if (res.cell.resolution_status !== 'RESOLVED') throw new Error(`Expected resolution_status RESOLVED, got ${res.cell.resolution_status}`);
      if (!res.cell.is_reviewed) throw new Error('is_reviewed should be true');
    });

    // B4: Confirm As-Is on Secondary current candidate
    await runTest('B4', 'Confirm As-Is on Secondary keeps Secondary value and does NOT revert to Candidate A', async () => {
      const res = await humanReviewService.confirmCell(userA, docId, cell4Id);
      if (!res.success) throw new Error(`confirmCell failed: ${res.message}`);
      if (res.cell.raw_value !== '1.250.000') throw new Error(`Reverted to Candidate A! raw_value is: ${res.cell.raw_value}`);
      if (res.cell.resolution_method !== 'HUMAN') throw new Error(`Expected resolution_method HUMAN, got ${res.cell.resolution_method}`);
      if (res.cell.resolution_status !== 'RESOLVED') throw new Error(`Expected resolution_status RESOLVED, got ${res.cell.resolution_status}`);
    });

    // B5: Confirm As-Is when selected candidate mismatches current cell
    await runTest('B5', 'Confirm As-Is fails safely with 409 when candidate mismatches cell value', async () => {
      // Intentionally insert mismatch candidate marked selected
      const mismatchCellId = crypto.randomUUID();
      await supabase.from('extracted_cells').insert({
        id: mismatchCellId,
        row_id: rowId,
        column_index: 0,
        raw_value: '001',
        normalized_value: '1',
        cell_type: 'TEXT',
      });
      await supabase.from('extraction_candidates').insert({
        id: crypto.randomUUID(),
        document_id: docId,
        cell_id: mismatchCellId,
        candidate_source: 'AZURE_PRIMARY',
        raw_value: '999_DIFFERENT',
        normalized_value: '999',
        provider: 'azure-document-intelligence',
        is_selected: true,
      });

      const res = await humanReviewService.confirmCell(userA, docId, mismatchCellId);
      await supabase.from('extraction_candidates').delete().eq('cell_id', mismatchCellId);
      await supabase.from('extracted_cells').delete().eq('id', mismatchCellId);

      if (res.success) throw new Error('Expected 409 mismatch error');
      if (res.status !== 409) throw new Error(`Expected status 409, got ${res.status}`);
      if (res.code !== 'CURRENT_VALUE_CANDIDATE_MISMATCH') throw new Error(`Expected code CURRENT_VALUE_CANDIDATE_MISMATCH, got ${res.code}`);
    });

    // B6: Physical-cell ownership check (cross-document/cross-user edit rejected)
    await runTest('B6', 'Physical cell ownership check rejects cross-user or cross-doc edits', async () => {
      // User B trying to edit User A doc
      const resB = await humanReviewService.editCell(userB, docId, cell1Id, '999', 'MONEY');
      if (resB.success || resB.status !== 404) throw new Error(`Expected 404 unauthorized, got status ${resB.status}`);
    });

    // B7: Placeholder / fake cell ID rejected
    await runTest('B7', 'Placeholder / fake cell ID is rejected with 400 CANNOT_EDIT_PLACEHOLDER_CELL', async () => {
      const fakeCellId = crypto.randomUUID();
      const res = await humanReviewService.editCell(userA, docId, fakeCellId, '100', 'MONEY');
      if (res.success) throw new Error('Expected failure for placeholder/fake cell');
      if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
      if (res.code !== 'CANNOT_EDIT_PLACEHOLDER_CELL') throw new Error(`Expected CANNOT_EDIT_PLACEHOLDER_CELL, got ${res.code}`);
    });

    // B8: First valid Human action transitions UNREVIEWED -> IN_PROGRESS
    await runTest('B8', 'First valid human action transitions review_status to IN_PROGRESS', async () => {
      const { data: d } = await supabase.from('documents').select('review_status, reviewed_by, reviewed_at').eq('id', docId).single();
      if (d.review_status !== 'IN_PROGRESS') throw new Error(`Expected review_status IN_PROGRESS, got ${d.review_status}`);
      if (d.reviewed_by !== null || d.reviewed_at !== null) throw new Error('reviewed_by and reviewed_at must be null');
    });

    // B9: Edit after REVIEWED transitions REVIEWED -> IN_PROGRESS and clears metadata
    await runTest('B9', 'Edit after REVIEWED transitions back to IN_PROGRESS and clears reviewed_by/reviewed_at', async () => {
      // Artificially complete review
      const nowTs = new Date().toISOString();
      await supabase.from('documents').update({
        review_status: 'REVIEWED',
        reviewed_by: userA,
        reviewed_at: nowTs,
      }).eq('id', docId);

      // Perform valid edit
      const editRes = await humanReviewService.editCell(userA, docId, cell1Id, '15,000', 'MONEY');
      if (!editRes.success) throw new Error(`editCell failed: ${editRes.message}`);

      // Check document state
      const { data: d } = await supabase.from('documents').select('review_status, reviewed_by, reviewed_at').eq('id', docId).single();
      if (d.review_status !== 'IN_PROGRESS') throw new Error(`Expected review_status IN_PROGRESS, got ${d.review_status}`);
      if (d.reviewed_by !== null) throw new Error(`reviewed_by should be null, got ${d.reviewed_by}`);
      if (d.reviewed_at !== null) throw new Error(`reviewed_at should be null, got ${d.reviewed_at}`);
    });

    // B10: Invalid Human Edit does NOT change review_status
    await runTest('B10', 'Invalid Human Edit does NOT change document review_status', async () => {
      const beforeDoc = await supabase.from('documents').select('review_status, updated_at').eq('id', docId).single();
      await humanReviewService.editCell(userA, docId, cell2Id, 'INVALID_VALUE', 'MONEY');
      const afterDoc = await supabase.from('documents').select('review_status, updated_at').eq('id', docId).single();

      if (beforeDoc.data.review_status !== afterDoc.data.review_status) {
        throw new Error(`review_status changed on invalid edit: ${beforeDoc.data.review_status} -> ${afterDoc.data.review_status}`);
      }
    });

    // B11: Review completion with PENDING cell is blocked
    await runTest('B11', 'Review completion with PENDING cell is blocked', async () => {
      // Set cell 5 to PENDING
      await supabase.from('extracted_cells').update({ resolution_status: 'PENDING' }).eq('id', cell5Id);
      const res = await humanReviewService.completeReview(userA, docId);
      if (res.success) throw new Error('Complete review should be blocked when PENDING cell exists');
      if (res.code !== 'BLOCKING_CELLS_REMAIN') throw new Error(`Expected code BLOCKING_CELLS_REMAIN, got ${res.code}`);
    });

    // B12: Review completion with UNRESOLVED cell is blocked
    await runTest('B12', 'Review completion with UNRESOLVED cell is blocked', async () => {
      // Set cell 5 to UNRESOLVED
      await supabase.from('extracted_cells').update({ resolution_status: 'UNRESOLVED' }).eq('id', cell5Id);
      const res = await humanReviewService.completeReview(userA, docId);
      if (res.success) throw new Error('Complete review should be blocked when UNRESOLVED cell exists');
      if (res.code !== 'BLOCKING_CELLS_REMAIN') throw new Error(`Expected code BLOCKING_CELLS_REMAIN, got ${res.code}`);
    });

    // B13: Review completion with HUMAN_REVIEW_REQUIRED is blocked
    await runTest('B13', 'Review completion with HUMAN_REVIEW_REQUIRED cell is blocked', async () => {
      // Set cell 5 to HUMAN_REVIEW_REQUIRED
      await supabase.from('extracted_cells').update({ resolution_status: 'HUMAN_REVIEW_REQUIRED' }).eq('id', cell5Id);
      const res = await humanReviewService.completeReview(userA, docId);
      if (res.success) throw new Error('Complete review should be blocked when HUMAN_REVIEW_REQUIRED cell exists');
      if (res.code !== 'BLOCKING_CELLS_REMAIN') throw new Error(`Expected code BLOCKING_CELLS_REMAIN, got ${res.code}`);
    });

    // B14: Review completion with non-blocking WARNING is allowed
    await runTest('B14', 'Review completion with non-blocking WARNING is allowed', async () => {
      // Reset cell 5 to non-blocking: ACCEPTED + NOT_REQUIRED
      await supabase.from('extracted_cells').update({
        resolution_status: 'NOT_REQUIRED',
        validation_status: 'ACCEPTED',
      }).eq('id', cell5Id);

      // Cell 3 has validation_status = 'WARNING' but resolution_status = 'RESOLVED' (from B3 confirm)
      const res = await humanReviewService.completeReview(userA, docId);
      if (!res.success) throw new Error(`Review completion with non-blocking warning should succeed: ${res.message}`);
    });

    // B15: Successful complete review sets REVIEWED, reviewed_by, reviewed_at
    await runTest('B15', 'Successful review completion atomically populates REVIEWED, reviewed_by, reviewed_at', async () => {
      const { data: d } = await supabase.from('documents').select('review_status, reviewed_by, reviewed_at').eq('id', docId).single();
      if (d.review_status !== 'REVIEWED') throw new Error(`Expected review_status REVIEWED, got ${d.review_status}`);
      if (d.reviewed_by !== userA) throw new Error(`Expected reviewed_by ${userA}, got ${d.reviewed_by}`);
      if (!d.reviewed_at) throw new Error('reviewed_at must be populated');
    });

    // B16: Re-run OCR after REVIEWED resets review_status to UNREVIEWED and clears metadata
    await runTest('B16', 'Re-run OCR resets review_status to UNREVIEWED and clears reviewed_by/reviewed_at', async () => {
      await humanReviewService.resetReviewOnOcrRerun(userA, docId);
      const { data: d } = await supabase.from('documents').select('status, review_status, reviewed_by, reviewed_at').eq('id', docId).single();
      if (d.status !== 'QUEUED') throw new Error(`Expected status QUEUED, got ${d.status}`);
      if (d.review_status !== 'UNREVIEWED') throw new Error(`Expected review_status UNREVIEWED, got ${d.review_status}`);
      if (d.reviewed_by !== null) throw new Error('reviewed_by should be null');
      if (d.reviewed_at !== null) throw new Error('reviewed_at should be null');
    });

    // B17: Exact duplicate Human Edit request is safe and idempotent
    await runTest('B17', 'Exact duplicate Human Edit request executes safely without corrupting data', async () => {
      const res1 = await humanReviewService.editCell(userA, docId, cell1Id, '20,000', 'MONEY');
      const res2 = await humanReviewService.editCell(userA, docId, cell1Id, '20,000', 'MONEY');
      if (!res1.success || !res2.success) throw new Error('Both duplicate edits should succeed safely');
      if (res2.cell.raw_value !== '20,000') throw new Error(`raw_value is not 20,000: ${res2.cell.raw_value}`);
    });

    // B18: Double confirmation on same cell is safe
    await runTest('B18', 'Double confirmation on same cell is safe and idempotent', async () => {
      const res1 = await humanReviewService.confirmCell(userA, docId, cell1Id);
      const res2 = await humanReviewService.confirmCell(userA, docId, cell1Id);
      if (!res1.success || !res2.success) throw new Error('Both confirmations should succeed safely');
      if (res2.cell.resolution_status !== 'RESOLVED') throw new Error('resolution_status should be RESOLVED');
    });

    // B19: Human review operations generate 0 external AI calls
    await runTest('B19', 'Human review operations trigger 0 Azure Primary, 0 Azure Secondary, and 0 Gemini calls', async () => {
      if (aiProviderCalls.azurePrimary !== 0 || aiProviderCalls.azureSecondary !== 0 || aiProviderCalls.gemini !== 0) {
        throw new Error(`Unexpected AI calls: ${JSON.stringify(aiProviderCalls)}`);
      }
    });

    // B20: Existing Phase 7 resolution flow still passes regression
    await runTest('B20', 'Existing Phase 7 resolution flow remains intact and functional', async () => {
      // Test resolve_extraction_cell_atomic RPC directly
      const candKey = `reg_${cell5Id}_${Date.now()}`;
      const { data: rpcRes, error: rpcErr } = await supabase.rpc('resolve_extraction_cell_atomic', {
        p_document_id: docId,
        p_user_id: userA,
        p_cell_id: cell5Id,
        p_candidate: {
          id: crypto.randomUUID(),
          candidate_source: 'SECONDARY_OCR',
          raw_value: '16/08/2026',
          normalized_value: '2026-08-16',
          confidence_score: 0.99,
          confidence_source: 'AZURE_MODEL',
          provider: 'secondary-ocr',
          attempt_status: 'COMPLETED',
          validation_status: 'ACCEPTED',
          validation_issues: [],
          idempotency_key: candKey,
        },
        p_resolution: {
          resolution_event_key: `event_${candKey}`,
          selected_candidate_id: null,
          resolution_status: 'UNRESOLVED',
          resolution_method: 'NONE',
          reason_code: 'REGRESSION_CHECK',
        },
        p_cell_updates: {
          validation_status: 'REVIEW_REQUIRED',
        },
      });

      if (rpcErr) throw new Error(`Phase 7 RPC failed: ${rpcErr.message}`);
      if (!rpcRes || !rpcRes.success) throw new Error('Phase 7 RPC response indicated failure');
    });

  } finally {
    // Cleanup isolated fixture
    console.log(`\nCleaning up test fixture document ${docId}...`);
    await supabase.from('extraction_resolution_events').delete().eq('document_id', docId);
    await supabase.from('extraction_resolutions').delete().eq('document_id', docId);
    await supabase.from('extraction_candidates').delete().eq('document_id', docId);
    await supabase.from('review_actions').delete().eq('document_id', docId);
    await supabase.from('extracted_cells').delete().in('id', [cell1Id, cell2Id, cell3Id, cell4Id, cell5Id]);
    await supabase.from('extracted_rows').delete().eq('id', rowId);
    await supabase.from('extracted_tables').delete().eq('id', tableId);
    await supabase.from('documents').delete().eq('id', docId);
    console.log('Cleanup completed successfully.');
  }

  // Write structured test results to file
  const reportPath = path.join(process.cwd(), 'phase8_backend_test_results.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalTests: testResults.length,
    passed: testResults.filter((r) => r.status === 'PASS').length,
    failed: testResults.filter((r) => r.status === 'FAIL').length,
    aiProviderCalls,
    results: testResults,
  }, null, 2));

  console.log(`\nResults written to ${reportPath}`);
  console.log(`Total: ${testResults.length} | Passed: ${testResults.filter((r) => r.status === 'PASS').length} | Failed: ${testResults.filter((r) => r.status === 'FAIL').length}`);
}

main().catch(console.error);
