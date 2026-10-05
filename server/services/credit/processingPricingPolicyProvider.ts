import {
  ProcessingPricingPolicy,
  ProcessingStrategyType,
  CANONICAL_PROCESSING_PRICING_VERSION,
  CREDIT_UNIT_SCALE,
  CANONICAL_APPROVED_PRODUCTION_POLICY_V1,
} from '../../types/processingPricing.js';

export { CANONICAL_APPROVED_PRODUCTION_POLICY_V1 } from '../../types/processingPricing.js';

/**
 * Validates that a processing pricing policy adheres to all financial and version invariants:
 * - Version must be canonical processing pricing namespace (CANONICAL_PROCESSING_PRICING_VERSION)
 * - Version must NOT reuse commercial catalog 'pricing-v1'
 * - Unit scale must be 1000 (1 credit = 1000 units)
 * - All rate units must be safe integers >= 0 (NO floats, NO negative, NO NaN/Infinity)
 */
export function validateProcessingPricingPolicy(policy: ProcessingPricingPolicy): void {
  if (!policy || typeof policy !== 'object') {
    const err: any = new Error('INVALID_PRICING_POLICY: Policy must be a non-null object');
    err.code = 'INVALID_PRICING_POLICY';
    throw err;
  }

  // Version namespace validation
  if (policy.processingPricingVersion !== CANONICAL_PROCESSING_PRICING_VERSION) {
    const err: any = new Error(
      `INVALID_PRICING_VERSION: Version '${policy.processingPricingVersion}' is invalid. Canonical version must be '${CANONICAL_PROCESSING_PRICING_VERSION}'.`
    );
    err.code = 'INVALID_PRICING_VERSION';
    throw err;
  }

  // Commercial catalog collision guard
  if (
    policy.processingPricingVersion === 'pricing-v1' ||
    (policy as any).pricingVersion === 'pricing-v1'
  ) {
    const err: any = new Error(
      'PRICING_NAMESPACE_COLLISION: Commercial catalog version "pricing-v1" must not be reused for processing pricing.'
    );
    err.code = 'PRICING_NAMESPACE_COLLISION';
    throw err;
  }

  // Scale validation
  if (policy.unitScale !== CREDIT_UNIT_SCALE) {
    const err: any = new Error(
      `INVALID_UNIT_SCALE: unitScale must be ${CREDIT_UNIT_SCALE} (1 credit = 1000 units).`
    );
    err.code = 'INVALID_UNIT_SCALE';
    throw err;
  }

  // Strategy rates validation
  const requiredStrategies: ProcessingStrategyType[] = [
    'LOCAL_NATIVE',
    'AZURE_FULL_PAGE',
    'HYBRID',
    'LOCAL_RECHECK',
    'AZURE_FALLBACK',
  ];

  if (!policy.strategyRates || typeof policy.strategyRates !== 'object') {
    const err: any = new Error('INVALID_PRICING_POLICY: strategyRates must be defined.');
    err.code = 'INVALID_PRICING_POLICY';
    throw err;
  }

  for (const strategy of requiredStrategies) {
    const rate = policy.strategyRates[strategy];
    if (typeof rate !== 'number' || !Number.isSafeInteger(rate) || rate < 0) {
      const err: any = new Error(
        `INVALID_STRATEGY_RATE: Rate for strategy '${strategy}' must be a safe integer >= 0. Got: ${rate}`
      );
      err.code = 'INVALID_STRATEGY_RATE';
      throw err;
    }
  }

  // Optional additional rates validation
  if (policy.additionalRates) {
    for (const [key, val] of Object.entries(policy.additionalRates)) {
      if (val !== undefined && (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0)) {
        const err: any = new Error(
          `INVALID_ADDITIONAL_RATE: Additional rate '${key}' must be a safe integer >= 0. Got: ${val}`
        );
        err.code = 'INVALID_ADDITIONAL_RATE';
        throw err;
      }
    }
  }

  // Optional minimum charge validation
  if (policy.minDocumentChargeUnits !== undefined) {
    const minUnits = policy.minDocumentChargeUnits;
    if (typeof minUnits !== 'number' || !Number.isSafeInteger(minUnits) || minUnits < 0) {
      const err: any = new Error(
        `INVALID_MIN_CHARGE: minDocumentChargeUnits must be a safe integer >= 0. Got: ${minUnits}`
      );
      err.code = 'INVALID_MIN_CHARGE';
      throw err;
    }
  }
}

