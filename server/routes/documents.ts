import express, { Response } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { db, DocumentPageRecord } from '../db/db.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { storageService } from '../services/storageService.js';
import { ocrService } from '../services/ocrService.js';
import { quotaService } from '../services/quotaService.js';
import { auditService } from '../services/auditService.js';
import { excelExportEngine, ExportMode } from '../services/excelExportEngine.js';
import { ocrRateLimiter, exportRateLimiter } from '../middleware/rateLimiter.js';
import { DataNormalizer } from '../services/ocr/normalizer.js';
import { createSupabaseUserClient, getSupabaseAdminClient } from '../services/supabaseClient.js';
import { UnifiedTableService } from '../services/unifiedTableService.js';
import { preflightService, PREFLIGHT_CONFIG } from '../services/preflightService.js';
import { humanReviewService } from '../services/humanReviewService.js';

const router = express.Router();

/**
 * Decodes original filename to preserve Vietnamese and Unicode characters.
 * Multer/busboy parses multipart headers as Latin-1 by default.
 * Converting Latin-1 byte representation back to UTF-8 recovers the original Unicode string.
 * Guard with '\ufffd' check to prevent over-decoding strings that are already UTF-8.
 */
export function decodeOriginalFilename(rawName?: string): string {
  if (!rawName) return 'document.pdf';
  try {
    const decoded = Buffer.from(rawName, 'latin1').toString('utf8');
    if (!decoded.includes('\ufffd')) {
      return decoded.normalize('NFC');
    }
  } catch {
    // fallback to original if decoding fails
  }
  return rawName.normalize('NFC');
}

// Multer in-memory storage configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB max file size
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/pjpeg'];
    const decodedName = decodeOriginalFilename(file.originalname);
    const ext = path.extname(decodedName).toLowerCase();
    const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png'];

    if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận tệp định dạng PDF, JPG, JPEG hoặc PNG.'));
    }
  },
});

// All document routes require Supabase Bearer Authentication
router.use(authMiddleware);

// 1. GET ALL USER DOCUMENTS (RLS: User can only see their own documents)
router.get('/', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const documents = await db.getUserDocuments(userId, req.userToken);
    res.json({
      success: true,
      documents,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Không thể tải danh sách tài liệu' });
  }
});

// 2. GET SINGLE DOCUMENT
router.get('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;

    const document = await db.getUserDocumentById(userId, docId, req.userToken);
    if (!document) {
      res.status(404).json({
        success: false,
        error: 'Không tìm thấy tài liệu hoặc bạn không có quyền truy cập.',
      });
      return;
    }

    const job = await db.getJobByDocumentId(userId, docId);

    res.json({
      success: true,
      document,
      job,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Lỗi khi tải thông tin tài liệu' });
  }
});

// 3. GET FILE CONTENT / STREAM FROM PRIVATE SUPABASE STORAGE (Requires Bearer Header)
router.get('/:id/file', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;

    // Strict ownership verification (RLS)
    const document = await db.getUserDocumentById(userId, docId, req.userToken);
    if (!document) {
      res.status(403).json({
        success: false,
        error: 'Truy cập bị từ chối. Bạn không sở hữu tài liệu này.',
      });
      return;
    }

    const fileData = await storageService.getFile(userId, docId, req.userToken);
    if (!fileData) {
      res.status(404).json({ success: false, error: 'Tệp tin không tồn tại trong bộ lưu trữ an toàn.' });
      return;
    }

    res.setHeader('Content-Type', fileData.mimeType || document.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.original_filename)}"`);
    res.send(fileData.buffer);
  } catch (err) {
    console.error('File stream error:', err);
    res.status(500).json({ success: false, error: 'Có lỗi khi đọc tệp từ lưu trữ riêng tư.' });
  }
});

