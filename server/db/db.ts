import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getSupabaseAdminClient, createSupabaseUserClient } from '../services/supabaseClient.js';
import { OCRAnalysisResult, OCRMetadataItem } from '../services/ocr/types.js';
import { MetadataFilterEngine, SEMANTIC_TYPE_ORDER } from '../services/ocr/metadataFilterEngine.js';
import { PreflightSummary } from '../services/preflightService.js';
import { ValidationEngine } from '../services/validation/ValidationEngine.js';

export type ProcessingStrategy =
  | 'LOCAL_NATIVE'
  | 'AZURE_FULL_PAGE'
  | 'HYBRID'
  | 'LOCAL_RECHECK'
  | 'AZURE_FALLBACK';

export interface DocumentPageRecord {
  id?: string;
  document_id: string;
  page_number: number;
  classification: 'NATIVE_TEXT' | 'SCANNED' | 'MIXED' | 'UNCERTAIN';
  classification_confidence: number;
  text_char_count: number;
  text_block_count: number;
  text_coverage: number;
  image_count: number;
  image_coverage: number;
  has_full_page_image: boolean;
  classification_reason?: string | null;
  processing_strategy?: ProcessingStrategy | null;
  fallback_strategy?: ProcessingStrategy | null;
  requires_azure?: boolean;
  requires_region_analysis?: boolean;
  decision_reason?: string | null;
  decision_version?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface DocumentMetadataRecord {
  id: string;
  document_id: string;
  label: string;
  raw_label: string;
  value: string;
  raw_value: string;
  normalized_label: string;
  normalized_value_for_match: string;
  confidence_score: number;
  source_page: number;
  key_bounding_box?: any;
  value_bounding_box?: any;
  occurrence_count: number;
  status: 'AUTO' | 'CONFLICT' | 'REVIEWED';
  semantic_type?: string;
  quality_score?: number;
  visibility_class?: string;
  alternatives?: any[];
  created_at: string;
  updated_at: string;
}

export interface PlanRecord {
  id: string;
  name: string;
  price_vnd: number;
  duration_days: number;
  document_quota: number;
  features: string[];
  is_active: boolean;
  created_at: string;
}

export interface ProfileRecord {
  id: string; // References auth.users(id)
  email: string;
  full_name: string;
  avatar_url?: string | null;
  current_plan_id: string;
  used_documents: number;
  created_at: string;
  updated_at: string;
}

export interface AuthUserRecord {
  id: string; // UUID in auth.users
  email: string;
  password_hash: string;
  full_name: string;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionRecord {
  id: string;
  user_id: string;
  plan_id: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING';
  start_at: string;
  expires_at: string;
  payment_status: string;
  created_at: string;
}

export interface UsageRecord {
  id: string;
  user_id: string;
  month_period: string; // YYYY-MM
  used_count: number;
  quota_limit: number;
  last_reset_at: string;
  updated_at: string;
}

export interface DocumentRecord {
  id: string;
  user_id: string; // auth.uid()
  original_filename: string;
  file_name: string;
  file_type: string;
  mime_type: string;
  file_size: number;
  page_count: number;
  storage_bucket: string; // 'documents'
  storage_path: string; // documents/{user_id}/{document_id}/original/{file_name}
  document_type: string;
  status: 'UPLOADED' | 'WAITING_CONFIRMATION' | 'QUEUED' | 'PROCESSING' | 'REVIEW_REQUIRED' | 'READY' | 'FAILED' | 'DELETED';
  review_status?: 'UNREVIEWED' | 'IN_PROGRESS' | 'REVIEWED';
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  preflight_summary?: PreflightSummary | null;
  output_type?: 'EXCEL' | 'WORD' | string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ProcessingJobRecord {
  id: string;
  document_id: string;
  user_id: string;
  status: 'QUEUED' | 'VALIDATING' | 'UPLOADING' | 'PROCESSING' | 'PARSING' | 'VALIDATING_RESULT' | 'REVIEW_REQUIRED' | 'READY' | 'FAILED';
  current_step: string;
  progress: number;
  attempt_count: number;
  error_code?: string | null;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditLogRecord {
  id: string;
  user_id: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  ip_address?: string;
  metadata?: Record<string, any>;
  created_at: string;
}

export interface OcrResultRecord {
  id: string;
  document_id: string;
  user_id?: string;
  page_number: number;
  raw_text: string;
  confidence_score: number;
  azure_model_id: string;
  metadata?: Record<string, any>;
  created_at: string;
}

export interface ExtractedTableRecord {
  id: string;
  document_id: string;
  user_id?: string;
  page_number: number;
  table_index: number;
  row_count: number;
  column_count: number;
  confidence_score: number;
  bounding_regions?: any[];
  created_at: string;
}

export interface ExtractedRowRecord {
  id: string;
  table_id: string;
  document_id?: string;
  user_id?: string;
  row_index: number;
  is_header?: boolean;
  created_at: string;
}

export interface ExtractedCellRecord {
  id: string;
  row_id: string;
  table_id?: string;
  document_id?: string;
  user_id?: string;
  row_index?: number;
  column_index: number;
  row_span?: number;
  column_span?: number;
  raw_value: string;
  normalized_value: string;
  cell_type: 'TEXT' | 'MONEY' | 'DATE' | 'NUMBER';
  confidence_score: number;
  is_reviewed: boolean;
  bounding_box?: any;
  created_at: string;
  updated_at: string;
}

export interface ReviewActionRecord {
  id: string;
  user_id: string;
  document_id: string;
  cell_id?: string;
  action_type: 'EDIT_CELL' | 'ADD_ROW' | 'DELETE_ROW' | 'COMPLETE_REVIEW';
  before_value?: string;
  after_value?: string;
  metadata?: Record<string, any>;
  created_at: string;
}

export interface ExportRecord {
  id: string;
  user_id: string;
  document_id: string;
  export_format: 'XLSX' | 'DOCX';
  export_mode: 'ORIGINAL' | 'NORMALIZED';
  file_name: string;
  file_size: number;
  storage_bucket: string;
  storage_path: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  error_message?: string | null;
  metadata?: Record<string, any>;
  created_at: string;
}

export interface ActiveSession {
  access_token: string;
  user_id: string;
  email: string;
  expires_at: number;
}

class DatabaseService {
  /**
   * Helper to resolve the appropriate Supabase Client:
   * Uses User-Scoped Client (with Bearer Token for RLS) when userToken is passed,
   * or falls back to Service-Role Admin Client for trusted server background tasks.
   */
  private getClient(userToken?: string) {
    if (userToken) {
      const userClient = createSupabaseUserClient(userToken);
      if (userClient) return userClient;
    }
    return getSupabaseAdminClient();
  }

  // --- PLANS ---
  async getPlans(): Promise<PlanRecord[]> {
    const client = getSupabaseAdminClient();
    const { data } = await client.from('plans').select('*').eq('is_active', true);
    return data || [];
  }

  async getPlanById(id: string): Promise<PlanRecord | null> {
    const client = getSupabaseAdminClient();
    const { data } = await client.from('plans').select('*').eq('id', id).maybeSingle();
    return data || null;
  }

  // --- PROFILES & AUTH ---
  async ensureProfile(userId: string, email: string, fullName: string): Promise<ProfileRecord> {
    const client = getSupabaseAdminClient();
    const now = new Date().toISOString();

    const { data: existing } = await client.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (existing) return existing;

    const newProfile: ProfileRecord = {
      id: userId,
      email,
      full_name: fullName || 'User',
      avatar_url: null,
      current_plan_id: 'FREE',
      used_documents: 0,
      created_at: now,
      updated_at: now,
    };

    const { data } = await client.from('profiles').upsert(newProfile, { onConflict: 'id' }).select().single();
    return data || newProfile;
  }

  async findProfileById(userId: string): Promise<ProfileRecord | null> {
    const client = getSupabaseAdminClient();
    const { data } = await client.from('profiles').select('*').eq('id', userId).maybeSingle();
    return data || null;
  }

  async updateProfileUsage(userId: string, usedDocuments: number): Promise<ProfileRecord | null> {
    const client = getSupabaseAdminClient();
    const now = new Date().toISOString();
    const { data } = await client
      .from('profiles')
      .update({ used_documents: usedDocuments, updated_at: now })
      .eq('id', userId)
      .select()
      .single();
    return data || null;
  }

  async upgradeUserPlan(userId: string, planId: string, durationDays: number, userToken?: string) {
    const client = this.getClient(userToken);
    const now = new Date();
    const nowIso = now.toISOString();

    // 1. Full Snapshot of all 3 entities before mutation
    const oldProfile = await this.findProfileById(userId);
    if (!oldProfile) throw new Error('Không tìm thấy tài khoản người dùng.');

    const { data: oldSubscriptions } = await client
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId);

    const monthPeriod = nowIso.slice(0, 7); // 'YYYY-MM'
    const { data: oldUsage } = await client
      .from('usage')
      .select('*')
      .eq('user_id', userId)
      .eq('month_period', monthPeriod)
      .maybeSingle();

    const plan = await this.getPlanById(planId);
    if (!plan) throw new Error('Gói cước không hợp lệ.');

    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();

    let profileUpdated = false;
    let oldSubDeactivated = false;
    let newSubInsertedId: string | null = null;
    let usageUpdated = false;

    try {
      // Step A: Update Profile (current_plan_id = planId, used_documents = 0)
      const { error: pErr } = await client
        .from('profiles')
        .update({
          current_plan_id: planId,
          used_documents: 0,
          updated_at: nowIso,
        })
        .eq('id', userId);

      if (pErr) throw new Error(`Lỗi cập nhật profile: ${pErr.message}`);
      profileUpdated = true;

      // Step B: Deactivate active subscriptions & Insert new active subscription
      const { error: deactivateErr } = await client
        .from('subscriptions')
        .update({ status: 'EXPIRED' })
        .eq('user_id', userId)
        .eq('status', 'ACTIVE');

      if (deactivateErr) throw new Error(`Lỗi cập nhật gói cước cũ: ${deactivateErr.message}`);
      oldSubDeactivated = true;

      const newSubId = crypto.randomUUID();
      const { error: newSubErr } = await client
        .from('subscriptions')
        .insert({
          id: newSubId,
          user_id: userId,
          plan_id: planId,
          status: 'ACTIVE',
          start_at: nowIso,
          expires_at: expiresAt,
          payment_status: 'COMPLETED',
          created_at: nowIso,
        });

      if (newSubErr) throw new Error(`Lỗi khởi tạo gói cước mới: ${newSubErr.message}`);
      newSubInsertedId = newSubId;

      // Step C: Upsert Usage record for current month
      const { error: uErr } = await client
        .from('usage')
        .upsert({
          id: oldUsage?.id || crypto.randomUUID(),
          user_id: userId,
          month_period: monthPeriod,
          used_count: 0,
          quota_limit: plan.document_quota,
          last_reset_at: nowIso,
          updated_at: nowIso,
        }, { onConflict: 'user_id,month_period' });

      if (uErr) throw new Error(`Lỗi cập nhật hạn mức tháng: ${uErr.message}`);
      usageUpdated = true;

      return { success: true };
    } catch (err: any) {
      console.error('[upgradeUserPlan] Error occurred. Executing compensating rollback...', err.message);

      // COMPENSATING ROLLBACK across all 3 entities
      try {
        if (profileUpdated && oldProfile) {
          await client.from('profiles').update({
            current_plan_id: oldProfile.current_plan_id,
            used_documents: oldProfile.used_documents,
            updated_at: nowIso,
          }).eq('id', userId);
        }

        if (newSubInsertedId) {
          await client.from('subscriptions').delete().eq('id', newSubInsertedId);
        }

        if (oldSubDeactivated && oldSubscriptions && oldSubscriptions.length > 0) {
          for (const sub of oldSubscriptions) {
            await client.from('subscriptions').update({ status: sub.status }).eq('id', sub.id);
          }
        }

        if (usageUpdated || oldUsage) {
          if (oldUsage) {
            await client.from('usage').upsert({
              id: oldUsage.id,
              user_id: userId,
              month_period: oldUsage.month_period,
              used_count: oldUsage.used_count,
              quota_limit: oldUsage.quota_limit,
              last_reset_at: oldUsage.last_reset_at,
              updated_at: nowIso,
            }, { onConflict: 'user_id,month_period' });
          }
        }
      } catch (rollbackErr: any) {
        console.error('[upgradeUserPlan] Critical rollback error:', rollbackErr.message);
      }

      throw err;
    }
  }

  async createAuthUserAndProfile(data: { email: string; password_hash: string; full_name: string }) {
    const userId = crypto.randomUUID();
    const profile = await this.ensureProfile(userId, data.email, data.full_name);
    const token = `sbp_${crypto.randomUUID()}_${userId}`;

    return {
      user: { id: userId, email: data.email, full_name: data.full_name },
      profile,
      session: { access_token: token, expires_in: 86400 * 30 },
    };
  }

  async authenticateUser(email: string, _password_hash: string) {
    const client = getSupabaseAdminClient();
    const { data: profile } = await client.from('profiles').select('*').eq('email', email).maybeSingle();
    if (!profile) return null;

    const token = `sbp_${crypto.randomUUID()}_${profile.id}`;
    return {
      user: { id: profile.id, email: profile.email, full_name: profile.full_name },
      profile,
      session: { access_token: token, expires_in: 86400 * 30 },
    };
  }

  async verifyLocalSupabaseToken(token: string) {
    const parts = token.split('_');
    if (parts.length >= 3) {
      const userId = parts[2];
      const profile = await this.findProfileById(userId);
      if (profile) {
        return {
          id: profile.id,
          email: profile.email,
          fullName: profile.full_name,
          currentPlanId: profile.current_plan_id,
          usedDocuments: profile.used_documents,
        };
      }
    }
    return null;
  }

  revokeSession(_token: string): boolean {
    return true;
  }

  // --- DOCUMENTS ---
  async getUserDocuments(userId: string, userToken?: string): Promise<DocumentRecord[]> {
    const client = this.getClient(userToken);
    const { data, error } = await client
      .from('documents')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[getUserDocuments] Error fetching user documents:', error);
      throw error;
    }

    return (data || []) as DocumentRecord[];
  }

