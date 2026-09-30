import { OCRAnalysisResult, OCRExtractedTable, OCRExtractedCell } from '../ocr/types.js';
import {
  DocumentValidationReport,
  TableValidationResult,
  CellValidationResult,
  ValidationIssue,
  ValidationStatus,
  VALIDATION_VERSION,
  ValidationSchemaContract,
} from './types.js';
import { ConfidenceValidator } from './validators/confidenceValidator.js';
import { DatatypeValidator } from './validators/datatypeValidator.js';
import { StructuralValidator } from './validators/structuralValidator.js';
import { LogicalValidator } from './validators/logicalValidator.js';

export class ValidationEngine {
  /**
   * Main deterministic validation entry point.
   * Evaluates OCR/Local extraction results BEFORE persistence or review.
   *
   * Crucial guarantees:
   * 1. NEVER mutates rawValue.
   * 2. NEVER makes external API calls (No LLM, No Gemini, No OCR calls).
   * 3. Distinct handling for Local Native (confidence=null) vs Azure model confidence.
   */
  public static validate(
    documentId: string,
    analysis: OCRAnalysisResult,
    schema?: ValidationSchemaContract
  ): DocumentValidationReport {
    console.log(`[VALIDATION_STARTED] doc: ${documentId}, tables: ${analysis.tables?.length || 0}, pages: ${analysis.pages?.length || 0}`);

    const tableResults: TableValidationResult[] = [];
    let acceptedCount = 0;
    let warningCount = 0;
    let reviewRequiredCount = 0;

    for (const table of analysis.tables || []) {
      const cellResults: CellValidationResult[] = [];
      const tableIssues: ValidationIssue[] = [];

      // 1. Table-level structural validation
      const structuralIssues = StructuralValidator.validateTable(table as any);
      tableIssues.push(...structuralIssues);

      // 2. Cell-level validations
      for (const row of table.rows || []) {
        for (const cell of row.cells || []) {
          const cellIssues: ValidationIssue[] = [];

          const cellConf = cell.confidence;
          const cellSource = (cell as any).confidenceSource || (table as any).confidenceSource || (cellConf != null ? 'AZURE_MODEL' : 'LOCAL_HEURISTIC');
          const structConf = (cell as any).structureConfidence ?? (table as any).structureConfidence;

          // A. Confidence & Source validation
          const confIssues = ConfidenceValidator.validateCell(cellConf, cellSource, structConf);
          cellIssues.push(...confIssues);

          // B. Datatype & Format validation
          const typeIssues = DatatypeValidator.validate(cell.cellType, cell.rawValue, cell.normalizedValue);
          cellIssues.push(...typeIssues);

          // C. Logical & Schema validation
          const schemaCol = schema?.columns?.find((c) => c.columnIndex === cell.columnIndex);
          const logicIssues = LogicalValidator.validate(cell.rawValue, cell.cellType, schemaCol);
          cellIssues.push(...logicIssues);

          // Resolve cell status
          let cellStatus: ValidationStatus = 'ACCEPTED';
          if (cellIssues.some((i) => i.severity === 'ERROR')) {
            cellStatus = 'REVIEW_REQUIRED';
          } else if (cellIssues.some((i) => i.severity === 'WARNING')) {
            cellStatus = 'WARNING';
          }

          const requiresSecondary = cellIssues.some((i) => i.requiresSecondaryOcr);

          if (cellStatus === 'ACCEPTED') acceptedCount++;
          else if (cellStatus === 'WARNING') warningCount++;
          else if (cellStatus === 'REVIEW_REQUIRED') reviewRequiredCount++;

          const cellValidation: CellValidationResult = {
            cellId: (cell as any).id,
            tableId: (table as any).id,
            rowIndex: row.rowIndex,
            columnIndex: cell.columnIndex,
            pageNumber: table.pageNumber,
            rawValue: cell.rawValue,
            normalizedValue: cell.normalizedValue,
            cellType: cell.cellType,
            status: cellStatus,
            issues: cellIssues,
            confidence: cellConf,
            confidenceSource: cellSource,
            structureConfidence: structConf,
            requiresSecondaryOcr: requiresSecondary,
            boundingPolygon: cell.boundingPolygon,
            coordinateUnit: (cell as any).coordinateUnit || 'point',
          };

          // Attach validation result to cell in-memory for downstream consumers
          (cell as any).validationStatus = cellStatus;
          (cell as any).validationIssues = cellIssues;
          (cell as any).requiresSecondaryOcr = requiresSecondary;

          cellResults.push(cellValidation);
        }
      }

      // Determine Table status
      let tableStatus: ValidationStatus = 'ACCEPTED';
      if (tableIssues.some((i) => i.severity === 'ERROR') || cellResults.some((c) => c.status === 'REVIEW_REQUIRED')) {
        tableStatus = 'REVIEW_REQUIRED';
      } else if (tableIssues.some((i) => i.severity === 'WARNING') || cellResults.some((c) => c.status === 'WARNING')) {
        tableStatus = 'WARNING';
      }

      tableResults.push({
        tableId: (table as any).id,
        pageNumber: table.pageNumber,
        tableIndex: table.tableIndex,
        status: tableStatus,
        issues: tableIssues,
        rowCount: table.rowCount,
        columnCount: table.columnCount,
        confidence: table.confidence,
        confidenceSource: (table as any).confidenceSource,
        structureConfidence: (table as any).structureConfidence,
        cellResults,
      });
    }

    // Determine final Document status based on Validation, NOT simplistic table-count hacks
    const hasBlockingIssues = reviewRequiredCount > 0 || tableResults.some((t) => t.issues.some((i) => i.severity === 'ERROR'));
    const finalDocStatus: ValidationStatus = hasBlockingIssues ? 'REVIEW_REQUIRED' : 'READY';

    const report: DocumentValidationReport = {
      documentId,
      status: finalDocStatus,
      acceptedCount,
      warningCount,
      reviewRequiredCount,
      validationVersion: VALIDATION_VERSION,
      tables: tableResults,
      metadataIssues: [],
      createdAt: new Date().toISOString(),
    };

    console.log(
      `[VALIDATION_COMPLETED] doc: ${documentId}, accepted: ${acceptedCount}, warning: ${warningCount}, reviewRequired: ${reviewRequiredCount}, status: ${finalDocStatus}`
    );

    return report;
  }
}
