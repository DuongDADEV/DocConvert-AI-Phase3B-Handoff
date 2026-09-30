import crypto from 'crypto';
import { getSupabaseAdminClient } from './supabaseClient.js';
import { db } from '../db/db.js';
import { CandidateRevalidator } from './secondaryOcr/CandidateRevalidator.js';
import { auditService } from './auditService.js';

export interface PhysicalCellInfo {
  id: string;
  row_id: string;
  table_id: string;
  document_id: string;
  page_number: number;
  row_index: number;
  column_index: number;
  raw_value: string;
  normalized_value: string;
  original_raw_value: string | null;
  cell_type: string;
  confidence_score: number | null;
  confidence_source: string | null;
  validation_status: 'ACCEPTED' | 'WARNING' | 'REVIEW_REQUIRED';
  validation_issues: any[];
  requires_secondary_ocr: boolean;
  resolution_status: string;
  resolution_method: string;
  is_reviewed: boolean;
}

export interface HumanReviewResult {
  success: boolean;
  status: number;
  code?: string;
  message?: string;
  error?: string;
  cell?: any;
  document?: any;
  reviewStatus?: string;
  remainingBlockingCount?: number;
  validationIssues?: any[];
  blockingCount?: number;
  blockingCells?: any[];
}

export class HumanReviewService {
  /**
   * Strictly verifies that cellId corresponds to a physical extracted cell belonging to this document.
   * Rejects missing, deleted, cross-document, or projected placeholder cells.
   */
  async verifyPhysicalCell(documentId: string, cellId: string): Promise<PhysicalCellInfo | null> {
    const adminClient = getSupabaseAdminClient();

    // 1. Fetch cell
    const { data: cell, error: cellError } = await adminClient
      .from('extracted_cells')
      .select(`
        id,
        row_id,
        column_index,
        raw_value,
        normalized_value,
        original_raw_value,
        cell_type,
        confidence_score,
        confidence_source,
        validation_status,
        validation_issues,
        requires_secondary_ocr,
        resolution_status,
        resolution_method,
        is_reviewed
      `)
      .eq('id', cellId)
      .maybeSingle();

    if (cellError || !cell) {
      return null;
    }

    // 2. Fetch row
    const { data: row, error: rowError } = await adminClient
      .from('extracted_rows')
      .select('id, row_index, table_id')
      .eq('id', cell.row_id)
      .maybeSingle();

    if (rowError || !row) {
      return null;
    }

    // 3. Fetch table and verify document ownership
    const { data: table, error: tableError } = await adminClient
      .from('extracted_tables')
      .select('id, document_id, page_number')
      .eq('id', row.table_id)
      .maybeSingle();

    if (tableError || !table || table.document_id !== documentId) {
      return null;
    }

    return {
      id: cell.id,
      row_id: cell.row_id,
      table_id: table.id,
      document_id: table.document_id,
      page_number: table.page_number,
      row_index: row.row_index,
      column_index: cell.column_index,
      raw_value: cell.raw_value ?? '',
      normalized_value: cell.normalized_value ?? '',
      original_raw_value: cell.original_raw_value,
      cell_type: cell.cell_type || 'TEXT',
      confidence_score: cell.confidence_score,
      confidence_source: cell.confidence_source,
      validation_status: cell.validation_status || 'ACCEPTED',
      validation_issues: Array.isArray(cell.validation_issues) ? cell.validation_issues : [],
      requires_secondary_ocr: Boolean(cell.requires_secondary_ocr),
      resolution_status: cell.resolution_status || 'NOT_REQUIRED',
      resolution_method: cell.resolution_method || 'NONE',
      is_reviewed: Boolean(cell.is_reviewed),
    };
  }