// 4. CREATE SHORT-LIVED SIGNED URL (For single document only, valid for 60 seconds)
router.post('/:id/signed-url', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;

    const document = await db.getUserDocumentById(userId, docId, req.userToken);
    if (!document) {
      res.status(403).json({
        success: false,
        error: 'Truy cập bị từ chối.',
      });
      return;
    }

    const signedUrlData = await storageService.createSignedUrl(
      userId,
      docId,
      document.file_name,
      60,
      req.userToken
    );

    if (!signedUrlData) {
      res.status(500).json({ success: false, error: 'Không thể tạo liên kết truy cập an toàn.' });
      return;
    }

    res.json({
      success: true,
      signedUrl: signedUrlData.signedUrl,
      expiresAt: signedUrlData.expiresAt,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Lỗi khi tạo liên kết an toàn.' });
  }
});

// 5. UPLOAD DOCUMENT TO SUPABASE STORAGE & RUN PREFLIGHT (No OCR triggered, No Quota consumed)
router.post('/upload', ocrRateLimiter, upload.single('file'), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const file = req.file;

    if (!file) {
      res.status(400).json({
        success: false,
        error: 'Vui lòng chọn một tệp PDF hoặc ảnh hợp lệ để tải lên.',
      });
      return;
    }

    // Step 1: Pre-check User Quota (Verification only, NOT consumed yet)
    const quota = await quotaService.checkUserQuota(userId);
    if (!quota.allowed) {
      res.status(403).json({
        success: false,
        error: quota.message || 'Bạn đã sử dụng hết số tài liệu của gói hiện tại. Vui lòng nâng cấp gói.',
      });
      return;
    }

    const rawName = (typeof req.body?.originalName === 'string' && req.body.originalName.trim())
      ? req.body.originalName.trim()
      : file.originalname;
    const originalFilename = decodeOriginalFilename(rawName);

    const documentId = crypto.randomUUID();
    const ext = path.extname(originalFilename).toLowerCase();
    const fileType = ext === '.pdf' ? 'PDF' : ext === '.png' ? 'PNG' : 'JPG';

    let isFileSaved = false;
    let isDocumentCreated = false;

    try {
      // Step 2: Save to Private Supabase Storage (Bucket: 'documents')
      const saved = await storageService.saveFile(
        userId,
        documentId,
        originalFilename,
        file.buffer,
        file.mimetype,
        req.userToken
      );
      isFileSaved = true;

      // Step 3: Run Deterministic Preflight Engine (Local analysis, zero OCR/Azure calls)
      const preflightResult = await preflightService.analyzeDocument(
        file.buffer,
        file.mimetype,
        originalFilename
      );

      // Step 4: Create Document Record in Database with status = 'WAITING_CONFIRMATION'
      const newDoc = await db.createDocument({
        id: documentId,
        user_id: userId,
        original_filename: originalFilename,
        file_name: saved.fileName,
        file_type: fileType,
        mime_type: file.mimetype,
        file_size: saved.fileSize,
        page_count: preflightResult.pageCount,
        storage_bucket: saved.storageBucket,
        storage_path: saved.storagePath,
        document_type: 'BANK_STATEMENT',
        status: 'WAITING_CONFIRMATION',
        preflight_summary: preflightResult.summary,
        output_type: 'EXCEL',
      }, req.userToken);
      isDocumentCreated = true;

      // Step 5: Save page-by-page Preflight analysis into normalized document_pages
      const pageRecords: DocumentPageRecord[] = preflightResult.pages.map((p) => ({
        id: crypto.randomUUID(),
        document_id: documentId,
        page_number: p.pageNumber,
        classification: p.classification,
        classification_confidence: p.classificationConfidence,
        text_char_count: p.textCharCount,
        text_block_count: p.textBlockCount,
        text_coverage: p.textCoverage,
        image_count: p.imageCount,
        image_coverage: p.imageCoverage,
        has_full_page_image: p.hasFullPageImage,
        classification_reason: p.classificationReason,
      }));

      await db.createDocumentPages(pageRecords, req.userToken);

      // Step 6: Log Audit Trail (UPLOAD_PREFLIGHT_COMPLETED)
      await auditService.log({
        userId,
        action: 'UPLOAD_PREFLIGHT_COMPLETED',
        resourceType: 'documents',
        resourceId: documentId,
        ipAddress: req.ip,
        metadata: {
          filename: file.originalname,
          fileSize: saved.fileSize,
          fileType,
          pageCount: preflightResult.pageCount,
          preflightSummary: preflightResult.summary,
          estimatedCredits: preflightResult.estimatedCredits,
        },
      });

      res.status(201).json({
        success: true,
        message: 'Tải tài liệu và phân tích cấu trúc hoàn tất. Vui lòng xác nhận để bắt đầu xử lý.',
        document: newDoc,
        preflight: {
          pageCount: preflightResult.pageCount,
          summary: preflightResult.summary,
          estimatedCredits: preflightResult.estimatedCredits,
          pages: preflightResult.pages,
        },
        quota, // Quota is NOT consumed at this point!
      });
    } catch (pipelineErr: any) {
      console.error(`[Upload Pipeline Error] docId: ${documentId}, isFileSaved: ${isFileSaved}, isDocumentCreated: ${isDocumentCreated}. Initiating compensating cleanup...`, pipelineErr);

      if (isFileSaved) {
        if (isDocumentCreated) {
          try {
            await db.hardDeleteDocument(userId, documentId, req.userToken);
          } catch (docCleanupErr) {
            console.error('[Compensating Cleanup] Error deleting orphan document:', docCleanupErr);
          }
        }

        try {
          await storageService.deleteDocumentFiles(userId, documentId, req.userToken);
        } catch (storageCleanupErr) {
          console.error('[Compensating Cleanup] Error deleting orphan storage file:', storageCleanupErr);
        }
      }

      throw pipelineErr;
    }
  } catch (err: any) {
    console.error('Document upload error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Có lỗi xảy ra khi tải tài liệu. Vui lòng thử lại.',
    });
  }
});

