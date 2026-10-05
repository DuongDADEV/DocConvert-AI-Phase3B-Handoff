/**
 * Phase 3A — Processing Pricing Contracts & Types
 *
 * Defines the canonical contract for:
 * 1. Pre-execution Processing Cost Estimation (estimatedUnits)
 * 2. Post-execution Processing Usage Measurement (actualUnits)
 *
 * FINANCIAL INVARIANTS:
 * - 1 credit = 1000 credit_units (integer scaled, SAFE INTEGER ONLY).
 * - estimatedUnits and actualUnits are the canonical financial source of truth.
 * - estimatedCredits and actualCredits are derived display values only (units / 1000).
 * - Version namespace is strictly processingPricingVersion = 'processing-pricing-v1'.
 * - Commercial billing catalog ('pricing-v1') is NOT reused.
 */

export const CANONICAL_PROCESSING_PRICING_VERSION = 'processing-pricing-v1';
export const CREDIT_UNIT_SCALE = 1000;

export type PageClassificationType = 'NATIVE_TEXT' | 'SCANNED' | 'MIXED' | 'UNCERTAIN';

export type ProcessingStrategyType =
  | 'LOCAL_NATIVE'
  | 'AZURE_FULL_PAGE'
  | 'HYBRID'
  | 'LOCAL_RECHECK'
  | 'AZURE_FALLBACK';

/**
 * Product Owner-approved production rates for Phase 3A.2 (processing-pricing-v1)
 * All rates in safe integer credit units (1 credit = 1000 credit_units).
 */
export const PRODUCTION_PROCESSING_RATES = {
  LOCAL_NATIVE: 350,       // 0.35 credit / page
  AZURE_FULL_PAGE: 1980,   // 1.98 credit / page
  HYBRID: 1980,            // 1.98 credit / page
  LOCAL_RECHECK: 0,        // included / no incremental customer charge
  AZURE_FALLBACK: 0,       // absorbed / no incremental customer charge in MVP
} as const;

/**
 * Canonical approved production policy configuration for processing-pricing-v1.
 */
export const CANONICAL_APPROVED_PRODUCTION_POLICY_V1: ProcessingPricingPolicy = Object.freeze({
  processingPricingVersion: CANONICAL_PROCESSING_PRICING_VERSION,
  unitScale: CREDIT_UNIT_SCALE,
  currency: 'CREDIT',
  isApprovedProductionPolicy: true,
  strategyRates: {
    LOCAL_NATIVE: 350,
    AZURE_FULL_PAGE: 1980,
    HYBRID: 1980,
    LOCAL_RECHECK: 0,
    AZURE_FALLBACK: 0,
  },
  additionalRates: {
    secondaryOcrPerCell: 0,   // included QA cost in MVP
    regionAnalysisPerPage: 0, // included in HYBRID
    documentBaseUnits: 0,
  },
  minDocumentChargeUnits: 0,  // NONE in MVP
});

/**
 * Canonical Processing Pricing Policy configuration.
 * All rate units MUST be safe integers >= 0.
 */
export interface ProcessingPricingPolicy {
  processingPricingVersion: string;
  unitScale: number; // 1000
  currency: 'CREDIT';
  isApprovedProductionPolicy: boolean;
  strategyRates: Record<ProcessingStrategyType, number>;
  additionalRates?: {
    secondaryOcrPerCell?: number;
    regionAnalysisPerPage?: number;
    documentBaseUnits?: number;
  };
  minDocumentChargeUnits?: number;
}

/**
 * Detailed input for a single page pricing evaluation.
 */
export interface ProcessingPagePricingInput {
  pageNumber: number;
  classification?: PageClassificationType;
  processingStrategy?: ProcessingStrategyType;
  requiresAzure?: boolean;
  requiresRegionAnalysis?: boolean;
  textCharCount?: number;
  imageCoverage?: number;
  textCoverage?: number;
  hasFullPageImage?: boolean;
}

/**
 * Page-level pricing result breakdown.
 */
export interface ProcessingPagePricingResult {
  pageNumber: number;
  classification: PageClassificationType;
  processingStrategy: ProcessingStrategyType;
  baseUnits: number;
  additionalUnits: number;
  estimatedUnits: number;
  pricingReason: string;
}

/**
 * Document-level input for processing cost estimation.
 */
export interface ProcessingPricingInput {
  documentId: string;
  pageCount: number;
  outputType?: string;
  pageClassifications?: PageClassificationType[];
  processingStrategies?: ProcessingStrategyType[];
  pages?: ProcessingPagePricingInput[];
  requiresAzure?: boolean;
  requiresSecondaryOcr?: boolean;
  requiresRegionAnalysis?: boolean;
}

/**
 * Document-level processing pricing estimate returned by the engine.
 */
export interface ProcessingPricingEstimate {
  documentId: string;
  pageCount: number;
  processingPricingVersion: string;
  /** Canonical integer credit units required for processing (1 credit = 1000 units) */
  estimatedUnits: number;
  /** Display-only derived float credits (unitsToCredits(estimatedUnits)) */
  estimatedCredits: number;
  /** Granular page-by-page pricing breakdown */
  pageBreakdown: ProcessingPagePricingResult[];
  /** Optional granular additional breakdown */
  additionalBreakdown?: Record<string, any>;
  /** Description or explanation of estimation basis */
  estimationBasis: string;
  /** Confidence / conditionality of estimate */
  confidence: 'HIGH' | 'MEDIUM' | 'CONDITIONAL_ESTIMATE';
}

