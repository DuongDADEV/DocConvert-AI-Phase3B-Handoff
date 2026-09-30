import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { OCRExtractedTable, OCRExtractedRow, OCRExtractedCell, OCRLine } from '../ocr/types.js';
import { DataNormalizer } from '../ocr/normalizer.js';
import type { LocalPageExtraction } from './types.js';

export class LocalPdfExtractor {
  /**
   * Loads a PDF document from a buffer using pdfjs-dist.
   */
  async loadPdfDocument(fileBuffer: Buffer): Promise<any> {
    const data = new Uint8Array(fileBuffer);
    const loadingTask = (pdfjsLib as any).getDocument({
      data,
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
    });
    return await loadingTask.promise;
  }

  /**
   * Extracts text, lines, coordinates, and basic layout structure for an individual page.
   */
  async extractPage(
    pdfDocOrBuffer: any,
    pageNumber: number,
    options?: { outputType?: string }
  ): Promise<LocalPageExtraction> {
    const pdfDoc = Buffer.isBuffer(pdfDocOrBuffer)
      ? await this.loadPdfDocument(pdfDocOrBuffer)
      : pdfDocOrBuffer;

    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();

    const rawItems: Array<{
      text: string;
      transform: number[];
      width: number;
      height: number;
      x: number;
      y: number;
    }> = [];

    const linesMap = new Map<number, Array<{ text: string; x: number; width: number; height: number }>>();
    const textStrings: string[] = [];

    for (const item of textContent.items) {
      if (!item.str || item.str.trim().length === 0) continue;
      const str = item.str.trim();
      textStrings.push(str);

      const tx = item.transform[4];
      const ty = item.transform[5];
      const itemHeight = Math.max(item.height || 0, Math.abs(item.transform[3]) || 10);
      const itemWidth = Math.max(item.width || 0, str.length * (itemHeight * 0.5));

      rawItems.push({
        text: str,
        transform: item.transform,
        width: itemWidth,
        height: itemHeight,
        x: tx,
        y: ty,
      });

      // Cluster into lines by rounded Y coordinate (tolerance = itemHeight * 0.5)
      let foundLineY: number | null = null;
      for (const lineY of linesMap.keys()) {
        if (Math.abs(ty - lineY) <= Math.max(4, itemHeight * 0.5)) {
          foundLineY = lineY;
          break;
        }
      }

      const targetY = foundLineY ?? ty;
      const lineItems = linesMap.get(targetY) || [];
      lineItems.push({ text: str, x: tx, width: itemWidth, height: itemHeight });
      linesMap.set(targetY, lineItems);
    }

    // Sort lines from top of page to bottom (in PDF, Y=0 is bottom, so descending Y)
    const sortedLineYs = Array.from(linesMap.keys()).sort((a, b) => b - a);

    const lines: OCRLine[] = [];
    const formattedLineTexts: string[] = [];

    for (const y of sortedLineYs) {
      const itemsInLine = linesMap.get(y)!;
      // Sort left to right
      itemsInLine.sort((a, b) => a.x - b.x);
      const lineStr = itemsInLine.map((i) => i.text).join(' ');
      formattedLineTexts.push(lineStr);

      const minX = itemsInLine[0].x;
      const lastItem = itemsInLine[itemsInLine.length - 1];
      const maxX = lastItem.x + lastItem.width;
      const maxY = y + (itemsInLine[0].height || 10);

      lines.push({
        content: lineStr,
        polygon: [minX, y, maxX, y, maxX, maxY, minX, maxY],
      });
    }

    const rawText = formattedLineTexts.join('\n');
    const charCount = rawItems.reduce((acc, it) => acc + it.text.length, 0);
    const blockCount = lines.length;

    // Structure Sufficiency & Table Extraction
    const { tables, isSufficient, requiresFallback, reason } = this.evaluateStructureAndExtractTables(
      rawItems,
      linesMap,
      sortedLineYs,
      pageNumber,
      options?.outputType || 'EXCEL'
    );

    return {
      pageNumber,
      rawText,
      charCount,
      blockCount,
      items: rawItems,
      lines,
      tables,
      structureSufficient: isSufficient,
      structureRequiresFallback: requiresFallback,
      structureReason: reason,
      coordinateSystem: {
        unit: 'point',
        scale: 1.0,
      },
    };
  }

