import {
  ProcessingPricingInput,
  ProcessingPricingEstimate,
  ProcessingPricingEstimator,
  ProcessingPricingPolicy,
  ProcessingPagePricingInput,
  ProcessingPagePricingResult,
  ProcessingStrategyType,
  PageClassificationType,
  ProcessingActualUsageInput,
  ProcessingActualUsage,
  ProcessingPageTechnicalUsage,
  ProcessingTechnicalUsage,
  ProcessingPageBillableUsage,
  ProcessingBillableUsage,
  CANONICAL_PROCESSING_PRICING_VERSION,
  CANONICAL_TELEMETRY_VERSION,
} from '../../types/processingPricing.js';
import {
  processingPricingPolicyProvider,
  validateProcessingPricingPolicy,
} from './processingPricingPolicyProvider.js';
import { unitsToCredits, safeParseCreditUnits } from './creditService.js';
import { processingDecisionEngine } from '../pde/ProcessingDecisionEngine.js';

export interface ProcessingPricingEngineOptions {
  policyProvider?: typeof processingPricingPolicyProvider;
}

/**
 * Phase 3A / 3A.2 — Canonical Processing Pricing Engine
 *
 * Implements deterministic, safe-integer cost estimation and actual usage measurement.
 *
 * CORE INVARIANTS:
 * 1. PURE & READ-ONLY: Never invokes financial RPCs (reserve, capture, release, grant).
 * 2. DETERMINISTIC: Same inputs + same policy => identical output.
 * 3. SAFE INTEGER ONLY: All financial unit calculations produce safe integers >= 0.
 * 4. FAIL-CLOSED: Fails closed with PROCESSING_PRICING_NOT_CONFIGURED in production
 *    until Product Owner explicitly approves pricing policy.
 * 5. SEPARATION: Technical cost basis is decoupled from customer credit price.
 *    - Customer billable usage is pinned from pre-processing billable path.
 *    - Technical provider work is recorded in observational telemetry.
 *    - Fallback and secondary OCR are included in MVP (no incremental customer charge).
 *    - Normal fallback and secondary OCR NEVER trigger reconciliation.
 */
export class ProcessingPricingEngine implements ProcessingPricingEstimator {
  private policyProvider: typeof processingPricingPolicyProvider;

  constructor(options?: ProcessingPricingEngineOptions) {
    this.policyProvider = options?.policyProvider || processingPricingPolicyProvider;
  }

  /**
   * Reports whether production pricing engine is enabled with approved production policy.
   */
  isProductionEnabled(): boolean {
    return this.policyProvider.isProductionPricingEnabled();
  }

  /**
   * Resolves the active policy:
   * 1. If explicit policy passed (e.g. test injection), validate and use it.
   * 2. Else fetch from policyProvider (fails closed if unapproved in production).
   */
  private resolvePolicy(explicitPolicy?: ProcessingPricingPolicy): ProcessingPricingPolicy {
    if (explicitPolicy) {
      validateProcessingPricingPolicy(explicitPolicy);
      return explicitPolicy;
    }
    return this.policyProvider.getActiveProductionPolicy();
  }