/**
 * Canonical Processing Pricing Policy Provider
 *
 * Enforces strict separation between:
 * - Production Policy: Fails closed unless approved by Product Owner.
 * - Development/Test Policy: Explicitly tagged and cannot silently become production.
 */
export class ProcessingPricingPolicyProvider {
  private activeProductionPolicy: ProcessingPricingPolicy | null = null;

  constructor(autoActivateApproved = false) {
    if (autoActivateApproved) {
      this.setApprovedProductionPolicy(CANONICAL_APPROVED_PRODUCTION_POLICY_V1);
    }
  }

  /**
   * Returns the active production policy.
   * FAILS CLOSED if Product Owner has not approved production rates.
   */
  getActiveProductionPolicy(): ProcessingPricingPolicy {
    if (!this.activeProductionPolicy) {
      const err: any = new Error(
        'PROCESSING_PRICING_NOT_CONFIGURED: Production processing pricing policy is not yet approved or configured.'
      );
      err.code = 'PROCESSING_PRICING_NOT_CONFIGURED';
      throw err;
    }

    return this.activeProductionPolicy;
  }

  /**
   * Status check: indicates whether an approved production policy is currently active.
   */
  isProductionPricingApproved(): boolean {
    return this.activeProductionPolicy !== null && this.activeProductionPolicy.isApprovedProductionPolicy === true;
  }

  /**
   * Status check: indicates whether production pricing engine is enabled with approved rates.
   */
  isProductionPricingEnabled(): boolean {
    return this.isProductionPricingApproved();
  }

  /**
   * Activates the approved production policy (Phase 3A.2 MVP approved rates).
   */
  activateApprovedProductionPolicy(): ProcessingPricingPolicy {
    this.setApprovedProductionPolicy(CANONICAL_APPROVED_PRODUCTION_POLICY_V1);
    return this.activeProductionPolicy!;
  }

  /**
   * Registers an approved production policy.
   * Requires isApprovedProductionPolicy === true.
   */
  setApprovedProductionPolicy(policy: ProcessingPricingPolicy): void {
    validateProcessingPricingPolicy(policy);
    if (!policy.isApprovedProductionPolicy) {
      const err: any = new Error(
        'UNAPPROVED_POLICY_REJECTED: Policy must have isApprovedProductionPolicy = true to be set as production.'
      );
      err.code = 'UNAPPROVED_POLICY_REJECTED';
      throw err;
    }
    this.activeProductionPolicy = Object.freeze({ ...policy });
  }

  /**
   * Clears production policy (resets to unconfigured fail-closed state).
   */
  clearProductionPolicy(): void {
    this.activeProductionPolicy = null;
  }

  /**
   * Returns a deterministic development/test policy for testing and simulation.
   * Strictly flagged with isApprovedProductionPolicy: false.
   */
  getDevelopmentPolicy(): ProcessingPricingPolicy {
    return {
      processingPricingVersion: CANONICAL_PROCESSING_PRICING_VERSION,
      unitScale: CREDIT_UNIT_SCALE,
      currency: 'CREDIT',
      isApprovedProductionPolicy: false,
      strategyRates: {
        LOCAL_NATIVE: 200,    // 0.2 credit
        AZURE_FULL_PAGE: 1000, // 1.0 credit
        HYBRID: 600,          // 0.6 credit
        LOCAL_RECHECK: 300,   // 0.3 credit
        AZURE_FALLBACK: 1000, // 1.0 credit
      },
      additionalRates: {
        secondaryOcrPerCell: 50, // 0.05 credit per cell
        regionAnalysisPerPage: 100, // 0.1 credit per page
        documentBaseUnits: 0,
      },
      minDocumentChargeUnits: 0,
    };
  }

  /**
   * Factory method for creating test policies with customized rate overrides.
   */
  createTestPolicy(overrides?: Partial<ProcessingPricingPolicy>): ProcessingPricingPolicy {
    const dev = this.getDevelopmentPolicy();
    const policy: ProcessingPricingPolicy = {
      ...dev,
      ...overrides,
      processingPricingVersion: overrides?.processingPricingVersion || dev.processingPricingVersion,
      strategyRates: {
        ...dev.strategyRates,
        ...(overrides?.strategyRates || {}),
      },
      additionalRates: {
        ...dev.additionalRates,
        ...(overrides?.additionalRates || {}),
      },
      isApprovedProductionPolicy: false,
    };
    validateProcessingPricingPolicy(policy);
    return policy;
  }
}

export const processingPricingPolicyProvider = new ProcessingPricingPolicyProvider(true);