// 5.1 CONFIRM AND TRIGGER EXPENSIVE OCR PROCESSING PIPELINE (ATOMIC POSTGRESQL TRANSACTION)
router.post('/:id/process', ocrRateLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const docId = req.params.id;
  const requestedOutputType = (req.body?.outputType || 'EXCEL').toUpperCase();

  console.log(`[PROCESS_CONFIRM_STARTED] docId: ${docId}, userId: ${userId}, outputType: ${requestedOutputType}`);

  // 1. Validate Selected Output Type (Word guard - do not route to Excel!)
  if (requestedOutputType === 'WORD') {
    console.warn(`[PROCESS_CONFIRM_REJECTED] docId: ${docId}, outputType: WORD unsupported`);
    res.status(400).json({
      success: false,
      code: 'UNSUPPORTED_OUTPUT_TYPE',
      error: 'Chức năng chuyển đổi sang Word (.docx) đang được phát triển (Sắp ra mắt). Vui lòng chọn đầu ra Excel để tiếp tục.',
    });
    return;
  }

  try {
    // 2. Call Atomic PostgreSQL RPC (locks document & quota, verifies state, creates job, deducts quota, transitions document)
    const result = await db.confirmDocumentProcessing(
      userId,
      docId,
      requestedOutputType,
      req.userToken
    );

    // 3. Handle Idempotent Results
    if (result.already_processing) {
      console.log(`[PROCESS_CONFIRM_ALREADY_PROCESSING] docId: ${docId}, jobId: ${result.job?.id}`);
      res.json({
        success: true,
        alreadyProcessing: true,
        message: result.message || 'Tài liệu đã nằm trong hàng đợi xử lý.',
        document: result.document,
        job: result.job,
        quota: result.quota,
      });
      return;
    }

    if (result.already_completed) {
      console.log(`[PROCESS_CONFIRM_ALREADY_COMPLETED] docId: ${docId}, jobId: ${result.job?.id}`);
      res.json({
        success: true,
        alreadyCompleted: true,
        message: result.message || 'Tài liệu đã được xử lý hoàn tất.',
        document: result.document,
        job: result.job,
        quota: result.quota,
      });
      return;
    }

    // 4. TRANSACTION IS COMMITTED!
    console.log(`[PROCESS_CONFIRM_COMMITTED] docId: ${docId}, jobId: ${result.job?.id}, quotaUsed: ${result.quota.used}/${result.quota.total}`);

    // 5. Trigger Background Worker ONLY AFTER COMMIT
    if (result.job?.id) {
      try {
        ocrService.startExistingJob(userId, result.job.id, docId);
        console.log(`[PROCESS_WORKER_STARTED] docId: ${docId}, jobId: ${result.job.id}`);
      } catch (workerStartErr: any) {
        console.error(`[PROCESS_WORKER_START_FAILED] docId: ${docId}, jobId: ${result.job.id}:`, workerStartErr);
        // Database remains durable & consistent: document is QUEUED, quota consumed once, job is QUEUED.
        // Worker failure post-commit is recovered via resumeUnfinishedJobs() on startup.
      }
    }

    // 6. Non-critical Audit Log (Outside critical transaction)
    try {
      await auditService.log({
        userId,
        action: 'PROCESSING_CONFIRMED',
        resourceType: 'documents',
        resourceId: docId,
        ipAddress: req.ip,
        metadata: {
          outputType: requestedOutputType,
          jobId: result.job?.id,
          pageCount: result.document?.page_count,
        },
      });
    } catch (auditErr) {
      console.warn(`[AuditLog Warning] Non-critical audit log failed for doc ${docId}:`, auditErr);
    }

    res.json({
      success: true,
      message: result.message || 'Đã xác nhận và bắt đầu đưa tài liệu vào hàng đợi xử lý OCR.',
      document: result.document,
      job: result.job,
      quota: result.quota,
    });
  } catch (err: any) {
    const errorMsg = String(err.message || '');
    console.error(`[PROCESS_CONFIRM_FAILED] docId: ${docId}:`, errorMsg);

    // Map PostgreSQL RPC exceptions to application-level HTTP errors
    if (errorMsg.includes('INSUFFICIENT_QUOTA')) {
      console.warn(`[PROCESS_CONFIRM_QUOTA_REJECTED] docId: ${docId}, userId: ${userId}`);
      res.status(403).json({
        success: false,
        code: 'INSUFFICIENT_QUOTA',
        error: 'Bạn đã sử dụng hết số tài liệu của gói hiện tại. Vui lòng nâng cấp gói để tiếp tục xử lý.',
      });
      return;
    }

    if (errorMsg.includes('DOCUMENT_NOT_FOUND')) {
      res.status(404).json({
        success: false,
        code: 'DOCUMENT_NOT_FOUND',
        error: 'Tài liệu không tồn tại hoặc bạn không có quyền truy cập.',
      });
      return;
    }

    if (errorMsg.includes('DOCUMENT_ACCESS_DENIED')) {
      res.status(403).json({
        success: false,
        code: 'DOCUMENT_ACCESS_DENIED',
        error: 'Truy cập bị từ chối. Bạn không sở hữu tài liệu này.',
      });
      return;
    }

    if (errorMsg.includes('INVALID_DOCUMENT_STATE')) {
      res.status(400).json({
        success: false,
        code: 'INVALID_DOCUMENT_STATE',
        error: 'Trạng thái tài liệu không hợp lệ để bắt đầu xử lý.',
      });
      return;
    }

    if (errorMsg.includes('UNSUPPORTED_OUTPUT_TYPE')) {
      res.status(400).json({
        success: false,
        code: 'UNSUPPORTED_OUTPUT_TYPE',
        error: 'Chức năng chuyển đổi sang Word (.docx) đang được phát triển (Sắp ra mắt). Vui lòng chọn đầu ra Excel để tiếp tục.',
      });
      return;
    }

    // Generic transaction failure (everything in PostgreSQL was rolled back)
    console.warn(`[PROCESS_CONFIRM_ROLLED_BACK] docId: ${docId}, error: ${errorMsg}`);
    res.status(500).json({
      success: false,
      code: 'TRANSACTION_FAILED',
      error: 'Lỗi khi kích hoạt xử lý tài liệu. Mọi thay đổi đã được hoàn tác.',
    });
  }
});