  /**
   * Evaluates pricing for a single page deterministically.
   */
  estimatePageCost(
    page: ProcessingPagePricingInput,
    policy: ProcessingPricingPolicy
  ): ProcessingPagePricingResult {
    const pageNum = page.pageNumber;
    let classification: PageClassificationType = page.classification || 'UNCERTAIN';
    let strategy: ProcessingStrategyType | undefined = page.processingStrategy;

    // If strategy is not pre-assigned, evaluate deterministically via PDE
    if (!strategy) {
      const pdeDecision = processingDecisionEngine.evaluatePage({
        pageNumber: pageNum,
        classification,
        classificationConfidence: 1,
        textCharCount: page.textCharCount ?? 0,
        textBlockCount: 0,
        textCoverage: page.textCoverage ?? 0,
        imageCount: 0,
        imageCoverage: page.imageCoverage ?? 0,
        hasFullPageImage: Boolean(page.hasFullPageImage),
        classificationReason: 'Pre-pricing PDE evaluation',
      });
      strategy = pdeDecision.preferredStrategy;
      classification = pdeDecision.classification;
    }

    // Validate strategy exists in policy
    const baseRate = policy.strategyRates[strategy];
    if (baseRate === undefined) {
      const err: any = new Error(
        `UNKNOWN_PROCESSING_STRATEGY: Strategy '${strategy}' has no rate configured in policy '${policy.processingPricingVersion}'.`
      );
      err.code = 'UNKNOWN_PROCESSING_STRATEGY';
      throw err;
    }

    let additionalUnits = 0;
    const additionalReasons: string[] = [];

    // Region analysis surcharge if applicable and policy assigns units (0 in approved MVP policy)
    if (page.requiresRegionAnalysis && policy.additionalRates?.regionAnalysisPerPage) {
      additionalUnits += policy.additionalRates.regionAnalysisPerPage;
      additionalReasons.push(`Phân tích vùng (+${policy.additionalRates.regionAnalysisPerPage} units)`);
    }

    const estimatedUnits = safeParseCreditUnits(baseRate + additionalUnits, `page_${pageNum}_units`);

    const reason = additionalReasons.length > 0
      ? `Chiến lược ${strategy}: ${baseRate} units, ${additionalReasons.join(', ')}`
      : `Chiến lược ${strategy}: ${baseRate} units`;

    return {
      pageNumber: pageNum,
      classification,
      processingStrategy: strategy,
      baseUnits: baseRate,
      additionalUnits,
      estimatedUnits,
      pricingReason: reason,
    };
  }

  /**
   * Main Engine Entrypoint: Estimates processing cost before OCR execution.
   */
  async estimateProcessingCost(
    input: ProcessingPricingInput,
    explicitPolicy?: ProcessingPricingPolicy
  ): Promise<ProcessingPricingEstimate> {
    const policy = this.resolvePolicy(explicitPolicy);

    // 1. Validate Input
    if (!input || typeof input !== 'object') {
      const err: any = new Error('INVALID_PROCESSING_INPUT: Input must be a valid object');
      err.code = 'INVALID_PROCESSING_INPUT';
      throw err;
    }

    if (
      typeof input.pageCount !== 'number' ||
      !Number.isSafeInteger(input.pageCount) ||
      input.pageCount <= 0
    ) {
      const err: any = new Error(
        `INVALID_PROCESSING_INPUT: pageCount must be a positive safe integer. Got: ${input.pageCount}`
      );
      err.code = 'INVALID_PROCESSING_INPUT';
      throw err;
    }

    // 2. Build or Normalize Page Inputs
    const pageBreakdown: ProcessingPagePricingResult[] = [];
    const totalPages = input.pageCount;

    if (input.pages && input.pages.length > 0) {
      if (input.pages.length !== totalPages) {
        const err: any = new Error(
          `PAGE_COUNT_MISMATCH: Input pageCount (${totalPages}) does not match pages array length (${input.pages.length}).`
        );
        err.code = 'PAGE_COUNT_MISMATCH';
        throw err;
      }

      for (const p of input.pages) {
        pageBreakdown.push(this.estimatePageCost(p, policy));
      }
    } else {
      // Synthesize pages from classifications or fallback to whole document
      for (let i = 1; i <= totalPages; i++) {
        const pageIdx = i - 1;
        const pageInput: ProcessingPagePricingInput = {
          pageNumber: i,
          classification: input.pageClassifications?.[pageIdx] || 'UNCERTAIN',
          processingStrategy: input.processingStrategies?.[pageIdx],
          requiresAzure: input.requiresAzure,
          requiresRegionAnalysis: input.requiresRegionAnalysis,
        };
        pageBreakdown.push(this.estimatePageCost(pageInput, policy));
      }
    }

    // 3. Document-Level Summation
    let sumPageUnits = 0;
    for (const pb of pageBreakdown) {
      sumPageUnits += pb.estimatedUnits;
    }

    // Document-level base units (if configured in policy)
    const docBaseUnits = policy.additionalRates?.documentBaseUnits || 0;
    let totalEstimatedUnits = sumPageUnits + docBaseUnits;

    // Apply minimum document charge if configured (0 in approved MVP policy)
    if (policy.minDocumentChargeUnits && totalEstimatedUnits < policy.minDocumentChargeUnits) {
      totalEstimatedUnits = policy.minDocumentChargeUnits;
    }

    // Strict Safe Integer Verification
    if (!Number.isSafeInteger(totalEstimatedUnits) || totalEstimatedUnits <= 0) {
      const err: any = new Error(
        `INVALID_PROCESSING_ESTIMATE: totalEstimatedUnits must be a positive safe integer. Got: ${totalEstimatedUnits}`
      );
      err.code = 'INVALID_PROCESSING_ESTIMATE';
      throw err;
    }

    const estimatedCredits = unitsToCredits(totalEstimatedUnits);

    // Determine confidence
    const hasUncertainOrHybrid = pageBreakdown.some(
      (p) => p.classification === 'UNCERTAIN' || p.processingStrategy === 'HYBRID'
    );
    const confidence = hasUncertainOrHybrid ? 'CONDITIONAL_ESTIMATE' : 'HIGH';

    return {
      documentId: input.documentId,
      pageCount: totalPages,
      processingPricingVersion: policy.processingPricingVersion,
      estimatedUnits: totalEstimatedUnits,
      estimatedCredits,
      pageBreakdown,
      additionalBreakdown: {
        sumPageUnits,
        documentBaseUnits: docBaseUnits,
        outputType: input.outputType || 'EXCEL',
        isApprovedProductionPolicy: policy.isApprovedProductionPolicy,
      },
      estimationBasis: `Ước tính định tuyến từng trang theo phiên bản ${policy.processingPricingVersion}: ${totalPages} trang, tổng cộng ${estimatedCredits} credits.`,
      confidence,
    };
  }

