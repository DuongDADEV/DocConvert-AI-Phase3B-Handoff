/**
 * Phase 6: Centralized Validation Configuration
 * Centralizes thresholds, issue codes, and evaluation parameters.
 * Avoids magic numbers scattered across files.
 */

export const VALIDATION_RULE_CODES = {
  // Confidence & Source
  LOW_OCR_CONFIDENCE: 'LOW_OCR_CONFIDENCE',
  MEDIUM_OCR_CONFIDENCE: 'MEDIUM_OCR_CONFIDENCE',
  LOW_STRUCTURE_CONFIDENCE: 'LOW_STRUCTURE_CONFIDENCE',
  CONFIDENCE_SOURCE_UNAVAILABLE: 'CONFIDENCE_SOURCE_UNAVAILABLE',

  // Format & Plausibility
  INVALID_DATE: 'INVALID_DATE',
  INVALID_NUMBER: 'INVALID_NUMBER',
  INVALID_MONEY: 'INVALID_MONEY',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_PHONE: 'INVALID_PHONE',
  INVALID_PERCENTAGE: 'INVALID_PERCENTAGE',

  // Datatype & Mismatch
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  EMPTY_REQUIRED_VALUE: 'EMPTY_REQUIRED_VALUE',

  // Structure
  COLUMN_COUNT_MISMATCH: 'COLUMN_COUNT_MISMATCH',
  TABLE_STRUCTURE_ANOMALY: 'TABLE_STRUCTURE_ANOMALY',
  PAGE_MAPPING_MISMATCH: 'PAGE_MAPPING_MISMATCH',
  COORDINATE_METADATA_MISSING: 'COORDINATE_METADATA_MISSING',

  // Logical & Schema
  LOGICAL_RULE_FAILED: 'LOGICAL_RULE_FAILED',
} as const;

export const validationConfig = {
  azureConfidence: {
    acceptedThreshold: 0.90, // >= 0.90: ACCEPTED
    warningThreshold: 0.80,  // 0.80 <= conf < 0.90: WARNING; < 0.80: REVIEW_REQUIRED
  },
  structureConfidence: {
    acceptedThreshold: 0.85,
    warningThreshold: 0.70,
  },
  rules: {
    requireCoordinatesForReviewCandidates: true,
    flagSecondaryOcrForOcrErrors: true,
  },
};
