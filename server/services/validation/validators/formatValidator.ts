import { ValidationIssue } from '../types.js';
import { VALIDATION_RULE_CODES } from '../validationConfig.js';

export class FormatValidator {
  /**
   * Deterministically validates Date format and calendar validity.
   */
  static validateDate(value: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const trimmed = value.trim();
    if (!trimmed) return issues;

    // Supported date patterns: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, DD.MM.YYYY
    const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    const ymdMatch = trimmed.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);

    let day = 0, month = 0, year = 0;

    if (dmyMatch) {
      day = parseInt(dmyMatch[1], 10);
      month = parseInt(dmyMatch[2], 10);
      year = parseInt(dmyMatch[3], 10);
      if (year < 100) year += 2000;
    } else if (ymdMatch) {
      year = parseInt(ymdMatch[1], 10);
      month = parseInt(ymdMatch[2], 10);
      day = parseInt(ymdMatch[3], 10);
    } else {
      // Check if standard JS Date parses it unambiguously
      const parsed = Date.parse(trimmed);
      if (isNaN(parsed)) {
        issues.push({
          code: VALIDATION_RULE_CODES.INVALID_DATE,
          severity: 'ERROR',
          message: `Định dạng ngày tháng không hợp lệ: "${trimmed}"`,
          rule: 'DateFormatRule',
          observedValue: trimmed,
          expected: 'DD/MM/YYYY hoặc YYYY-MM-DD',
          requiresSecondaryOcr: true,
        });
        return issues;
      }
      return issues;
    }

    // Calendar range validation
    if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) {
      issues.push({
        code: VALIDATION_RULE_CODES.INVALID_DATE,
        severity: 'ERROR',
        message: `Giá trị ngày tháng nằm ngoài lịch thiên văn: ngày ${day}, tháng ${month}, năm ${year}`,
        rule: 'CalendarValidityRule',
        observedValue: trimmed,
        expected: 'Ngày hợp lệ trong lịch (1..31, tháng 1..12)',
        requiresSecondaryOcr: true,
      });
      return issues;
    }

    // Days per month check
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day > daysInMonth) {
      issues.push({
        code: VALIDATION_RULE_CODES.INVALID_DATE,
        severity: 'ERROR',
        message: `Tháng ${month}/${year} chỉ có tối đa ${daysInMonth} ngày (ghi nhận ngày ${day}).`,
        rule: 'DaysInMonthRule',
        observedValue: trimmed,
        expected: `Tối đa ${daysInMonth} ngày cho tháng ${month}`,
        requiresSecondaryOcr: true,
      });
    }

    return issues;
  }

  /**
   * Deterministically validates Money format.
   */
  static validateMoney(value: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const trimmed = value.trim();
    if (!trimmed) return issues;

    // Remove currency symbols and whitespace: VND, đ, $, €, etc.
    const clean = trimmed.replace(/[đ₫\$€¥VNDvnd\s]/g, '');

    // Alphanumeric contamination check (e.g. "120k", "12a345")
    if (/[a-zA-Z]/.test(clean)) {
      issues.push({
        code: VALIDATION_RULE_CODES.INVALID_MONEY,
        severity: 'ERROR',
        message: `Số tiền chứa ký tự chữ bất thường: "${trimmed}"`,
        rule: 'MoneyNoAlphaRule',
        observedValue: trimmed,
        expected: 'Số tiền không chứa ký tự chữ cái',
        requiresSecondaryOcr: true,
      });
      return issues;
    }

    // Check parseability
    const normalized = clean.replace(/\./g, '').replace(/,/g, '.');
    const num = parseFloat(normalized);
    if (isNaN(num)) {
      issues.push({
        code: VALIDATION_RULE_CODES.INVALID_MONEY,
        severity: 'ERROR',
        message: `Không thể chuyển đổi giá trị số tiền: "${trimmed}"`,
        rule: 'MoneyNumericParseRule',
        observedValue: trimmed,
        expected: 'Chuỗi số tiền hợp lệ',
        requiresSecondaryOcr: true,
      });
    }

    return issues;
  }

  /**
   * Deterministically validates generic Number format.
   */
  static validateNumber(value: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const trimmed = value.trim();
    if (!trimmed) return issues;

    // Check if clean number
    const clean = trimmed.replace(/\s/g, '').replace(/,/g, '.');
    if (isNaN(Number(clean))) {
      issues.push({
        code: VALIDATION_RULE_CODES.INVALID_NUMBER,
        severity: 'ERROR',
        message: `Giá trị không thể biểu diễn dưới dạng số: "${trimmed}"`,
        rule: 'NumericPlausibilityRule',
        observedValue: trimmed,
        expected: 'Số nguyên hoặc số thập phân',
        requiresSecondaryOcr: true,
      });
    }

    return issues;
  }

  /**
   * Deterministically validates Email format.
   */
  static validateEmail(value: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const trimmed = value.trim();
    if (!trimmed) return issues;

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) {
      issues.push({
        code: VALIDATION_RULE_CODES.INVALID_EMAIL,
        severity: 'WARNING',
        message: `Định dạng thư điện tử (email) không đúng chuẩn: "${trimmed}"`,
        rule: 'EmailFormatRule',
        observedValue: trimmed,
        expected: 'Địa chỉ email hợp lệ (vd: user@example.com)',
        requiresSecondaryOcr: false,
      });
    }

    return issues;
  }

  /**
   * Deterministically validates Phone number plausibility.
   */
  static validatePhone(value: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const trimmed = value.trim();
    if (!trimmed) return issues;

    // Digits only after stripping punctuation +, -, (, ), spaces
    const digitsOnly = trimmed.replace(/[\+\-\(\)\s\.]/g, '');
    if (!/^\d+$/.test(digitsOnly) || digitsOnly.length < 8 || digitsOnly.length > 15) {
      issues.push({
        code: VALIDATION_RULE_CODES.INVALID_PHONE,
        severity: 'WARNING',
        message: `Số điện thoại không hợp lý (${digitsOnly.length} chữ số): "${trimmed}"`,
        rule: 'PhonePlausibilityRule',
        observedValue: trimmed,
        expected: 'Số điện thoại từ 8 đến 15 chữ số',
        requiresSecondaryOcr: false,
      });
    }

    return issues;
  }
}
