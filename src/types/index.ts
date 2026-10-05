export interface User {
  id: string;
  email: string;
  fullName: string;
  currentPlanId: string;
  usedDocuments?: number;
  createdAt: string;
}

export interface Plan {
  id: string;
  name: string;
  price_vnd: number;
  duration_days: number;
  document_quota: number;
  features: string[];
  is_active: boolean;
  created_at: string;
}

export interface BillingPlanEntitlements {
  included_credits: number;
  max_file_mb: number;
  batch_enabled: boolean;
  priority_queue: boolean;
  api_access: 'NONE' | 'BETA' | 'FULL';
  retention_days: number;
  pdf_to_word: boolean;
  pdf_to_excel: boolean;
}

export interface BillingPricingPlan {
  id: string;
  code: string;
  name: string;
  description: string;
  channel: 'WEB' | 'API' | 'ENTERPRISE';
  product_type: 'SUBSCRIPTION' | 'CREDIT_PACK' | 'USAGE' | 'ENTERPRISE';
  price: number;
  currency: string;
  billing_interval: 'NONE' | 'MONTH' | 'YEAR';
  interval_count: number;
  credits: number;
  entitlements: BillingPlanEntitlements;
  metadata: {
    badge?: string | null;
    sort_order?: number;
    [key: string]: any;
  };
  pricing_version: string;
}

export interface CreditPack {
  id: string;
  code: string;
  name: string;
  description: string;
  channel: 'WEB' | 'API' | 'ENTERPRISE';
  product_type: 'CREDIT_PACK';
  price: number;
  currency: string;
  credits: number;
  metadata: {
    sort_order?: number;
    [key: string]: any;
  };
  pricing_version: string;
}

export interface QuotaInfo {
  allowed: boolean;
  used: number;
  total: number;
  remaining: number;
  planId: string;
  planName: string;
  message?: string;
}

export type PageClassification = 'NATIVE_TEXT' | 'SCANNED' | 'MIXED' | 'UNCERTAIN';

export interface PreflightSummary {
  nativeTextPages: number;
  scannedPages: number;
  mixedPages: number;
  uncertainPages: number;
}

export interface DocumentPageItem {
  id?: string;
  document_id: string;
  page_number: number;
  classification: PageClassification;
  classification_confidence: number;
  text_char_count: number;
  text_block_count: number;
  text_coverage: number;
  image_count: number;
  image_coverage: number;
  has_full_page_image: boolean;
  classification_reason?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PreflightDetails {
  pageCount: number;
  summary: PreflightSummary;
  estimatedCredits: number;
  pages?: DocumentPageItem[];
  outputType?: 'EXCEL' | 'WORD' | string;
}

export interface DocumentItem {
  id: string;
  user_id: string;
  original_filename: string;
  file_name: string;
  file_type: 'PDF' | 'JPG' | 'JPEG' | 'PNG';
  mime_type: string;
  file_size: number;
  page_count: number;
  storage_bucket: string;
  storage_path: string;
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

export interface ProcessingJob {
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

export interface ExtractedCell {
  id: string;
  rowIndex: number;
  columnIndex: number;
  rowSpan: number;
  columnSpan: number;
  rawValue: string;
  normalizedValue: string;
  cellType: 'TEXT' | 'MONEY' | 'DATE' | 'NUMBER';
  confidence: number | null;
  confidenceSource?: string;
  structureConfidence?: number | null;
  coordinateUnit?: 'point' | 'inch' | 'pixel';
  validationStatus?: 'ACCEPTED' | 'WARNING' | 'REVIEW_REQUIRED';
  validationIssues?: Array<{ code: string; severity: string; message: string }>;
  requiresSecondaryOcr?: boolean;
  isReviewed: boolean;
  originalRawValue?: string | null;
  resolutionStatus?: string;
  resolutionMethod?: string;
  boundingPolygon?: number[];
  updatedAt?: string;
}

export interface ExtractedRow {
  id: string;
  rowIndex: number;
  isHeader: boolean;
  cells: ExtractedCell[];
}

export interface ExtractedTable {
  id: string;
  pageNumber: number;
  tableIndex: number;
  rowCount: number;
  columnCount: number;
  confidence: number | null;
  confidenceSource?: string;
  structureConfidence?: number | null;
  coordinateUnit?: 'point' | 'inch' | 'pixel';
  boundingRegions?: Array<{ pageNumber: number; polygon: number[] }>;
  headers: string[];
  rows: ExtractedRow[];
}

export interface OCRPageResult {
  id: string;
  document_id: string;
  page_number: number;
  raw_text: string;
  confidence_score: number;
  azure_model_id: string;
  metadata?: Record<string, any>;
  created_at: string;
}

export interface OCRStats {
  totalCells: number;
  lowConfidenceCount: number;
  mediumConfidenceCount: number;
  highConfidenceCount: number;
  requiresReview: boolean;
}

export type SemanticType =
  | 'ACCOUNT_HOLDER'
  | 'ACCOUNT_NUMBER'
  | 'CUSTOMER_ID'
  | 'STATEMENT_FROM'
  | 'STATEMENT_TO'
  | 'STATEMENT_PERIOD'
  | 'CURRENCY'
  | 'ACCOUNT_TYPE'
  | 'BRANCH'
  | 'ADDRESS'
  | 'TAX_CODE'
  | 'STATEMENT_DATE'
  | 'OPENING_DATE'
  | 'OPENING_BALANCE'
  | 'CLOSING_BALANCE'
  | 'STATEMENT_TIMESTAMP'
  | 'OTHER';

export type VisibilityClass = 'CORE' | 'ADDITIONAL' | 'REJECTED';

export interface OCRMetadataItem {
  id?: string;
  label: string;
  value: string;
  rawLabel: string;
  rawValue: string;
  confidence: number;
  qualityScore?: number;
  semanticType?: SemanticType;
  visibilityClass?: VisibilityClass;
  occurrenceCount?: number;
  status?: 'AUTO' | 'CONFLICT' | 'FILTERED' | 'MANUAL';
  sourcePage: number;
  keyBoundingPolygon?: number[];
  valueBoundingPolygon?: number[];
  alternatives?: Array<{
    rawLabel: string;
    rawValue: string;
    confidence: number;
    sourcePage: number;
  }>;
}

export interface DocumentOCRData {
  document: DocumentItem;
  job?: ProcessingJob | null;
  pages: OCRPageResult[];
  tables: ExtractedTable[];
  metadata?: Record<string, any>;
  documentMetadata?: OCRMetadataItem[];
  unifiedTransactionTable?: UnifiedTransactionTable | null;
  validationReport?: any;
  stats: OCRStats;
}

export interface AuditLog {
  id: string;
  user_id: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  ip_address?: string;
  metadata?: Record<string, any>;
  created_at: string;
}

export interface ExportItem {
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

export interface AuthResponse {
  success: boolean;
  token?: string;
  user?: User;
  quota?: QuotaInfo;
  error?: string;
  message?: string;
}

export type SemanticColumnType =
  | 'STT'
  | 'DATE'
  | 'VALUE_DATE'
  | 'REFERENCE'
  | 'DESCRIPTION'
  | 'DEBIT'
  | 'CREDIT'
  | 'BALANCE'
  | 'OTHER';

export type QualitySeverity = 'PASS' | 'WARNING' | 'CRITICAL';

export interface QualityReason {
  code: string;
  message?: string;
}

export interface CellQualityAssessment {
  severity: QualitySeverity;
  reasons: QualityReason[];
}

export interface UnifiedCell {
  id: string | null;
  rowId?: string;
  tableId?: string;
  sourcePage?: number;
  sourceColumnIndex?: number;
  canonicalColumnIndex: number;
  rawValue: string;
  normalizedValue: string;
  cellType?: string;
  confidence: number | null;
  confidenceSource?: string;
  qualityAssessment?: CellQualityAssessment;
  isReviewed?: boolean;
  boundingPolygon?: any;
  isPlaceholder?: boolean;

