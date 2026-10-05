import type { DocumentAIProvider, OCRAnalysisResult, OCRExtractedTable, OCRPage, OCRMetadataObservation } from '../ocr/types.js';
import { azureOcrProvider } from '../ocr/AzureDocumentIntelligenceProvider.js';
import { MetadataFilterEngine } from '../ocr/metadataFilterEngine.js';
import { localPdfExtractor } from './LocalPdfExtractor.js';
import { pagePdfExtractor } from './PagePdfExtractor.js';
import type { DocumentProcessingPlan, PageExtractionResult, ProcessingStrategy } from './types.js';
import {
  CANONICAL_PROCESSING_PRICING_VERSION,
  CANONICAL_TELEMETRY_VERSION,
  type ProcessingPageTechnicalTelemetry,
  type ProcessingTechnicalUsage,
} from '../../types/processingPricing.js';

export class ProcessingExecutor {
  private azureProvider: DocumentAIProvider;
  public azurePagesAttempted = 0;
  public azurePagesSucceeded = 0;

  constructor(azureProvider?: DocumentAIProvider) {
    this.azureProvider = azureProvider || azureOcrProvider;
  }

  getAzureProgress(): { attempted: number; succeeded: number } {
    return {
      attempted: this.azurePagesAttempted,
      succeeded: this.azurePagesSucceeded,
    };
  }

