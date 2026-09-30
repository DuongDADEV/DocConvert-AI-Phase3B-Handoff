import { ValidationIssue } from '../types.js';
import { VALIDATION_RULE_CODES } from '../validationConfig.js';
import { FormatValidator } from './formatValidator.js';

export class DatatypeValidator {
  /**
   * Validates whether cell content matches declared or expected cellType.
   */
  static validate(cellType: string | undefined, rawValue: string, normalizedValue?: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const trimmed = rawValue.trim();
    if (!trimmed || !cellType) return issues;

    const upperType = cellType.toUpperCase();

    switch (upperType) {
      case 'NUMBER': {
        // Must be parseable as number without letters
        if (/[a-zA-Z]/.test(trimmed)) {
          issues.push({
            code: VALIDATION_RULE_CODES.TYPE_MISMATCH,
            severity: 'ERROR',
            message: `Kiểu ô được khai báo là NUMBER nhưng giá trị chứa chữ cái: "${trimmed}"`,
            rule: 'NumberTypeIntegrityRule',
            observedValue: trimmed,
            expected: 'Chỉ chứa các chữ số và dấu phân cách số học',
            requiresSecondaryOcr: true,
          });
        } else {
          issues.push(...FormatValidator.validateNumber(trimmed));
        }
        break;
      }

      case 'DATE': {
        issues.push(...FormatValidator.validateDate(trimmed));
        break;
      }

      case 'MONEY': {
        issues.push(...FormatValidator.validateMoney(trimmed));
        break;
      }

      case 'EMAIL': {
        issues.push(...FormatValidator.validateEmail(trimmed));
        break;
      }

      case 'PHONE': {
        issues.push(...FormatValidator.validatePhone(trimmed));
        break;
      }
    }

    return issues;
  }
}