/**
 * ==============================================================================
 * SEPARATION OF CONCERNS: TECHNICAL USAGE vs BILLABLE USAGE (PHASE 3A.2)
 * ==============================================================================
 */

export const CANONICAL_TELEMETRY_VERSION = 'telemetry-v1';

/**
 * Canonical Phase 3A.3 Page Technical Telemetry Contract (Section IX).
 * Observational Technical Execution Telemetry for a single page.
 * Tracks what provider/worker operations occurred in reality.
 * NEVER affects customer billing directly.
 */
export interface ProcessingPageTechnicalTelemetry {
  telemetryVersion: string;
  pageNumber: number;
  plannedStrategy: ProcessingStrategyType;
  billableStrategy: ProcessingStrategyType;
  executedStrategy: ProcessingStrategyType;
  azureCalled: boolean;
  fallbackOccurred: boolean;
  fallbackReason?: string;
  regionAnalysisExecuted: boolean;
  outputType?: string;
  processingDecisionVersion: string;
  processingPricingVersion: string;
  secondaryOcrExecuted?: boolean;
  secondaryOcrCellCount?: number;
  technicalCostUnits?: number;
}

/**
 * Backwards-compatible alias for page technical telemetry.
 */
export type ProcessingPageTechnicalUsage = ProcessingPageTechnicalTelemetry;

/**
 * Document-level observational technical telemetry contract (Section X).
 * Used for margin analysis, provider cost monitoring, and operational debugging.
 * DISTINCT FROM ProcessingBillableUsage.
 */
export interface ProcessingTechnicalUsage {
  telemetryVersion: string;
  documentId: string;
  totalPageCount: number;
  nativeExecutedPageCount: number;
  azureExecutedPageCount: number;
  hybridExecutedPageCount: number;
  fallbackPageCount: number;
  regionAnalysisPageCount: number;
  secondaryOcrExecuted: boolean;
  secondaryOcrCellCount: number;
  secondaryOcrAttemptCount: number;
  secondaryOcrProviderSummary?: Record<string, number>;
  successfulResolutionCount?: number;
  failedResolutionCount?: number;
  pages: ProcessingPageTechnicalTelemetry[];
  /** Backwards-compatible aliases for Phase 3A.2 callers */
  nativePageCount?: number;
  azurePageCount?: number;
  hybridPageCount?: number;
}

/**
 * Authoritative Customer Billable Usage for a single page.
 * Pinned from pre-processing billable path and approved pricing policy.
 */
export interface ProcessingPageBillableUsage {
  pageNumber: number;
  billableStrategy: ProcessingStrategyType;
  baseUnits: number;
  incrementalUnits: number;
  billableUnits: number;
  billableCredits: number;
  pricingReason: string;
}

/**
 * Authoritative Document-Level Customer Billable Usage.
 * Sole financial basis for credit capture and settlement.
 */
export interface ProcessingBillableUsage {
  documentId: string;
  processingPricingVersion: string;
  totalBillableUnits: number;
  totalBillableCredits: number;
  estimatedUnits?: number;
  pageUsage: ProcessingPageBillableUsage[];
  usageBreakdown?: Record<string, any>;
  reconciliationRequired: boolean;
  varianceUnits?: number;
  technicalTelemetry?: ProcessingTechnicalUsage;
}

/**
 * Page-level actual usage record following OCR execution.
 */
export interface ProcessingPageActualUsage {
  pageNumber: number;
  executedStrategy: ProcessingStrategyType;
  primaryOcrUsed: boolean;
  secondaryOcrUsed?: boolean;
  secondaryOcrCellCount?: number;
  regionAnalysisUsed?: boolean;
  actualUnits: number;
  /** Billable path if different from executedStrategy (e.g. LOCAL_NATIVE for fallback) */
  billableStrategy?: ProcessingStrategyType;
  billableUnits?: number;
  fallbackOccurred?: boolean;
  fallbackReason?: string;
}

/**
 * Input for calculating actual processing usage after execution.
 */
export interface ProcessingActualUsageInput {
  documentId: string;
  estimatedUnits?: number;
  pages: ProcessingPageActualUsage[];
  documentBaseUnits?: number;
  technicalPages?: ProcessingPageTechnicalUsage[];
}

/**
 * Canonical actual usage contract established for future capture & settlement.
 */
export interface ProcessingActualUsage {
  documentId: string;
  processingPricingVersion: string;
  totalActualUnits: number;
  totalActualCredits: number;
  estimatedUnits?: number;
  pageUsage: ProcessingPageActualUsage[];
  usageBreakdown?: Record<string, any>;
  /** Flagged ONLY for true anomalies (corrupt state, unknown strategy). NOT for normal fallback or secondary OCR. */
  reconciliationRequired: boolean;
  varianceUnits?: number;
  billableUsage?: ProcessingBillableUsage;
  technicalUsage?: ProcessingTechnicalUsage;
}

export interface ProcessingPricingEstimator {
  estimateProcessingCost(
    input: ProcessingPricingInput,
    policy?: ProcessingPricingPolicy
  ): Promise<ProcessingPricingEstimate>;
}
