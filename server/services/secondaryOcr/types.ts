/**
 * Phase 7 — Targeted Secondary OCR & Conflict Resolution Domain Types
 */

export type ResolutionStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'RESOLVED'
  | 'UNRESOLVED'
  | 'HUMAN_REVIEW_REQUIRED';

export type ResolutionMethod =
  | 'NONE'
  | 'DETERMINISTIC'
  | 'SECONDARY_OCR'
  | 'SECONDARY_OCR_ENHANCED'
  | 'GEMINI'
  | 'HUMAN';

export type CandidateSource =
  | 'AZURE_PRIMARY'
  | 'LOCAL_NATIVE'
  | 'SECONDARY_OCR'
  | 'SECONDARY_OCR_ENHANCED'
  | 'HUMAN_EDIT';

export type CandidateAttemptStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export type CoordinateUnit = 'point' | 'pixel' | 'inch' | 'normalized';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  unit?: CoordinateUnit;
  polygon?: Array<{ x: number; y: number }>;
}

export interface PageRenderOptions {
  pageNumber: number;
  dpi?: number; // default 150, 300 for enhanced
}

export interface RenderedPage {
  documentId: string;
  pageNumber: number;
  width: number;
  height: number;
  dpi: number;
  imageBuffer: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
}

export type PreprocessingVariant = 'original' | 'enhanced_contrast' | 'binarized_otsu' | 'grayscale';

export interface RegionExtractOptions {
  paddingPx?: number;
  variant?: PreprocessingVariant;
  outputFormat?: 'image/png' | 'image/jpeg';
}

export interface RegionSnippet {
  cellId: string;
  pageNumber: number;
  boundingBox: BoundingBox;
  cropBox: { x: number; y: number; width: number; height: number };
  variant: PreprocessingVariant;
  imageBuffer: Buffer;
  mimeType: string;
}

export interface SecondaryOcrContext {
  cellId: string;
  documentId: string;
  pageNumber: number;
  rowIndex: number;
  columnIndex: number;
  headerLabel?: string;
  expectedDataType?: string;
  expectedPattern?: string;
  originalRawValue?: string;
  previousIssues?: Array<{ code: string; message: string }>;
}

export interface SecondaryOcrResult {
  provider: string;
  providerVersion: string;
  rawValue: string;
  confidenceScore: number;
  confidenceSource: string;
  attemptStatus: CandidateAttemptStatus;
  errorMessage?: string;
  metadata?: Record<string, any>;
}

export interface SecondaryOcrProvider {
  readonly providerId: string;
  readonly providerVersion: string;
  recognizeRegion(
    snippet: RegionSnippet,
    context: SecondaryOcrContext
  ): Promise<SecondaryOcrResult>;
}

export interface CandidateRevalidationResult {
  isValid: boolean;
  normalizedValue: string | null;
  validationStatus: 'ACCEPTED' | 'WARNING' | 'REVIEW_REQUIRED';
  issues: Array<{
    code: string;
    severity: 'WARNING' | 'ERROR';
    message: string;
    observedValue?: string;
    expected?: string;
    requiresSecondaryOcr?: boolean;
  }>;
}

export interface ConflictResolutionDecision {
  resolutionStatus: ResolutionStatus;
  resolutionMethod: ResolutionMethod;
  selectedCandidateId: string | null;
  selectedCandidateSource: CandidateSource | null;
  finalRawValue: string;
  finalNormalizedValue: string | null;
  finalValidationStatus: 'ACCEPTED' | 'WARNING' | 'REVIEW_REQUIRED';
  reasonCode: string;
  reasonMessage: string;
  semanticDecision?: 'A' | 'B' | 'UNKNOWN';
  semanticConfidence?: number;
}

export interface SecondaryOcrBudget {
  maxCellsPerDocument: number; // default 20
  maxAttemptsPerCell: number;  // default 2 (original + enhanced)
}
