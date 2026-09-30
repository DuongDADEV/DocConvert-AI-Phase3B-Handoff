import crypto from 'crypto';
import { getSupabaseAdminClient } from '../supabaseClient.js';
import type {
  SecondaryOcrBudget,
  SecondaryOcrContext,
  SecondaryOcrProvider,
} from './types.js';
import { PageRenderer } from './PageRenderer.js';
import { RegionExtractor } from './RegionExtractor.js';
import { AzureSnippetSecondaryOcrProvider } from './SecondaryOcrProvider.js';
import { ConflictResolutionEngine } from './ConflictResolutionEngine.js';
import { CandidateRevalidator } from './CandidateRevalidator.js';

export interface SecondaryOcrCoordinatorOptions {
  budget?: SecondaryOcrBudget;
  provider?: SecondaryOcrProvider;
}

export class SecondaryOcrCoordinator {
  private pageRenderer = new PageRenderer();
  private regionExtractor = new RegionExtractor();
  private provider: SecondaryOcrProvider;
  private resolutionEngine = new ConflictResolutionEngine();
  private budget: SecondaryOcrBudget;

  constructor(options?: SecondaryOcrCoordinatorOptions) {
    this.provider = options?.provider || new AzureSnippetSecondaryOcrProvider();
    this.budget = options?.budget || {
      maxCellsPerDocument: 20,
      maxAttemptsPerCell: 2,
    };
  }

