/**
 * Unified Table Service
 *
 * Implements backend runtime projection that unifies multiple physical Azure OCR tables
 * into a single canonical Unified Transaction Table per document.
 *
 * PURE IN-MEMORY PROJECTION:
 * - Does NOT mutate physical extracted_tables, extracted_rows, or extracted_cells in DB.
 * - Preserves 100% of physical cell IDs, row IDs, table IDs, bounding polygons, and confidence scores.
 * - Does not create fake DB IDs for missing slots (uses null / placeholder flag).
 * - Detects repeated headers across pages and removes them from transaction rows.
 * - Separates footer/summary rows and leading summary banners into a distinct summary collection.
 */

import { CellQualityEvaluator, CellQualityAssessment } from './quality/CellQualityEvaluator.js';

export interface UnifiedCell {
  id: string | null;              // EXACT extracted_cells.id (null for placeholder)
  rowId?: string;                 // EXACT source row id
  tableId?: string;               // EXACT source table id
  sourcePage?: number;

  sourceColumnIndex?: number;
  canonicalColumnIndex: number;

  rawValue: string;
  normalizedValue: string;
  cellType?: string;

  confidence: number | null;
  confidenceSource?: string;
  qualityAssessment?: CellQualityAssessment;
  isReviewed?: boolean;
  boundingPolygon?: any;
  isPlaceholder?: boolean;

  // Phase 6 Validation Engine preservation
  validationStatus?: 'ACCEPTED' | 'WARNING' | 'REVIEW_REQUIRED';
  validationIssues?: any[];
  requiresSecondaryOcr?: boolean;
  structureConfidence?: number | null;

  // Phase 7 Targeted Secondary OCR & Conflict Resolution preservation
  originalRawValue?: string | null;
  resolutionStatus?: 'NOT_REQUIRED' | 'PENDING' | 'RESOLVED' | 'UNRESOLVED' | 'HUMAN_REVIEW_REQUIRED';
  resolutionMethod?: 'NONE' | 'DETERMINISTIC' | 'SECONDARY_OCR' | 'SECONDARY_OCR_ENHANCED' | 'GEMINI' | 'HUMAN';

  // Coordinate system
  coordinateUnit?: string;
}

export interface UnifiedRow {
  displayRowIndex: number;

  sourceRowId: string;
  sourceTableId: string;
  sourcePage: number;

  cells: UnifiedCell[];
}

export type SemanticColumnType =
  | 'STT'
  | 'DATE'
  | 'VALUE_DATE'
  | 'REFERENCE'
  | 'DESCRIPTION'
  | 'DEBIT'
  | 'CREDIT'
  | 'BALANCE'
  | 'OTHER';

export interface UnifiedColumn {
  canonicalColumnIndex: number;
  header: string;
  normalizedHeader: string;
  semanticType: SemanticColumnType;
}

export interface UnifiedSummaryRow {
  sourceRowId: string;
  sourceTableId: string;
  sourcePage: number;
  values: string[];
  reason: string;
}

export interface TableClassificationResult {
  tableId: string;
  pageNumber: number;
  tableIndex: number;
  score: number;
  classification: 'TRANSACTION' | 'METADATA' | 'SUMMARY' | 'NOISE';
  evidence: {
    rowCount: number;
    columnCount: number;
    dateDensity: number;
    moneyDensity: number;
    sttDensity: number;
    narrativeDensity: number;
    headerTransactionScore: number;
    headerMetadataScore: number;
    areaRatio: number;
  };
}

export interface UnifiedTransactionTable {
  id: string;
  documentId: string;

  headers: string[];
  columns: UnifiedColumn[];

  rows: UnifiedRow[];
  summaryRows: UnifiedSummaryRow[];

  sourceTableIds: string[];
  sourcePages: number[];

  rowCount: number;
  columnCount: number;

  diagnostics: {
    physicalTableCount: number;
    transactionCandidateCount: number;
    rejectedTableCount: number;
    repeatedHeaderRowsRemoved: number;
    summaryRowsSeparated: number;
    columnAlignmentWarnings: number;
    projectionDurationMs: number;
    logicalGroupCount: number;
  };
}