  /**
   * Phase 3A.2 — Evaluates canonical customer billable usage following processing execution.
   * Under processing-pricing-v1:
   * - LOCAL_NATIVE remains 350 units even if AZURE_FALLBACK occurred (absorbed by DocConvert AI).
   * - SECONDARY_OCR has 0 incremental customer charge.
   * - REGION_ANALYSIS has 0 incremental customer charge (included in HYBRID).
   * - Normal fallback and normal secondary OCR do NOT trigger reconciliation.
   */
  calculateBillableUsage(
    input: {
      documentId: string;
      estimatedUnits?: number;
      pages: Array<{
        pageNumber: number;
        billableStrategy?: ProcessingStrategyType;
        executedStrategy?: ProcessingStrategyType;
        fallbackOccurred?: boolean;
        secondaryOcrExecuted?: boolean;
        secondaryOcrCellCount?: number;
        regionAnalysisExecuted?: boolean;
      }>;
      technicalTelemetry?: ProcessingTechnicalUsage;
    },
    explicitPolicy?: ProcessingPricingPolicy
  ): ProcessingBillableUsage {
    const policy = this.resolvePolicy(explicitPolicy);

    if (!input || !Array.isArray(input.pages) || input.pages.length === 0) {
      const err: any = new Error('INVALID_BILLABLE_USAGE_INPUT: pages must be a non-empty array');
      err.code = 'INVALID_BILLABLE_USAGE_INPUT';
      throw err;
    }

    let totalBillableUnits = 0;
    const pageUsage: ProcessingPageBillableUsage[] = [];

    for (const p of input.pages) {
      // Determine billable strategy: pinned pre-processing path takes priority
      let strat: ProcessingStrategyType = p.billableStrategy || p.executedStrategy || 'LOCAL_NATIVE';

      // Fallback rule: If original path was LOCAL_NATIVE and fallback occurred, billable strategy remains LOCAL_NATIVE
      if (p.executedStrategy === 'AZURE_FALLBACK' && (!p.billableStrategy || p.billableStrategy === 'LOCAL_NATIVE')) {
        strat = 'LOCAL_NATIVE';
      }

      const baseRate = policy.strategyRates[strat];
      if (baseRate === undefined) {
        const err: any = new Error(`UNKNOWN_PROCESSING_STRATEGY: Strategy '${strat}' has no configured rate.`);
        err.code = 'UNKNOWN_PROCESSING_STRATEGY';
        throw err;
      }

      // No incremental customer charges for fallback, secondary OCR, or region analysis in MVP
      const incrementalUnits = 0;
      const pageUnits = safeParseCreditUnits(baseRate + incrementalUnits, `billable_page_${p.pageNumber}`);
      totalBillableUnits += pageUnits;

      let reason = `Chiến lược tính phí: ${strat} (${baseRate} units)`;
      if (p.fallbackOccurred || p.executedStrategy === 'AZURE_FALLBACK') {
        reason += ` [Đã kích hoạt Azure Fallback - chi phí được DocConvert AI hấp thụ]`;
      }
      if (p.secondaryOcrExecuted) {
        reason += ` [Targeted Secondary OCR - miễn phí QA]`;
      }

      pageUsage.push({
        pageNumber: p.pageNumber,
        billableStrategy: strat,
        baseUnits: baseRate,
        incrementalUnits,
        billableUnits: pageUnits,
        billableCredits: unitsToCredits(pageUnits),
        pricingReason: reason,
      });
    }

    const estimated = input.estimatedUnits;
    let reconciliationRequired = false;
    let varianceUnits = 0;

    if (estimated !== undefined) {
      if (!Number.isSafeInteger(estimated) || estimated < 0) {
        const err: any = new Error('INVALID_ESTIMATED_UNITS: estimatedUnits must be a safe integer >= 0');
        err.code = 'INVALID_ESTIMATED_UNITS';
        throw err;
      }
      if (totalBillableUnits > estimated) {
        reconciliationRequired = true;
        varianceUnits = totalBillableUnits - estimated;
      }
    }

    return {
      documentId: input.documentId,
      processingPricingVersion: policy.processingPricingVersion,
      totalBillableUnits,
      totalBillableCredits: unitsToCredits(totalBillableUnits),
      estimatedUnits: estimated,
      pageUsage,
      usageBreakdown: {
        pageCount: input.pages.length,
        isApprovedProductionPolicy: policy.isApprovedProductionPolicy,
      },
      reconciliationRequired,
      varianceUnits,
      technicalTelemetry: input.technicalTelemetry,
    };
  }

