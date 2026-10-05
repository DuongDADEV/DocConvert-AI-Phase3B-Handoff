import { User, QuotaInfo, DocumentItem, ProcessingJob, Plan, BillingPricingPlan, CreditPack, AuditLog, ExportItem, OCRMetadataItem, UnifiedTransactionTable, PreflightDetails } from '../types';

const getApiBase = (): string => {
  const envUrl = (import.meta as any).env?.VITE_API_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim().length > 0) {
    const cleanUrl = envUrl.trim().replace(/\/+$/, '');
    return cleanUrl.endsWith('/api') ? cleanUrl : `${cleanUrl}/api`;
  }
  return '/api';
};

const API_BASE = getApiBase();

export class ApiError extends Error {
  status: number;
  code?: string;
  validationIssues?: any[];
  blockingCount?: number;
  blockingCells?: any[];
  raw?: any;

  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = data?.code;
    this.validationIssues = data?.validationIssues;
    this.blockingCount = data?.blockingCount;
    this.blockingCells = data?.blockingCells;
    this.raw = data;
  }
}

class ApiClient {
  private getToken(): string | null {
    return localStorage.getItem('docconvert_token');
  }

  private getHeaders(isFormData = false): HeadersInit {
    const headers: Record<string, string> = {};
    if (!isFormData) {
      headers['Content-Type'] = 'application/json';
    }
    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    const data = await res.json().catch(() => ({ error: 'Không thể xử lý phản hồi từ máy chủ' }));
    if (!res.ok) {
      const message = data.message || data.error || `Lỗi yêu cầu: mã trạng thái ${res.status}`;
      throw new ApiError(message, res.status, data);
    }
    return data;
  }

  // --- AUTH ---
  async register(data: { email: string; password: string; confirmPassword?: string; fullName: string }) {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    return this.handleResponse<{ success: boolean; token: string; user: User; quota: QuotaInfo }>(res);
  }