  async getUserDocumentById(userId: string, documentId: string, userToken?: string): Promise<DocumentRecord | null> {
    const client = this.getClient(userToken);
    const { data, error } = await client
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      console.error(`[getUserDocumentById] Error fetching document ${documentId}:`, error);
      throw error;
    }

    return (data as DocumentRecord) || null;
  }

  async createDocument(doc: Partial<DocumentRecord>, userToken?: string): Promise<DocumentRecord> {
    const client = this.getClient(userToken);
    const now = new Date().toISOString();

    const newDoc: DocumentRecord = {
      id: doc.id || crypto.randomUUID(),
      user_id: doc.user_id!,
      original_filename: doc.original_filename || 'document.pdf',
      file_name: doc.file_name || doc.original_filename || 'document.pdf',
      file_type: doc.file_type || 'PDF',
      mime_type: doc.mime_type || 'application/pdf',
      file_size: doc.file_size || 0,
      page_count: doc.page_count || 1,
      storage_bucket: doc.storage_bucket || 'documents',
      storage_path: doc.storage_path || '',
      document_type: doc.document_type || 'BANK_STATEMENT',
      status: doc.status || 'QUEUED',
      preflight_summary: doc.preflight_summary ?? null,
      output_type: (doc.output_type as any) || 'EXCEL',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };

    const { data, error } = await client.from('documents').insert(newDoc).select().single();
    if (error) {
      console.error('[createDocument] Error creating document in Supabase:', error);
      throw error;
    }
    return (data as DocumentRecord) || newDoc;
  }

