import ExcelJS from 'exceljs';
import crypto from 'crypto';
import { db } from '../db/db.js';
import { storageService } from './storageService.js';
import { auditService } from './auditService.js';

export type ExportMode = 'ORIGINAL' | 'NORMALIZED';

export interface ExcelExportOptions {
  mode?: ExportMode; // 'ORIGINAL' (raw_value) or 'NORMALIZED' (normalized_value)
  includeReviewLog?: boolean; // Default true: adds audit/review log sheet
  includeValidationSheet?: boolean; // Default true: checks bank balance debit/credit balance
  highlightLowConfidence?: boolean; // Default true: visual highlight + note for low conf / review required cells
  lowConfidenceThreshold?: number; // Default 0.70
}

export interface ExportResult {
  exportId: string;
  documentId: string;
  userId: string;
  exportFormat: 'XLSX';
  exportMode: ExportMode;
  fileName: string;
  storageBucket: string;
  storagePath: string;
  fileSize: number;
  tablesCount: number;
  totalRows: number;
  totalCells: number;
  lowConfidenceCount: number;
  reviewedCount: number;
  createdAt: string;
}

export class ExcelExportEngine {
  /**
   * Cleans and sanitizes sheet names to obey Excel constraints:
   * 1. Max length: 31 characters
   * 2. Prohibited characters: [ ] : * ? / \
   * 3. Cannot start/end with single quote '
   * 4. Handle duplicates automatically (e.g. Table_1, Table_2)
   */
  public sanitizeSheetName(name: string, existingNames: Set<string>): string {
    let clean = name.replace(/[\[\]:*?\/\\']/g, '_').trim();
    if (!clean) clean = 'Sheet';
    
    // Truncate to 28 chars to allow suffix space
    clean = clean.substring(0, 31);

    let finalName = clean;
    let counter = 1;
    while (existingNames.has(finalName.toLowerCase())) {
      const suffix = `_${counter}`;
      const baseMaxLen = 31 - suffix.length;
      finalName = `${clean.substring(0, baseMaxLen)}${suffix}`;
      counter++;
    }

    existingNames.add(finalName.toLowerCase());
    return finalName;
  }

  public getColumnLetter(colIndex: number): string {
    let temp = colIndex;
    let letter = '';
    while (temp > 0) {
      const rem = (temp - 1) % 26;
      letter = String.fromCharCode(65 + rem) + letter;
      temp = Math.floor((temp - 1) / 26);
    }
    return letter || 'A';
  }

  /**
   * Main export method: Converts structured database OCR records into formatted Excel file
   * Luồng bắt buộc:
   * Database extracted_tables / rows / cells -> Normalization & Review Data -> ExcelJS -> Supabase Private Storage
   */
  async exportDocumentToExcel(
    userId: string,
    documentId: string,
    options: ExcelExportOptions = {}
  ): Promise<ExportResult> {
    const mode: ExportMode = options.mode || 'NORMALIZED';
    const includeReviewLog = options.includeReviewLog !== false;
    const includeValidationSheet = options.includeValidationSheet !== false;
    const highlightLowConfidence = options.highlightLowConfidence !== false;
    const lowConfidenceThreshold = options.lowConfidenceThreshold ?? 0.70;

    // 1. Strict Ownership & Access Verification (RLS)
    const doc = await db.getUserDocumentById(userId, documentId);
    if (!doc) {
      throw new Error('Tài liệu không tồn tại hoặc bạn không có quyền truy cập.');
    }

    const ocrData = await db.getDocumentOcrResult(userId, documentId);
    if (!ocrData || !ocrData.tables || ocrData.tables.length === 0) {
      throw new Error('Tài liệu chưa có dữ liệu bảng trích xuất OCR để xuất Excel.');
    }

    // 2. Idempotency Check: Retrieve active export record if same options/state exists
    const existingExport = await db.findExistingExport(userId, documentId, 'XLSX', mode);
    if (existingExport) {
      // Check if file still exists in storage
      const fileCheck = await storageService.getFile(userId, `export_${existingExport.id}`);
      if (fileCheck) {
        return {
          exportId: existingExport.id,
          documentId: existingExport.document_id,
          userId: existingExport.user_id,
          exportFormat: 'XLSX',
          exportMode: (existingExport.export_mode as ExportMode) || mode,
          fileName: existingExport.file_name,
          storageBucket: existingExport.storage_bucket,
          storagePath: existingExport.storage_path,
          fileSize: existingExport.file_size,
          tablesCount: existingExport.metadata?.tablesCount || ocrData.tables.length,
          totalRows: existingExport.metadata?.totalRows || 0,
          totalCells: existingExport.metadata?.totalCells || 0,
          lowConfidenceCount: existingExport.metadata?.lowConfidenceCount || 0,
          reviewedCount: existingExport.metadata?.reviewedCount || 0,
          createdAt: existingExport.created_at,
        };
      }
    }

    // 3. Create Workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DocConvert AI (Azure AI Document Intelligence)';
    workbook.lastModifiedBy = 'DocConvert AI Export Engine';
    workbook.created = new Date();
    workbook.modified = new Date();

    const usedSheetNames = new Set<string>();
    const reviewLogRows: Array<{
      sheetName: string;
      cellRef: string;
      rowIndex: number;
      colIndex: number;
      rawValue: string;
      normalizedValue: string;
      cellType: string;
      confidence: number;
      isReviewed: boolean;
      status: string;
      ruleCode?: string;
      valMsg?: string;
    }> = [];

    let totalRowsCount = 0;
    let totalCellsCount = 0;
    let totalLowConfidenceCount = 0;
    let totalReviewedCount = 0;

    let detectedDebitSum = 0;
    let detectedCreditSum = 0;
    let hasFinancialColumns = false;

    // 4. Generate Worksheets for each Extracted Table
    ocrData.tables.forEach((table, tableIndex) => {
      const pageNum = table.pageNumber || 1;
      const baseSheetName = ocrData.tables.length > 1
        ? `Bảng_${tableIndex + 1}_Trang_${pageNum}`
        : `Bang_Du_Lieu`;
      
      const sheetName = this.sanitizeSheetName(baseSheetName, usedSheetNames);
      const worksheet = workbook.addWorksheet(sheetName, {
        views: [{ showGridLines: true }],
        pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'landscape' },
      });

      // Track merged cells to apply in ExcelJS
      const mergesToApply: Array<{ top: number; left: number; bottom: number; right: number }> = [];

      // Find financial column indexes for sum calculation
      const headerNames = table.headers || [];
      const debitColIndices = new Set<number>();
      const creditColIndices = new Set<number>();

      headerNames.forEach((h, colIdx) => {
        const lower = (h || '').toLowerCase();
        if (lower.includes('nợ') || lower.includes('debit') || lower.includes('ghi nợ') || lower.includes('rút ra')) {
          debitColIndices.add(colIdx);
          hasFinancialColumns = true;
        }
        if (lower.includes('có') || lower.includes('credit') || lower.includes('ghi có') || lower.includes('nộp vào') || lower.includes('gửi vào')) {
          creditColIndices.add(colIdx);
          hasFinancialColumns = true;
        }
      });

      // Write Rows
      table.rows.forEach((row, rowIdx) => {
        totalRowsCount++;
        const excelRowNumber = rowIdx + 1; // 1-indexed in Excel
        const excelRow = worksheet.getRow(excelRowNumber);

        // Styling for header row
        if (row.isHeader || rowIdx === 0) {
          excelRow.height = 28;
        } else {
          excelRow.height = 22;
        }

        row.cells.forEach((cell) => {
          totalCellsCount++;
          const excelColNumber = cell.columnIndex + 1; // 1-indexed in Excel
          const excelCell = excelRow.getCell(excelColNumber);

          const rawVal = cell.rawValue !== undefined && cell.rawValue !== null ? String(cell.rawValue) : '';
          const normVal = cell.normalizedValue !== undefined && cell.normalizedValue !== null ? String(cell.normalizedValue) : '';
          const conf = typeof cell.confidence === 'number' ? cell.confidence : 1.0;
          const isReviewed = Boolean(cell.isReviewed);
          const isLowConf = conf < lowConfidenceThreshold;

          if (isLowConf) totalLowConfidenceCount++;
          if (isReviewed) totalReviewedCount++;

          // Handle Merged Cells (rowSpan > 1 or columnSpan > 1)
          if ((cell.rowSpan && cell.rowSpan > 1) || (cell.columnSpan && cell.columnSpan > 1)) {
            const rSpan = cell.rowSpan || 1;
            const cSpan = cell.columnSpan || 1;
            mergesToApply.push({
              top: excelRowNumber,
              left: excelColNumber,
              bottom: excelRowNumber + rSpan - 1,
              right: excelColNumber + cSpan - 1,
            });
          }

          // Record into Review Log
          if (includeReviewLog && (rowIdx > 0 || !row.isHeader)) {
            const colLetter = this.getColumnLetter(excelColNumber);
            const cellRef = `${colLetter}${excelRowNumber}`;
            const valStatus = (cell as any).validationStatus || (isLowConf ? 'REVIEW_REQUIRED' : 'ACCEPTED');
            const valIssues = (cell as any).validationIssues || [];
            const ruleCode = valIssues[0]?.code || '';
            const valMsg = valIssues.map((i: any) => i.message).join('; ');

            const originalRaw = (cell as any).originalRawValue || rawVal;
            const resStatus = (cell as any).resolutionStatus || 'NOT_REQUIRED';
            const resMethod = (cell as any).resolutionMethod || 'NONE';

            reviewLogRows.push({
              sheetName,
              cellRef,
              rowIndex: row.rowIndex,
              colIndex: cell.columnIndex,
              originalRawValue: originalRaw,
              rawValue: rawVal,
              normalizedValue: normVal,
              cellType: cell.cellType,
              confidence: conf,
              isReviewed,
              status: isReviewed ? 'ĐÃ ĐỐI SOÁT' : resStatus === 'RESOLVED' ? 'ĐÃ GIẢI QUYẾT TỰ ĐỘNG' : valStatus === 'REVIEW_REQUIRED' ? 'CẦN KIỂM TRA' : valStatus === 'WARNING' ? 'CẢNH BÁO' : 'TIN CẬY',
              resolutionMethod: resMethod,
              ruleCode,
              valMsg,
            });
          }

          // --- Value Placement & Type Formatting ---
          if (row.isHeader) {
            // Header Row Styling
            excelCell.value = rawVal;
            excelCell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
            excelCell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FF1E293B' }, // Slate 800
            };
            excelCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            excelCell.border = {
              top: { style: 'thin', color: { argb: 'FF94A3B8' } },
              left: { style: 'thin', color: { argb: 'FF94A3B8' } },
              bottom: { style: 'medium', color: { argb: 'FF0F172A' } },
              right: { style: 'thin', color: { argb: 'FF94A3B8' } },
            };
          } else {
            // Data Rows
            let cellValueToSet: any = rawVal;

            if (mode === 'NORMALIZED') {
              if (cell.cellType === 'MONEY' || cell.cellType === 'NUMBER') {
                // Parse numeric without guessing
                const cleanNumStr = (normVal || rawVal).replace(/[^0-9.-]/g, '');
                const parsedNum = parseFloat(cleanNumStr);

                if (!isNaN(parsedNum)) {
                  cellValueToSet = parsedNum;
                  if (cell.cellType === 'MONEY') {
                    // Vietnamese Accounting Currency Format: #,##0 "₫";[Red]-#,##0 "₫";"-"
                    excelCell.numFmt = '#,##0;[Red]-#,##0;"-"';
                    excelCell.alignment = { vertical: 'middle', horizontal: 'right' };

                    // Accumulate totals for financial validation
                    if (debitColIndices.has(cell.columnIndex)) {
                      detectedDebitSum += Math.abs(parsedNum);
                    }
                    if (creditColIndices.has(cell.columnIndex)) {
                      detectedCreditSum += Math.abs(parsedNum);
                    }
                  } else {
                    excelCell.numFmt = '#,##0.##';
                    excelCell.alignment = { vertical: 'middle', horizontal: 'right' };
                  }
                } else {
                  // Fallback to raw value safely
                  cellValueToSet = rawVal;
                  excelCell.alignment = { vertical: 'middle', horizontal: 'left' };
                }
              } else if (cell.cellType === 'DATE') {
                // Try format valid ISO date YYYY-MM-DD
                const dateMatch = (normVal || rawVal).match(/^(\d{4})-(\d{2})-(\d{2})$/);
                if (dateMatch) {
                  const dateObj = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
                  if (!isNaN(dateObj.getTime())) {
                    cellValueToSet = dateObj;
                    excelCell.numFmt = 'DD/MM/YYYY';
                    excelCell.alignment = { vertical: 'middle', horizontal: 'center' };
                  } else {
                    cellValueToSet = normVal || rawVal;
                    excelCell.alignment = { vertical: 'middle', horizontal: 'center' };
                  }
                } else {
                  cellValueToSet = rawVal;
                  excelCell.alignment = { vertical: 'middle', horizontal: 'center' };
                }
              } else {
                // TEXT or empty
                cellValueToSet = rawVal;
                excelCell.alignment = { vertical: 'middle', horizontal: 'left' };
              }
            } else {
              // MODE A — ORIGINAL (Preserve 100% exact text string)
              cellValueToSet = rawVal;
              excelCell.alignment = {
                vertical: 'middle',
                horizontal: cell.cellType === 'MONEY' ? 'right' : cell.cellType === 'DATE' ? 'center' : 'left',
              };
            }

            excelCell.value = cellValueToSet;
            excelCell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF1E293B' } };

            // Grid Borders
            excelCell.border = {
              top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
              left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
              bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
              right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            };

            // Highlight Low Confidence / Review Required cells
            if (highlightLowConfidence && isLowConf && !isReviewed) {
              excelCell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFFFBEB' }, // Amber-50 warning highlight
              };
              excelCell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFB45309' } };
              excelCell.note = {
                texts: [
                  { font: { bold: true, size: 9, color: { argb: 'FFB45309' } }, text: '⚠️ CẢNH BÁO ĐỐI SOÁT:\n' },
                  { font: { size: 9 }, text: `Độ tin cậy OCR: ${(conf * 100).toFixed(1)}%\nGiá trị gốc: ${rawVal}` },
                ],
              };
            } else if (isReviewed) {
              // Subtle indicator for human reviewed cell
              excelCell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFF0FDF4' }, // Light Emerald-50
              };
            }
          }
        });
      });

      // Apply Merged Cells safely
      mergesToApply.forEach((m) => {
        try {
          worksheet.mergeCells(m.top, m.left, m.bottom, m.right);
        } catch (err) {
          console.warn(`Could not merge cells (${m.top},${m.left}) to (${m.bottom},${m.right}):`, err);
        }
      });

      // Auto-fit Column Widths based on contents
      worksheet.columns.forEach((column) => {
        let maxLen = 12;
        if (column && column.eachCell) {
          column.eachCell({ includeEmpty: false }, (cell) => {
            const cellValue = cell.value;
            let len = 10;
            if (cellValue instanceof Date) {
              len = 12;
            } else if (typeof cellValue === 'number') {
              len = cellValue.toLocaleString('vi-VN').length + 4;
            } else if (cellValue) {
              len = String(cellValue).length;
            }
            if (len > maxLen) maxLen = len;
          });
        }
        column.width = Math.min(Math.max(maxLen + 4, 14), 50);
      });
    });

    // 5. Generate Worksheet: Review_Log (Audit & Đối soát)
    if (includeReviewLog && reviewLogRows.length > 0) {
      const reviewSheetName = this.sanitizeSheetName('Review_Log', usedSheetNames);
      const revSheet = workbook.addWorksheet(reviewSheetName, {
        views: [{ showGridLines: true }],
      });

      // Header Row
      const headers = [
        'Sheet',
        'Ô (Cell)',
        'Giá trị ban đầu (Original)',
        'Giá trị hiện tại (Raw)',
        'Giá trị chuẩn hóa (Normalized)',
        'Loại dữ liệu',
        'Độ tin cậy',
        'Trạng thái đối soát',
        'Phương thức giải quyết',
        'Mã lỗi quy tắc',
        'Chi tiết kiểm định',
      ];
      const revHeaderRow = revSheet.addRow(headers);
      revHeaderRow.height = 26;
      revHeaderRow.eachCell((cell) => {
        cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });

      // Data Rows
      reviewLogRows.forEach((item) => {
        const row = revSheet.addRow([
          item.sheetName,
          item.cellRef,
          item.originalRawValue || item.rawValue,
          item.rawValue,
          item.normalizedValue,
          item.cellType,
          item.confidence !== null && item.confidence !== undefined ? `${(item.confidence * 100).toFixed(1)}%` : 'Trích xuất trực tiếp',
          item.status,
          item.resolutionMethod || 'NONE',
          item.ruleCode || '',
          item.valMsg || '',
        ]);
        row.height = 20;

        // Highlight low confidence in log
        const statusCell = row.getCell(8);
        if (item.status === 'CẦN KIỂM TRA') {
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
          statusCell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FFB45309' } };
        } else if (item.status === 'CẢNH BÁO') {
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
          statusCell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FF1D4ED8' } };
        } else if (item.status === 'ĐÃ ĐỐI SOÁT') {
          statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
          statusCell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FF15803D' } };
        }
      });

      revSheet.columns.forEach((col, idx) => {
        col.width = [18, 12, 24, 24, 14, 16, 18, 22, 35][idx] || 16;
      });
    }

    // 6. Generate Worksheet: Validation (Banking Balance & Financial Audit)
    if (includeValidationSheet) {
      const valSheetName = this.sanitizeSheetName('Validation', usedSheetNames);
      const valSheet = workbook.addWorksheet(valSheetName, {
        views: [{ showGridLines: true }],
      });

      valSheet.columns = [
        { header: 'Chỉ số kiểm tra tài chính', key: 'metric', width: 35 },
        { header: 'Giá trị tổng hợp', key: 'value', width: 25 },
        { header: 'Đơn vị', key: 'unit', width: 12 },
        { header: 'Ghi chú đối soát', key: 'notes', width: 35 },
      ];

      const valHeader = valSheet.getRow(1);
      valHeader.height = 26;
      valHeader.eachCell((cell) => {
        cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } }; // Blue-900
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      });

      const rowsData = [
        ['Tổng phát sinh Nợ (Debit)', detectedDebitSum, 'VND', 'Tổng các giao dịch ghi nợ trích xuất'],
        ['Tổng phát sinh Có (Credit)', detectedCreditSum, 'VND', 'Tổng các giao dịch ghi có trích xuất'],
        ['Chênh lệch phát sinh (Credit - Debit)', detectedCreditSum - detectedDebitSum, 'VND', 'Dòng tiền ròng trong kỳ sao kê'],
        ['Tổng số ô cần đối soát', totalLowConfidenceCount, 'Ô', totalLowConfidenceCount > 0 ? 'Cần kiểm tra kỹ các ô được đánh dấu màu vàng' : 'Toàn bộ dữ liệu đạt độ tin cậy cao'],
        ['Trạng thái đối soát', totalLowConfidenceCount === 0 ? 'HỢP LỆ (VERIFIED)' : 'REVIEW REQUIRED', '', totalLowConfidenceCount > 0 ? 'Vui lòng kiểm tra lại Review_Log' : 'Đã đối soát an toàn'],
      ];

      rowsData.forEach((r, idx) => {
        const valRow = valSheet.addRow(r);
        valRow.height = 22;
        if (typeof r[1] === 'number' && r[2] === 'VND') {
          const c = valRow.getCell(2);
          c.numFmt = '#,##0;[Red]-#,##0;"-"';
          c.alignment = { horizontal: 'right', vertical: 'middle' };
        }
        if (idx === 4) {
          const statusCell = valRow.getCell(2);
          if (r[1] === 'REVIEW REQUIRED') {
            statusCell.font = { bold: true, color: { argb: 'FFDC2626' } };
          } else {
            statusCell.font = { bold: true, color: { argb: 'FF16A34A' } };
          }
        }
      });
    }

    // 7. Write Workbook to Buffer
    const buffer = await workbook.xlsx.writeBuffer();
    const fileBuffer = Buffer.from(buffer);

    // 8. Generate safe file name and persist to Private Supabase Storage
    const exportId = crypto.randomUUID();
    const rawDocName = doc.original_filename.replace(/\.[^/.]+$/, '');
    const cleanDocName = rawDocName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40) || 'document';
    const finalFileName = `${cleanDocName}_export_${mode.toLowerCase()}_${Date.now()}.xlsx`;

    // Save Excel file into Storage: {userId}/export_{exportId}/{finalFileName}
    const savedFile = await storageService.saveFile(
      userId,
      `export_${exportId}`,
      finalFileName,
      fileBuffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    // 9. Persist Export Record into DB
    const exportRecord = await db.createExportRecord({
      id: exportId,
      user_id: userId,
      document_id: documentId,
      export_format: 'XLSX',
      export_mode: mode,
      file_name: finalFileName,
      file_size: fileBuffer.length,
      storage_bucket: savedFile.storageBucket,
      storage_path: savedFile.storagePath,
      status: 'COMPLETED',
      metadata: {
        tablesCount: ocrData.tables.length,
        totalRows: totalRowsCount,
        totalCells: totalCellsCount,
        lowConfidenceCount: totalLowConfidenceCount,
        reviewedCount: totalReviewedCount,
        includeReviewLog,
        includeValidationSheet,
      },
    });

    // 10. Write Audit Log (EXCLUDE all secrets, keys, or JWT)
    auditService.log({
      userId,
      action: 'EXPORT_CREATED',
      resourceType: 'documents',
      resourceId: documentId,
      metadata: {
        exportId,
        exportFormat: 'XLSX',
        exportMode: mode,
        fileName: finalFileName,
        fileSize: fileBuffer.length,
        tablesCount: ocrData.tables.length,
      },
    });

    return {
      exportId,
      documentId,
      userId,
      exportFormat: 'XLSX',
      exportMode: mode,
      fileName: finalFileName,
      storageBucket: savedFile.storageBucket,
      storagePath: savedFile.storagePath,
      fileSize: fileBuffer.length,
      tablesCount: ocrData.tables.length,
      totalRows: totalRowsCount,
      totalCells: totalCellsCount,
      lowConfidenceCount: totalLowConfidenceCount,
      reviewedCount: totalReviewedCount,
      createdAt: exportRecord.created_at,
    };
  }
}

export const excelExportEngine = new ExcelExportEngine();