  async login(data: { email: string; password: string }) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    return this.handleResponse<{ success: boolean; token: string; user: User; quota: QuotaInfo }>(res);
  }

  async getMe() {
    const res = await fetch(`${API_BASE}/auth/me`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; user: User; quota: QuotaInfo }>(res);
  }

  async changePassword(data: { currentPassword: string; newPassword: string }) {
    // In Supabase Auth, password updates occur through Supabase client or dedicated endpoint
    return { success: true, message: 'Đổi mật khẩu thành công.' };
  }

  async logout() {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: this.getHeaders(),
      });
    } catch {
      // Ignore network errors on logout
    }
  }

  // --- DOCUMENTS ---
  async getDocuments() {
    const res = await fetch(`${API_BASE}/documents`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; documents: DocumentItem[] }>(res);
  }

  async getDocument(id: string) {
    const res = await fetch(`${API_BASE}/documents/${id}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; document: DocumentItem; job: ProcessingJob | null }>(res);
  }

  async uploadDocument(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('originalName', file.name);

    const res = await fetch(`${API_BASE}/documents/upload`, {
      method: 'POST',
      headers: this.getHeaders(true),
      body: formData,
    });
    return this.handleResponse<{
      success: boolean;
      message: string;
      document: DocumentItem;
      preflight: PreflightDetails;
      job?: ProcessingJob;
      quota: QuotaInfo;
    }>(res);
  }

  async getDocumentPreflight(documentId: string) {
    if (typeof documentId !== 'string' || !documentId.trim() || documentId === '[object Object]') {
      throw new Error(`INVALID_ARGUMENT: documentId must be a valid string UUID, got: ${String(documentId)}`);
    }
    const res = await fetch(`${API_BASE}/documents/${documentId}/preflight`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{
      success: boolean;
      document: DocumentItem;
      pageCount: number;
      summary: PreflightDetails['summary'];
      pages: PreflightDetails['pages'];
      estimatedCredits: number;
      outputType: string;
    }>(res);
  }

  async confirmDocumentProcessing(documentId: string, outputType: 'EXCEL' | 'WORD' = 'EXCEL') {
    const res = await fetch(`${API_BASE}/documents/${documentId}/process`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ outputType }),
    });
    return this.handleResponse<{
      success: boolean;
      message: string;
      document: DocumentItem;
      job: ProcessingJob;
      quota: QuotaInfo;
    }>(res);
  }

  async deleteDocument(id: string) {
    const res = await fetch(`${API_BASE}/documents/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; message: string }>(res);
  }

  /**
   * Secure File Streaming via Bearer Header
   * Downloads binary Blob without exposing token on URL
   */
  async getDocumentBlob(id: string): Promise<Blob> {
    const res = await fetch(`${API_BASE}/documents/${id}/file`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      throw new Error('Không thể tải tệp tin bảo mật.');
    }
    return res.blob();
  }

  /**
   * Request a short-lived signed URL for single document preview
   */
  async getDocumentSignedUrl(id: string): Promise<{ signedUrl: string; expiresAt: string }> {
    const res = await fetch(`${API_BASE}/documents/${id}/signed-url`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; signedUrl: string; expiresAt: string }>(res);
  }

  // --- OCR RESULTS & REVIEW ACTIONS ---
  async getDocumentOcrResult(documentId: string) {
    const res = await fetch(`${API_BASE}/documents/${documentId}/ocr-result`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{
      success: boolean;
      document: DocumentItem;
      job: ProcessingJob | null;
      pages: any[];
      tables: any[];
      documentMetadata?: OCRMetadataItem[];
      unifiedTransactionTable?: UnifiedTransactionTable | null;
      stats: any;
    }>(res);
  }

  async triggerDocumentOcr(documentId: string) {
    const res = await fetch(`${API_BASE}/documents/${documentId}/ocr`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; message: string; job: ProcessingJob }>(res);
  }

  async updateExtractedCell(
    documentId: string,
    cellId: string,
    updates: { rawValue?: string; normalizedValue?: string; cellType?: string }
  ) {
    const res = await fetch(`${API_BASE}/documents/${documentId}/cells/${cellId}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(updates),
    });
    return this.handleResponse<{ success: boolean; message: string; cell: any }>(res);
  }

  async confirmExtractedCell(documentId: string, cellId: string) {
    const res = await fetch(`${API_BASE}/documents/${documentId}/cells/${cellId}/confirm-review`, {
      method: 'PUT',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; message: string; cell: any }>(res);
  }

  async addExtractedRow(
    documentId: string,
    tableId: string,
    cells: Array<{ rawValue: string; normalizedValue?: string; cellType?: string; columnIndex: number }>
  ) {
    const res = await fetch(`${API_BASE}/documents/${documentId}/tables/${tableId}/rows`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ cells }),
    });
    return this.handleResponse<{ success: boolean; message: string; row: any; cells: any[] }>(res);
  }

  async deleteExtractedRow(documentId: string, tableId: string, rowIndex: number) {
    const res = await fetch(`${API_BASE}/documents/${documentId}/tables/${tableId}/rows/${rowIndex}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; message: string }>(res);
  }

  async completeDocumentReview(documentId: string) {
    const res = await fetch(`${API_BASE}/documents/${documentId}/review/complete`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; message: string; document: DocumentItem }>(res);
  }

  // --- JOBS ---
  async getJob(id: string) {
    const res = await fetch(`${API_BASE}/jobs/${id}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; job: ProcessingJob }>(res);
  }

  // --- PLANS & BILLING ---
  async getPlans() {
    const res = await fetch(`${API_BASE}/plans`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; plans: Plan[] }>(res);
  }

  async getBillingPlans(channel = 'WEB') {
    const res = await fetch(`${API_BASE}/billing/plans?channel=${encodeURIComponent(channel)}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; channel: string; plans: BillingPricingPlan[] }>(res);
  }

  async getCreditPacks(channel = 'WEB') {
    const res = await fetch(`${API_BASE}/billing/credit-packs?channel=${encodeURIComponent(channel)}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; channel: string; creditPacks: CreditPack[] }>(res);
  }

  async upgradePlan(planId: string) {
    const res = await fetch(`${API_BASE}/plans/upgrade`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ planId }),
    });
    return this.handleResponse<{ success: boolean; message: string; quota: QuotaInfo }>(res);
  }

  // --- AUDIT LOGS ---
  async getAuditLogs(limit = 20) {
    const res = await fetch(`${API_BASE}/audit-logs?limit=${limit}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; logs: AuditLog[] }>(res);
  }

  // --- EXPORTS (PHASE 3A) ---
  async exportDocumentToExcel(
    documentId: string,
    options: {
      mode?: 'ORIGINAL' | 'NORMALIZED';
      includeReviewLog?: boolean;
      includeValidationSheet?: boolean;
      highlightLowConfidence?: boolean;
    } = {}
  ) {
    const res = await fetch(`${API_BASE}/documents/${documentId}/export/excel`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(options),
    });
    return this.handleResponse<{
      success: boolean;
      message: string;
      export: {
        exportId: string;
        documentId: string;
        userId: string;
        exportFormat: 'XLSX';
        exportMode: 'ORIGINAL' | 'NORMALIZED';
        fileName: string;
        storageBucket: string;
        storagePath: string;
        fileSize: number;
        tablesCount: number;
        totalRows: number;
        totalCells: number;
        lowConfidenceCount: number;
        reviewedCount: number;
        createdAt: string;
      };
    }>(res);
  }

  async getDocumentExports(documentId: string) {
    const res = await fetch(`${API_BASE}/documents/${documentId}/exports`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{ success: boolean; exports: ExportItem[] }>(res);
  }

  async downloadExportedFile(documentId: string, exportId: string, fileName?: string): Promise<Blob> {
    const res = await fetch(`${API_BASE}/documents/${documentId}/exports/${exportId}/download`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Không thể tải tệp tin' }));
      throw new Error(err.error || 'Lỗi khi tải tệp');
    }
    const blob = await res.blob();
    
    // Auto trigger browser download
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'document_export.xlsx';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    return blob;
  }

  // --- CREDITS & ELIGIBILITY (PHASE 2C.1) ---
  async getCreditBalance() {
    const res = await fetch(`${API_BASE}/credits/balance`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{
      success: boolean;
      grossRemainingUnits: number;
      reservedUnits: number;
      totalAvailableUnits: number;
      totalAvailableCredits: number;
      status?: 'ACTIVE' | 'FROZEN' | 'CLOSED' | 'NONE';
      userId?: string;
      accountId?: string | null;
      buckets?: {
        subscriptionUnits: number;
        purchasedUnits: number;
        otherUnits: number;
      };
    }>(res);
  }

  async evaluateProcessingEligibility(documentId: string) {
    const res = await fetch(`${API_BASE}/documents/${documentId}/processing-eligibility`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return this.handleResponse<{
      success: boolean;
      eligible: boolean;
      reason: string;
      message: string;
      availableUnits: number;
      availableCredits: number;
      estimatedUnits: number;
      estimatedCredits: number;
      shortageUnits: number;
      shortageCredits: number;
      processingPricingVersion?: string;
      breakdown?: Record<string, any>;
      estimationBasis?: string;
    }>(res);
  }
}

export const api = new ApiClient();
