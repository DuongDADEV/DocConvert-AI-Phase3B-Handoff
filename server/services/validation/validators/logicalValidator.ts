import { ValidationIssue, ValidationSchemaColumn } from '../types.js';
import { VALIDATION_RULE_CODES } from '../validationConfig.js';

export class LogicalValidator {
  /**
   * Evaluates generic logical and schema rules deterministically.
   */
  static validate(
    rawValue: string,
    cellType?: string,
    schemaRule?: ValidationSchemaColumn
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const trimmed = rawValue.trim();

    // Rule 1: Empty required cell
    if (schemaRule?.required && !trimmed) {
      issues.push({
        code: VALIDATION_RULE_CODES.EMPTY_REQUIRED_VALUE,
        severity: 'ERROR',
        message: `Ô bắt buộc thuộc cột "${schemaRule.name}" không được để trống.`,
        rule: 'RequiredCellNonEmptyRule',
        expected: 'Giá trị khác rỗng',
        requiresSecondaryOcr: true,
      });
      return issues;
    }

    if (!trimmed) return issues;

    // Rule 2: Percentage range logic (> 100% or < 0%)
    if (cellType === 'PERCENTAGE' || schemaRule?.expectedType === 'PERCENTAGE' || trimmed.endsWith('%')) {
      const clean = trimmed.replace('%', '').trim().replace(/,/g, '.');
      const val = parseFloat(clean);
      if (!isNaN(val)) {
        if (val > 100 || val < 0) {
          issues.push({
            code: VALIDATION_RULE_CODES.LOGICAL_RULE_FAILED,
            severity: 'ERROR',
            message: `Tỷ lệ phần trăm vượt ngưỡng hợp lý (0..100%): ghi nhận ${val}%`,
            rule: 'PercentageRangeRule',
            observedValue: val,
            expected: '0% <= Tỷ lệ <= 100%',
            requiresSecondaryOcr: true,
          });
        }
      }
    }

    // Rule 3: Schema min/max if supplied
    if (schemaRule && (schemaRule.min !== undefined || schemaRule.max !== undefined)) {
      const num = parseFloat(trimmed.replace(/[\.,\s]/g, ''));
      if (!isNaN(num)) {
        if (schemaRule.min !== undefined && num < schemaRule.min) {
          issues.push({
            code: VALIDATION_RULE_CODES.LOGICAL_RULE_FAILED,
            severity: 'ERROR',
            message: `Giá trị (${num}) nhỏ hơn mức tối thiểu cho phép (${schemaRule.min}).`,
            rule: 'SchemaMinValueRule',
            observedValue: num,
            expected: `>= ${schemaRule.min}`,
            requiresSecondaryOcr: false,
          });
        }
        if (schemaRule.max !== undefined && num > schemaRule.max) {
          issues.push({
            code: VALIDATION_RULE_CODES.LOGICAL_RULE_FAILED,
            severity: 'ERROR',
            message: `Giá trị (${num}) vượt quá mức tối đa cho phép (${schemaRule.max}).`,
            rule: 'SchemaMaxValueRule',
            observedValue: num,
            expected: `<= ${schemaRule.max}`,
            requiresSecondaryOcr: false,
          });
        }
      }
    }

    return issues;
  }
}