  /**
   * Calculates blocking cells preventing document review completion.
   * PENDING, UNRESOLVED, HUMAN_REVIEW_REQUIRED, or unadjudicated ERROR validation cells block.
   */
  async calculateBlockingCells(documentId: string): Promise<{ blockingCount: number; blockingCells: any[] }> {
    const adminClient = getSupabaseAdminClient();

    // 1. Fetch tables belonging to this document
    const { data: tables, error: tableError } = await adminClient
      .from('extracted_tables')
      .select('id, page_number')
      .eq('document_id', documentId);

    if (tableError || !tables || tables.length === 0) {
      return { blockingCount: 0, blockingCells: [] };
    }

    const tableMap = new Map<string, any>(tables.map(t => [t.id, t]));
    const tableIds = tables.map(t => t.id);

    // 2. Fetch rows belonging to these tables
    const { data: rows, error: rowError } = await adminClient
      .from('extracted_rows')
      .select('id, row_index, table_id')
      .in('table_id', tableIds);

    if (rowError || !rows || rows.length === 0) {
      return { blockingCount: 0, blockingCells: [] };
    }

    const rowMap = new Map<string, any>(rows.map(r => [r.id, r]));
    const rowIds = rows.map(r => r.id);

    // 3. Fetch cells belonging to these rows
    const { data: cells, error: cellError } = await adminClient
      .from('extracted_cells')
      .select(`
        id,
        row_id,
        raw_value,
        normalized_value,
        cell_type,
        validation_status,
        validation_issues,
        resolution_status,
        resolution_method,
        is_reviewed,
        column_index
      `)
      .in('row_id', rowIds);

    if (cellError || !cells || cells.length === 0) {
      return { blockingCount: 0, blockingCells: [] };
    }

    const blocking: any[] = [];

    for (const c of cells) {
      const row = rowMap.get(c.row_id);
      const table = row ? tableMap.get(row.table_id) : null;

      const resStatus = c.resolution_status || 'NOT_REQUIRED';
      const valStatus = c.validation_status || 'ACCEPTED';
      const issues = Array.isArray(c.validation_issues) ? c.validation_issues : [];
      const hasError = issues.some((i: any) => i.severity === 'ERROR');

      let isBlocker = false;
      let blockReason = '';

      if (resStatus === 'PENDING') {
        isBlocker = true;
        blockReason = 'Tiến trình giải quyết OCR phụ đang chờ xử lý (PENDING).';
      } else if (resStatus === 'UNRESOLVED') {
        isBlocker = true;
        blockReason = 'Xung đột trích xuất chưa được giải quyết (UNRESOLVED).';
      } else if (resStatus === 'HUMAN_REVIEW_REQUIRED') {
        isBlocker = true;
        blockReason = 'Ô dữ liệu bắt buộc người dùng kiểm tra (HUMAN_REVIEW_REQUIRED).';
      } else if (valStatus === 'REVIEW_REQUIRED' && resStatus !== 'RESOLVED') {
        isBlocker = true;
        blockReason = 'Ô dữ liệu vi phạm quy tắc kiểm tra (REVIEW_REQUIRED) chưa được giải quyết.';
      } else if (hasError && resStatus !== 'RESOLVED') {
        isBlocker = true;
        blockReason = 'Ô dữ liệu có lỗi nghiêm trọng chưa được giải quyết.';
      }

      if (isBlocker) {
        blocking.push({
          cellId: c.id,
          pageNumber: table?.page_number ?? 1,
          rowIndex: row?.row_index ?? 0,
          columnIndex: c.column_index,
          rawValue: c.raw_value,
          resolutionStatus: resStatus,
          validationStatus: valStatus,
          reason: blockReason,
        });
      }
    }

    return {
      blockingCount: blocking.length,
      blockingCells: blocking,
    };
  }