  async updateDocumentStatus(userId: string, documentId: string, status: DocumentRecord['status']): Promise<DocumentRecord | null> {
    const client = getSupabaseAdminClient();
    const now = new Date().toISOString();
    const payload: any = { status, updated_at: now };
    if (status === 'QUEUED') {
      payload.review_status = 'UNREVIEWED';
      payload.reviewed_by = null;
      payload.reviewed_at = null;
    }
    const { data } = await client
      .from('documents')
      .update(payload)
      .eq('id', documentId)
      .eq('user_id', userId)
      .select()
      .single();

    return data || null;
  }

  /**
   * Atomic state transition guard for /process idempotency:
   * Only transitions if current status === fromStatus (e.g. WAITING_CONFIRMATION -> QUEUED).
   * Prevents duplicate clicks, double-processing, and parallel race conditions.
   */
  async transitionDocumentStatus(
    userId: string,
    documentId: string,
    fromStatus: DocumentRecord['status'],
    toStatus: DocumentRecord['status'],
    outputType?: 'EXCEL' | 'WORD' | string,
    userToken?: string
  ): Promise<DocumentRecord | null> {
    const client = this.getClient(userToken);
    const now = new Date().toISOString();

    const updatePayload: any = { status: toStatus, updated_at: now };
    if (outputType) {
      updatePayload.output_type = outputType;
    }

    const { data, error } = await client
      .from('documents')
      .update(updatePayload)
      .eq('id', documentId)
      .eq('user_id', userId)
      .eq('status', fromStatus)
      .select()
      .maybeSingle();

    if (error) {
      console.error('[transitionDocumentStatus] Error in Supabase:', error.message);
      throw error;
    }

    return (data as DocumentRecord) || null;
  }

  /**
   * Phase 4.2: Atomic PostgreSQL RPC confirmation
   * Executes document row locking, quota row locking, active job idempotency,
   * quota deduction, and job creation in a SINGLE PostgreSQL transaction.
   */
  async confirmDocumentProcessing(
    userId: string,
    documentId: string,
    outputType: string = 'EXCEL',
    userToken?: string
  ): Promise<{
    success: boolean;
    already_processing?: boolean;
    already_completed?: boolean;
    message?: string;
    document: DocumentRecord;
    job: ProcessingJobRecord | null;
    quota: {
      used: number;
      total: number;
      remaining: number;
      planId: string;
      planName: string;
    };
  }> {
    // Privileged transaction RPC is strictly executed using the backend service_role admin client.
    // The userId has already been cryptographically verified by authMiddleware (from JWT).
    // The RPC function itself has EXECUTE permissions revoked from PUBLIC, anon, authenticated,
    // and granted ONLY to service_role, preventing any client-side direct bypass.
    const client = getSupabaseAdminClient();
    const { data, error } = await client.rpc('confirm_document_processing', {
      p_document_id: documentId,
      p_user_id: userId,
      p_output_type: outputType,
    });

    if (error) {
      throw error;
    }

    return data;
  }

