import {
  ProcessingPricingInput,
  ProcessingPricingEstimate,
  ProcessingPricingEstimator,
} from '../../types/processingPricing.js';
import { unitsToCredits, safeParseCreditUnits } from './creditService.js';
import { processingPricingEngine } from './processingPricingEngine.js';

export { processingPricingEngine } from './processingPricingEngine.js';
export { processingPricingPolicyProvider } from './processingPricingPolicyProvider.js';

/**
 * Phase 2C legacy / Fail-Closed Processing Pricing Estimator
 */
export class FailClosedPricingEstimator implements ProcessingPricingEstimator {
  async estimateProcessingCost(_input: ProcessingPricingInput): Promise<ProcessingPricingEstimate> {
    const error: any = new Error(
      'PROCESSING_PRICING_NOT_CONFIGURED: Production processing pricing engine is not yet configured.'
    );
    error.code = 'PROCESSING_PRICING_NOT_CONFIGURED';
    throw error;
  }
}

/**
 * Configurable Estimator for Testing and Development
 * Strictly validates that estimatedUnits is a positive integer.
 */
export class ConfigurablePricingEstimator implements ProcessingPricingEstimator {
  private unitsPerPage: number;
  private processingPricingVersion: string;

  constructor(unitsPerPage = 1000, processingPricingVersion = 'processing-pricing-v1') {
    this.unitsPerPage = unitsPerPage;
    this.processingPricingVersion = processingPricingVersion;
  }

  async estimateProcessingCost(input: ProcessingPricingInput): Promise<ProcessingPricingEstimate> {
    if (typeof input.pageCount !== 'number' || !Number.isSafeInteger(input.pageCount) || input.pageCount <= 0) {
      const error: any = new Error('INVALID_PROCESSING_ESTIMATE: pageCount must be a positive safe integer');
      error.code = 'INVALID_PROCESSING_ESTIMATE';
      throw error;
    }

    const estimatedUnits = safeParseCreditUnits(input.pageCount * this.unitsPerPage, 'estimatedUnits');
    if (!Number.isSafeInteger(estimatedUnits) || estimatedUnits <= 0) {
      const error: any = new Error('INVALID_PROCESSING_ESTIMATE: estimatedUnits must be a positive safe integer');
      error.code = 'INVALID_PROCESSING_ESTIMATE';
      throw error;
    }

    const estimatedCredits = unitsToCredits(estimatedUnits);

    return {
      documentId: input.documentId,
      pageCount: input.pageCount,
      estimatedUnits,
      estimatedCredits,
      processingPricingVersion: this.processingPricingVersion,
      pageBreakdown: [],
      breakdown: {
        pageCount: input.pageCount,
        unitsPerPage: this.unitsPerPage,
        outputType: input.outputType || 'EXCEL',
      },
      estimationBasis: `Development processing pricing estimate: ${input.pageCount} pages x ${this.unitsPerPage} units/page`,
      confidence: 'HIGH',
    };
  }
}

/**
 * Canonical default estimator wiring in Phase 3A:
 * Uses canonical ProcessingPricingEngine, which safely fails closed
 * in production until Product Owner approves pricing policy.
 */
export const defaultPricingEstimator = processingPricingEngine;
