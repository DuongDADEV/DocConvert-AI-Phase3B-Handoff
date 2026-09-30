import dotenv from 'dotenv';
dotenv.config();
import { db } from '../server/db/db';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function testForcedFailure() {
  const client = getSupabaseAdminClient();
  const testUserId = '30ed6381-0d2f-4d4a-a2f6-d8e0ac07452c';
  const testDocId = crypto.randomUUID();

  console.log('1. Setting up initial document and OCR data...');
  // Create test document
  await db.createDocument({
    id: testDocId,
    user_id: testUserId,
    file_name: 'test_doc.pdf',
    status: 'PROCESSING'
  });

  // Save an initial valid OCR analysis
  const initialAnalysis: any = {
    provider: 'local',
    modelId: 'pde-v1',
    overallConfidence: 0.9,
    pages: [{ pageNumber: 1, rawText: 'Initial text', confidence: 0.9 }],
    tables: [
      {
        pageNumber: 1,
        tableIndex: 0,
        rowCount: 2,
        columnCount: 2,
        confidence: 0.9,
        rows: [
          {
            rowIndex: 0,
            cells: [
              { columnIndex: 0, rawValue: 'Cell 1', confidence: 0.9 },
              { columnIndex: 1, rawValue: 'Cell 2', confidence: 0.9 }
            ]
          }
        ]
      }
    ],
    metadata: {}
  };

  await db.saveOcrAnalysis(testUserId, testDocId, initialAnalysis);

  // Verify initial data in DB
  const { data: initialTables } = await client.from('extracted_tables').select('id').eq('document_id', testDocId);
  const { data: initialOcr } = await client.from('ocr_results').select('id').eq('document_id', testDocId);
  console.log(`Initial DB state: ${initialTables?.length} tables, ${initialOcr?.length} ocr_results.`);

  // Now create a malformed analysis that throws during extracted_cells chunk insert or after cleanup
  console.log('2. Attempting saveOcrAnalysis with malformed data (forcing failure during cell insertion)...');
  const malformedAnalysis: any = {
    provider: 'local',
    modelId: 'pde-v1',
    overallConfidence: 0.9,
    pages: [{ pageNumber: 1, rawText: 'Attempt 2 text', confidence: 0.9 }],
    tables: [
      {
        pageNumber: 1,
        tableIndex: 0,
        rowCount: 1,
        columnCount: 1,
        confidence: 0.9,
        rows: [
          {
            rowIndex: 0,
            cells: [
              {
                columnIndex: 'INVALID_TYPE_FORCING_DB_ERROR' as any, // triggers database error on insert
                rawValue: 'Bad Cell'
              }
            ]
          }
        ]
      }
    ],
    metadata: {}
  };

  let caughtError: any = null;
  try {
    await db.saveOcrAnalysis(testUserId, testDocId, malformedAnalysis);
  } catch (err: any) {
    caughtError = err;
    console.log('Caught expected error from saveOcrAnalysis:', err.message);
  }

  // Inspect database state after caught failure
  const { data: afterTables } = await client.from('extracted_tables').select('id').eq('document_id', testDocId);
  const { data: afterOcr } = await client.from('ocr_results').select('id').eq('document_id', testDocId);
  const { data: afterCells } = await client.from('extracted_cells').select('id');
  const doc = await db.getUserDocumentById(testUserId, testDocId);

  console.log(`DB state after failure:`);
  console.log(`- Document status: ${doc?.status}`);
  console.log(`- Extracted tables: ${afterTables?.length} (cleanup was called in catch block)`);
  console.log(`- OCR results: ${afterOcr?.length}`);

  // Cleanup
  console.log('3. Cleaning up test document...');
  await client.from('documents').delete().eq('id', testDocId);
}

testForcedFailure().catch(console.error);