  /**
   * Runs targeted secondary OCR and conflict resolution for eligible cells in a document.
   */
  async processDocumentCells(
    userId: string,
    documentId: string,
    fileBuffer: Buffer,
    mimeType: string
  ): Promise<{
    processedCount: number;
    resolvedCount: number;
    unresolvedCount: number;
  }> {
    const supabase = getSupabaseAdminClient();

    // 1. Fetch cells that strictly require secondary OCR from Supabase
    const { data: targetCells, error: fetchErr } = await supabase
      .from('extracted_cells')
      .select(`
        id, row_id, column_index, raw_value, original_raw_value, normalized_value,
        confidence_score, confidence_source, validation_status, validation_issues,
        bounding_box, requires_secondary_ocr, cell_type,
        extracted_rows!inner (
          id, row_index, table_id, is_header,
          extracted_tables!inner (
            id, page_number, table_index, document_id
          )
        )
      `)
      .eq('extracted_rows.extracted_tables.document_id', documentId)
      .eq('requires_secondary_ocr', true)
      .limit(this.budget.maxCellsPerDocument);

    if (fetchErr) {
      console.error(`[SecondaryOcrCoordinator] Failed to fetch target cells for doc ${documentId}:`, fetchErr.message);
      throw fetchErr;
    }

    if (!targetCells || targetCells.length === 0) {
      console.log(`[SecondaryOcrCoordinator] No cells require secondary OCR for doc ${documentId}.`);
      return { processedCount: 0, resolvedCount: 0, unresolvedCount: 0 };
    }

    console.log(
      `[SecondaryOcrCoordinator] Found ${targetCells.length} cells requiring secondary OCR for doc ${documentId} (budget: ${this.budget.maxCellsPerDocument}).`
    );

    let processedCount = 0;
    let resolvedCount = 0;
    let unresolvedCount = 0;

    for (const cell of targetCells) {
      try {
        const table = (cell.extracted_rows as any).extracted_tables;
        const pageNumber = table.page_number || 1;
        const boundingBox = cell.bounding_box;

        if (!boundingBox) {
          console.warn(`[SecondaryOcrCoordinator] Skipping cell ${cell.id}: missing bounding_box`);
          continue;
        }

        const cellContext: SecondaryOcrContext = {
          cellId: cell.id,
          documentId,
          pageNumber,
          rowIndex: (cell.extracted_rows as any).row_index,
          columnIndex: cell.column_index,
          expectedDataType: cell.cell_type,
          originalRawValue: cell.original_raw_value || cell.raw_value || '',
          previousIssues: cell.validation_issues || [],
        };

        // 2. Render Page at standard DPI (150)
        const renderedPage = await this.pageRenderer.renderPage(documentId, fileBuffer, mimeType, {
          pageNumber,
          dpi: 150,
        });

        // 3. Extract snippet (original)
        const snippetOriginal = await this.regionExtractor.extractRegion(
          cell.id,
          renderedPage,
          boundingBox,
          { variant: 'original', paddingPx: 6 }
        );

        // 4. Run secondary OCR attempt 1
        const candidateBResult = await this.provider.recognizeRegion(snippetOriginal, cellContext);

        // 5. Check if enhanced retry is needed (if attempt 1 failed or invalid)
        let candidateBEnhancedResult = null;
        const revalAttempt1 = CandidateRevalidator.revalidate(
          candidateBResult.rawValue,
          cell.cell_type,
          candidateBResult.confidenceScore,
          candidateBResult.confidenceSource
        );

        if (!revalAttempt1.isValid && this.budget.maxAttemptsPerCell >= 2) {
          console.log(`[SecondaryOcrCoordinator] Triggering enhanced retry for cell ${cell.id}...`);
          const snippetEnhanced = await this.regionExtractor.extractRegion(
            cell.id,
            renderedPage,
            boundingBox,
            { variant: 'enhanced_contrast', paddingPx: 8 }
          );
          candidateBEnhancedResult = await this.provider.recognizeRegion(snippetEnhanced, cellContext);
        }

        // 6. Resolve conflict
        const decision = await this.resolutionEngine.resolve({
          candidateA: {
            source: 'AZURE_PRIMARY',
            rawValue: cell.raw_value || '',
            normalizedValue: cell.normalized_value,
            confidenceScore: cell.confidence_score,
            validationStatus: cell.validation_status,
            issues: cell.validation_issues || [],
          },
          candidateB: candidateBResult,
          candidateBEnhanced: candidateBEnhancedResult,
          cellType: cell.cell_type,
          context: cellContext,
          snippet: snippetOriginal,
        });

        // 7. Persist atomically via resolve_extraction_cell_atomic RPC
        const candidateBId = crypto.randomUUID();
        const candBKey = `${cell.id}_attempt_1_${snippetOriginal.variant}`;
        const resolutionEventKey = `${cell.id}_res_${Date.now()}`;

        // Revalidate final value for cell updates
        const finalReval = CandidateRevalidator.revalidate(
          decision.finalRawValue,
          cell.cell_type,
          decision.semanticConfidence || candidateBResult.confidenceScore,
          decision.resolutionMethod === 'GEMINI' ? 'GEMINI' : 'SECONDARY_OCR'
        );

        const { data: rpcRes, error: rpcErr } = await supabase.rpc('resolve_extraction_cell_atomic', {
          p_document_id: documentId,
          p_user_id: userId,
          p_cell_id: cell.id,
          p_candidate: {
            id: candidateBId,
            candidate_source: decision.resolutionMethod === 'SECONDARY_OCR_ENHANCED' ? 'SECONDARY_OCR_ENHANCED' : 'SECONDARY_OCR',
            raw_value: candidateBResult.rawValue,
            normalized_value: revalAttempt1.normalizedValue,
            confidence_score: candidateBResult.confidenceScore,
            confidence_source: candidateBResult.confidenceSource || 'AZURE_MODEL',
            provider: candidateBResult.provider,
            provider_version: candidateBResult.providerVersion,
            attempt_number: 1,
            attempt_status: candidateBResult.attemptStatus,
            preprocessing_variant: snippetOriginal.variant,
            validation_status: revalAttempt1.validationStatus,
            validation_issues: revalAttempt1.issues,
            idempotency_key: candBKey,
          },
          p_resolution: {
            resolution_event_key: resolutionEventKey,
            selected_candidate_id: decision.resolutionStatus === 'RESOLVED' ? candidateBId : null,
            resolution_status: decision.resolutionStatus,
            resolution_method: decision.resolutionMethod,
            reason_code: decision.reasonCode,
            reason_message: decision.reasonMessage,
            semantic_decision: decision.semanticDecision || null,
            semantic_confidence: decision.semanticConfidence || null,
          },
          p_cell_updates: {
            raw_value: decision.finalRawValue,
            normalized_value: decision.finalNormalizedValue,
            validation_status: decision.finalValidationStatus,
            validation_issues: finalReval.issues,
            requires_secondary_ocr: decision.finalValidationStatus === 'REVIEW_REQUIRED',
            confidence_score: decision.semanticConfidence || candidateBResult.confidenceScore,
            confidence_source: decision.resolutionMethod === 'GEMINI' ? 'LOCAL_HEURISTIC' : (candidateBResult.confidenceSource || 'AZURE_MODEL'),
          },
        });

        if (rpcErr) {
          console.error(`[SecondaryOcrCoordinator] Failed to persist resolution for cell ${cell.id}:`, rpcErr.message);
          throw rpcErr;
        }

        processedCount++;
        if (decision.resolutionStatus === 'RESOLVED') {
          resolvedCount++;
        } else {
          unresolvedCount++;
        }
      } catch (cellErr: any) {
        console.error(`[SecondaryOcrCoordinator] Error processing cell ${cell.id}:`, cellErr.message || cellErr);
      }
    }

    // Clean cache for this document
    this.pageRenderer.clearCache(documentId);

    return { processedCount, resolvedCount, unresolvedCount };
  }
}