  // --- DOCUMENT PAGES (PREFLIGHT NORMALIZED TABLE) ---
  async createDocumentPages(pages: DocumentPageRecord[], userToken?: string): Promise<DocumentPageRecord[]> {
    if (!pages || pages.length === 0) return [];
    const client = this.getClient(userToken);

    const formattedPages = pages.map((p) => ({
      ...p,
      id: p.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id)
        ? p.id
        : crypto.randomUUID(),
    }));

    const { data, error } = await client.from('document_pages').insert(formattedPages).select();
    if (error) {
      console.error('[createDocumentPages] Supabase error:', error.message);
      throw new Error(`Lỗi khi lưu thông tin trang tài liệu vào database: ${error.message}`);
    }

    return (data || formattedPages) as DocumentPageRecord[];
  }

  async getDocumentPages(userId: string, documentId: string, userToken?: string): Promise<DocumentPageRecord[]> {
    const doc = await this.getUserDocumentById(userId, documentId, userToken);
    if (!doc) return [];

    const client = this.getClient(userToken);
    const { data, error } = await client
      .from('document_pages')
      .select('*')
      .eq('document_id', documentId)
      .order('page_number', { ascending: true });

    if (error) {
      console.error('[getDocumentPages] Supabase error:', error.message);
      throw new Error(`Lỗi khi tải danh sách trang từ database: ${error.message}`);
    }

    return (data || []) as DocumentPageRecord[];
  }

  async updateDocumentPageDecisions(
    documentId: string,
    decisions: Array<{
      page_number: number;
      processing_strategy: ProcessingStrategy;
      fallback_strategy?: ProcessingStrategy;
      requires_azure: boolean;
      requires_region_analysis: boolean;
      decision_reason: string;
      decision_version: string;
    }>,
    userToken?: string
  ): Promise<void> {
    if (!decisions || decisions.length === 0) return;
    const client = this.getClient(userToken);
    const now = new Date().toISOString();

    for (const d of decisions) {
      const updatePayload: any = {
        processing_strategy: d.processing_strategy,
        fallback_strategy: d.fallback_strategy || null,
        requires_azure: d.requires_azure,
        requires_region_analysis: d.requires_region_analysis,
        decision_reason: d.decision_reason,
        decision_version: d.decision_version,
        updated_at: now,
      };

      const { error } = await client
        .from('document_pages')
        .update(updatePayload)
        .eq('document_id', documentId)
        .eq('page_number', d.page_number);

      if (error) {
        console.error(`[updateDocumentPageDecisions] Error updating page ${d.page_number}:`, error.message);
        throw new Error(`Lỗi cập nhật quyết định xử lý trang ${d.page_number}: ${error.message}`);
      }
    }
  }

  async updateDocumentPageCount(userId: string, documentId: string, pageCount: number): Promise<DocumentRecord | null> {
    const client = getSupabaseAdminClient();
    const now = new Date().toISOString();
    const { data } = await client
      .from('documents')
      .update({ page_count: pageCount, updated_at: now })
      .eq('id', documentId)
      .eq('user_id', userId)
      .select()
      .single();

    return data || null;
  }

  async softDeleteDocument(userId: string, documentId: string, userToken?: string): Promise<boolean> {
    const client = this.getClient(userToken);
    const now = new Date().toISOString();
    const { error } = await client
      .from('documents')
      .update({ status: 'DELETED', deleted_at: now, updated_at: now })
      .eq('id', documentId)
      .eq('user_id', userId);

    return !error;
  }

  async hardDeleteDocument(userId: string, documentId: string, userToken?: string): Promise<boolean> {
    const client = this.getClient(userToken);
    try {
      await client.from('processing_jobs').delete().eq('document_id', documentId).eq('user_id', userId);
      await this.cleanupOcrData(documentId);
      const { error } = await client.from('documents').delete().eq('id', documentId).eq('user_id', userId);
      return !error;
    } catch (err) {
      console.error(`[hardDeleteDocument] Error deleting document ${documentId}:`, err);
      return false;
    }
  }

  // --- PROCESSING JOBS ---
  async createProcessingJob(job: Partial<ProcessingJobRecord>): Promise<ProcessingJobRecord> {
    const client = getSupabaseAdminClient();
    const now = new Date().toISOString();

    const newJob: ProcessingJobRecord = {
      id: job.id || crypto.randomUUID(),
      document_id: job.document_id!,
      user_id: job.user_id!,
      status: job.status || 'QUEUED',
      current_step: job.current_step || 'Queued in pipeline',
      progress: job.progress || 0,
      attempt_count: job.attempt_count || 1,
      error_code: job.error_code || null,
      error_message: job.error_message || null,
      started_at: job.started_at || null,
      completed_at: job.completed_at || null,
      created_at: now,
      updated_at: now,
    };

    const { data, error } = await client.from('processing_jobs').insert(newJob).select().single();
    if (error) {
      console.error('[createProcessingJob] Error creating processing job:', error);
      throw error;
    }
    return data || newJob;
  }

  async getProcessingJob(userId: string, jobId: string): Promise<ProcessingJobRecord | null> {
    const client = getSupabaseAdminClient();
    const { data } = await client
      .from('processing_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', userId)
      .maybeSingle();

    return data || null;
  }