  // Phase 6 Validation Engine preservation
  validationStatus?: 'ACCEPTED' | 'WARNING' | 'REVIEW_REQUIRED';
  validationIssues?: any[];
  requiresSecondaryOcr?: boolean;
  structureConfidence?: number | null;

  // Phase 7 Targeted Secondary OCR & Conflict Resolution preservation
  originalRawValue?: string | null;
  resolutionStatus?: 'NOT_REQUIRED' | 'PENDING' | 'RESOLVED' | 'UNRESOLVED' | 'HUMAN_REVIEW_REQUIRED';
  resolutionMethod?: 'NONE' | 'DETERMINISTIC' | 'SECONDARY_OCR' | 'SECONDARY_OCR_ENHANCED' | 'GEMINI' | 'HUMAN';

  // Coordinate system
  coordinateUnit?: string;
}

export interface UnifiedRow {
  displayRowIndex: number;
  sourceRowId: string;
  sourceTableId: string;
  sourcePage: number;
  cells: UnifiedCell[];
}

export interface UnifiedColumn {
  canonicalColumnIndex: number;
  header: string;
  normalizedHeader: string;
  semanticType: SemanticColumnType;
}

export interface UnifiedSummaryRow {
  sourceRowId: string;
  sourceTableId: string;
  sourcePage: number;
  values: string[];
  reason: string;
}

export interface UnifiedTransactionTable {
  id: string;
  documentId: string;
  headers: string[];
  columns: UnifiedColumn[];
  rows: UnifiedRow[];
  summaryRows: UnifiedSummaryRow[];
  sourceTableIds: string[];
  sourcePages: number[];
  rowCount: number;
  columnCount: number;
  diagnostics: {
    physicalTableCount: number;
    transactionCandidateCount: number;
    rejectedTableCount: number;
    repeatedHeaderRowsRemoved: number;
    summaryRowsSeparated: number;
    columnAlignmentWarnings: number;
    projectionDurationMs: number;
    logicalGroupCount: number;
  };
}

export type CreditAccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED' | 'NONE';

export interface UserCreditBalance {
  grossRemainingUnits: number;
  reservedUnits: number;
  totalAvailableUnits: number;
  totalAvailableCredits: number;
  status?: CreditAccountStatus;
  userId?: string;
  accountId?: string | null;
  buckets?: {
    subscriptionUnits: number;
    purchasedUnits: number;
    otherUnits: number;
  };
}

export type CreditAccountUiState =
  | 'LOADING'
  | 'SUCCESS'
  | 'NO_CREDIT_ACCOUNT'
  | 'AUTH_ERROR'
  | 'API_ERROR';

export type ProcessingEligibilityReason =
  | 'ELIGIBLE'
  | 'INSUFFICIENT_CREDIT'
  | 'CREDIT_ACCOUNT_NOT_FOUND'
  | 'CREDIT_ACCOUNT_FROZEN'
  | 'CREDIT_ACCOUNT_CLOSED'
  | 'PROCESSING_PRICING_NOT_CONFIGURED'
  | 'INVALID_PROCESSING_ESTIMATE'
  | 'DOCUMENT_NOT_READY'
  | 'DOCUMENT_NOT_FOUND';

export interface ProcessingEligibilityResponse {
  success: boolean;
  eligible: boolean;
  reason: ProcessingEligibilityReason;
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
}