  /**
   * Deterministic evaluation of layout sufficiency for requested output type (EXCEL).
   */
  private evaluateStructureAndExtractTables(
    items: Array<{ text: string; x: number; y: number; width: number; height: number }>,
    linesMap: Map<number, Array<{ text: string; x: number; width: number; height: number }>>,
    sortedLineYs: number[],
    pageNumber: number,
    outputType: string
  ): {
    tables: OCRExtractedTable[];
    isSufficient: boolean;
    requiresFallback: boolean;
    reason?: string;
  } {
    // If output is not EXCEL, plain text is sufficient
    if (outputType !== 'EXCEL') {
      return {
        tables: [],
        isSufficient: true,
        requiresFallback: false,
      };
    }

    // Detect grid-like multi-column rows (lines containing >= 3 spaced items or distinct tab stops)
    const multiColumnLines: Array<{ y: number; items: Array<{ text: string; x: number; width: number }> }> = [];

    for (const y of sortedLineYs) {
      const lineItems = linesMap.get(y)!;
      if (lineItems.length >= 2) {
        multiColumnLines.push({ y, items: lineItems });
      }
    }

    // For EXCEL output, if we have fewer than 2 multi-column rows or very sparse content:
    // It is unstructured prose or layout requiring Azure layout table detection.
    if (multiColumnLines.length < 2) {
      return {
        tables: [],
        isSufficient: false,
        requiresFallback: true,
        reason:
          'Trang văn bản tự nhiên không có lưới cột/dòng xác định cho định dạng Excel; kích hoạt fallback Azure để trích xuất bảng chính xác.',
      };
    }

    // Try to form a structured table if column positions align cleanly
    // Group adjacent multi-column lines into table candidates
    const tableRows: OCRExtractedRow[] = [];
    let maxColumns = 0;

    multiColumnLines.forEach((mLine, rowIndex) => {
      maxColumns = Math.max(maxColumns, mLine.items.length);
      const cells: OCRExtractedCell[] = mLine.items.map((it, colIndex) => {
        const normalized = DataNormalizer.normalizeCell(it.text);
        return {
          rowIndex,
          columnIndex: colIndex,
          rowSpan: 1,
          columnSpan: 1,
          rawValue: it.text,
          normalizedValue: normalized.normalizedValue,
          cellType: normalized.cellType,
          confidence: null, // Digital native text has no optical OCR probability
          confidenceSource: 'LOCAL_HEURISTIC',
          structureConfidence: 0.95,
          coordinateUnit: 'point',
          kind: rowIndex === 0 ? 'columnHeader' : 'content',
          boundingPolygon: [it.x, mLine.y, it.x + it.width, mLine.y, it.x + it.width, mLine.y + 10, it.x, mLine.y + 10],
        };
      });

      tableRows.push({
        rowIndex,
        isHeader: rowIndex === 0,
        cells,
      });
    });

    // If table has at least 2 rows and 2 columns
    if (tableRows.length >= 2 && maxColumns >= 2) {
      const extractedTable: OCRExtractedTable = {
        pageNumber,
        tableIndex: 0,
        rowCount: tableRows.length,
        columnCount: maxColumns,
        confidence: null, // Native digital table has no optical OCR score
        structureConfidence: 0.95,
        coordinateUnit: 'point',
        rows: tableRows,
        headers: tableRows[0]?.cells.map((c) => c.rawValue) || [],
      };

      return {
        tables: [extractedTable],
        isSufficient: true,
        requiresFallback: false,
      };
    }

    return {
      tables: [],
      isSufficient: false,
      requiresFallback: true,
      reason:
        'Cấu trúc bảng cục bộ không đạt tiêu chuẩn lưới bảng tính tối thiểu; chuyển tiếp sang Azure Document Intelligence.',
    };
  }
}

export const localPdfExtractor = new LocalPdfExtractor();
