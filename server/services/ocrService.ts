import { db, ProcessingJobRecord } from '../db/db.js';
import { ocrWorker } from './ocrWorker.js';

export interface IOCRService {
  queueDocumentForProcessing(userId: string, documentId: string): Promise<ProcessingJobRecord>;
  startExistingJob(userId: string, jobId: string, documentId: string): void;
  retryDocumentProcessing(userId: string, documentId: string): Promise<ProcessingJobRecord>;
  getJobStatus(userId: string, jobId: string): Promise<ProcessingJobRecord | null>;
}

export class AzureDocumentIntelligenceService implements IOCRService {
  /**
   * Queues a document for OCR and triggers the non-blocking background worker.
   */
  async queueDocumentForProcessing(userId: string, documentId: string): Promise<ProcessingJobRecord> {
    const existingJob = await db.getJobByDocumentId(userId, documentId);
    if (existingJob) {
      // If it's already QUEUED or PROCESSING, return it
      if (existingJob.status === 'QUEUED' || existingJob.status === 'PROCESSING') {
        return existingJob;
      }
      // If already finished or failed, return existing
      if (existingJob.status === 'READY' || existingJob.status === 'REVIEW_REQUIRED') {
        return existingJob;
      }
    }

    const jobId = existingJob ? existingJob.id : crypto.randomUUID();
    const job = existingJob
      ? (await db.updateProcessingJob(userId, jobId, {
          status: 'QUEUED',
          current_step: 'Đang xếp hàng chờ xử lý Azure AI Document Intelligence',
          progress: 10,
          attempt_count: (existingJob.attempt_count || 0) + 1,
          error_code: null,
          error_message: null,
          started_at: new Date().toISOString(),
          completed_at: null,
        }))!
      : await db.createProcessingJob({
          id: jobId,
          document_id: documentId,
          user_id: userId,
          status: 'QUEUED',
          current_step: 'Đang xếp hàng chờ xử lý Azure AI Document Intelligence',
          progress: 10,
          attempt_count: 1,
          started_at: new Date().toISOString(),
        });

    await db.updateDocumentStatus(userId, documentId, 'QUEUED');

    // Trigger non-blocking background worker execution
    setImmediate(() => {
      ocrWorker.processJob(userId, job.id, documentId).catch((err) => {
        console.error(`[ocrService] Background worker error for job ${job.id}:`, err);
      });
    });

    return job;
  }

  /**
   * Triggers background OCR worker for a job that was ALREADY durably created by the atomic database transaction.
   * Does NOT insert another job, does NOT touch quota, and does NOT overwrite document status.
   */
  startExistingJob(userId: string, jobId: string, documentId: string): void {
    setImmediate(() => {
      ocrWorker.processJob(userId, jobId, documentId).catch((err) => {
        console.error(`[ocrService] Background worker error for existing job ${jobId}:`, err);
      });
    });
  }

  async retryDocumentProcessing(userId: string, documentId: string): Promise<ProcessingJobRecord> {
    const doc = await db.getUserDocumentById(userId, documentId);
    if (!doc) {
      throw new Error('Tài liệu không tồn tại hoặc không có quyền truy cập.');
    }

    let job = await db.getJobByDocumentId(userId, documentId);
    const jobId = job ? job.id : crypto.randomUUID();

    job = job
      ? (await db.updateProcessingJob(userId, jobId, {
          status: 'QUEUED',
          current_step: 'Đang xếp hàng thử lại xử lý OCR...',
          progress: 10,
          attempt_count: (job.attempt_count || 1) + 1,
          error_code: null,
          error_message: null,
          started_at: new Date().toISOString(),
          completed_at: null,
        }))!
      : await db.createProcessingJob({
          id: jobId,
          document_id: documentId,
          user_id: userId,
          status: 'QUEUED',
          current_step: 'Đang xếp hàng thử lại xử lý OCR...',
          progress: 10,
          attempt_count: 1,
          started_at: new Date().toISOString(),
        });

    await db.updateDocumentStatus(userId, documentId, 'QUEUED');

    setImmediate(() => {
      ocrWorker.processJob(userId, jobId, documentId).catch((err) => {
        console.error(`[ocrService] Retry background worker error for job ${jobId}:`, err);
      });
    });

    return job;
  }

  async getJobStatus(userId: string, jobId: string): Promise<ProcessingJobRecord | null> {
    return await db.getProcessingJob(userId, jobId);
  }
}

export const ocrService = new AzureDocumentIntelligenceService();