  async getJobByDocumentId(userId: string, documentId: string): Promise<ProcessingJobRecord | null> {
    const client = getSupabaseAdminClient();
    const { data } = await client
      .from('processing_jobs')
      .select('*')
      .eq('document_id', documentId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return data || null;
  }

  async getQueuedJobs(): Promise<ProcessingJobRecord[]> {
    const client = getSupabaseAdminClient();
    const { data } = await client
      .from('processing_jobs')
      .select('*')
      .in('status', ['QUEUED', 'PROCESSING', 'VALIDATING', 'UPLOADING', 'PARSING', 'VALIDATING_RESULT'])
      .order('created_at', { ascending: true });

    return data || [];
  }

  async updateProcessingJob(userId: string, jobId: string, updates: Partial<ProcessingJobRecord>): Promise<ProcessingJobRecord | null> {
    const client = getSupabaseAdminClient();
    const now = new Date().toISOString();
    const { data } = await client
      .from('processing_jobs')
      .update({ ...updates, updated_at: now })
      .eq('id', jobId)
      .eq('user_id', userId)
      .select()
      .single();

    return data || null;
  }

  // --- ATOMIC OCR RESULTS & VALIDATION PERSISTENCE (PHASE 6) ---
  async saveOcrAnalysis(
    userId: string,
    documentId: string,
    analysis: OCRAnalysisResult,
    validationReport?: any
  ): Promise<void> {
    const client = getSupabaseAdminClient();
    const doc = await this.getUserDocumentById(userId, documentId);
    if (!doc) {
      throw new Error('Document not found or unauthorized');
    }

    const now = new Date().toISOString();
    const finalStatus = validationReport?.status || 'READY';

    // 1. Prepare normalized ocr_results records
    const ocrResultRecords = (analysis.pages || []).map((p, idx) => ({
      id: crypto.randomUUID(),
      page_number: p.pageNumber,
      raw_text: p.rawText || analysis.rawText,
      confidence_score: p.confidence ?? analysis.overallConfidence,
      azure_model_id: analysis.modelId,
      metadata: {
        provider: analysis.provider,
        linesCount: p.linesCount,
        ...(idx === 0 && analysis.documentMetadata ? { documentMetadata: analysis.documentMetadata } : {}),
        ...analysis.metadata,
      },
    }));

    // 2. Prepare normalized tables, rows, cells & validation issues
    const tableRecords: any[] = [];
    const rowRecords: any[] = [];
    const cellRecords: any[] = [];
    const validationIssuesRecords: any[] = [];

    for (const t of analysis.tables || []) {
      const tableId = (t as any).id || crypto.randomUUID();
      (t as any).id = tableId;
      const tableSource = (t as any).confidenceSource || (t.confidence != null ? 'AZURE_MODEL' : 'LOCAL_HEURISTIC');
      const structConf = (t as any).structureConfidence;

      tableRecords.push({
        id: tableId,
        page_number: t.pageNumber,
        table_index: t.tableIndex,
        row_count: t.rowCount,
        column_count: t.columnCount,
        confidence_score: t.confidence,
        confidence_source: tableSource,
        structure_confidence: structConf,
      });

      for (const r of t.rows || []) {
        const rowId = (r as any).id || crypto.randomUUID();
        (r as any).id = rowId;

        rowRecords.push({
          id: rowId,
          table_id: tableId,
          row_index: r.rowIndex,
          is_header: r.isHeader,
        });

        for (const c of r.cells || []) {
          const cellId = (c as any).id || crypto.randomUUID();
          (c as any).id = cellId;
          const cellSource = (c as any).confidenceSource || tableSource;

          cellRecords.push({
            id: cellId,
            row_id: rowId,
            column_index: c.columnIndex,
            raw_value: c.rawValue,
            normalized_value: c.normalizedValue || c.rawValue,
            cell_type: c.cellType || 'TEXT',
            confidence_score: c.confidence,
            confidence_source: cellSource,
            is_reviewed: false,
            bounding_box: c.boundingPolygon
              ? {
                  polygon: c.boundingPolygon,
                  unit: (c as any).coordinateUnit || 'point',
                }
              : undefined,
            validation_status: (c as any).validationStatus || 'ACCEPTED',
            validation_issues: (c as any).validationIssues || [],
            requires_secondary_ocr: (c as any).requiresSecondaryOcr || false,
          });

          if (Array.isArray((c as any).validationIssues)) {
            for (const iss of (c as any).validationIssues) {
              validationIssuesRecords.push({
                table_id: tableId,
                cell_id: cellId,
                page_number: t.pageNumber,
                row_index: r.rowIndex,
                column_index: c.columnIndex,
                rule_code: iss.code,
                severity: iss.severity,
                message: iss.message,
                observed_value: iss.observedValue !== undefined ? String(iss.observedValue) : null,
                expected_pattern: iss.expected,
                requires_secondary_ocr: iss.requiresSecondaryOcr || false,
                bounding_box: c.boundingPolygon ? { polygon: c.boundingPolygon } : undefined,
                coordinate_unit: (c as any).coordinateUnit || 'point',
              });
            }
          }
        }
      }
    }

    // 3. Assemble atomic JSON payload
    const effectiveValReport = validationReport !== undefined ? validationReport : ValidationEngine.validate(documentId, analysis);

    const metadataRecords = (analysis.documentMetadata || []).map((m: any) => ({
      id: m.id || crypto.randomUUID(),
      label: m.label,
      raw_label: m.rawLabel ?? m.raw_label ?? m.label ?? '',
      value: m.value,
      raw_value: m.rawValue ?? m.raw_value ?? m.value ?? '',
      normalized_label: m.normalizedLabel ?? m.normalized_label ?? (m.label ? String(m.label).toLowerCase().trim() : 'unknown'),
      normalized_value_for_match: m.normalizedValueForMatch ?? m.normalized_value_for_match ?? (m.value ? String(m.value).toLowerCase().trim() : ''),
      confidence_score: m.confidence ?? m.confidence_score ?? 0.95,
      source_page: m.sourcePage ?? m.source_page ?? 1,
      key_bounding_box: m.keyBoundingPolygon ? { polygon: m.keyBoundingPolygon } : m.key_bounding_box,
      value_bounding_box: m.valueBoundingPolygon ? { polygon: m.valueBoundingPolygon } : m.value_bounding_box,
      occurrence_count: m.occurrenceCount ?? m.occurrence_count ?? 1,
      status: m.status || 'AUTO',
      alternatives: m.alternatives || [],
    }));

    const payload = {
      page_count: analysis.pages?.length || 1,
      final_status: finalStatus,
      ocr_results: ocrResultRecords,
      tables: tableRecords,
      rows: rowRecords,
      cells: cellRecords,
      document_metadata: metadataRecords,
      validation_run: effectiveValReport
        ? {
            status: effectiveValReport.status,
            accepted_count: effectiveValReport.acceptedCount,
            warning_count: effectiveValReport.warningCount,
            review_required_count: effectiveValReport.reviewRequiredCount,
            validation_version: effectiveValReport.validationVersion,
          }
        : null,
      validation_issues: validationIssuesRecords,
    };

    // 4. Execute Native PostgreSQL Atomic Transaction via RPC
    const { data: rpcRes, error: rpcErr } = await client.rpc('save_document_analysis_atomic', {
      p_document_id: documentId,
      p_user_id: userId,
      p_payload: payload,
    });

    if (rpcErr) {
      console.error(`[saveOcrAnalysis] save_document_analysis_atomic RPC failed:`, rpcErr);
      throw new Error(`ATOMIC_PERSISTENCE_FAILED: ${rpcErr.message}`);
    }

    console.log(`[saveOcrAnalysis] Successfully persisted analysis atomically via PostgreSQL RPC for doc ${documentId}`);
  }

  private async cleanupOcrData(documentId: string): Promise<void> {
    const client = getSupabaseAdminClient();
    // Delete cells via table rows cascade or direct cleanup
    const { data: tables } = await client.from('extracted_tables').select('id').eq('document_id', documentId);
    if (tables && tables.length > 0) {
      const tableIds = tables.map((t) => t.id);
      const { data: rows } = await client.from('extracted_rows').select('id').in('table_id', tableIds);
      if (rows && rows.length > 0) {
        const rowIds = rows.map((r) => r.id);
        await client.from('extracted_cells').delete().in('row_id', rowIds);
      }
      await client.from('extracted_rows').delete().in('table_id', tableIds);
    }
    await client.from('extracted_tables').delete().eq('document_id', documentId);
    await client.from('ocr_results').delete().eq('document_id', documentId);
    try {
      await client.from('document_metadata').delete().eq('document_id', documentId);
    } catch {
      // Ignore if table unpopulated
    }
  }

  async getDocumentOcrResult(userId: string, documentId: string, userToken?: string) {
    const client = this.getClient(userToken);
    const doc = await this.getUserDocumentById(userId, documentId, userToken);
    if (!doc) return null;

    const [pagesRes, tablesRes, metadataRes, valRunRes, valIssuesRes] = await Promise.all([
      client.from('ocr_results').select('*').eq('document_id', documentId).order('page_number', { ascending: true }),
      client.from('extracted_tables').select('*').eq('document_id', documentId).order('table_index', { ascending: true }),
      client.from('document_metadata').select('*').eq('document_id', documentId).order('source_page', { ascending: true }),
      client.from('validation_runs').select('*').eq('document_id', documentId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      client.from('validation_issues').select('*').eq('document_id', documentId).order('page_number', { ascending: true }),
    ]);

    const pages = pagesRes.data || [];
    const dbTables = tablesRes.data || [];
    const dbMetadata = metadataRes.data || [];
    const valRun = (valRunRes as any)?.data || null;
    const valIssues = (valIssuesRes as any)?.data || [];

    let formattedTables: any[] = [];
    let dbCellsAll: any[] = [];

    if (dbTables.length > 0) {
      const tableIds = dbTables.map((t) => t.id);
      const { data: dbRows } = await client.from('extracted_rows').select('*').in('table_id', tableIds).order('row_index', { ascending: true });
      const rows = dbRows || [];

      if (rows.length > 0) {
        const rowIds = rows.map((r) => r.id);
        const { data: dbCells } = await client.from('extracted_cells').select('*').in('row_id', rowIds).order('column_index', { ascending: true });
        dbCellsAll = dbCells || [];

        const cellsByRow = new Map<string, any[]>();
        for (const c of dbCellsAll) {
          const arr = cellsByRow.get(c.row_id) || [];
          arr.push(c);
          cellsByRow.set(c.row_id, arr);
        }

        const rowsByTable = new Map<string, any[]>();
        for (const r of rows) {
          const arr = rowsByTable.get(r.table_id) || [];
          arr.push(r);
          rowsByTable.set(r.table_id, arr);
        }

        formattedTables = dbTables.map((t) => {
          const tRows = rowsByTable.get(t.id) || [];
          tRows.sort((a, b) => a.row_index - b.row_index);

          const formattedRows = tRows.map((r) => {
            const rCells = cellsByRow.get(r.id) || [];
            rCells.sort((a, b) => a.column_index - b.column_index);

            return {
              id: r.id,
              rowIndex: r.row_index,
              isHeader: r.is_header,
              cells: rCells.map((c) => ({
                id: c.id,
                rowIndex: c.row_index,
                columnIndex: c.column_index,
                rowSpan: c.row_span,
                columnSpan: c.column_span,
                rawValue: c.raw_value,
                normalizedValue: c.normalized_value,
                cellType: c.cell_type,
                confidence: c.confidence_score !== null && c.confidence_score !== undefined ? Number(c.confidence_score) : null,
                confidenceSource: c.confidence_source || (c.confidence_score !== null && c.confidence_score !== undefined
                  ? 'AZURE_MODEL'
                  : (c.raw_value && c.raw_value.trim() !== '' ? 'LOCAL_HEURISTIC' : 'EMPTY_CELL')),
                structureConfidence: (c as any).structure_confidence != null
                  ? Number((c as any).structure_confidence)
                  : (t.structure_confidence != null ? Number(t.structure_confidence) : null),
                validationStatus: c.validation_status || 'ACCEPTED',
                validationIssues: c.validation_issues || [],
                requiresSecondaryOcr: c.requires_secondary_ocr || false,
                isReviewed: c.is_reviewed,
                originalRawValue: c.original_raw_value,
                resolutionStatus: c.resolution_status,
                resolutionMethod: c.resolution_method,
                boundingPolygon: c.bounding_box?.polygon,
                coordinateUnit: c.bounding_box?.unit || 'point',
                updatedAt: c.updated_at,
              })),
            };
          });

          const headerRow = formattedRows.find((r) => r.isHeader) || formattedRows[0];
          const headers = headerRow ? headerRow.cells.map((c) => c.rawValue) : [];

          return {
            id: t.id,
            pageNumber: t.page_number,
            tableIndex: t.table_index,
            rowCount: t.row_count,
            columnCount: t.column_count,
            confidence: t.confidence_score,
            confidenceSource: t.confidence_source || (t.confidence_score != null ? 'AZURE_MODEL' : 'LOCAL_HEURISTIC'),
            structureConfidence: t.structure_confidence != null ? Number(t.structure_confidence) : null,
            boundingRegions: t.bounding_regions,
            headers,
            rows: formattedRows,
          };
        });
      }
    }

    let totalCells = 0;
    let lowConfidenceCount = 0;
    let mediumConfidenceCount = 0;
    let highConfidenceCount = 0;

    for (const c of dbCellsAll) {
      totalCells++;
      if (c.confidence_score === null || c.confidence_score === undefined) {
        // Native local digital extraction cells: do not falsely treat as low OCR confidence
        continue;
      }
      const score = Number(c.confidence_score);
      if (score < 0.7) lowConfidenceCount++;
      else if (score < 0.9) mediumConfidenceCount++;
      else highConfidenceCount++;
    }

    let documentMetadata: OCRMetadataItem[] = dbMetadata.map((m: any) => {
      let semanticType = m.semantic_type;
      let qualityScore = m.quality_score != null ? Number(m.quality_score) : undefined;
      let visibilityClass = m.visibility_class;

      if (!semanticType && Array.isArray(m.alternatives)) {
        const metaExt = m.alternatives.find((a: any) => a._metaExt);
        if (metaExt?._metaExt) {
          semanticType = metaExt._metaExt.semanticType;
          qualityScore = metaExt._metaExt.qualityScore != null ? Number(metaExt._metaExt.qualityScore) : undefined;
          visibilityClass = metaExt._metaExt.visibilityClass;
        }
      }

      const cleanAlternatives = Array.isArray(m.alternatives)
        ? m.alternatives.filter((a: any) => !a._metaExt)
        : [];

      return {
        id: m.id,
        label: m.label,
        value: m.value,
        rawLabel: m.raw_label,
        rawValue: m.raw_value,
        confidence: m.confidence_score,
        sourcePage: m.source_page,
        keyBoundingPolygon: m.key_bounding_box?.polygon,
        valueBoundingPolygon: m.value_bounding_box?.polygon,
        occurrenceCount: m.occurrence_count || 1,
        status: m.status || 'AUTO',
        semanticType: semanticType || undefined,
        qualityScore: qualityScore != null ? Number(qualityScore) : undefined,
        visibilityClass: visibilityClass || 'ADDITIONAL',
        alternatives: cleanAlternatives.length > 0 ? cleanAlternatives : undefined,
      };
    });

    if (documentMetadata.length === 0 && pages.length > 0 && pages[0].metadata?.documentMetadata) {
      documentMetadata = pages[0].metadata.documentMetadata;
    }

    documentMetadata = MetadataFilterEngine.canonicalizeMetadata(documentMetadata);

    const validationReport = valRun
      ? {
          id: valRun.id,
          status: valRun.status,
          acceptedCount: valRun.accepted_count,
          warningCount: valRun.warning_count,
          reviewRequiredCount: valRun.review_required_count,
          validationVersion: valRun.validation_version,
          issues: valIssues,
        }
      : null;

    return {
      document: doc,
      pages: pages.map((p) => ({
        id: p.id,
        pageNumber: p.page_number,
        rawText: p.raw_text,
        confidence: p.confidence_score,
        linesCount: p.metadata?.linesCount || 0,
      })),
      tables: formattedTables,
      documentMetadata,
      validationReport,
      stats: {
        totalCells,
        lowConfidenceCount,
        mediumConfidenceCount,
        highConfidenceCount,
        requiresReview: validationReport
          ? validationReport.status === 'REVIEW_REQUIRED'
          : lowConfidenceCount > 0,
      },
    };
  }

  async updateExtractedCell(
    userId: string,
    documentId: string,
    cellId: string,
    updates: { rawValue?: string; normalizedValue?: string; cellType?: string; isReviewed?: boolean },
    userToken?: string
  ) {
    const client = this.getClient(userToken);
    const doc = await this.getUserDocumentById(userId, documentId, userToken);
    if (!doc) throw new Error('Unauthorized or document not found');

    const { data: cell } = await client.from('extracted_cells').select('*').eq('id', cellId).single();
    if (!cell) {
      throw new Error('Cell not found');
    }

    const now = new Date().toISOString();
    const payload: any = { updated_at: now };
    if (updates.rawValue !== undefined) payload.raw_value = updates.rawValue;
    if (updates.normalizedValue !== undefined) {
      payload.normalized_value = updates.normalizedValue;
    } else if (updates.rawValue !== undefined) {
      payload.normalized_value = updates.rawValue;
    }
    if (updates.cellType !== undefined) payload.cell_type = updates.cellType;
    if (updates.isReviewed !== undefined) payload.is_reviewed = updates.isReviewed;

    const { data: updatedCell, error } = await client
      .from('extracted_cells')
      .update(payload)
      .eq('id', cellId)
      .select()
      .single();

    if (error) throw error;

    // Record review action
    const oldVal = cell.normalized_value ?? cell.raw_value ?? '';
    const newVal = payload.normalized_value ?? payload.raw_value ?? oldVal;
    const isEdit = updates.rawValue !== undefined || updates.normalizedValue !== undefined;
    await client.from('review_actions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      document_id: documentId,
      cell_id: cellId,
      action_type: isEdit ? 'EDIT_CELL' : 'CONFIRM_AS_IS',
      old_value: oldVal,
      new_value: newVal,
      created_at: now,
    });

    return updatedCell;
  }

  async addExtractedRow(
    userId: string,
    documentId: string,
    tableId: string,
    cellsInput: Array<{ rawValue: string; normalizedValue?: string; cellType?: string; columnIndex: number }>,
    userToken?: string
  ) {
    const client = this.getClient(userToken);
    const doc = await this.getUserDocumentById(userId, documentId, userToken);
    if (!doc) throw new Error('Unauthorized or document not found');

    const { data: table } = await client.from('extracted_tables').select('*').eq('id', tableId).eq('document_id', documentId).single();
    if (!table) throw new Error('Table not found');

    const { data: existingRows } = await client.from('extracted_rows').select('*').eq('table_id', tableId).order('row_index', { ascending: false }).limit(1);
    const maxRowIndex = existingRows && existingRows.length > 0 ? existingRows[0].row_index : -1;
    const newRowIndex = maxRowIndex + 1;

    const now = new Date().toISOString();
    const rowId = crypto.randomUUID();
    const newRow: ExtractedRowRecord = {
      id: rowId,
      table_id: tableId,
      row_index: newRowIndex,
      is_header: false,
      created_at: now,
    };

    const { error: rErr } = await client.from('extracted_rows').insert(newRow);
    if (rErr) throw rErr;

    const cellRecords: ExtractedCellRecord[] = cellsInput.map((c) => ({
      id: crypto.randomUUID(),
      row_id: rowId,
      row_index: newRowIndex,
      column_index: c.columnIndex,
      row_span: 1,
      column_span: 1,
      raw_value: c.rawValue,
      normalized_value: c.normalizedValue || c.rawValue,
      cell_type: (c.cellType as any) || 'TEXT',
      confidence_score: 1.0,
      is_reviewed: true,
      created_at: now,
      updated_at: now,
    }));

    if (cellRecords.length > 0) {
      const { error: cErr } = await client.from('extracted_cells').insert(cellRecords);
      if (cErr) throw cErr;
    }

    await client.from('extracted_tables').update({ row_count: table.row_count + 1 }).eq('id', tableId);

    await client.from('review_actions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      document_id: documentId,
      action_type: 'ADD_ROW',
      metadata: { tableId, rowIndex: newRowIndex, addedCellsCount: cellRecords.length },
      created_at: now,
    });

    return { row: newRow, cells: cellRecords };
  }