// 5.2 GET DOCUMENT PREFLIGHT DETAILS (Document summary + normalized document_pages)
router.get('/:id/preflight', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;

    const document = await db.getUserDocumentById(userId, docId, req.userToken);
    if (!document) {
      res.status(404).json({
        success: false,
        error: 'Tài liệu không tồn tại hoặc bạn không có quyền truy cập.',
      });
      return;
    }

    const pages = await db.getDocumentPages(userId, docId, req.userToken);

    res.json({
      success: true,
      document,
      pageCount: document.page_count,
      summary: document.preflight_summary || {
        nativeTextPages: 0,
        scannedPages: 0,
        mixedPages: 0,
        uncertainPages: 0,
      },
      pages,
      estimatedCredits: document.page_count * PREFLIGHT_CONFIG.CREDITS_PER_PAGE,
      outputType: document.output_type || 'EXCEL',
    });
  } catch (err: any) {
    console.error('Get preflight error:', err);
    res.status(500).json({ success: false, error: 'Không thể tải thông tin phân tích tài liệu.' });
  }
});

// 6. DELETE DOCUMENT (Soft delete DB + remove objects from Private Supabase Storage)
router.delete('/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;

    const document = await db.getUserDocumentById(userId, docId, req.userToken);
    if (!document) {
      res.status(404).json({
        success: false,
        error: 'Tài liệu không tồn tại hoặc bạn không có quyền xóa tài liệu này.',
      });
      return;
    }

    // 1. Soft delete database record
    const deleted = await db.softDeleteDocument(userId, docId, req.userToken);
    if (!deleted) {
      res.status(500).json({ success: false, error: 'Không thể xóa bản ghi tài liệu.' });
      return;
    }

    // 2. Remove files from Supabase Storage
    await storageService.deleteDocumentFiles(userId, docId, req.userToken);

    // 3. Log audit
    await auditService.log({
      userId,
      action: 'DELETE_DOCUMENT',
      resourceType: 'documents',
      resourceId: docId,
      ipAddress: req.ip,
      metadata: { originalFilename: document.original_filename },
    });

    res.json({
      success: true,
      message: 'Đã xóa tài liệu và tệp lưu trữ an toàn thành công.',
    });
  } catch (err) {
    console.error('Document delete error:', err);
    res.status(500).json({ success: false, error: 'Có lỗi xảy ra khi xóa tài liệu.' });
  }
});