  /**
   * Phase 3A.2 / 3A.3 — Aggregates observational technical execution telemetry.
   * NEVER affects customer billing.
   */
  calculateTechnicalUsage(input: {
    documentId: string;
    pages: ProcessingPageTechnicalUsage[];
    secondaryOcrAttemptCount?: number;
    secondaryOcrProviderSummary?: Record<string, number>;
    successfulResolutionCount?: number;
    failedResolutionCount?: number;
  }): ProcessingTechnicalUsage {
    let fallbackCount = 0;
    let azureCount = 0;
    let nativeCount = 0;
    let hybridCount = 0;
    let regionAnalysisCount = 0;
    let secOcrCellSum = 0;

    for (const p of input.pages) {
      if (p.fallbackOccurred || p.executedStrategy === 'AZURE_FALLBACK') fallbackCount++;
      if (p.azureCalled || p.executedStrategy === 'AZURE_FULL_PAGE' || p.executedStrategy === 'AZURE_FALLBACK') azureCount++;
      if (p.executedStrategy === 'LOCAL_NATIVE') nativeCount++;
      if (p.executedStrategy === 'HYBRID') hybridCount++;
      if (p.regionAnalysisExecuted || p.executedStrategy === 'HYBRID') regionAnalysisCount++;
      if (p.secondaryOcrCellCount) secOcrCellSum += p.secondaryOcrCellCount;
    }

    const secondaryOcrAttemptCount = input.secondaryOcrAttemptCount || 0;
    const secondaryOcrExecuted = secOcrCellSum > 0 || secondaryOcrAttemptCount > 0 || (input.pages.some((p) => p.secondaryOcrExecuted));

    return {
      telemetryVersion: CANONICAL_TELEMETRY_VERSION,
      documentId: input.documentId,
      totalPageCount: input.pages.length,
      nativeExecutedPageCount: nativeCount,
      nativePageCount: nativeCount,
      azureExecutedPageCount: azureCount,
      azurePageCount: azureCount,
      hybridExecutedPageCount: hybridCount,
      hybridPageCount: hybridCount,
      fallbackPageCount: fallbackCount,
      regionAnalysisPageCount: regionAnalysisCount,
      secondaryOcrExecuted,
      secondaryOcrCellCount: secOcrCellSum,
      secondaryOcrAttemptCount,
      secondaryOcrProviderSummary: input.secondaryOcrProviderSummary || {},
      successfulResolutionCount: input.successfulResolutionCount,
      failedResolutionCount: input.failedResolutionCount,
      pages: input.pages,
    };
  }