  async deleteExtractedRow(userId: string, documentId: string, tableId: string, rowIndex: number, userToken?: string) {
    const client = this.getClient(userToken);
    const doc = await this.getUserDocumentById(userId, documentId, userToken);
    if (!doc) throw new Error('Unauthorized or document not found');

    const { data: rows } = await client.from('extracted_rows').select('id').eq('table_id', tableId).eq('row_index', rowIndex);
    if (rows && rows.length > 0) {
      const rowIds = rows.map((r) => r.id);
      await client.from('extracted_cells').delete().in('row_id', rowIds);
      await client.from('extracted_rows').delete().in('id', rowIds);
    }

    const now = new Date().toISOString();
    await client.from('review_actions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      document_id: documentId,
      action_type: 'DELETE_ROW',
      metadata: { tableId, rowIndex },
      created_at: now,
    });
  }

  async markDocumentReviewed(userId: string, documentId: string, userToken?: string) {
    const client = this.getClient(userToken);
    const doc = await this.getUserDocumentById(userId, documentId, userToken);
    if (!doc) throw new Error('Document not found');

    const now = new Date().toISOString();
    const { data } = await client
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

    await client.from('review_actions').insert({
      id: crypto.randomUUID(),
      user_id: userId,
      document_id: documentId,
      action_type: 'COMPLETE_REVIEW',
      created_at: now,
    });

    return data || doc;
  }

  // --- AUDIT LOGS ---
  async createAuditLog(log: Partial<AuditLogRecord>): Promise<AuditLogRecord> {
    const client = getSupabaseAdminClient();
    const newLog: AuditLogRecord = {
      id: log.id || crypto.randomUUID(),
      user_id: log.user_id || 'system',
      action: log.action || 'UNKNOWN',
      resource_type: log.resource_type || undefined,
      resource_id: log.resource_id || undefined,
      ip_address: log.ip_address || undefined,
      metadata: log.metadata || undefined,
      created_at: new Date().toISOString(),
    };
    const { data } = await client.from('audit_logs').insert(newLog).select().single();
    return data || newLog;
  }

  async getUserAuditLogs(userId: string, limit = 50): Promise<AuditLogRecord[]> {
    const client = getSupabaseAdminClient();
    const { data } = await client.from('audit_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
    return data || [];
  }

  // --- EXPORTS ---
  async createExportRecord(rec: Partial<ExportRecord>): Promise<ExportRecord> {
    const client = getSupabaseAdminClient();
    const now = new Date().toISOString();
    const newExport: ExportRecord = {
      id: rec.id || crypto.randomUUID(),
      user_id: rec.user_id!,
      document_id: rec.document_id!,
      export_format: rec.export_format || 'XLSX',
      export_mode: rec.export_mode || 'NORMALIZED',
      file_name: rec.file_name || 'export.xlsx',
      file_size: rec.file_size || 0,
      storage_bucket: rec.storage_bucket || 'documents',
      storage_path: rec.storage_path || '',
      status: rec.status || 'COMPLETED',
      error_message: rec.error_message || null,
      metadata: rec.metadata || {},
      created_at: now,
    };
    const { data } = await client.from('export_files').insert(newExport).select().single();
    return data || newExport;
  }

  async getDocumentExports(userId: string, documentId: string): Promise<ExportRecord[]> {
    const client = getSupabaseAdminClient();
    const { data } = await client.from('export_files').select('*').eq('document_id', documentId).eq('user_id', userId).order('created_at', { ascending: false });
    return data || [];
  }

  async getUserExportById(userId: string, exportId: string): Promise<ExportRecord | null> {
    const client = getSupabaseAdminClient();
    const { data } = await client.from('export_files').select('*').eq('id', exportId).eq('user_id', userId).maybeSingle();
    return data || null;
  }

  async findExistingExport(userId: string, documentId: string, format: string, mode: string): Promise<ExportRecord | null> {
    const client = getSupabaseAdminClient();
    const { data } = await client
      .from('export_files')
      .select('*')
      .eq('document_id', documentId)
      .eq('user_id', userId)
      .eq('export_format', format)
      .eq('export_mode', mode)
      .eq('status', 'COMPLETED')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return data || null;
  }
}

export const db = new DatabaseService();
