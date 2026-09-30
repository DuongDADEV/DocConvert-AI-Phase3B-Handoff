import 'dotenv/config';
import crypto from 'crypto';
import { getSupabaseAdminClient, getBaseSupabaseClient } from '../server/services/supabaseClient.js';
import { db } from '../server/db/db.js';

async function seed() {
  const admin = getSupabaseAdminClient();
  const client = getBaseSupabaseClient();
  const email = 'test_browser_e2e@docconvert.test';
  const password = 'Password123!';

  // Ensure user in auth
  let authUser = (await admin.auth.admin.listUsers()).data.users.find(u => u.email === email);
  if (!authUser) {
    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    authUser = created.user;
  }

  const userId = authUser.id;

  // Ensure profile
  await db.ensureProfile(userId, email, 'Tester Browser E2E');

  // Sign in to get genuine Supabase access token
  const { data: signData, error: signErr } = await client.auth.signInWithPassword({ email, password });
  if (signErr) throw signErr;
  const token = signData.session.access_token;

  const docId = '11111111-2222-3333-4444-555555555555';
  const tableId = '22222222-3333-4444-5555-666666666666';
  const rowHeaderId = '33333333-4444-5555-6666-777777777770';
  const row1Id = '33333333-4444-5555-6666-777777777771';
  const row2Id = '33333333-4444-5555-6666-777777777772';
  const cellH1Id = '44444444-5555-6666-7777-888888888880';
  const cellH2Id = '44444444-5555-6666-7777-888888888889';
  const cell1Id = '44444444-5555-6666-7777-888888888881';
  const cell2Id = '44444444-5555-6666-7777-888888888882';
  const cell3Id = '44444444-5555-6666-7777-888888888883';

  console.log('Seeding test data for user:', userId, email);

  // Clean up if existing
  await admin.from('review_actions').delete().eq('document_id', docId);
  await admin.from('extraction_resolutions').delete().eq('document_id', docId);
  await admin.from('extraction_candidates').delete().eq('document_id', docId);
  await admin.from('extracted_cells').delete().eq('table_id', tableId);
  await admin.from('extracted_rows').delete().eq('table_id', tableId);
  await admin.from('extracted_tables').delete().eq('document_id', docId);
  await admin.from('documents').delete().eq('id', docId);

  // 1. Insert Document
  const { error: dErr } = await admin.from('documents').insert({
    id: docId,
    user_id: userId,
    original_filename: 'sao_ke_browser_e2e.pdf',
    file_name: 'sao_ke_browser_e2e.pdf',
    file_type: 'PDF',
    file_size: 2048,
    page_count: 1,
    mime_type: 'application/pdf',
    storage_bucket: 'documents',
    storage_path: `${userId}/${docId}/sao_ke_browser_e2e.pdf`,
    document_type: 'BANK_STATEMENT',
    status: 'READY',
    review_status: 'UNREVIEWED',
  });
  if (dErr) throw dErr;

  // 2. Insert Table
  const { error: tErr } = await admin.from('extracted_tables').insert({
    id: tableId,
    document_id: docId,
    page_number: 1,
    table_index: 0,
    row_count: 3,
    column_count: 2,
    confidence_score: 0.95,
    confidence_source: 'LOCAL_HEURISTIC',
  });
  if (tErr) throw tErr;

  // 3. Insert Rows
  await admin.from('extracted_rows').insert([
    { id: rowHeaderId, table_id: tableId, row_index: 0, is_header: true },
    { id: row1Id, table_id: tableId, row_index: 1, is_header: false },
    { id: row2Id, table_id: tableId, row_index: 2, is_header: false },
  ]);

  // 4. Insert Cells:
  const { error: cellErr } = await admin.from('extracted_cells').insert([
    // Headers
    {
      id: cellH1Id,
      row_id: rowHeaderId,
      column_index: 0,
      raw_value: 'Số tiền',
      normalized_value: 'Số tiền',
      cell_type: 'TEXT',
      confidence_score: 0.99,
      confidence_source: 'LOCAL_HEURISTIC',
      is_reviewed: true,
      validation_status: 'ACCEPTED',
      validation_issues: [],
      resolution_status: 'NOT_REQUIRED',
      resolution_method: 'NONE',
    },
    {
      id: cellH2Id,
      row_id: rowHeaderId,
      column_index: 1,
      raw_value: 'Ghi chú',
      normalized_value: 'Ghi chú',
      cell_type: 'TEXT',
      confidence_score: 0.99,
      confidence_source: 'LOCAL_HEURISTIC',
      is_reviewed: true,
      validation_status: 'ACCEPTED',
      validation_issues: [],
      resolution_status: 'NOT_REQUIRED',
      resolution_method: 'NONE',
    },
    {
      id: cell1Id,
      row_id: row1Id,
      column_index: 0,
      raw_value: '1.25O.OOO',
      normalized_value: '1.25O.OOO',
      cell_type: 'MONEY',
      confidence_score: 0.72,
      confidence_source: 'LOCAL_HEURISTIC',
      is_reviewed: false,
      validation_status: 'REVIEW_REQUIRED',
      validation_issues: [{ type: 'FORMAT_ERROR', message: 'Số tiền chứa ký tự chữ cái thay vì số' }],
      resolution_status: 'UNRESOLVED',
      resolution_method: 'NONE',
      bounding_box: { polygon: [0.1, 0.1, 0.4, 0.1, 0.4, 0.2, 0.1, 0.2], unit: 'inch', page: 1 },
    },
    {
      id: cell2Id,
      row_id: row1Id,
      column_index: 1,
      raw_value: '500.000',
      normalized_value: '500000',
      cell_type: 'MONEY',
      confidence_score: 0.91,
      confidence_source: 'LOCAL_HEURISTIC',
      is_reviewed: false,
      validation_status: 'ACCEPTED',
      validation_issues: [],
      resolution_status: 'UNRESOLVED',
      resolution_method: 'NONE',
      bounding_box: { polygon: [0.5, 0.1, 0.9, 0.1, 0.9, 0.2, 0.5, 0.2], unit: 'inch', page: 1 },
    },
    {
      id: cell3Id,
      row_id: row2Id,
      column_index: 0,
      raw_value: '32/13/2025',
      normalized_value: '32/13/2025',
      cell_type: 'DATE',
      confidence_score: 0.65,
      confidence_source: 'LOCAL_HEURISTIC',
      is_reviewed: false,
      validation_status: 'REVIEW_REQUIRED',
      validation_issues: [{ type: 'DATE_OUT_OF_RANGE', message: 'Ngày tháng không hợp lệ' }],
      resolution_status: 'UNRESOLVED',
      resolution_method: 'NONE',
      bounding_box: { polygon: [0.1, 0.3, 0.4, 0.3, 0.4, 0.4, 0.1, 0.4], unit: 'inch', page: 1 },
    },
  ]);
  if (cellErr) throw new Error(`Cell insert failed: ${cellErr.message}`);

  // Candidates for Candidate A
  await admin.from('extraction_candidates').insert([
    {
      id: crypto.randomUUID(),
      cell_id: cell1Id,
      document_id: docId,
      candidate_source: 'PRIMARY_OCR',
      candidate_index: 0,
      raw_value: '1.25O.OOO',
      normalized_value: '1.25O.OOO',
      confidence: 0.72,
      is_selected: true,
      validation_status: 'REVIEW_REQUIRED',
      validation_issues: [{ type: 'FORMAT_ERROR', message: 'Số tiền chứa ký tự chữ cái thay vì số' }],
    },
    {
      id: crypto.randomUUID(),
      cell_id: cell2Id,
      document_id: docId,
      candidate_source: 'PRIMARY_OCR',
      candidate_index: 0,
      raw_value: '500.000',
      normalized_value: '500000',
      confidence: 0.91,
      is_selected: true,
      validation_status: 'ACCEPTED',
      validation_issues: [],
    },
    {
      id: crypto.randomUUID(),
      cell_id: cell3Id,
      document_id: docId,
      candidate_source: 'PRIMARY_OCR',
      candidate_index: 0,
      raw_value: '32/13/2025',
      normalized_value: '32/13/2025',
      confidence: 0.65,
      is_selected: true,
      validation_status: 'REVIEW_REQUIRED',
      validation_issues: [{ type: 'DATE_OUT_OF_RANGE', message: 'Ngày tháng không hợp lệ' }],
    },
  ]);

  console.log('SUCCESS! Seeded document:', docId);
  console.log('User ID:', userId);
  console.log('Email:', email);
  console.log('Password:', password);
  console.log('Token:', token);
}

seed().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