  /**
   * Executes the DocumentProcessingPlan page by page.
   * Separates native local extraction from Azure Document Intelligence OCR.
   * Remaps all isolated sub-page executions back to original 1-based page numbers.
   */
  async executePlan(
    documentId: string,
    userId: string,
    fileBuffer: Buffer,
    mimeType: string,
    plan: DocumentProcessingPlan,
    options?: { outputType?: string }
  ): Promise<OCRAnalysisResult> {
    const isPdf = mimeType === 'application/pdf' || fileBuffer.subarray(0, 4).toString() === '%PDF';
    const outputType = options?.outputType || 'EXCEL';

    const pageResults: PageExtractionResult[] = [];
    const pagesForAzure: number[] = [];
    const azureStrategyMap = new Map<number, ProcessingStrategy>();
    const fallbackReasonMap = new Map<number, string>();
    const decisionMap = new Map<number, any>();

    for (const dec of plan.decisions) {
      decisionMap.set(dec.pageNumber, dec);
    }

    // Reset progress tracking for this execution
    this.azurePagesAttempted = 0;
    this.azurePagesSucceeded = 0;

    // 1. Process LOCAL_NATIVE candidates first
    let pdfDocObj: any = null;
    if (isPdf) {
      try {
        pdfDocObj = await localPdfExtractor.loadPdfDocument(fileBuffer);
      } catch (err: any) {
        console.warn(`[ProcessingExecutor] Could not load PDF in pdfjs-dist for doc ${documentId}:`, err.message);
      }
    }

    for (const dec of plan.decisions) {
      const pageNum = dec.pageNumber;

      if (dec.preferredStrategy === 'LOCAL_NATIVE' && pdfDocObj) {
        console.log(`[LOCAL_EXTRACTION_STARTED] doc: ${documentId}, page: ${pageNum}`);
        try {
          const localExt = await localPdfExtractor.extractPage(pdfDocObj, pageNum, { outputType });

          if (localExt.structureRequiresFallback) {
            const reason = localExt.structureReason || 'Structure insufficient';
            console.log(
              `[AZURE_FALLBACK_TRIGGERED] doc: ${documentId}, page: ${pageNum}, reason: "${reason}"`
            );
            pagesForAzure.push(pageNum);
            azureStrategyMap.set(pageNum, 'AZURE_FALLBACK');
            fallbackReasonMap.set(pageNum, reason);
          } else {
            console.log(`[LOCAL_EXTRACTION_COMPLETED] doc: ${documentId}, page: ${pageNum}, textLen: ${localExt.rawText.length}`);
            
            let telemetry: ProcessingPageTechnicalTelemetry | undefined;
            try {
              telemetry = {
                telemetryVersion: CANONICAL_TELEMETRY_VERSION,
                pageNumber: pageNum,
                plannedStrategy: 'LOCAL_NATIVE',
                billableStrategy: 'LOCAL_NATIVE',
                executedStrategy: 'LOCAL_NATIVE',
                azureCalled: false,
                fallbackOccurred: false,
                regionAnalysisExecuted: Boolean(dec.requiresRegionAnalysis),
                outputType,
                processingDecisionVersion: dec.decisionVersion || plan.decisionVersion || 'pde-v1.0.0',
                processingPricingVersion: CANONICAL_PROCESSING_PRICING_VERSION,
              };
            } catch (telErr: any) {
              console.warn(`[TELEMETRY_PERSISTENCE_WARNING] Failed creating telemetry for doc ${documentId} page ${pageNum}:`, telErr?.message || telErr);
            }

            pageResults.push({
              pageNumber: pageNum,
              strategyUsed: 'LOCAL_NATIVE',
              source: 'LOCAL',
              text: localExt.rawText,
              confidence: null, // Honest: native digital text has no optical OCR probability score
              lines: localExt.lines,
              tables: localExt.tables,
              coordinateSystem: localExt.coordinateSystem,
              telemetry,
            });
          }
        } catch (localErr: any) {
          const reason = localErr.message || 'Local extraction runtime error';
          console.warn(`[AZURE_FALLBACK_TRIGGERED] doc: ${documentId}, page: ${pageNum}, local error: ${reason}`);
          pagesForAzure.push(pageNum);
          azureStrategyMap.set(pageNum, 'AZURE_FALLBACK');
          fallbackReasonMap.set(pageNum, reason);
        }
      } else {
        // SCANNED, HYBRID, LOCAL_RECHECK (resolved to Azure), etc.
        pagesForAzure.push(pageNum);
        azureStrategyMap.set(pageNum, dec.preferredStrategy);
      }
    }

    // Sort pages for Azure in ascending order
    pagesForAzure.sort((a, b) => a - b);

    // 2. Process Azure Pages (if any required)
    if (pagesForAzure.length > 0) {
      console.log(`[AZURE_PAGE_STARTED] doc: ${documentId}, count: ${pagesForAzure.length}, pages: [${pagesForAzure.join(', ')}]`);
      this.azurePagesAttempted = pagesForAzure.length;

      let azureAnalysis: OCRAnalysisResult;

      try {
        if (pagesForAzure.length === plan.totalPages || !isPdf) {
          // Send entire file buffer directly to Azure
          azureAnalysis = await this.azureProvider.analyzeDocument(fileBuffer, mimeType, {
            modelId: 'prebuilt-layout',
          });

          this.azurePagesSucceeded = pagesForAzure.length;

          // Filter and collect results only for the requested pages (or all if whole doc)
          azureAnalysis.pages.forEach((p) => {
            if (pagesForAzure.includes(p.pageNumber)) {
              const strat = azureStrategyMap.get(p.pageNumber) || 'AZURE_FULL_PAGE';
              const isFallback = strat === 'AZURE_FALLBACK';
              const dec = decisionMap.get(p.pageNumber);
              const pageTables = azureAnalysis.tables.filter((t) => t.pageNumber === p.pageNumber);
              const pageObs = azureAnalysis.rawMetadataObservations?.filter((o) => o.sourcePage === p.pageNumber);

              let telemetry: ProcessingPageTechnicalTelemetry | undefined;
              try {
                telemetry = {
                  telemetryVersion: CANONICAL_TELEMETRY_VERSION,
                  pageNumber: p.pageNumber,
                  plannedStrategy: dec?.preferredStrategy || (isFallback ? 'LOCAL_NATIVE' : strat),
                  billableStrategy: isFallback ? 'LOCAL_NATIVE' : (dec?.preferredStrategy || strat),
                  executedStrategy: isFallback ? 'AZURE_FALLBACK' : strat,
                  azureCalled: true,
                  fallbackOccurred: isFallback,
                  fallbackReason: isFallback ? fallbackReasonMap.get(p.pageNumber) : undefined,
                  regionAnalysisExecuted: Boolean(dec?.requiresRegionAnalysis) || strat === 'HYBRID',
                  outputType,
                  processingDecisionVersion: dec?.decisionVersion || plan.decisionVersion || 'pde-v1.0.0',
                  processingPricingVersion: CANONICAL_PROCESSING_PRICING_VERSION,
                };
              } catch (telErr: any) {
                console.warn(`[TELEMETRY_PERSISTENCE_WARNING] Failed creating Azure telemetry for doc ${documentId} page ${p.pageNumber}:`, telErr?.message || telErr);
              }

              pageResults.push({
                pageNumber: p.pageNumber,
                strategyUsed: strat,
                source: isFallback ? 'AZURE_FALLBACK' : strat === 'HYBRID' ? 'HYBRID' : 'AZURE',
                text: p.rawText || '',
                confidence: p.confidence ?? azureAnalysis.overallConfidence,
                lines: p.lines,
                tables: pageTables,
                rawMetadataObservations: pageObs,
                coordinateSystem: {
                  unit: (p.unit as any) || 'inch',
                },
                telemetry,
              });
            }
          });
        } else {
          // Selective Page Extraction: create a sub-PDF containing ONLY the required pages!
          const subPdfBuffer = await pagePdfExtractor.createSubPdf(fileBuffer, pagesForAzure);
          const subResult = await this.azureProvider.analyzeDocument(subPdfBuffer, 'application/pdf', {
            modelId: 'prebuilt-layout',
          });

          this.azurePagesSucceeded = pagesForAzure.length;

          // CRITICAL REMAPPING: map subPdf page 1..N back to pagesForAzure[0..N-1]
          subResult.pages.forEach((subPage) => {
            const subIdx = subPage.pageNumber - 1; // 1-based to 0-based
            const origPageNum = pagesForAzure[subIdx] ?? subPage.pageNumber;
            const strat = azureStrategyMap.get(origPageNum) || 'AZURE_FULL_PAGE';
            const isFallback = strat === 'AZURE_FALLBACK';
            const dec = decisionMap.get(origPageNum);

            // Remap subResult tables for this page
            const pageTables = subResult.tables
              .filter((t) => t.pageNumber === subPage.pageNumber)
              .map((t) => ({
                ...t,
                pageNumber: origPageNum,
                coordinateUnit: (subPage.unit as any) || 'inch',
                boundingRegions: t.boundingRegions?.map((b: any) => ({
                  ...b,
                  pageNumber: origPageNum,
                  unit: (subPage.unit as any) || 'inch',
                })),
                rows: t.rows.map((r) => ({
                  ...r,
                  cells: r.cells.map((c) => ({
                    ...c,
                    coordinateUnit: (subPage.unit as any) || 'inch',
                  })),
                })),
              }));

            // Remap observations
            const pageObs = subResult.rawMetadataObservations
              ?.filter((o) => o.sourcePage === subPage.pageNumber)
              .map((o) => ({
                ...o,
                sourcePage: origPageNum,
              }));

            let telemetry: ProcessingPageTechnicalTelemetry | undefined;
            try {
              telemetry = {
                telemetryVersion: CANONICAL_TELEMETRY_VERSION,
                pageNumber: origPageNum,
                plannedStrategy: dec?.preferredStrategy || (isFallback ? 'LOCAL_NATIVE' : strat),
                billableStrategy: isFallback ? 'LOCAL_NATIVE' : (dec?.preferredStrategy || strat),
                executedStrategy: isFallback ? 'AZURE_FALLBACK' : strat,
                azureCalled: true,
                fallbackOccurred: isFallback,
                fallbackReason: isFallback ? fallbackReasonMap.get(origPageNum) : undefined,
                regionAnalysisExecuted: Boolean(dec?.requiresRegionAnalysis) || strat === 'HYBRID',
                outputType,
                processingDecisionVersion: dec?.decisionVersion || plan.decisionVersion || 'pde-v1.0.0',
                processingPricingVersion: CANONICAL_PROCESSING_PRICING_VERSION,
              };
            } catch (telErr: any) {
              console.warn(`[TELEMETRY_PERSISTENCE_WARNING] Failed creating subPage telemetry for doc ${documentId} page ${origPageNum}:`, telErr?.message || telErr);
            }

            pageResults.push({
              pageNumber: origPageNum,
              strategyUsed: strat,
              source: isFallback ? 'AZURE_FALLBACK' : strat === 'HYBRID' ? 'HYBRID' : 'AZURE',
              text: subPage.rawText || '',
              confidence: subPage.confidence ?? subResult.overallConfidence,
              lines: subPage.lines,
              tables: pageTables,
              rawMetadataObservations: pageObs,
              coordinateSystem: {
                unit: (subPage.unit as any) || 'inch',
              },
              telemetry,
            });
          });

          console.log(`[AZURE_PAGE_COMPLETED] doc: ${documentId}, remappedPages: [${pagesForAzure.join(', ')}]`);
        }
      } catch (azureErr: any) {
        // Tag error with azure execution progress before throwing
        (azureErr as any).azurePagesSucceeded = this.azurePagesSucceeded;
        (azureErr as any).azurePagesAttempted = this.azurePagesAttempted;
        throw azureErr;
      }
    }

    // 3. Merging: Combine local and Azure page results into a unified OCRAnalysisResult
    return this.mergeUnifiedResults(documentId, plan, pageResults);
  }

