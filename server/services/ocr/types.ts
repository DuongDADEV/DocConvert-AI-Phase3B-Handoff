import type { Buffer } from 'node:buffer';

export type CellType = 'TEXT' | 'MONEY' | 'DATE' | 'NUMBER';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface BoundingPolygon {
  points: { x: number; y: number }[]; // Normalized or pixel coordinates
  pageNumber: number;
}

export interface OCRExtractedCell {
  id?: string;
  rowIndex: number;
  columnIndex: number;
  rowSpan?: number;
  columnSpan?: number;
  rawValue: string;
  normalizedValue?: string;
  cellType: CellType;
  confidence: number | null;
  confidenceSource?: 'AZURE_WORD_AGGREGATE' | 'AZURE_CELL' | 'EMPTY_CELL' | 'UNAVAILABLE' | 'LOCAL_HEURISTIC' | 'AZURE_MODEL' | string;
  structureConfidence?: number;
  coordinateUnit?: 'point' | 'inch' | 'pixel';
  validationStatus?: 'ACCEPTED' | 'WARNING' | 'REVIEW_REQUIRED';
  validationIssues?: any[];
  requiresSecondaryOcr?: boolean;
  isReviewed?: boolean;
  originalRawValue?: string | null;
  resolutionStatus?: string;
  resolutionMethod?: string;
  kind?: 'content' | 'rowHeader' | 'columnHeader';
  boundingPolygon?: number[]; // [x1, y1, x2, y2, x3, y3, x4, y4]
}

export interface OCRExtractedRow {
  id?: string;
  rowIndex: number;
  isHeader?: boolean;
  cells: OCRExtractedCell[];
}

export interface OCRExtractedTable {
  id?: string;
  pageNumber: number;
  tableIndex: number;
  rowCount: number;
  columnCount: number;
  confidence: number | null;
  confidenceSource?: string;
  structureConfidence?: number;
  coordinateUnit?: 'point' | 'inch' | 'pixel';
  boundingRegions?: any[];
  rows: OCRExtractedRow[];
  headers?: string[];
}

export interface OCRLine {
  content: string;
  polygon?: number[]; // [x1, y1, x2, y2, x3, y3, x4, y4]
}

export interface OCRPage {
  pageNumber: number;
  width?: number;
  height?: number;
  unit?: string;
  linesCount?: number;
  wordsCount?: number;
  rawText?: string;
  confidence?: number;
  lines?: OCRLine[];
  angle?: number;
}

export type SemanticType =
  | 'ACCOUNT_HOLDER'
  | 'ACCOUNT_NUMBER'
  | 'CUSTOMER_ID'
  | 'TAX_CODE'
  | 'STATEMENT_FROM'
  | 'STATEMENT_TO'
  | 'STATEMENT_PERIOD'
  | 'STATEMENT_DATE'
  | 'CURRENCY'
  | 'ACCOUNT_TYPE'
  | 'BRANCH'
  | 'ADDRESS'
  | 'OPENING_DATE'
  | 'OPENING_BALANCE'
  | 'CLOSING_BALANCE'
  | 'STATEMENT_TIMESTAMP'
  | 'OTHER';

export type VisibilityClass = 'CORE' | 'ADDITIONAL' | 'REJECTED';

export type MetadataSourceType = 'KEY_VALUE' | 'HEADER_LINE' | 'HEADER_TABLE';

export interface OCRMetadataObservation {
  rawLabel: string;
  rawValue: string;
  confidence: number;
  sourcePage: number; // Remapped global page number
  keyBoundingPolygon?: number[];   // [x1, y1, x2, y2, x3, y3, x4, y4]
  valueBoundingPolygon?: number[]; // [x1, y1, x2, y2, x3, y3, x4, y4]
  normalizedLabel?: string;
  normalizedValueForMatch?: string;
  chunkIndex?: number;
  sourceType?: MetadataSourceType;
  normalizedTop?: number;
  normalizedBottom?: number;
  semanticType?: SemanticType;
  qualityScore?: number;
}

export interface OCRMetadataItem {
  id?: string;
  label: string;
  value: string;
  rawLabel: string;
  rawValue: string;
  confidence: number;
  sourcePage: number;
  keyBoundingPolygon?: number[];
  valueBoundingPolygon?: number[];
  occurrenceCount: number;
  status: 'AUTO' | 'CONFLICT' | 'REVIEWED';
  semanticType?: SemanticType;
  qualityScore?: number;
  visibilityClass?: VisibilityClass;
  alternatives?: Array<{
    rawLabel: string;
    rawValue: string;
    confidence: number;
    sourcePage: number;
  }>;
}

export interface MetadataFilterMetrics {
  rawKeyValueCount: number;
  headerLineCandidateCount: number;
  headerTableCandidateCount: number;
  filteredTableOverlapCount: number;
  filteredTransactionPatternCount: number;
  filteredEmptyCount: number;
  filteredMalformedCount: number;
  candidateCount: number;
  nearDuplicateMergeCount: number;
  canonicalCount: number;
  coreCount: number;
  additionalCount: number;
  conflictCount: number;
  rejectedCount: number;
}

export interface OCRAnalysisResult {
  provider: string;
  modelId: string;
  overallConfidence: number;
  rawText: string;
  pages: OCRPage[];
  tables: OCRExtractedTable[];
  rawMetadataObservations?: OCRMetadataObservation[];
  documentMetadata?: OCRMetadataItem[];
  metadataPipelineMetrics?: MetadataFilterMetrics;
  metadata?: Record<string, any>;
}

export interface DocumentAIProvider {
  readonly providerName: string;
  analyzeDocument(
    fileBuffer: Buffer,
    mimeType: string,
    options?: { modelId?: string; forceSimulation?: boolean }
  ): Promise<OCRAnalysisResult>;
}
