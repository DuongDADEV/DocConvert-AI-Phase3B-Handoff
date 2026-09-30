import { ValidationIssue, ValidationSeverity } from '../types.js';
import { VALIDATION_RULE_CODES, validationConfig } from '../validationConfig.js';

export class ConfidenceValidator {
  /**
   * Validates OCR or structure confidence for a cell.
   * - Azure: numeric model confidence [0..1]
   * - Local Native: confidence = null is normal; evaluates structureConfidence and source
   */
  static validateCell(
    confidence: number | null | undefined,
    confidenceSource: string | undefined,
    structureConfidence?: number | null
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Case 1: Azure Model Confidence
    if (confidenceSource === 'AZURE_MODEL' || (confidence !== null && confidence !== undefined && confidenceSource !== 'LOCAL_HEURISTIC')) {
      if (confidence !== null && confidence !== undefined) {
        if (confidence < validationConfig.azureConfidence.warningThreshold) {
          issues.push({
            code: VALIDATION_RULE_CODES.LOW_OCR_CONFIDENCE,
            severity: 'ERROR',
            message: `Điểm tin cậy OCR thấp (${(confidence * 100).toFixed(1)}% < ${validationConfig.azureConfidence.warningThreshold * 100}%). Cần đối soát thủ công.`,
            rule: 'AzureConfidenceRule',
            observedValue: confidence,
            expected: `>= ${validationConfig.azureConfidence.warningThreshold}`,
            requiresSecondaryOcr: true,
          });
        } else if (confidence < validationConfig.azureConfidence.acceptedThreshold) {
          issues.push({
            code: VALIDATION_RULE_CODES.MEDIUM_OCR_CONFIDENCE,
            severity: 'WARNING',
            message: `Điểm tin cậy OCR mức trung bình (${(confidence * 100).toFixed(1)}%).`,
            rule: 'AzureConfidenceRule',
            observedValue: confidence,
            expected: `>= ${validationConfig.azureConfidence.acceptedThreshold}`,
            requiresSecondaryOcr: false,
          });
        }
      }
    }

    // Case 2: Local Heuristic Extraction
    if (confidenceSource === 'LOCAL_HEURISTIC') {
      // Local extraction having confidence = null is EXPECTED and TRUTHFUL.
      // We check structureConfidence instead of rejecting null confidence.
      if (structureConfidence !== null && structureConfidence !== undefined) {
        if (structureConfidence < validationConfig.structureConfidence.warningThreshold) {
          issues.push({
            code: VALIDATION_RULE_CODES.LOW_STRUCTURE_CONFIDENCE,
            severity: 'ERROR',
            message: `Độ tin cậy cấu trúc bảng vector thấp (${(structureConfidence * 100).toFixed(1)}%).`,
            rule: 'LocalStructureConfidenceRule',
            observedValue: structureConfidence,
            expected: `>= ${validationConfig.structureConfidence.warningThreshold}`,
            requiresSecondaryOcr: true,
          });
        } else if (structureConfidence < validationConfig.structureConfidence.acceptedThreshold) {
          issues.push({
            code: VALIDATION_RULE_CODES.LOW_STRUCTURE_CONFIDENCE,
            severity: 'WARNING',
            message: `Độ tin cậy cấu trúc bảng vector ở mức trung bình (${(structureConfidence * 100).toFixed(1)}%).`,
            rule: 'LocalStructureConfidenceRule',
            observedValue: structureConfidence,
            expected: `>= ${validationConfig.structureConfidence.acceptedThreshold}`,
            requiresSecondaryOcr: false,
          });
        }
      }
    }

    return issues;
  }
}