  /**
   * Post-Processing Usage Calculator
   * Calculates actual credit units consumed by executed work.
   * Separates customer billable units from raw provider technical metrics.
   */
  calculateActualUsage(
    input: ProcessingActualUsageInput,
    explicitPolicy?: ProcessingPricingPolicy
  ): ProcessingActualUsage {
    const policy = this.resolvePolicy(explicitPolicy);

    if (!input || !Array.isArray(input.pages) || input.pages.length === 0) {
      const err: any = new Error('INVALID_ACTUAL_USAGE_INPUT: pages must be a non-empty array');
      err.code = 'INVALID_ACTUAL_USAGE_INPUT';
      throw err;
    }

    let totalActualUnits = 0;
    const validatedPageUsage = input.pages.map((p) => {
      if (typeof p.actualUnits !== 'number' || !Number.isSafeInteger(p.actualUnits) || p.actualUnits < 0) {
        const err: any = new Error(
          `INVALID_ACTUAL_UNITS: Page ${p.pageNumber} actualUnits must be a safe integer >= 0. Got: ${p.actualUnits}`
        );
        err.code = 'INVALID_ACTUAL_UNITS';
        throw err;
      }
      totalActualUnits += p.actualUnits;
      return { ...p };
    });

    const docBaseUnits = input.documentBaseUnits || policy.additionalRates?.documentBaseUnits || 0;
    totalActualUnits += docBaseUnits;

    if (!Number.isSafeInteger(totalActualUnits) || totalActualUnits < 0) {
      const err: any = new Error(
        `INVALID_ACTUAL_USAGE: totalActualUnits must be a safe integer >= 0. Got: ${totalActualUnits}`
      );
      err.code = 'INVALID_ACTUAL_USAGE';
      throw err;
    }

    const estimated = input.estimatedUnits;
    let reconciliationRequired = false;
    let varianceUnits = 0;

    if (estimated !== undefined) {
      if (!Number.isSafeInteger(estimated) || estimated < 0) {
        const err: any = new Error(
          `INVALID_ESTIMATED_UNITS: estimatedUnits must be a safe integer >= 0. Got: ${estimated}`
        );
        err.code = 'INVALID_ESTIMATED_UNITS';
        throw err;
      }

      if (totalActualUnits > estimated) {
        // ACTUAL EXCEEDS ESTIMATE (Over-consumption guard)
        // INVARIANT: Never auto-debit above reserved credits.
        reconciliationRequired = true;
        varianceUnits = totalActualUnits - estimated;
      }
    }

    // Build attached observational technical telemetry if technicalPages provided
    let technicalUsage: ProcessingTechnicalUsage | undefined;
    if (input.technicalPages && input.technicalPages.length > 0) {
      technicalUsage = this.calculateTechnicalUsage({
        documentId: input.documentId,
        pages: input.technicalPages,
      });
    }

    return {
      documentId: input.documentId,
      processingPricingVersion: policy.processingPricingVersion,
      totalActualUnits,
      totalActualCredits: unitsToCredits(totalActualUnits),
      estimatedUnits: estimated,
      pageUsage: validatedPageUsage,
      usageBreakdown: {
        pageCount: input.pages.length,
        documentBaseUnits: docBaseUnits,
      },
      reconciliationRequired,
      varianceUnits,
      technicalUsage,
    };
  }
}

export const processingPricingEngine = new ProcessingPricingEngine();