// 7. GET OCR STRUCTURED RESULT & TABLES FOR REVIEW
router.get('/:id/ocr-result', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;

    // Strict User Isolation Check
    const document = await db.getUserDocumentById(userId, docId, req.userToken);
    if (!document) {
      res.status(404).json({
        success: false,
        error: 'Tài liệu không tồn tại hoặc bạn không có quyền truy cập.',
      });
      return;
    }

    const ocrData = await db.getDocumentOcrResult(userId, docId, req.userToken);
    const job = await db.getJobByDocumentId(userId, docId);

    if (!ocrData || ocrData.tables.length === 0) {
      // If OCR not run yet, provide status
      res.json({
        success: true,
        document,
        job,
        pages: ocrData?.pages || [],
        tables: [],
        documentMetadata: ocrData?.documentMetadata || [],
        unifiedTransactionTable: null,
        stats: {
          totalCells: 0,
          lowConfidenceCount: 0,
          mediumConfidenceCount: 0,
          highConfidenceCount: 0,
          requiresReview: false,
        },
      });
      return;
    }

    let unifiedTransactionTable = null;
    try {
      unifiedTransactionTable = UnifiedTableService.projectDocumentTables(docId, ocrData.tables);
    } catch (projErr) {
      console.error(`[UnifiedTableService] Error projecting unified table for document ${docId}:`, projErr);
      unifiedTransactionTable = null;
    }

    res.json({
      success: true,
      document: ocrData.document,
      job,
      pages: ocrData.pages,
      tables: ocrData.tables,
      documentMetadata: ocrData.documentMetadata || [],
      unifiedTransactionTable,
      stats: ocrData.stats,
    });
  } catch (err: any) {
    console.error('Get OCR result error:', err);
    res.status(500).json({ success: false, error: 'Không thể tải dữ liệu OCR của tài liệu.' });
  }
});