  /**
   * Human Edit Endpoint Logic:
   * Revalidates submitted value, enforces safety (no overwrite if invalid),
   * persists valid edit via Phase 7 resolve_extraction_cell_atomic RPC, and updates review_status.
   */
  async editCell(
    userId: string,
    documentId: string,
    cellId: string,
    rawValue: string,
    cellType?: string,
    userToken?: string
  ): Promise<HumanReviewResult> {
    const adminClient = getSupabaseAdminClient();

    // 1. Verify document ownership
    const doc = await db.getUserDocumentById(userId, documentId, userToken);
    if (!doc) {
      return { success: false, status: 404, message: 'Tài liệu không tồn tại hoặc bạn không có quyền truy cập.' };
    }

    // 2. Verify physical cell identity & lineage (Reject placeholder)
    const cell = await this.verifyPhysicalCell(documentId, cellId);
    if (!cell) {
      return {
        success: false,
        status: 400,
        code: 'CANNOT_EDIT_PLACEHOLDER_CELL',
        message: 'Ô dữ liệu không tồn tại trên tài liệu này hoặc là ô giả lập (projected placeholder).',
      };
    }

    const effectiveType = (cellType || cell.cell_type || 'TEXT').toUpperCase();

    // 3. Re-validate submitted value using deterministic rules
    const reval = CandidateRevalidator.revalidate(rawValue, effectiveType, 1.0, 'HUMAN_INPUT');

    // 4. INVALID HUMAN EDIT SAFETY CHECK
    if (!reval.isValid) {
      // DO NOT overwrite extracted_cells.raw_value
      // DO NOT mark cell RESOLVED
      // Return HTTP 422 with structured validation issues
      return {
        success: false,
        status: 422,
        code: 'HUMAN_EDIT_VALIDATION_FAILED',
        message: 'Giá trị chỉnh sửa không hợp lệ theo quy tắc kiểm tra kiểu dữ liệu.',
        validationIssues: reval.issues,
      };
    }

    // 5. VALID HUMAN EDIT: Persist atomically via Phase 7 RPC
    const candidateId = crypto.randomUUID();
    const candKey = `${cellId}_human_${Date.now()}`;
    const resEventKey = `${cellId}_res_human_${Date.now()}`;

    const { data: rpcRes, error: rpcErr } = await adminClient.rpc('resolve_extraction_cell_atomic', {
      p_document_id: documentId,
      p_user_id: userId,
      p_cell_id: cellId,
      p_candidate: {
        id: candidateId,
        candidate_source: 'HUMAN_EDIT',
        raw_value: rawValue,
        normalized_value: reval.normalizedValue,
        confidence_score: 1.0,
        confidence_source: 'LOCAL_HEURISTIC',
        provider: 'human-reviewer',
        provider_version: 'v1.0',
        attempt_number: 1,
        attempt_status: 'COMPLETED',
        validation_status: reval.validationStatus,
        validation_issues: reval.issues,
        idempotency_key: candKey,
      },
      p_resolution: {
        resolution_event_key: resEventKey,
        selected_candidate_id: candidateId,
        resolution_status: 'RESOLVED',
        resolution_method: 'HUMAN',
        reason_code: 'HUMAN_EDIT_APPLIED',
        reason_message: 'Giá trị được người dùng chỉnh sửa và xác nhận',
      },
      p_cell_updates: {
        raw_value: rawValue,
        normalized_value: reval.normalizedValue,
        validation_status: reval.validationStatus,
        validation_issues: reval.issues,
        confidence_score: 1.0,
        confidence_source: cell.confidence_source || 'LOCAL_HEURISTIC',
        requires_secondary_ocr: false,
      },
    });

    if (rpcErr) {
      console.error('[HumanReviewService] RPC resolve_extraction_cell_atomic error:', rpcErr);
      return { success: false, status: 500, message: `Lỗi khi lưu dữ liệu nguyên tử: ${rpcErr.message}` };
    }

    // Mark cell as reviewed
    await adminClient.from('extracted_cells').update({ is_reviewed: true }).eq('id', cellId);

    // 6. Transition document review_status -> IN_PROGRESS and clear completion metadata atomically
    const now = new Date().toISOString();
    await adminClient
      .from('documents')
      .update({
        review_status: 'IN_PROGRESS',
        reviewed_by: null,
        reviewed_at: null,
        updated_at: now,
      })
      .eq('id', documentId);

    // 7. Backward-compatible dual-write to legacy review_actions
    await adminClient.from('review_actions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      document_id: documentId,
      cell_id: cellId,
      action_type: 'EDIT_CELL',
      old_value: cell.raw_value,
      new_value: rawValue,
      created_at: now,
    });

