/**
 * Phase 2C — Processing Eligibility & Credit Guard Types
 *
 * Defines the structured response model for pre-processing credit sufficiency checks.
 */

export type ProcessingEligibilityReason =
  | 'ELIGIBLE'
  | 'INSUFFICIENT_CREDIT'
  | 'CREDIT_ACCOUNT_NOT_FOUND'
  | 'CREDIT_ACCOUNT_FROZEN'
  | 'CREDIT_ACCOUNT_CLOSED'
  | 'PROCESSING_PRICING_NOT_CONFIGURED'
  | 'INVALID_PROCESSING_ESTIMATE'
  | 'DOCUMENT_NOT_READY'
  | 'DOCUMENT_NOT_FOUND';

export interface ProcessingEligibilityResult {
  /** Authoritative boolean decision: whether document processing is allowed to proceed */
  eligible: boolean;
  /** Machine-readable reason code */
  reason: ProcessingEligibilityReason;
  /** Localized human-readable message for frontend display */
  message: string;
  /** Currently valid, unexpired, unreserved available credit units */
  availableUnits: number;
  /** Derived display available credits */
  availableCredits: number;
  /** Estimated required units for processing */
  estimatedUnits: number;
  /** Derived display estimated credits */
  estimatedCredits: number;
  /** Missing credit units if availableUnits < estimatedUnits, otherwise 0 */
  shortageUnits: number;
  /** Derived display shortage credits */
  shortageCredits: number;
  /** Applied processing pricing version identifier (e.g. 'processing-pricing-v1') */
  processingPricingVersion?: string;
  /** Detailed breakdown from pricing estimator if available */
  breakdown?: Record<string, any>;
  /** Explanation of estimation basis */
  estimationBasis?: string;
}
