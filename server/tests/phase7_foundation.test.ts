import assert from 'assert';
import crypto from 'crypto';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { db } from '../db/db.js';

console.log('================================================================');
console.log('   PHASE 7 — FOUNDATION & ATOMIC RPC TESTS (A–F + INVARIANTS)');
console.log('================================================================\n');

async function runPhase7FoundationTests() {
  const client = getSupabaseAdminClient();
  let passedCount = 0;

  function assertTest(condition: boolean, testName: string, detail: string) {
    assert(condition, `[FAIL] ${testName}: ${detail}`);
    console.log(`✅ [PASS] ${testName}: ${detail}`);
    passedCount++;
  }

  const testUserId = '30ed6381-0d2f-4d4a-a2f6-d8e0ac07452c';
  const testDocId = crypto.randomUUID();
  let testCellId: string;
  let candidateAId: string;
  let candidateBId: string;

  try {
    // -------------------------------------------------------------------------
    // Setup Document, Table, Row, Cell in Supabase
    // -------------------------------------------------------------------------
    console.log('--- Setting up test document, table, row, cell in PostgreSQL ---');
    await db.createDocument({
      id: testDocId,
      user_id: testUserId,
      file_name: 'phase7_foundation_test.pdf',
      status: 'REVIEW_REQUIRED',
    });

    const tableId = crypto.randomUUID();
    const { error: tErr } = await client.from('extracted_tables').insert({
      id: tableId,
      document_id: testDocId,
      page_number: 1,
      table_index: 0,
      row_count: 1,
      column_count: 1,
      confidence_score: 0.9,
      confidence_source: 'AZURE_MODEL',
    });
    if (tErr) throw new Error(`Table insert failed: ${tErr.message}`);

    const rowId = crypto.randomUUID();
    const { error: rErr } = await client.from('extracted_rows').insert({
      id: rowId,
      table_id: tableId,
      row_index: 0,
      is_header: false,
    });
    if (rErr) throw new Error(`Row insert failed: ${rErr.message}`);

    testCellId = crypto.randomUUID();
    const { error: cErr } = await client.from('extracted_cells').insert({
      id: testCellId,
      row_id: rowId,
      column_index: 0,
      raw_value: 'Initial Cell Value',
      original_raw_value: 'Initial Cell Value',
      normalized_value: 'Initial Cell Value',
      confidence_score: 0.65,
      confidence_source: 'AZURE_CELL',
      validation_status: 'REVIEW_REQUIRED',
      bounding_box: { x: 10, y: 20, width: 100, height: 30, unit: 'point' },
      requires_secondary_ocr: true,
    });
    if (cErr) throw new Error(`Cell insert failed: ${cErr.message}`);

    // Create a validation run
    const runId = crypto.randomUUID();
    const { error: runErr } = await client.from('validation_runs').insert({
      id: runId,
      document_id: testDocId,
      status: 'REVIEW_REQUIRED',
      review_required_count: 1,
      warning_count: 0,
      accepted_count: 0,
      validation_version: 'val-v1',
    });
    if (runErr) throw new Error(`Run insert failed: ${runErr.message}`);

    // =========================================================================
    // TEST E: Reject Invalid p_candidate Sources (AZURE_PRIMARY / LOCAL_NATIVE)
    // =========================================================================
    console.log('\n--- Running TEST E: Restrict p_candidate Sources ---');
    {
      const { data, error } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: {
          candidate_source: 'AZURE_PRIMARY', // FORBIDDEN for p_candidate
          raw_value: 'Test Val',
          idempotency_key: `${testCellId}_inv_src_1`,
        },
        p_resolution: {
          resolution_event_key: 'evt_invalid_src_1',
          resolution_status: 'UNRESOLVED',
        },
        p_cell_updates: {
          validation_status: 'REVIEW_REQUIRED',
        },
      });

      assertTest(
        !!error && error.message.includes('INVALID_CANDIDATE_SOURCE'),
        'TEST E1',
        'Reject p_candidate candidate_source = AZURE_PRIMARY'
      );
    }
    {
      const { data, error } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: {
          candidate_source: 'LOCAL_NATIVE', // FORBIDDEN for p_candidate
          raw_value: 'Test Val',
          idempotency_key: `${testCellId}_inv_src_2`,
        },
        p_resolution: {
          resolution_event_key: 'evt_invalid_src_2',
          resolution_status: 'UNRESOLVED',
        },
        p_cell_updates: {
          validation_status: 'REVIEW_REQUIRED',
        },
      });

      assertTest(
        !!error && error.message.includes('INVALID_CANDIDATE_SOURCE'),
        'TEST E2',
        'Reject p_candidate candidate_source = LOCAL_NATIVE'
      );
    }

    // =========================================================================
    // INVARIANT TEST: Mandatory resolution_event_key
    // =========================================================================
    console.log('\n--- Running INVARIANT TEST: Mandatory resolution_event_key ---');
    {
      const { data, error } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: null,
        p_resolution: {
          resolution_event_key: '', // Empty key
          resolution_status: 'UNRESOLVED',
        },
        p_cell_updates: {
          validation_status: 'REVIEW_REQUIRED',
        },
      });

      assertTest(
        !!error && error.message.includes('RESOLUTION_EVENT_KEY_REQUIRED'),
        'INVARIANT: Empty resolution_event_key rejected',
        'Raises RESOLUTION_EVENT_KEY_REQUIRED'
      );
    }

    // =========================================================================
    // INVARIANT TEST: Cell Document Mismatch
    // =========================================================================
    console.log('\n--- Running INVARIANT TEST: Cell Document Mismatch ---');
    {
      const wrongDocId = crypto.randomUUID();
      const { data, error } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: wrongDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: null,
        p_resolution: {
          resolution_event_key: 'evt_wrong_doc',
          resolution_status: 'UNRESOLVED',
        },
        p_cell_updates: {
          validation_status: 'REVIEW_REQUIRED',
        },
      });

      assertTest(
        !!error && (error.message.includes('DOCUMENT_NOT_FOUND') || error.message.includes('CELL_NOT_FOUND_OR_DOCUMENT_MISMATCH')),
        'INVARIANT: Cell Document Mismatch rejected',
        'Cannot resolve cell on mismatched document'
      );
    }

    // =========================================================================
    // INVARIANT TEST: UNRESOLVED requires validation_status = REVIEW_REQUIRED
    // =========================================================================
    console.log('\n--- Running INVARIANT TEST: UNRESOLVED requires REVIEW_REQUIRED ---');
    {
      const { data, error } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: null,
        p_resolution: {
          resolution_event_key: 'evt_unresolved_accepted',
          resolution_status: 'UNRESOLVED',
        },
        p_cell_updates: {
          validation_status: 'ACCEPTED', // FORBIDDEN with UNRESOLVED
        },
      });

      assertTest(
        !!error && error.message.includes('UNRESOLVED_REQUIRES_REVIEW_REQUIRED'),
        'INVARIANT: UNRESOLVED cannot have validation_status = ACCEPTED',
        'Raises UNRESOLVED_REQUIRES_REVIEW_REQUIRED'
      );
    }

    // =========================================================================
    // INVARIANT TEST: RESOLVED requires selected_candidate_id
    // =========================================================================
    console.log('\n--- Running INVARIANT TEST: RESOLVED requires selected candidate ---');
    {
      const { data, error } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: null,
        p_resolution: {
          resolution_event_key: 'evt_no_cand_resolved',
          resolution_status: 'RESOLVED',
          selected_candidate_id: null,
        },
        p_cell_updates: {
          validation_status: 'ACCEPTED',
        },
      });

      assertTest(
        !!error && error.message.includes('RESOLVED_STATE_REQUIRES_SELECTED_CANDIDATE'),
        'INVARIANT: RESOLVED requires selected candidate',
        'Raises RESOLVED_STATE_REQUIRES_SELECTED_CANDIDATE'
      );
    }

    // =========================================================================
    // FIRST SUCCESSFUL RESOLUTION CALL: Lazy-creates Cand A, inserts Cand B
    // =========================================================================
    console.log('\n--- First valid resolution execution ---');
    candidateBId = crypto.randomUUID();
    const candBKey = `${testCellId}_attempt_1_orig`;
    const resolutionEventKey1 = `${testCellId}_res_event_001`;

    const { data: res1, error: err1 } = await client.rpc('resolve_extraction_cell_atomic', {
      p_document_id: testDocId,
      p_user_id: testUserId,
      p_cell_id: testCellId,
      p_candidate: {
        id: candidateBId,
        candidate_source: 'SECONDARY_OCR',
        raw_value: 'Corrected Value 100',
        normalized_value: '100',
        confidence_score: 0.98,
        confidence_source: 'AZURE_MODEL',
        provider: 'tesseract-secondary',
        attempt_number: 1,
        attempt_status: 'COMPLETED',
        preprocessing_variant: 'original',
        validation_status: 'ACCEPTED',
        validation_issues: [],
        idempotency_key: candBKey,
      },
      p_resolution: {
        resolution_event_key: resolutionEventKey1,
        selected_candidate_id: candidateBId,
        resolution_status: 'RESOLVED',
        resolution_method: 'SECONDARY_OCR',
        reason_code: 'SECONDARY_OCR_VALID',
        reason_message: 'Secondary OCR passed all validation rules',
        semantic_decision: 'B',
        semantic_confidence: 0.98,
      },
      p_cell_updates: {
        raw_value: 'Corrected Value 100',
        normalized_value: '100',
        validation_status: 'ACCEPTED',
        validation_issues: [],
        requires_secondary_ocr: false,
        confidence_score: 0.98,
        confidence_source: 'AZURE_MODEL',
      },
    });

    if (err1) throw new Error(`First resolution call failed: ${err1.message}`);

    assertTest(res1.success === true, 'First Resolution', 'Executed successfully');
    candidateAId = res1.candidate_a_id;
    assertTest(!!candidateAId, 'Candidate A Lazy Creation', `Created with ID ${candidateAId}`);
    assertTest(res1.selected_candidate_id === candidateBId, 'Candidate B Selected', 'Candidate B is selected');

    // Verify exactly 1 selected candidate in extraction_candidates
    const { data: selectedCands } = await client
      .from('extraction_candidates')
      .select('id, is_selected')
      .eq('cell_id', testCellId)
      .eq('is_selected', true);

    assertTest(
      selectedCands?.length === 1 && selectedCands[0].id === candidateBId,
      'One Selected Candidate Constraint',
      'Database contains exactly 1 selected candidate for the cell'
    );

    // =========================================================================
    // TEST A: Same resolution_event_key Exact Replay (Idempotent No-Op)
    // =========================================================================
    console.log('\n--- Running TEST A: Same resolution_event_key Exact Replay ---');
    {
      const { data: resReplay, error: errReplay } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: {
          id: candidateBId,
          candidate_source: 'SECONDARY_OCR',
          raw_value: 'Corrected Value 100',
          normalized_value: '100',
          confidence_score: 0.98,
          confidence_source: 'AZURE_MODEL',
          provider: 'tesseract-secondary',
          attempt_number: 1,
          attempt_status: 'COMPLETED',
          preprocessing_variant: 'original',
          validation_status: 'ACCEPTED',
          validation_issues: [],
          idempotency_key: candBKey,
        },
        p_resolution: {
          resolution_event_key: resolutionEventKey1,
          selected_candidate_id: candidateBId,
          resolution_status: 'RESOLVED',
          resolution_method: 'SECONDARY_OCR',
          reason_code: 'SECONDARY_OCR_VALID',
          reason_message: 'Secondary OCR passed all validation rules',
          semantic_decision: 'B',
          semantic_confidence: 0.98,
        },
        p_cell_updates: {
          raw_value: 'Corrected Value 100',
          normalized_value: '100',
          validation_status: 'ACCEPTED',
          validation_issues: [],
          requires_secondary_ocr: false,
          confidence_score: 0.98,
          confidence_source: 'AZURE_MODEL',
        },
      });

      if (errReplay) throw new Error(`Replay failed with unexpected error: ${errReplay.message}`);

      assertTest(
        resReplay.success === true && resReplay.idempotent_replay === true,
        'TEST A1: Exact Replay Success',
        'Returns success with idempotent_replay: true'
      );

      // Verify no duplicate event was inserted
      const { count: eventCount } = await client
        .from('extraction_resolution_events')
        .select('*', { count: 'exact', head: true })
        .eq('cell_id', testCellId)
        .eq('resolution_event_key', resolutionEventKey1);

      assertTest(eventCount === 1, 'TEST A2: Event Deduplication', 'Event count remains exactly 1');

      // Verify candidates count remains 2 (A and B)
      const { count: candCount } = await client
        .from('extraction_candidates')
        .select('*', { count: 'exact', head: true })
        .eq('cell_id', testCellId);

      assertTest(candCount === 2, 'TEST A3: No Candidate Duplication', 'Candidate count remains exactly 2');
    }

    // =========================================================================
    // TEST B: Same resolution_event_key with Different selected_candidate_id
    // =========================================================================
    console.log('\n--- Running TEST B: Same Event Key + Different Candidate ---');
    {
      const { data, error } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: null,
        p_resolution: {
          resolution_event_key: resolutionEventKey1,
          selected_candidate_id: candidateAId, // DIFFERENT from committed B
          resolution_status: 'RESOLVED',
          resolution_method: 'SECONDARY_OCR',
          semantic_decision: 'B',
        },
        p_cell_updates: {
          validation_status: 'ACCEPTED',
        },
      });

      assertTest(
        !!error && error.message.includes('RESOLUTION_IDEMPOTENCY_PAYLOAD_MISMATCH'),
        'TEST B',
        'Replay with different candidate rejected with RESOLUTION_IDEMPOTENCY_PAYLOAD_MISMATCH'
      );
    }

    // =========================================================================
    // TEST C: Same Event Key with Different resolution_status / method
    // =========================================================================
    console.log('\n--- Running TEST C: Same Event Key + Different Status/Method ---');
    {
      const { data, error } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: null,
        p_resolution: {
          resolution_event_key: resolutionEventKey1,
          selected_candidate_id: candidateBId,
          resolution_status: 'UNRESOLVED', // DIFFERENT from committed RESOLVED
          resolution_method: 'SECONDARY_OCR',
          semantic_decision: 'B',
        },
        p_cell_updates: {
          validation_status: 'REVIEW_REQUIRED',
        },
      });

      assertTest(
        !!error && error.message.includes('RESOLUTION_IDEMPOTENCY_PAYLOAD_MISMATCH'),
        'TEST C1',
        'Replay with different resolution_status rejected with RESOLUTION_IDEMPOTENCY_PAYLOAD_MISMATCH'
      );
    }
    {
      const { data, error } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: null,
        p_resolution: {
          resolution_event_key: resolutionEventKey1,
          selected_candidate_id: candidateBId,
          resolution_status: 'RESOLVED',
          resolution_method: 'GEMINI', // DIFFERENT from committed SECONDARY_OCR
          semantic_decision: 'B',
        },
        p_cell_updates: {
          validation_status: 'ACCEPTED',
        },
      });

      assertTest(
        !!error && error.message.includes('RESOLUTION_IDEMPOTENCY_PAYLOAD_MISMATCH'),
        'TEST C2',
        'Replay with different resolution_method rejected with RESOLUTION_IDEMPOTENCY_PAYLOAD_MISMATCH'
      );
    }

    // =========================================================================
    // TEST D: FAILED Candidate Same Key + Different raw_value
    // =========================================================================
    console.log('\n--- Running TEST D: FAILED Candidate Payload Immutability ---');
    const failedCandKey = `${testCellId}_failed_attempt_1`;
    {
      // First, create a FAILED candidate
      const failedCandId = crypto.randomUUID();
      const { data: failedRes, error: failedErr } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: {
          id: failedCandId,
          candidate_source: 'SECONDARY_OCR',
          raw_value: 'Failed Raw Output',
          attempt_status: 'FAILED',
          idempotency_key: failedCandKey,
        },
        p_resolution: {
          resolution_event_key: `${testCellId}_failed_evt_1`,
          resolution_status: 'UNRESOLVED',
          resolution_method: 'SECONDARY_OCR',
          reason_code: 'OCR_FAILED',
        },
        p_cell_updates: {
          validation_status: 'REVIEW_REQUIRED',
        },
      });

      if (failedErr) throw new Error(`Setup failed candidate failed: ${failedErr.message}`);

      // Now attempt to replay the same failed candidate idempotency key with a DIFFERENT raw_value
      const { data: mismatchData, error: mismatchErr } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: {
          candidate_source: 'SECONDARY_OCR',
          raw_value: 'DIFFERENT FAILED RAW VALUE', // Mutated payload!
          attempt_status: 'FAILED',
          idempotency_key: failedCandKey,
        },
        p_resolution: {
          resolution_event_key: `${testCellId}_failed_evt_2`,
          resolution_status: 'UNRESOLVED',
          resolution_method: 'SECONDARY_OCR',
          reason_code: 'OCR_FAILED',
        },
        p_cell_updates: {
          validation_status: 'REVIEW_REQUIRED',
        },
      });

      assertTest(
        !!mismatchErr && mismatchErr.message.includes('IDEMPOTENCY_PAYLOAD_MISMATCH'),
        'TEST D1: FAILED Candidate Payload Mismatch',
        'Replaying FAILED candidate with different raw_value rejected with IDEMPOTENCY_PAYLOAD_MISMATCH'
      );

      // Now replay the same FAILED candidate with IDENTICAL raw_value and candidate_source
      const { data: replayData, error: replayErr } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: {
          candidate_source: 'SECONDARY_OCR',
          raw_value: 'Failed Raw Output', // IDENTICAL payload
          attempt_status: 'FAILED',
          idempotency_key: failedCandKey,
        },
        p_resolution: {
          resolution_event_key: `${testCellId}_failed_evt_3`,
          resolution_status: 'UNRESOLVED',
          resolution_method: 'SECONDARY_OCR',
          reason_code: 'OCR_FAILED',
        },
        p_cell_updates: {
          validation_status: 'REVIEW_REQUIRED',
        },
      });

      assertTest(
        !replayErr && replayData.success === true,
        'TEST D2: FAILED Candidate Identical Replay',
        'Identical FAILED candidate replay successfully reuses candidate without error'
      );
    }

    // =========================================================================
    // TEST F: Full Atomic Rollback Regression
    // =========================================================================
    console.log('\n--- Running TEST F: Atomic Rollback Regression ---');
    {
      const preCount = (await client.from('extraction_resolution_events').select('*', { count: 'exact', head: true }).eq('cell_id', testCellId)).count;
      const preCandCount = (await client.from('extraction_candidates').select('*', { count: 'exact', head: true }).eq('cell_id', testCellId)).count;

      // Trigger an RPC call that will abort halfway (e.g. invalid candidate_a_id)
      const fakeCandAId = crypto.randomUUID();
      const { error: abortErr } = await client.rpc('resolve_extraction_cell_atomic', {
        p_document_id: testDocId,
        p_user_id: testUserId,
        p_cell_id: testCellId,
        p_candidate: {
          candidate_source: 'SECONDARY_OCR',
          raw_value: 'Do Not Persist',
          idempotency_key: `${testCellId}_abort_cand`,
        },
        p_resolution: {
          resolution_event_key: `${testCellId}_abort_evt`,
          candidate_a_id: fakeCandAId, // Will cause CANDIDATE_A_DOCUMENT_OR_CELL_MISMATCH
          resolution_status: 'RESOLVED',
          selected_candidate_id: candidateBId,
        },
        p_cell_updates: {
          raw_value: 'Do Not Mutate Cell',
          validation_status: 'ACCEPTED',
        },
      });

      assertTest(
        !!abortErr && abortErr.message.includes('CANDIDATE_A_DOCUMENT_OR_CELL_MISMATCH'),
        'TEST F1: Transaction Aborted',
        'Aborted with CANDIDATE_A_DOCUMENT_OR_CELL_MISMATCH'
      );

      const postCount = (await client.from('extraction_resolution_events').select('*', { count: 'exact', head: true }).eq('cell_id', testCellId)).count;
      const postCandCount = (await client.from('extraction_candidates').select('*', { count: 'exact', head: true }).eq('cell_id', testCellId)).count;

      assertTest(preCount === postCount, 'TEST F2: Event Rollback', 'No orphan events created');
      assertTest(preCandCount === postCandCount, 'TEST F3: Candidate Rollback', 'No orphan candidates created');

      const { data: cellAfter } = await client.from('extracted_cells').select('raw_value').eq('id', testCellId).single();
      assertTest(cellAfter?.raw_value !== 'Do Not Mutate Cell', 'TEST F4: Cell Rollback', 'Cell raw_value was not modified');
    }

    // =========================================================================
    // Verify Cell original_raw_value immutability
    // =========================================================================
    const { data: finalCell } = await client
      .from('extracted_cells')
      .select('original_raw_value, raw_value')
      .eq('id', testCellId)
      .single();

    assertTest(
      finalCell?.original_raw_value === 'Initial Cell Value',
      'Authoritative original_raw_value',
      `original_raw_value remained "Initial Cell Value" despite updates to raw_value: "${finalCell?.raw_value}"`
    );

    console.log(`\n================================================================`);
    console.log(`   ALL PHASE 7 FOUNDATION TESTS PASSED: ${passedCount}/${passedCount}`);
    console.log(`================================================================\n`);
  } finally {
    // Cleanup test data
    console.log('--- Cleaning up test artifacts ---');
    await client.from('documents').delete().eq('id', testDocId);
    console.log('Cleanup completed.\n');
  }
}

runPhase7FoundationTests().catch((err) => {
  console.error('\n❌ TEST RUNNER CRASHED:', err);
  process.exit(1);
});
