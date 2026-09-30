import { DataNormalizer } from '../ocr/normalizer.js';
import { ConfidenceValidator } from '../validation/validators/confidenceValidator.js';
import { DatatypeValidator } from '../validation/validators/datatypeValidator.js';
import { LogicalValidator } from '../validation/validators/logicalValidator.js';
import type { CandidateRevalidationResult } from './types.js';

export class CandidateRevalidator {
  /**
   * Revalidates an OCR candidate (Candidate B) against deterministic Phase 6 validation rules.
   */
  static revalidate(
    rawValue: string,
    cellType?: string,
    confidenceScore?: number,
    confidenceSource?: string,
    schemaColumn?: any
  ): CandidateRevalidationResult {
    const raw = rawValue ?? '';
    const type = (cellType || 'TEXT').toUpperCase();

    // 1. Normalize value
    const normalizedResult = DataNormalizer.normalizeCell(raw, type as any);
    const normalizedValue = normalizedResult.normalizedValue;

    const issues: any[] = [];

    // 2. Validate Confidence
    const confIssues = ConfidenceValidator.validateCell(
      confidenceScore ?? null,
      confidenceSource || 'AZURE_MODEL',
      1.0 // structureConfidence is preserved from table
    );
    issues.push(...confIssues);

    // 3. Validate Datatype & Format
    const typeIssues = DatatypeValidator.validate(type, raw, normalizedValue);
    issues.push(...typeIssues);

    // 4. Validate Logical & Schema constraints
    const logicIssues = LogicalValidator.validate(raw, type, schemaColumn);
    issues.push(...logicIssues);

    // 5. Determine validation status
    const hasErrors = issues.some((i) => i.severity === 'ERROR');
    const hasWarnings = issues.some((i) => i.severity === 'WARNING');

    let validationStatus: 'ACCEPTED' | 'WARNING' | 'REVIEW_REQUIRED' = 'ACCEPTED';
    if (hasErrors) {
      validationStatus = 'REVIEW_REQUIRED';
    } else if (hasWarnings) {
      validationStatus = 'WARNING';
    }

    return {
      isValid: !hasErrors,
      normalizedValue,
      validationStatus,
      issues: issues.map((i) => ({
        code: i.code,
        severity: i.severity,
        message: i.message,
        observedValue: raw,
        expected: i.expected,
        requiresSecondaryOcr: i.requiresSecondaryOcr ?? false,
      })),
    };
  }
}