// Configurable thresholds (Centralized, no scattered magic numbers)
export const UNIFIED_CONFIG = {
  TRANSACTION_SCORE_THRESHOLD: 0.50,
  REPEATED_HEADER_SIMILARITY_THRESHOLD: 0.40,
  DATE_REGEX: /^(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}-\d{1,2})$/,
  MONEY_REGEX: /^[+-]?(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?$/,
  STT_REGEX: /^\d{1,4}$/,
  SUMMARY_LABEL_REGEX: /(?:tổng|total|số dư cuối|closing balance|cộng phát sinh|lũy kế|grand total|so du dau)/i,
  METADATA_HEADER_REGEX: /(?:khách hàng|client|tên tài khoản|account name|số tài khoản|account no|cif|chi nhánh|branch|kỳ sao kê|statement period|loại tiền|currency)/i,
};

/**
 * Remove Vietnamese accents and convert to lowercase for fuzzy token matching
 */
export function normalizeVietnameseText(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class UnifiedTableService {
  /**
   * Main entry point: Projects an array of physical extracted tables into a UnifiedTransactionTable.
   */
  static projectDocumentTables(documentId: string, physicalTables: any[]): UnifiedTransactionTable | null {
    const startTime = Date.now();

    if (!physicalTables || physicalTables.length === 0) {
      return null;
    }

    // STEP 1: Classify physical tables
    const classifications: TableClassificationResult[] = physicalTables.map((t) =>
      this.classifyTable(t, physicalTables)
    );

    const transactionCandidates = physicalTables.filter((t) => {
      const c = classifications.find((cls) => cls.tableId === t.id);
      return c && c.classification === 'TRANSACTION';
    });

    if (transactionCandidates.length === 0) {
      return null;
    }

    // STEP 2: Logical Grouping by Schema Compatibility
    const groups = this.groupCompatibleTables(transactionCandidates);
    const dominantGroup = groups[0]; // Highest row count / most complete group

    if (!dominantGroup || dominantGroup.tables.length === 0) {
      return null;
    }

    // STEP 3: Choose Canonical Schema from highest quality table in dominant group
    const canonicalTable = this.selectCanonicalTable(dominantGroup.tables);
    const columns = this.deriveCanonicalColumns(canonicalTable, dominantGroup.tables);

    // STEP 4: Align columns, remove repeated headers, separate summary rows
    const unifiedRows: UnifiedRow[] = [];
    const summaryRows: UnifiedSummaryRow[] = [];
    let repeatedHeaderRowsRemoved = 0;
    let columnAlignmentWarnings = 0;
    const sourceTableIds: string[] = [];
    const sourcePagesSet = new Set<number>();

    let displayRowIndex = 0;

    // Process tables sorted by pageNumber then tableIndex
    const sortedTables = [...dominantGroup.tables].sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
      return a.tableIndex - b.tableIndex;
    });

    for (let tableOrder = 0; tableOrder < sortedTables.length; tableOrder++) {
      const table = sortedTables[tableOrder];
      sourceTableIds.push(table.id);
      sourcePagesSet.add(table.pageNumber);

      const tableRows = table.rows || [];
      const { headerRowIndex, headers: detectedHeaders } = this.findTableHeaderRow(table);

      // Create a copy of table with detected headers for mapping
      const tableWithHeaders = {
        ...table,
        headers: detectedHeaders,
        columnCount: Math.max(table.columnCount || 0, detectedHeaders.length),
      };

      const columnMapping = this.mapSourceColumnsToCanonical(tableWithHeaders, columns);

      // Check for alignment anomalies
      const unmappedCols = columnMapping.filter((idx) => idx === -1).length;
      if (unmappedCols > 0) {
        columnAlignmentWarnings += unmappedCols;
      }

      for (let rIdx = 0; rIdx < tableRows.length; rIdx++) {
        const row = tableRows[rIdx];
        const rawValues: string[] = [];
        const sourceColCount = Math.max(table.columnCount || 0, (row.cells || []).length);

        for (let c = 0; c < sourceColCount; c++) {
          const found = (row.cells || []).find((cell: any) => cell.columnIndex === c);
          rawValues.push(found ? (found.rawValue || '') : '');
        }

        // Check 1: Rows appearing BEFORE the detected transaction header
        // (e.g. ACB's page summary banner at row 0 & 1: "So du dau + Gui vao", "1,450,264,221.00...")
        if (rIdx < headerRowIndex) {
          summaryRows.push({
            sourceRowId: row.id,
            sourceTableId: table.id,
            sourcePage: table.pageNumber,
            values: rawValues,
            reason: 'Leading page summary banner before transaction header',
          });
          continue;
        }

        // Check 2: The actual detected header row of this table
        if (rIdx === headerRowIndex) {
          if (tableOrder > 0 || headerRowIndex > 0) {
            repeatedHeaderRowsRemoved++;
          }
          continue;
        }

        // Check 3: Header marked explicitly by OCR
        if (row.isHeader) {
          repeatedHeaderRowsRemoved++;
          continue;
        }

        // Check 4: Repeated header row stored as data (Pages >= 2 or tables > 0)
        if (this.isRepeatedHeaderRow(rawValues, columns)) {
          repeatedHeaderRowsRemoved++;
          continue;
        }

        // Check 5: Summary/footer row (e.g. "Tổng phát sinh", "Số dư cuối kỳ")
        const summaryCheck = this.detectSummaryRow(rawValues, columns);
        if (summaryCheck.isSummary) {
          summaryRows.push({
            sourceRowId: row.id,
            sourceTableId: table.id,
            sourcePage: table.pageNumber,
            values: rawValues,
            reason: summaryCheck.reason,
          });
          continue;
        }

        // Project physical cells into canonical columns
        const projectedCells: UnifiedCell[] = [];

        for (let colIdx = 0; colIdx < columns.length; colIdx++) {
          // Find which source column maps to this canonical column
          const sourceColIdx = columnMapping.indexOf(colIdx);

          if (sourceColIdx !== -1) {
            const cell = (row.cells || []).find((c: any) => c.columnIndex === sourceColIdx);
            if (cell) {
              projectedCells.push({
                id: cell.id,
                rowId: row.id,
                tableId: table.id,
                sourcePage: table.pageNumber,
                sourceColumnIndex: sourceColIdx,
                canonicalColumnIndex: colIdx,
                rawValue: cell.rawValue || '',
                normalizedValue: cell.normalizedValue ?? cell.rawValue ?? '',
                cellType: cell.cellType || 'TEXT',
                confidence: typeof cell.confidence === 'number' ? cell.confidence : null,
                confidenceSource: cell.confidenceSource,
                isReviewed: Boolean(cell.isReviewed),
                boundingPolygon: cell.boundingPolygon,
                isPlaceholder: false,

                // Phase 6 Validation preservation
                validationStatus: cell.validationStatus || 'ACCEPTED',
                validationIssues: cell.validationIssues || [],
                requiresSecondaryOcr: Boolean(cell.requiresSecondaryOcr),
                structureConfidence: cell.structureConfidence != null ? Number(cell.structureConfidence) : null,

                // Phase 7 Secondary OCR & Conflict Resolution preservation
                originalRawValue: cell.originalRawValue !== undefined ? cell.originalRawValue : (cell.rawValue || ''),
                resolutionStatus: cell.resolutionStatus || 'NOT_REQUIRED',
                resolutionMethod: cell.resolutionMethod || 'NONE',

                // Coordinate unit
                coordinateUnit: cell.coordinateUnit || 'point',
              });
              continue;
            }
          }

          // Missing slot -> Insert placeholder with exact null ID
          projectedCells.push({
            id: null,
            rowId: row.id,
            tableId: table.id,
            sourcePage: table.pageNumber,
            canonicalColumnIndex: colIdx,
            rawValue: '',
            normalizedValue: '',
            cellType: 'TEXT',
            confidence: null,
            confidenceSource: 'EMPTY_CELL',
            validationStatus: 'ACCEPTED',
            validationIssues: [],
            requiresSecondaryOcr: false,
            originalRawValue: null,
            resolutionStatus: 'NOT_REQUIRED',
            resolutionMethod: 'NONE',
            isPlaceholder: true,
          });
        }

        unifiedRows.push({
          displayRowIndex: displayRowIndex++,
          sourceRowId: row.id,
          sourceTableId: table.id,
          sourcePage: table.pageNumber,
          cells: projectedCells,
        });
      }
    }

    // Evaluate cell semantic quality across unified rows
    CellQualityEvaluator.evaluateTable(columns, unifiedRows);

    const duration = Date.now() - startTime;

    return {
      id: `unified-tx-${documentId}`,
      documentId,
      headers: columns.map((c) => c.header),
      columns,
      rows: unifiedRows,
      summaryRows,
      sourceTableIds,
      sourcePages: Array.from(sourcePagesSet).sort((a, b) => a - b),
      rowCount: unifiedRows.length,
      columnCount: columns.length,
      diagnostics: {
        physicalTableCount: physicalTables.length,
        transactionCandidateCount: transactionCandidates.length,
        rejectedTableCount: physicalTables.length - transactionCandidates.length,
        repeatedHeaderRowsRemoved,
        summaryRowsSeparated: summaryRows.length,
        columnAlignmentWarnings,
        projectionDurationMs: duration,
        logicalGroupCount: groups.length,
      },
    };
  }

  /**
   * Localizes where the transaction header actually begins in a physical table.
   * Real case proof: ACB tables on Pages 1..7 have a 2-row summary banner at Rows 0 & 1,
   * while the real transaction header (Ngay, Dien giai, Ghi no, Ghi co, So du) is at Row 2.
   */
  static findTableHeaderRow(table: any): { headerRowIndex: number; headers: string[] } {
    const rows = table.rows || [];
    let bestRowIdx = -1;
    let bestScore = -1;
    let bestHeaders = table.headers || [];

    const maxCheckRows = Math.min(3, rows.length);
    for (let rIdx = 0; rIdx < maxCheckRows; rIdx++) {
      const row = rows[rIdx];
      const cellValues: string[] = [];
      const colCount = Math.max(table.columnCount || 0, (row.cells || []).length);

      for (let c = 0; c < colCount; c++) {
        const found = (row.cells || []).find((cell: any) => cell.columnIndex === c);
        cellValues.push(found ? (found.rawValue || '').trim() : '');
      }

      let txScore = 0;
      for (const val of cellValues) {
        const norm = normalizeVietnameseText(val);
        if (
          norm === 'ngay' ||
          norm === 'ngay gd' ||
          norm === 'booking date' ||
          norm === 'date' ||
          norm === 'dien giai' ||
          norm === 'noi dung' ||
          norm === 'description' ||
          norm === 'ghi no' ||
          norm === 'ps no' ||
          norm === 'debit' ||
          norm === 'rut ra' ||
          norm === 'ghi co' ||
          norm === 'ps co' ||
          norm === 'credit' ||
          norm === 'gui vao' ||
          norm === 'so du' ||
          norm === 'balance' ||
          norm === 'stt' ||
          norm === 'so gd' ||
          norm === 'so ct' ||
          norm === 'chung tu' ||
          norm === 'tra lai' ||
          norm === 'nv' ||
          norm === 'gdv'
        ) {
          txScore += 3;
        } else if (norm.includes('ngay') || norm.includes('dien giai') || norm.includes('debit') || norm.includes('credit')) {
          txScore += 2;
        }

        // Penalize summary banner headers (e.g. 'So du dau + Gui vao', '-Rut ra', '- Phi -')
        if (norm.includes('so du dau') || norm.includes('nhap von') || norm.includes('phi')) {
          txScore -= 2;
        }
      }

      if (txScore > bestScore && txScore >= 3) {
        bestScore = txScore;
        bestRowIdx = rIdx;
        bestHeaders = cellValues;
      }
    }

    return { headerRowIndex: bestRowIdx, headers: bestHeaders };
  }

  /**
   * Deterministic scoring function for table classification.
   * Does NOT reject by row count alone; uses evidence weighting.
   */
  static classifyTable(table: any, allTablesOnDoc: any[]): TableClassificationResult {
    const rows = table.rows || [];
    const rowCount = rows.length;
    const columnCount = table.columnCount || (table.headers ? table.headers.length : 0);

    // Calculate cell value distributions
    let totalCells = 0;
    let dateCells = 0;
    let moneyCells = 0;
    let sttCells = 0;
    let narrativeCells = 0;

    for (const r of rows) {
      if (r.isHeader) continue;
      for (const c of r.cells || []) {
        totalCells++;
        const val = (c.rawValue || '').trim();
        if (!val) continue;

        if (UNIFIED_CONFIG.DATE_REGEX.test(val)) {
          dateCells++;
        } else if (UNIFIED_CONFIG.MONEY_REGEX.test(val) && val.length >= 3) {
          moneyCells++;
        } else if (UNIFIED_CONFIG.STT_REGEX.test(val)) {
          sttCells++;
        }

        if (val.length > 15 && /[a-zA-Z\u00C0-\u024F\u1EA0-\u1EF9]/.test(val)) {
          narrativeCells++;
        }
      }
    }

    const cellDenom = Math.max(1, totalCells);
    const dateDensity = dateCells / cellDenom;
    const moneyDensity = moneyCells / cellDenom;
    const sttDensity = sttCells / cellDenom;
    const narrativeDensity = narrativeCells / cellDenom;

    // Header semantics scoring (check both table.headers and detected header row)
    const { headers } = this.findTableHeaderRow(table);
    let headerTxScore = 0;
    let headerMetaScore = 0;

    for (const h of headers) {
      const norm = normalizeVietnameseText(h);
      if (
        norm.includes('ngay') ||
        norm.includes('date') ||
        norm.includes('dien giai') ||
        norm.includes('noi dung') ||
        norm.includes('so tien') ||
        norm.includes('no') ||
        norm.includes('co') ||
        norm.includes('debit') ||
        norm.includes('credit') ||
        norm.includes('so du') ||
        norm.includes('balance') ||
        norm.includes('stt') ||
        norm.includes('ref') ||
        norm.includes('tra lai')
      ) {
        headerTxScore += 1;
      }
      if (UNIFIED_CONFIG.METADATA_HEADER_REGEX.test(h)) {
        headerMetaScore += 1;
      }
    }

    const headerDenom = Math.max(1, headers.length);
    const headerTransactionScore = headerTxScore / headerDenom;
    const headerMetadataScore = headerMetaScore / headerDenom;

    // Relative area dominance on page
    const samePageTables = allTablesOnDoc.filter((t) => t.pageNumber === table.pageNumber);
    const samePageTotalCells = samePageTables.reduce((acc, t) => acc + (t.rowCount * t.columnCount), 0);
    const tableCells = rowCount * columnCount;
    const areaRatio = samePageTotalCells > 0 ? tableCells / samePageTotalCells : 1.0;

    // Deterministic Composite Score:
    let score = 0;

    // Positive transaction signals:
    if (dateDensity > 0.05) score += 0.25;
    if (moneyDensity > 0.10) score += 0.25;
    if (sttDensity > 0.03) score += 0.10;
    if (narrativeDensity > 0.05) score += 0.15;
    if (headerTransactionScore >= 0.50) score += 0.30;
    else if (headerTransactionScore > 0.25) score += 0.15;
    if (columnCount >= 5) score += 0.10;
    else if (columnCount >= 4) score += 0.05;
    if (rowCount >= 10) score += 0.15;
    else if (rowCount >= 3) score += 0.08;
    if (areaRatio > 0.6) score += 0.10;

    // Negative metadata/summary signals:
    if (headerMetadataScore > 0.3) score -= 0.35;
    if (columnCount <= 3 && headerMetadataScore > 0) score -= 0.30;
    if (columnCount === 2 && rowCount <= 6) score -= 0.35; // typical 2-column key-value box
    if (rowCount <= 4 && moneyDensity > 0.4 && dateDensity === 0) {
      // Summary balance box (e.g. Opening, Debit Total, Credit Total, Closing)
      score -= 0.30;
    }

    // Clamp score between 0.0 and 1.0
    const finalScore = Math.max(0.0, Math.min(1.0, score));

    let classification: 'TRANSACTION' | 'METADATA' | 'SUMMARY' | 'NOISE' = 'NOISE';
    if (finalScore >= UNIFIED_CONFIG.TRANSACTION_SCORE_THRESHOLD) {
      classification = 'TRANSACTION';
    } else if (headerMetadataScore > 0.2 || (columnCount <= 3 && rowCount <= 8)) {
      classification = 'METADATA';
    } else if (moneyDensity > 0.2 && rowCount <= 5) {
      classification = 'SUMMARY';
    }

    return {
      tableId: table.id,
      pageNumber: table.pageNumber,
      tableIndex: table.tableIndex,
      score: finalScore,
      classification,
      evidence: {
        rowCount,
        columnCount,
        dateDensity,
        moneyDensity,
        sttDensity,
        narrativeDensity,
        headerTransactionScore,
        headerMetadataScore,
        areaRatio,
      },
    };
  }

  /**
   * Group candidate transaction tables by schema compatibility.
   */
  static groupCompatibleTables(tables: any[]): Array<{ tables: any[]; totalRows: number; schemaSignature: string }> {
    const groups: Map<string, any[]> = new Map();

    for (const table of tables) {
      // Group signature based on column count range and semantic similarity
      // Allow minor variations (e.g. 5 vs 6 columns in ACB, or 4 vs 5) to belong to the same group
      const colCount = table.columnCount || (table.headers ? table.headers.length : 0);
      const signature = `cols-${colCount >= 4 ? '4-12' : colCount}`;

      const list = groups.get(signature) || [];
      list.push(table);
      groups.set(signature, list);
    }

    const result = Array.from(groups.entries()).map(([sig, grpTables]) => ({
      schemaSignature: sig,
      tables: grpTables,
      totalRows: grpTables.reduce((sum, t) => sum + (t.rows?.length || 0), 0),
    }));

    // Sort by total rows descending (dominant group first)
    return result.sort((a, b) => b.totalRows - a.totalRows);
  }

  /**
   * Selects canonical table with the highest quality headers/structure in the group.
   * Real case proof: Page 1 of HDBank has empty headers, Page 2 has complete headers.
   * ACB Page 8 has clean 5 headers: Ngay, Dien giai, Ghi no, Ghi co, So du.
   */
  static selectCanonicalTable(tables: any[]): any {
    let bestTable = tables[0];
    let bestScore = -1;

    for (const table of tables) {
      const { headers } = this.findTableHeaderRow(table);
      const nonEmptyHeaders = headers.filter((h: string) => (h || '').trim().length > 0).length;
      const coverage = headers.length > 0 ? nonEmptyHeaders / headers.length : 0;

      // Count recognizable transaction semantic terms in headers
      let semanticCount = 0;
      for (const h of headers) {
        const norm = normalizeVietnameseText(h);
        if (
          norm.includes('ngay') ||
          norm.includes('dien giai') ||
          norm.includes('ghi no') ||
          norm.includes('ghi co') ||
          norm.includes('so du') ||
          norm.includes('stt') ||
          norm.includes('so gd') ||
          norm.includes('chung tu')
        ) {
          semanticCount++;
        }
      }

      // Score based on semantic quality, header coverage, and column count
      let score = semanticCount * 30 + coverage * 20 + (table.columnCount || 0) * 2;

      if (score > bestScore) {
        bestScore = score;
        bestTable = table;
      }
    }

    return bestTable;
  }

  /**
   * Derives canonical column definitions with semantic types.
   */
  static deriveCanonicalColumns(canonicalTable: any, allGroupTables: any[]): UnifiedColumn[] {
    const { headers: initialHeaders } = this.findTableHeaderRow(canonicalTable);
    let headers: string[] = [...initialHeaders];

    // Filter out trailing completely empty strings if any
    while (headers.length > 0 && !headers[headers.length - 1]?.trim()) {
      headers.pop();
    }

    // If canonicalTable has some empty headers, try to backfill from other tables in the same group
    if (headers.some((h) => !h || !h.trim())) {
      for (const other of allGroupTables) {
        if (other.id === canonicalTable.id) continue;
        const { headers: otherHeaders } = this.findTableHeaderRow(other);
        if (otherHeaders.length === headers.length) {
          for (let i = 0; i < headers.length; i++) {
            if (!headers[i] || !headers[i].trim()) {
              if (otherHeaders[i] && otherHeaders[i].trim()) {
                headers[i] = otherHeaders[i].trim();
              }
            }
          }
        }
      }
    }

    // Determine semantic column types
    return headers.map((rawHeader, idx) => {
      const displayHeader = rawHeader && rawHeader.trim() ? rawHeader.trim() : `Cột ${idx + 1}`;
      const normalizedHeader = normalizeVietnameseText(displayHeader);
      const semanticType = this.inferSemanticType(displayHeader, idx, headers.length, canonicalTable, headers);

      return {
        canonicalColumnIndex: idx,
        header: displayHeader,
        normalizedHeader,
        semanticType,
      };
    });
  }

  /**
   * Infer semantic column type combining header semantics, position, and sample data.
   */
  static inferSemanticType(
    header: string,
    columnIndex: number,
    totalColumns: number,
    table: any,
    allHeaders?: string[]
  ): SemanticColumnType {
    const norm = normalizeVietnameseText(header);

    if (norm.includes('stt') || norm === 'no' || norm === '#') {
      return 'STT';
    }
    if (norm.includes('gia tri') || norm.includes('effective') || norm.includes('value date') || norm.includes('ngay hl')) {
      return 'VALUE_DATE';
    }
    if (norm.includes('ngay') || norm.includes('date')) {
      return 'DATE';
    }
    if (
      norm.includes('so gd') ||
      norm.includes('ma gd') ||
      norm.includes('so giao dich') ||
      norm.includes('ma giao dich') ||
      norm.includes('transaction no') ||
      norm.includes('transaction number') ||
      norm.includes('so tham chieu') ||
      norm.includes('reference no') ||
      norm.includes('reference number') ||
      norm.includes('ref') ||
      norm.includes('so chung tu') ||
      norm.includes('so ct') ||
      norm.includes('chung tu') ||
      norm.includes('doc no') ||
      norm.includes('mgd')
    ) {
      return 'REFERENCE';
    }
    if (
      norm.includes('dien giai') ||
      norm.includes('noi dung') ||
      norm.includes('description') ||
      norm.includes('chi tiet') ||
      norm.includes('narrative')
    ) {
      return 'DESCRIPTION';
    }
    if (
      norm.includes('ghi no') ||
      norm.includes('rut ra') ||
      norm.includes('debit') ||
      norm.includes('phat sinh no') ||
      norm.includes('ps no')
    ) {
      return 'DEBIT';
    }
    if (
      norm.includes('ghi co') ||
      norm.includes('gui vao') ||
      norm.includes('credit') ||
      norm.includes('phat sinh co') ||
      norm.includes('ps co')
    ) {
      return 'CREDIT';
    }
    if (norm.includes('so du') || norm.includes('balance')) {
      return 'BALANCE';
    }

    // Check if an explicit balance column already exists elsewhere in this table schema
    const headersList = allHeaders || (Array.isArray(table?.headers) ? table.headers : undefined);
    const hasExplicitBalanceElsewhere = headersList
      ? headersList.some((h: string, idx: number) => {
          if (idx === columnIndex) return false;
          const hNorm = normalizeVietnameseText(h);
          return hNorm.includes('so du') || hNorm.includes('balance');
        })
      : false;

    // Fallback based on typical position heuristics:
    if (columnIndex === 0 && (norm.includes('stt') || totalColumns >= 7)) {
      return 'STT';
    }
    if (columnIndex === totalColumns - 1 && totalColumns >= 5 && !hasExplicitBalanceElsewhere) {
      return 'BALANCE';
    }

    return 'OTHER';
  }

  /**
   * Maps source columns of a physical table to canonical columns.
   * Handles 5-vs-6 column variations (e.g. ACB) without index shifting.
   */
  static mapSourceColumnsToCanonical(table: any, canonicalColumns: UnifiedColumn[]): number[] {
    const sourceHeaders: string[] = table.headers || [];
    const sourceColCount = Math.max(table.columnCount || 0, sourceHeaders.length);

    const mapping: number[] = new Array(sourceColCount).fill(-1);
    const assignedCanonical = new Set<number>();

    // Pass 1: Match by exact normalized header similarity
    for (let sIdx = 0; sIdx < sourceHeaders.length; sIdx++) {
      const sNorm = normalizeVietnameseText(sourceHeaders[sIdx]);
      if (!sNorm) continue;

      for (let cIdx = 0; cIdx < canonicalColumns.length; cIdx++) {
        if (assignedCanonical.has(cIdx)) continue;
        const cNorm = canonicalColumns[cIdx].normalizedHeader;

        if (sNorm === cNorm || (sNorm.length > 3 && (sNorm.includes(cNorm) || cNorm.includes(sNorm)))) {
          mapping[sIdx] = cIdx;
          assignedCanonical.add(cIdx);
          break;
        }
      }
    }

    // Pass 2: Match by Semantic Column Type for unmapped columns
    for (let sIdx = 0; sIdx < sourceColCount; sIdx++) {
      if (mapping[sIdx] !== -1) continue;

      const sHeader = sourceHeaders[sIdx] || '';
      const sType = this.inferSemanticType(sHeader, sIdx, sourceColCount, table, sourceHeaders);

      if (sType !== 'OTHER') {
        for (let cIdx = 0; cIdx < canonicalColumns.length; cIdx++) {
          if (assignedCanonical.has(cIdx)) continue;
          if (canonicalColumns[cIdx].semanticType === sType) {
            mapping[sIdx] = cIdx;
            assignedCanonical.add(cIdx);
            break;
          }
        }
      }
    }

    // Pass 3: Match remaining unmapped columns preserving relative order
    let lastAssignedCanonical = -1;
    for (let sIdx = 0; sIdx < sourceColCount; sIdx++) {
      if (mapping[sIdx] !== -1) {
        lastAssignedCanonical = mapping[sIdx];
        continue;
      }

      // Find next available canonical slot after lastAssignedCanonical
      for (let cIdx = lastAssignedCanonical + 1; cIdx < canonicalColumns.length; cIdx++) {
        if (!assignedCanonical.has(cIdx)) {
          mapping[sIdx] = cIdx;
          assignedCanonical.add(cIdx);
          lastAssignedCanonical = cIdx;
          break;
        }
      }
    }

    return mapping;
  }

  /**
   * Generic repeated header detection.
   * Checks if row values match canonical headers or typical transaction header keywords.
   */
  static isRepeatedHeaderRow(rowValues: string[], canonicalColumns: UnifiedColumn[]): boolean {
    if (!rowValues || rowValues.length === 0) return false;

    let headerMatchCount = 0;
    let nonBlankCount = 0;

    for (let i = 0; i < rowValues.length; i++) {
      const val = (rowValues[i] || '').trim();
      if (!val) continue;
      nonBlankCount++;

      const valNorm = normalizeVietnameseText(val);

      // Check against canonical header
      const canCol = canonicalColumns[i];
      if (canCol && valNorm === canCol.normalizedHeader) {
        headerMatchCount++;
        continue;
      }

      // Check against common header keywords
      if (
        valNorm === 'ngay gd' ||
        valNorm === 'ngay' ||
        valNorm === 'date' ||
        valNorm === 'booking date' ||
        valNorm === 'dien giai' ||
        valNorm === 'noi dung' ||
        valNorm === 'description' ||
        valNorm === 'rut ra' ||
        valNorm === 'gui vao' ||
        valNorm === 'debit' ||
        valNorm === 'credit' ||
        valNorm === 'ghi no' ||
        valNorm === 'ghi co' ||
        valNorm === 'so du' ||
        valNorm === 'balance' ||
        valNorm === 'stt' ||
        valNorm === 'ref' ||
        valNorm === 'so ct' ||
        valNorm === 'so gd' ||
        valNorm === 'tra lai' ||
        valNorm === 'nv' ||
        valNorm === 'gdv'
      ) {
        headerMatchCount++;
      }
    }

    if (nonBlankCount === 0) return false;

    // If >= 40% of non-blank cells in this row resemble column headers
    return headerMatchCount / nonBlankCount >= UNIFIED_CONFIG.REPEATED_HEADER_SIMILARITY_THRESHOLD;
  }

  /**
   * Detects summary/footer rows (e.g. "Tổng phát sinh", "Số dư cuối kỳ", "Total").
   */
  static detectSummaryRow(rowValues: string[], canonicalColumns: UnifiedColumn[]): { isSummary: boolean; reason: string } {
    if (!rowValues || rowValues.length === 0) {
      return { isSummary: false, reason: '' };
    }

    const rowText = rowValues.join(' ');
    if (UNIFIED_CONFIG.SUMMARY_LABEL_REGEX.test(rowText)) {
      // Confirm this is not a regular transaction whose description just happens to contain 'tổng'
      // A summary row rarely has a valid date in its DATE column
      const dateColIdx = canonicalColumns.findIndex((c) => c.semanticType === 'DATE');
      if (dateColIdx !== -1 && rowValues[dateColIdx]) {
        const dateVal = rowValues[dateColIdx].trim();
        if (UNIFIED_CONFIG.DATE_REGEX.test(dateVal)) {
          // Has valid transaction date -> regular transaction
          return { isSummary: false, reason: '' };
        }
      }

      return {
        isSummary: true,
        reason: 'Matched summary/footer pattern (Tổng/Total/Số dư cuối)',
      };
    }

    return { isSummary: false, reason: '' };
  }
}
