import { SupabaseClient } from '@supabase/supabase-js';
import { db } from '../../db/db.js';
import { creditService, unitsToCredits, safeParseCreditUnits } from './creditService.js';
import {
  ProcessingEligibilityReason,
  ProcessingEligibilityResult,
} from '../../types/processingEligibility.js';
import {
  ProcessingPricingInput,
  ProcessingPricingEstimate,
  ProcessingPricingEstimator,
} from '../../types/processingPricing.js';
import { defaultPricingEstimator } from './processingPricingContract.js';

export interface EvaluateProcessingEligibilityOptions {
  pricingEstimator?: ProcessingPricingEstimator;
  userClient?: SupabaseClient | null;
  userToken?: string;
}

/**
 * Hardened Document State Guard:
 * Canonical confirmable state for new processing in DocConvert AI is 'WAITING_CONFIRMATION'.
 * All other states (QUEUED, PROCESSING, READY, REVIEW_REQUIRED, DELETED, FAILED) are blocked.
 */
export function isDocumentEligibleForNewProcessing(status: string): boolean {
  return status === 'WAITING_CONFIRMATION';
}

/**
 * Validates that a financial credit unit value is a non-negative safe integer.
 */
export function isSafeIntegerCreditUnits(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export class ProcessingEligibilityService {
  private defaultEstimator: ProcessingPricingEstimator;

  constructor(defaultEstimator: ProcessingPricingEstimator = defaultPricingEstimator) {
    this.defaultEstimator = defaultEstimator;
  }

  /**
   * Pure Decision Helper: Checks credit sufficiency given available & estimated integer units.
   * Compares against totalAvailableUnits strictly (never gross owned balance).
   *
   * SAFE INTEGER CREDIT UNITS CONTRACT:
   * Rejects NaN, Infinity, fractional units, unsafe integers (> Number.MAX_SAFE_INTEGER), and negative units.
   */
  evaluateCreditSufficiency(
    availableUnits: number,
    estimatedUnits: number,
    accountStatus: 'ACTIVE' | 'FROZEN' | 'CLOSED' | 'NONE' = 'ACTIVE',
    processingPricingVersion: string = 'processing-pricing-v1',
    breakdown?: Record<string, any>,
    estimationBasis?: string
  ): ProcessingEligibilityResult {
    // 1. Validate estimate units (Strict Safe Integer Contract)
    if (
      typeof estimatedUnits !== 'number' ||
      !Number.isSafeInteger(estimatedUnits) ||
      estimatedUnits <= 0
    ) {
      const fallbackAvailable = isSafeIntegerCreditUnits(availableUnits) ? availableUnits : 0;
      return {
        eligible: false,
        reason: 'INVALID_PROCESSING_ESTIMATE',
        message: 'Ước tính chi phí xử lý không hợp lệ (phải là số nguyên an toàn dương).',
        availableUnits: fallbackAvailable,
        availableCredits: unitsToCredits(fallbackAvailable),
        estimatedUnits: 0,
        estimatedCredits: 0,
        shortageUnits: 0,
        shortageCredits: 0,
        processingPricingVersion,
        breakdown,
        estimationBasis,
      };
    }

    if (!isSafeIntegerCreditUnits(availableUnits)) {
      return {
        eligible: false,
        reason: 'INVALID_PROCESSING_ESTIMATE',
        message: 'Số dư tín dụng khả dụng không hợp lệ (phải là số nguyên an toàn không âm).',
        availableUnits: 0,
        availableCredits: 0,
        estimatedUnits: 0,
        estimatedCredits: 0,
        shortageUnits: 0,
        shortageCredits: 0,
        processingPricingVersion,
        breakdown,
        estimationBasis,
      };
    }

    const safeAvailable = safeParseCreditUnits(availableUnits, 'availableUnits');
    const safeEstimated = safeParseCreditUnits(estimatedUnits, 'estimatedUnits');
    const availableCredits = unitsToCredits(safeAvailable);
    const estimatedCredits = unitsToCredits(safeEstimated);

    // 2. Validate account status
    if (accountStatus === 'NONE') {
      return {
        eligible: false,
        reason: 'CREDIT_ACCOUNT_NOT_FOUND',
        message: 'Tài khoản của bạn chưa được khởi tạo tài khoản credit.',
        availableUnits: safeAvailable,
        availableCredits,
        estimatedUnits: safeEstimated,
        estimatedCredits,
        shortageUnits: safeEstimated,
        shortageCredits: estimatedCredits,
        processingPricingVersion,
        breakdown,
        estimationBasis,
      };
    }

    if (accountStatus === 'FROZEN') {
      const shortageUnits = Math.max(0, safeEstimated - safeAvailable);
      return {
        eligible: false,
        reason: 'CREDIT_ACCOUNT_FROZEN',
        message: 'Tài khoản credit của bạn đang bị tạm khóa (FROZEN). Không thể bắt đầu xử lý tài liệu mới.',
        availableUnits: safeAvailable,
        availableCredits,
        estimatedUnits: safeEstimated,
        estimatedCredits,
        shortageUnits,
        shortageCredits: unitsToCredits(shortageUnits),
        processingPricingVersion,
        breakdown,
        estimationBasis,
      };
    }

    if (accountStatus === 'CLOSED') {
      const shortageUnits = Math.max(0, safeEstimated - safeAvailable);
      return {
        eligible: false,
        reason: 'CREDIT_ACCOUNT_CLOSED',
        message: 'Tài khoản credit của bạn đã bị đóng (CLOSED). Không thể bắt đầu xử lý tài liệu mới.',
        availableUnits: safeAvailable,
        availableCredits,
        estimatedUnits: safeEstimated,
        estimatedCredits,
        shortageUnits,
        shortageCredits: unitsToCredits(shortageUnits),
        processingPricingVersion,
        breakdown,
        estimationBasis,
      };
    }

    // 3. Sufficient credit check: availableUnits >= estimatedUnits
    if (safeAvailable >= safeEstimated) {
      return {
        eligible: true,
        reason: 'ELIGIBLE',
        message: `Đủ điều kiện xử lý. Chi phí ước tính: ${estimatedCredits} credits.`,
        availableUnits: safeAvailable,
        availableCredits,
        estimatedUnits: safeEstimated,
        estimatedCredits,
        shortageUnits: 0,
        shortageCredits: 0,
        processingPricingVersion,
        breakdown,
        estimationBasis,
      };
    }

    // 4. Insufficient credit (Safe Integer Shortage Arithmetic)
    const shortageUnits = safeEstimated - safeAvailable;
    const shortageCredits = unitsToCredits(shortageUnits);

    return {
      eligible: false,
      reason: 'INSUFFICIENT_CREDIT',
      message: `Tài liệu này dự kiến cần ${estimatedCredits} credits để xử lý, nhưng tài khoản của bạn hiện chỉ có ${availableCredits} credits khả dụng. Bạn cần thêm ít nhất ${shortageCredits} credits để tiếp tục.`,
      availableUnits: safeAvailable,
      availableCredits,
      estimatedUnits: safeEstimated,
      estimatedCredits,
      shortageUnits,
      shortageCredits,
      processingPricingVersion,
      breakdown,
      estimationBasis,
    };
  }

  /**
   * Main Service Operation: Evaluates whether a user and document are eligible for OCR processing.
   *
   * TERMINOLOGY CLARIFICATION:
   * - PROCESSING_ELIGIBILITY_GUARD = implemented (early UX guard only)
   * - HARD_PROCESSING_CREDIT_ENFORCEMENT = not implemented (occurs at future atomic reserve-before-queue)
   *
   * Strict Safety Invariants:
   * - Read-only guard: NEVER calls reservation primitives
   * - NEVER creates background job records
   * - NEVER invokes document processing workers or AI providers
   * - NEVER mutates credit accounts, grants, or ledger tables
   * - Derives userId strictly from authenticated context
   */
  async evaluateProcessingEligibility(
    userId: string,
    documentId: string,
    options: EvaluateProcessingEligibilityOptions = {}
  ): Promise<ProcessingEligibilityResult> {
    if (!userId) {
      throw new Error('INVALID_ARGUMENT: userId is required');
    }
    if (!documentId) {
      throw new Error('INVALID_ARGUMENT: documentId is required');
    }

    // 1. Verify Document Ownership & Existence
    const doc = await db.getUserDocumentById(userId, documentId, options.userToken);
    if (!doc) {
      return {
        eligible: false,
        reason: 'DOCUMENT_NOT_FOUND',
        message: 'Không tìm thấy tài liệu hoặc bạn không có quyền truy cập.',
        availableUnits: 0,
        availableCredits: 0,
        estimatedUnits: 0,
        estimatedCredits: 0,
        shortageUnits: 0,
        shortageCredits: 0,
      };
    }

    // 2. Verify Document Lifecycle Readiness (Hardened State Guard)
    // Only WAITING_CONFIRMATION is eligible for new processing confirmation.
    // All other states (QUEUED, PROCESSING, READY, REVIEW_REQUIRED, DELETED, FAILED) are blocked.
    if (!isDocumentEligibleForNewProcessing(doc.status)) {
      return {
        eligible: false,
        reason: 'DOCUMENT_NOT_READY',
        message: `Tài liệu không ở trạng thái sẵn sàng để xác nhận xử lý (trạng thái hiện tại: ${doc.status}). Chỉ tài liệu ở trạng thái WAITING_CONFIRMATION mới đủ điều kiện bắt đầu xử lý.`,
        availableUnits: 0,
        availableCredits: 0,
        estimatedUnits: 0,
        estimatedCredits: 0,
        shortageUnits: 0,
        shortageCredits: 0,
      };
    }

    // 3. Build ProcessingPricingInput from Document Metadata & Pages
    const pages = await db.getDocumentPages(userId, documentId, options.userToken);
    const pricingInput: ProcessingPricingInput = {
      documentId: doc.id,
      pageCount: doc.page_count && doc.page_count > 0 ? doc.page_count : (pages.length > 0 ? pages.length : 1),
      outputType: doc.output_type || 'EXCEL',
      pageClassifications: pages.map((p) => p.classification as any),
      processingStrategies: pages.map((p) => p.processing_strategy as any).filter(Boolean),
      pages: pages.map((p) => ({
        pageNumber: p.page_number,
        classification: p.classification as any,
        processingStrategy: p.processing_strategy as any,
        requiresAzure: Boolean(p.requires_azure),
        requiresRegionAnalysis: Boolean(p.requires_region_analysis),
        textCharCount: p.text_char_count,
        textCoverage: p.text_coverage,
        imageCoverage: p.image_coverage,
        hasFullPageImage: Boolean(p.has_full_page_image),
      })),
      requiresAzure: pages.some((p) => p.requires_azure === true),
      requiresRegionAnalysis: pages.some((p) => p.requires_region_analysis === true),
    };

    // 4. Obtain Processing Cost Estimate from Pricing Estimator
    const estimator = options.pricingEstimator || this.defaultEstimator;
    let estimate: ProcessingPricingEstimate;

    try {
      estimate = await estimator.estimateProcessingCost(pricingInput);
    } catch (err: any) {
      if (err.code === 'PROCESSING_PRICING_NOT_CONFIGURED' || err.message?.includes('PROCESSING_PRICING_NOT_CONFIGURED')) {
        const balance = await creditService.getUserBalance(userId, options.userClient);
        return {
          eligible: false,
          reason: 'PROCESSING_PRICING_NOT_CONFIGURED',
          message: 'Bảng giá xử lý tài liệu chưa được cấu hình trên hệ thống.',
          availableUnits: balance.totalAvailableUnits,
          availableCredits: balance.totalAvailableCredits,
          estimatedUnits: 0,
          estimatedCredits: 0,
          shortageUnits: 0,
          shortageCredits: 0,
        };
      }

      if (err.code === 'INVALID_PROCESSING_ESTIMATE' || err.message?.includes('INVALID_PROCESSING_ESTIMATE')) {
        const balance = await creditService.getUserBalance(userId, options.userClient);
        return {
          eligible: false,
          reason: 'INVALID_PROCESSING_ESTIMATE',
          message: 'Ước tính chi phí xử lý không hợp lệ.',
          availableUnits: balance.totalAvailableUnits,
          availableCredits: balance.totalAvailableCredits,
          estimatedUnits: 0,
          estimatedCredits: 0,
          shortageUnits: 0,
          shortageCredits: 0,
        };
      }

      throw err;
    }

    // Validate returned estimate
    if (!estimate || !Number.isInteger(estimate.estimatedUnits) || estimate.estimatedUnits <= 0) {
      const balance = await creditService.getUserBalance(userId, options.userClient);
      return {
        eligible: false,
        reason: 'INVALID_PROCESSING_ESTIMATE',
        message: 'Ước tính chi phí xử lý không hợp lệ (phải là số nguyên dương).',
        availableUnits: balance.totalAvailableUnits,
        availableCredits: balance.totalAvailableCredits,
        estimatedUnits: 0,
        estimatedCredits: 0,
        shortageUnits: 0,
        shortageCredits: 0,
        processingPricingVersion: estimate?.processingPricingVersion,
      };
    }

    // 5. Query User Balance & Credit Account Status
    const balance = await creditService.getUserBalance(userId, options.userClient);

    // 6. Evaluate Decision using totalAvailableUnits
    return this.evaluateCreditSufficiency(
      balance.totalAvailableUnits,
      estimate.estimatedUnits,
      balance.status as any,
      estimate.processingPricingVersion || 'processing-pricing-v1',
      estimate.breakdown,
      estimate.estimationBasis
    );
  }
}

export const processingEligibilityService = new ProcessingEligibilityService();
