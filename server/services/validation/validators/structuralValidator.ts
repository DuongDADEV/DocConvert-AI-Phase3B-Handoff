import { ValidationIssue } from '../types.js';
import { VALIDATION_RULE_CODES } from '../validationConfig.js';

export class StructuralValidator {
  /**
   * Validates structural consistency of a table and its rows.
   */
  static validateTable(
    table: {
      pageNumber: number;
      columnCount: number;
      rowCount: number;
      rows: Array<{ rowIndex: number; cells: any[] }>;
    }
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    if (!table.rows || table.rows.length === 0) {
      return issues;
    }

    // Check row column counts against expected table.columnCount
    const expectedCols = table.columnCount || (table.rows[0]?.cells?.length ?? 0);
    const deviantRows: number[] = [];

    for (const r of table.rows) {
      const cellCount = r.cells?.length ?? 0;
      if (cellCount !== expectedCols && cellCount > 0) {
        deviantRows.push(r.rowIndex);
      }
    }

    if (deviantRows.length > 0) {
      issues.push({
        code: VALIDATION_RULE_CODES.COLUMN_COUNT_MISMATCH,
        severity: 'WARNING',
        message: `Bảng trang ${table.pageNumber} có ${deviantRows.length} dòng có số cột (${deviantRows.slice(0, 3).join(', ')}...) không khớp với số cột chuẩn của bảng (${expectedCols}).`,
        rule: 'TableRowColumnCountConsistencyRule',
        observedValue: { expectedCols, deviantRowsCount: deviantRows.length },
        expected: `Mỗi dòng có chính xác ${expectedCols} cột`,
        requiresSecondaryOcr: false,
      });
    }

    // Check suspicious single-row or zero-cell anomalies
    if (table.rowCount > 0 && table.rows.length === 0) {
      issues.push({
        code: VALIDATION_RULE_CODES.TABLE_STRUCTURE_ANOMALY,
        severity: 'ERROR',
        message: `Bảng trang ${table.pageNumber} khai báo ${table.rowCount} dòng nhưng không có dữ liệu dòng nào.`,
        rule: 'TableEmptyRowsAnomalyRule',
        requiresSecondaryOcr: true,
      });
    }

    return issues;
  }
}
