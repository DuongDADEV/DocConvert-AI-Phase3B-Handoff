/**
 * Phase 6: Validation Engine Types
 * Deterministic, typed validation models for cell, row, table, and document levels.
 */

export type ValidationSeverity = 'WARNING' | 'ERROR';
export type ValidationStatus = 'ACCEPTED' | 'WARNING' | 'REVIEW_REQUIRED';

export const VALIDATION_VERSION = 'val-v1';

export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  message: string;
  rule: string;
  observedValue?: unknown;
  expected?: string;
  requiresSecondaryOcr?: boolean;
}

export interface CellValidationResult {
  cellId?: string;
  tableId?: string;
  rowIndex: number;
  columnIndex: number;
  pageNumber: number;
  rawValue: string;
  normalizedValue?: string;
  cellType?: string;
  status: ValidationStatus;
  issues: ValidationIssue[];
  confidence?: number | null;
  confidenceSource?: string;
  structureConfidence?: number | null;
  requiresSecondaryOcr: boolean;
  boundingPolygon?: number[];
  coordinateUnit?: 'point' | 'inch' | 'pixel';
}

export interface TableValidationResult {
  tableId?: string;
  pageNumber: number;
  tableIndex: number;
  status: ValidationStatus;
  issues: ValidationIssue[];
  rowCount: number;
  columnCount: number;
  confidence?: number | null;
  confidenceSource?: string;
  structureConfidence?: number | null;
  cellResults: CellValidationResult[];
}

export interface DocumentValidationReport {
  documentId: string;
  status: 'READY' | 'REVIEW_REQUIRED';
  acceptedCount: number;
  warningCount: number;
  reviewRequiredCount: number;
  validationVersion: string;
  tables: TableValidationResult[];
  metadataIssues: ValidationIssue[];
  createdAt: string;
}

export interface ValidationSchemaColumn {
  name: string;
  columnIndex?: number;
  expectedType?: 'NUMBER' | 'MONEY' | 'DATE' | 'PERCENTAGE' | 'TEXT' | 'EMAIL' | 'PHONE';
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp | string;
}

export interface ValidationSchemaContract {
  columns?: ValidationSchemaColumn[];
  strictColumnCount?: number;
}