  /**
   * Merges all PageExtractionResult entries into a single, cohesive OCRAnalysisResult.
   * Guarantees monotonic tableIndex, sorted original page numbering, and canonical metadata.
   */
  private mergeUnifiedResults(
    documentId: string,
    plan: DocumentProcessingPlan,
    pageResults: PageExtractionResult[]
  ): OCRAnalysisResult {
    // Sort all pages by pageNumber ascending
    pageResults.sort((a, b) => a.pageNumber - b.pageNumber);

    const mergedPages: OCRPage[] = [];
    const mergedTables: OCRExtractedTable[] = [];
    const mergedRawObservations: OCRMetadataObservation[] = [];
    const rawTextParts: string[] = [];

    let globalTableIdx = 0;
    let confidenceSum = 0;
    let confidenceCount = 0;

    for (const pr of pageResults) {
      mergedPages.push({
        pageNumber: pr.pageNumber,
        linesCount: pr.lines?.length || 0,
        rawText: pr.text,
        confidence: pr.confidence,
        lines: pr.lines,
        telemetry: pr.telemetry,
      });

      if (pr.text) {
        rawTextParts.push(`--- Trang ${pr.pageNumber} (${pr.strategyUsed}) ---\n${pr.text}`);
      }

      if (typeof pr.confidence === 'number') {
        confidenceSum += pr.confidence;
        confidenceCount++;
      }

      // Remap and monotonically index tables
      for (const t of pr.tables) {
        const unit = pr.coordinateSystem?.unit || (t as any).coordinateUnit || 'point';
        const tableSource = (t as any).confidenceSource || (pr.strategyUsed === 'LOCAL_NATIVE' ? 'LOCAL_HEURISTIC' : 'AZURE_MODEL');
        const structConf = (t as any).structureConfidence;
        mergedTables.push({
          ...t,
          pageNumber: pr.pageNumber,
          tableIndex: globalTableIdx++,
          confidenceSource: tableSource,
          structureConfidence: structConf,
          coordinateUnit: unit,
          boundingRegions: t.boundingRegions?.map((b: any) => ({
            ...b,
            pageNumber: pr.pageNumber,
            unit,
          })),
          rows: t.rows.map((r) => ({
            ...r,
            cells: r.cells.map((c) => ({
              ...c,
              confidenceSource: (c as any).confidenceSource || tableSource,
              structureConfidence: (c as any).structureConfidence ?? structConf,
              coordinateUnit: c.coordinateUnit || unit,
            })),
          })),
        });
        if (typeof t.confidence === 'number') {
          confidenceSum += t.confidence;
          confidenceCount++;
        }
      }

      // Observations
      if (pr.rawMetadataObservations) {
        for (const obs of pr.rawMetadataObservations) {
          mergedRawObservations.push({
            ...obs,
            sourcePage: pr.pageNumber,
          });
        }
      }
    }

    // Deduce canonical document metadata using existing MetadataFilterEngine
    const filterResult = MetadataFilterEngine.processObservations(
      mergedRawObservations,
      mergedTables,
      mergedPages
    );

    const overallConfidence =
      confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(4)) : 0.95;