// 8. TRIGGER / RETRY OCR PROCESSING
router.post('/:id/ocr', ocrRateLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;

    const document = await db.getUserDocumentById(userId, docId, req.userToken);
    if (!document) {
      res.status(404).json({
        success: false,
        error: 'Tài liệu không tồn tại hoặc bạn không có quyền truy cập.',
      });
      return;
    }

    const job = await ocrService.retryDocumentProcessing(userId, docId);
    await humanReviewService.resetReviewOnOcrRerun(userId, docId);

    await auditService.log({
      userId,
      action: 'RETRY_OCR',
      resourceType: 'documents',
      resourceId: docId,
      ipAddress: req.ip,
      metadata: { jobId: job.id },
    });

    res.json({
      success: true,
      message: 'Đã gửi yêu cầu xử lý OCR vào hàng đợi Azure AI.',
      job,
    });
  } catch (err: any) {
    console.error('Trigger OCR error:', err);
    res.status(500).json({ success: false, error: err.message || 'Không thể bắt đầu xử lý OCR.' });
  }
});

// 9. UPDATE EXTRACTED CELL (Human Review & Edit Data)
router.put('/:id/cells/:cellId', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;
    const cellId = req.params.cellId;
    const { rawValue, cellType } = req.body;

    const result = await humanReviewService.editCell(userId, docId, cellId, rawValue, cellType, req.userToken);
    res.status(result.status).json(result);
  } catch (err: any) {
    console.error('Update cell error:', err);
    res.status(err.status || 500).json({ success: false, error: err.message || 'Không thể cập nhật ô dữ liệu.' });
  }
});

// 9.1 CONFIRM EXTRACTED CELL AS-IS (Human Review Confirmation)
router.put('/:id/cells/:cellId/confirm-review', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;
    const cellId = req.params.cellId;

    const result = await humanReviewService.confirmCell(userId, docId, cellId, req.userToken);
    res.status(result.status).json(result);
  } catch (err: any) {
    console.error('Confirm review error:', err);
    res.status(err.status || 500).json({ success: false, error: err.message || 'Không thể xác nhận ô dữ liệu.' });
  }
});

// 10. ADD ROW TO TABLE
router.post('/:id/tables/:tableId/rows', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;
    const tableId = req.params.tableId;
    const { cells } = req.body; // Array of { rawValue, normalizedValue, cellType, columnIndex }

    const result = await db.addExtractedRow(userId, docId, tableId, Array.isArray(cells) ? cells : [], req.userToken);

    res.status(201).json({
      success: true,
      message: 'Đã thêm dòng mới vào bảng thành công.',
      row: result.row,
      cells: result.cells,
    });
  } catch (err: any) {
    console.error('Add row error:', err);
    res.status(400).json({ success: false, error: err.message || 'Không thể thêm dòng mới.' });
  }
});

// 11. DELETE ROW FROM TABLE
router.delete('/:id/tables/:tableId/rows/:rowIndex', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;
    const tableId = req.params.tableId;
    const rowIndex = parseInt(req.params.rowIndex, 10);

    await db.deleteExtractedRow(userId, docId, tableId, rowIndex, req.userToken);

    res.json({
      success: true,
      message: 'Đã xóa dòng khỏi bảng thành công.',
    });
  } catch (err: any) {
    console.error('Delete row error:', err);
    res.status(400).json({ success: false, error: err.message || 'Không thể xóa dòng.' });
  }
});