    // 8. Retrieve authoritative persisted cell
    const { data: updatedCell } = await adminClient.from('extracted_cells').select('*').eq('id', cellId).single();
    const { blockingCount } = await this.calculateBlockingCells(documentId);

    return {
      success: true,
      status: 200,
      message: 'Đã cập nhật ô dữ liệu thành công.',
      cell: updatedCell,
      reviewStatus: 'IN_PROGRESS',
      remainingBlockingCount: blockingCount,
      validationIssues: reval.issues,
    };
  }

  /**
   * Confirm As-Is Endpoint Logic:
   * Confirms the CURRENT selected value (without hardcoding Candidate A).
   * Validates consistency, preserves raw_value and validation history, records resolutionMethod = HUMAN.
   */
  async confirmCell(
    userId: string,
    documentId: string,
    cellId: string,
    userToken?: string
  ): Promise<HumanReviewResult> {
    const adminClient = getSupabaseAdminClient();

    // 1. Verify document ownership
    const doc = await db.getUserDocumentById(userId, documentId, userToken);
    if (!doc) {
      return { success: false, status: 404, message: 'Tài liệu không tồn tại hoặc bạn không có quyền truy cập.' };
    }

    // 2. Verify physical cell identity & lineage (Reject placeholder)
    const cell = await this.verifyPhysicalCell(documentId, cellId);
    if (!cell) {
      return {
        success: false,
        status: 400,
        code: 'CANNOT_EDIT_PLACEHOLDER_CELL',
        message: 'Ô dữ liệu không tồn tại trên tài liệu này hoặc là ô giả lập (projected placeholder).',
      };
    }

    // 3. Query existing candidates for this cell to find current selected candidate
    const { data: candidates, error: candErr } = await adminClient
      .from('extraction_candidates')
      .select('id, candidate_source, raw_value, is_selected')
      .eq('cell_id', cellId)
      .eq('document_id', documentId)
      .order('is_selected', { ascending: false })
      .order('created_at', { ascending: false });

    if (candErr) {
      return { success: false, status: 500, message: `Lỗi truy vấn ứng viên: ${candErr.message}` };
    }

    let selectedCandidateId: string | null = null;

    if (candidates && candidates.length > 0) {
      const selected = candidates.find((c) => c.is_selected);
      if (selected) {
        // Verify consistency with current persisted cell value
        if (selected.raw_value === cell.raw_value) {
          selectedCandidateId = selected.id;
        } else {
          // Check if any existing candidate matches current cell raw_value
          const matching = candidates.find((c) => c.raw_value === cell.raw_value);
          if (matching) {
            selectedCandidateId = matching.id;
          } else {
            // Mismatch: extracted_cells.raw_value does not match selected candidate
            return {
              success: false,
              status: 409,
              code: 'CURRENT_VALUE_CANDIDATE_MISMATCH',
              message: `Giá trị hiện tại của ô ("${cell.raw_value}") không khớp với ứng viên được chọn ("${selected.raw_value}").`,
            };
          }
        }
      } else {
        // No candidate currently marked selected, choose matching or first
        const matching = candidates.find((c) => c.raw_value === cell.raw_value);
        selectedCandidateId = matching ? matching.id : candidates[0].id;
      }

      // If Primary Candidate A does not exist, insert it with is_selected: false
      // to avoid RPC Step 4 lazy-creation colliding with the currently selected candidate on idx_candidates_one_selected_per_cell
      const hasPrimary = candidates.some((c) => c.candidate_source === 'AZURE_PRIMARY' || c.candidate_source === 'LOCAL_NATIVE');
      if (!hasPrimary) {
        const candAId = crypto.randomUUID();
        const candSource = cell.confidence_source === 'LOCAL_HEURISTIC' ? 'LOCAL_NATIVE' : 'AZURE_PRIMARY';
        await adminClient.from('extraction_candidates').insert({
          id: candAId,
          document_id: documentId,
          cell_id: cellId,
          candidate_source: candSource,
          raw_value: cell.original_raw_value || cell.raw_value,
          normalized_value: cell.normalized_value,
          confidence_score: cell.confidence_score,
          confidence_source: cell.confidence_source || 'AZURE_MODEL',
          provider: candSource === 'LOCAL_NATIVE' ? 'local-pdf-extractor' : 'azure-document-intelligence',
          provider_version: 'base-v1',
          attempt_number: 1,
          attempt_status: 'COMPLETED',
          validation_status: cell.validation_status,
          validation_issues: cell.validation_issues,
          is_selected: false,
          idempotency_key: `${cellId}_candidate_a`,
        });
      }
    } else {
      // Lazy creation of Candidate A for cells that did not participate in Phase 7 secondary OCR
      const candAId = crypto.randomUUID();
      const candSource = cell.confidence_source === 'LOCAL_HEURISTIC' ? 'LOCAL_NATIVE' : 'AZURE_PRIMARY';
      const { error: insAError } = await adminClient.from('extraction_candidates').insert({
        id: candAId,
        document_id: documentId,
        cell_id: cellId,
        candidate_source: candSource,
        raw_value: cell.raw_value,
        normalized_value: cell.normalized_value,
        confidence_score: cell.confidence_score,
        confidence_source: cell.confidence_source || 'AZURE_MODEL',
        provider: candSource === 'LOCAL_NATIVE' ? 'local-pdf-extractor' : 'azure-document-intelligence',
        provider_version: 'base-v1',
        attempt_number: 1,
        attempt_status: 'COMPLETED',
        validation_status: cell.validation_status,
        validation_issues: cell.validation_issues,
        is_selected: true,
        idempotency_key: `${cellId}_candidate_a`,
      });

      if (insAError) {
        console.error('[HumanReviewService] Lazy Candidate A insertion failed:', insAError);
        return { success: false, status: 500, message: `Lỗi tạo ứng viên gốc: ${insAError.message}` };
      }

      selectedCandidateId = candAId;
    }

    // 4. Persist resolution atomically via resolve_extraction_cell_atomic RPC
    const resEventKey = `${cellId}_res_confirm_${Date.now()}`;

    const { error: rpcErr } = await adminClient.rpc('resolve_extraction_cell_atomic', {
      p_document_id: documentId,
      p_user_id: userId,
      p_cell_id: cellId,
      p_candidate: null, // Confirming existing candidate
      p_resolution: {
        resolution_event_key: resEventKey,
        selected_candidate_id: selectedCandidateId,
        resolution_status: 'RESOLVED',
        resolution_method: 'HUMAN',
        reason_code: 'HUMAN_CONFIRMED_AS_IS',
        reason_message: 'Giá trị hiện tại được người dùng xác nhận đúng',
      },
      p_cell_updates: {
        raw_value: cell.raw_value,
        normalized_value: cell.normalized_value,
        validation_status: cell.validation_status, // preserve existing validation status
        validation_issues: cell.validation_issues, // preserve existing issues
        confidence_score: cell.confidence_score,
        confidence_source: cell.confidence_source,
        requires_secondary_ocr: false,
      },
    });

    if (rpcErr) {
      console.error('[HumanReviewService] Confirm As-Is RPC error:', rpcErr);
      return { success: false, status: 500, message: `Lỗi khi xác nhận ô nguyên tử: ${rpcErr.message}` };
    }

    // Mark cell reviewed
    await adminClient.from('extracted_cells').update({ is_reviewed: true }).eq('id', cellId);

    // 5. Transition document review_status -> IN_PROGRESS and clear completion metadata atomically
    const now = new Date().toISOString();
    await adminClient
      .from('documents')
      .update({
        review_status: 'IN_PROGRESS',
        reviewed_by: null,
        reviewed_at: null,
        updated_at: now,
      })
      .eq('id', documentId);

    // 6. Backward-compatible dual-write to legacy review_actions
    await adminClient.from('review_actions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      document_id: documentId,
      cell_id: cellId,
      action_type: 'CONFIRM_AS_IS',
      old_value: cell.raw_value,
      new_value: cell.raw_value,
      created_at: now,
    });

    // 7. Retrieve authoritative persisted cell
    const { data: updatedCell } = await adminClient.from('extracted_cells').select('*').eq('id', cellId).single();
    const { blockingCount } = await this.calculateBlockingCells(documentId);

    return {
      success: true,
      status: 200,
      message: 'Đã xác nhận ô dữ liệu đúng.',
      cell: updatedCell,
      reviewStatus: 'IN_PROGRESS',
      remainingBlockingCount: blockingCount,
    };
  }

  /**
   * Complete Review Gate:
   * Enforces zero blocking cells (PENDING, UNRESOLVED, HUMAN_REVIEW_REQUIRED, unadjudicated ERROR).
   * When clear, atomically sets review_status = REVIEWED, reviewed_by = userId, reviewed_at = NOW().
   */
  async completeReview(
    userId: string,
    documentId: string,
    userToken?: string
  ): Promise<HumanReviewResult> {
    const adminClient = getSupabaseAdminClient();

    // 1. Verify document ownership
    const doc = await db.getUserDocumentById(userId, documentId, userToken);
    if (!doc) {
      return { success: false, status: 404, message: 'Tài liệu không tồn tại hoặc bạn không có quyền truy cập.' };
    }

    // 2. Evaluate Review Completion Gate
    const { blockingCount, blockingCells } = await this.calculateBlockingCells(documentId);

    if (blockingCount > 0) {
      return {
        success: false,
        status: 400,
        code: 'BLOCKING_CELLS_REMAIN',
        message: `Không thể hoàn tất đối soát vì còn ${blockingCount} ô dữ liệu có lỗi hoặc chưa được giải quyết.`,
        blockingCount,
        blockingCells: blockingCells.slice(0, 10),
      };
    }

    // 3. Atomically update document review completion metadata
    const now = new Date().toISOString();
    const { data: updatedDoc, error: updateErr } = await adminClient
      .from('documents')
      .update({
        review_status: 'REVIEWED',
        reviewed_by: userId,
        reviewed_at: now,
        updated_at: now,
      })
      .eq('id', documentId)
      .eq('user_id', userId)
      .select()
      .single();

    if (updateErr) {
      console.error('[HumanReviewService] Failed to complete review on document:', updateErr);
      return { success: false, status: 500, message: `Lỗi cập nhật trạng thái đối soát: ${updateErr.message}` };
    }

    // 4. Log document-level audit event
    await auditService.log({
      userId,
      action: 'COMPLETE_REVIEW',
      resourceType: 'documents',
      resourceId: documentId,
      metadata: { originalFilename: doc.original_filename, reviewStatus: 'REVIEWED' },
    });

    // 5. Dual-write legacy review_actions
    await adminClient.from('review_actions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      document_id: documentId,
      action_type: 'COMPLETE_REVIEW',
      created_at: now,
    });

    return {
      success: true,
      status: 200,
      message: 'Đã hoàn tất đối soát dữ liệu. Tài liệu sẵn sàng để xuất file.',
      document: updatedDoc,
    };
  }

  /**
   * Resets human review state on OCR re-run:
   * Sets status = QUEUED, review_status = UNREVIEWED, reviewed_by = NULL, reviewed_at = NULL atomically.
   */
  async resetReviewOnOcrRerun(userId: string, documentId: string): Promise<void> {
    const adminClient = getSupabaseAdminClient();
    const now = new Date().toISOString();
    await adminClient
      .from('documents')
      .update({
        status: 'QUEUED',
        review_status: 'UNREVIEWED',
        reviewed_by: null,
        reviewed_at: null,
        updated_at: now,
      })
      .eq('id', documentId)
      .eq('user_id', userId);
  }
}

export const humanReviewService = new HumanReviewService();