    // Aggregate observational technical telemetry
    let documentTelemetry: ProcessingTechnicalUsage | undefined;
    try {
      const pageTelemetryList = pageResults
        .map((p) => p.telemetry)
        .filter(Boolean) as ProcessingPageTechnicalTelemetry[];

      let fallbackCount = 0;
      let azureCount = 0;
      let nativeCount = 0;
      let hybridCount = 0;
      let regionCount = 0;

      for (const t of pageTelemetryList) {
        if (t.fallbackOccurred || t.executedStrategy === 'AZURE_FALLBACK') fallbackCount++;
        if (t.azureCalled || t.executedStrategy === 'AZURE_FULL_PAGE' || t.executedStrategy === 'AZURE_FALLBACK') azureCount++;
        if (t.executedStrategy === 'LOCAL_NATIVE') nativeCount++;
        if (t.executedStrategy === 'HYBRID') hybridCount++;
        if (t.regionAnalysisExecuted || t.executedStrategy === 'HYBRID') regionCount++;
      }

      documentTelemetry = {
        telemetryVersion: CANONICAL_TELEMETRY_VERSION,
        documentId,
        totalPageCount: plan.totalPages,
        nativeExecutedPageCount: nativeCount,
        azureExecutedPageCount: azureCount,
        hybridExecutedPageCount: hybridCount,
        fallbackPageCount: fallbackCount,
        regionAnalysisPageCount: regionCount,
        secondaryOcrExecuted: false,
        secondaryOcrCellCount: 0,
        secondaryOcrAttemptCount: 0,
        pages: pageTelemetryList,
      };
    } catch (telemetryErr: any) {
      console.warn(
        `[TELEMETRY_PERSISTENCE_WARNING] Failed to aggregate document technical telemetry for doc ${documentId}:`,
        telemetryErr?.message || telemetryErr
      );
    }

    console.log(
      `[PROCESSING_PLAN_COMPLETED] doc: ${documentId}, totalPages: ${plan.totalPages}, ` +
      `pagesProcessed: ${mergedPages.length}, tablesExtracted: ${mergedTables.length}, ` +
      `canonicalMetadata: ${filterResult.canonicalMetadata.length}, conf: ${overallConfidence}`
    );

    return {
      provider: 'DocConvert PDE Hybrid / Azure AI Layout',
      modelId: 'prebuilt-layout',
      overallConfidence,
      rawText: rawTextParts.join('\n\n'),
      pages: mergedPages,
      tables: mergedTables,
      rawMetadataObservations: mergedRawObservations,
      documentMetadata: filterResult.canonicalMetadata,
      metadataPipelineMetrics: filterResult.metrics,
      metadata: {
        model: 'pde-v1-hybrid',
        pageCount: plan.totalPages,
        tableCount: mergedTables.length,
        chunkCount: pageResults.length,
        localPages: plan.localPages,
        azurePages: plan.azurePages,
        hybridPages: plan.hybridPages,
        decisionVersion: plan.decisionVersion,
        technicalUsage: documentTelemetry,
      },
    };
  }
}

export const processingExecutor = new ProcessingExecutor();