// 12. COMPLETE DOCUMENT REVIEW (Review Completion Gate)
router.post('/:id/review/complete', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;

    const result = await humanReviewService.completeReview(userId, docId, req.userToken);
    res.status(result.status).json(result);
  } catch (err: any) {
    console.error('Complete review error:', err);
    res.status(err.status || 500).json({ success: false, error: err.message || 'Không thể hoàn tất đối soát.' });
  }
});

// 13. EXPORT DOCUMENT TO EXCEL (.XLSX) — (Phase 3A)
router.post('/:id/export/excel', exportRateLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;
    const { mode, includeReviewLog, includeValidationSheet, highlightLowConfidence } = req.body;

    const exportMode: ExportMode = mode === 'ORIGINAL' ? 'ORIGINAL' : 'NORMALIZED';

    const result = await excelExportEngine.exportDocumentToExcel(userId, docId, {
      mode: exportMode,
      includeReviewLog: includeReviewLog !== false,
      includeValidationSheet: includeValidationSheet !== false,
      highlightLowConfidence: highlightLowConfidence !== false,
    });

    res.json({
      success: true,
      message: `Đã xuất dữ liệu sang định dạng Excel (.xlsx) thành công (${exportMode === 'ORIGINAL' ? 'Dữ liệu gốc' : 'Chuẩn hóa'}).`,
      export: result,
    });
  } catch (err: any) {
    console.error('Excel Export error:', err);
    res.status(400).json({
      success: false,
      error: err.message || 'Không thể tạo tệp Excel từ dữ liệu tài liệu.',
    });
  }
});

// 14. GET DOCUMENT EXPORTS HISTORY
router.get('/:id/exports', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;

    // Verify ownership
    const doc = await db.getUserDocumentById(userId, docId, req.userToken);
    if (!doc) {
      res.status(404).json({ success: false, error: 'Không tìm thấy tài liệu hoặc không có quyền truy cập.' });
      return;
    }

    const exportsList = await db.getDocumentExports(userId, docId);
    res.json({
      success: true,
      exports: exportsList,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Không thể tải lịch sử xuất tệp.' });
  }
});

// 15. DOWNLOAD EXPORTED EXCEL FILE (Secure Stream with User Isolation)
router.get('/:id/exports/:exportId/download', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const docId = req.params.id;
    const exportId = req.params.exportId;

    // Strict ownership & RLS check
    const doc = await db.getUserDocumentById(userId, docId, req.userToken);
    if (!doc) {
      res.status(403).json({ success: false, error: 'Truy cập bị từ chối. Bạn không sở hữu tài liệu này.' });
      return;
    }

    const exportRecord = await db.getUserExportById(userId, exportId);
    if (!exportRecord || exportRecord.document_id !== docId) {
      res.status(404).json({ success: false, error: 'Không tìm thấy bản xuất tệp hoặc bạn không có quyền tải xuống.' });
      return;
    }

    // Retrieve file from private storage
    const fileData = await storageService.getFile(userId, `export_${exportId}`, req.userToken);
    if (!fileData) {
      res.status(404).json({ success: false, error: 'Tệp xuất không tồn tại trong kho lưu trữ an toàn.' });
      return;
    }

    // Log download audit action
    await auditService.log({
      userId,
      action: 'DOWNLOAD_EXPORT',
      resourceType: 'documents',
      resourceId: docId,
      ipAddress: req.ip,
      metadata: {
        exportId,
        fileName: exportRecord.file_name,
        fileSize: exportRecord.file_size,
        exportFormat: exportRecord.export_format,
      },
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(exportRecord.file_name)}"`);
    res.setHeader('Content-Length', fileData.buffer.length);
    res.send(fileData.buffer);
  } catch (err: any) {
    console.error('Download export error:', err);
    res.status(500).json({ success: false, error: 'Lỗi khi tải tệp xuất.' });
  }
});

export default router;
