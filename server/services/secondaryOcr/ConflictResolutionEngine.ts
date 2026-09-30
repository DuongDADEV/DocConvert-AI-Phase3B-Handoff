import type {
  CandidateSource,
  ConflictResolutionDecision,
  RegionSnippet,
  SecondaryOcrContext,
  SecondaryOcrResult,
} from './types.js';
import { CandidateRevalidator } from './CandidateRevalidator.js';
import { GeminiAdjudicator } from './GeminiAdjudicator.js';

export interface ResolveCandidateOptions {
  candidateA: {
    id?: string;
    source: CandidateSource;
    rawValue: string;
    normalizedValue?: string | null;
    confidenceScore?: number;
    validationStatus: 'ACCEPTED' | 'WARNING' | 'REVIEW_REQUIRED';
    issues?: any[];
  };
  candidateB?: SecondaryOcrResult | null;
  candidateBEnhanced?: SecondaryOcrResult | null;
  cellType?: string;
  context: SecondaryOcrContext;
  snippet?: RegionSnippet;
}

export class ConflictResolutionEngine {
  private geminiAdjudicator = new GeminiAdjudicator();

  /**
   * Resolves conflicting candidates for a cell strictly according to Phase 7 policy:
   * 1. Deterministic resolution first (Exact match, Single valid candidate).
   * 2. Enhanced retry evaluation if initial secondary OCR was insufficient.
   * 3. Gemini last-resort adjudication ONLY when deterministic and retry fail.
   * 4. Human review if Gemini returns UNKNOWN or cannot adjudicate.
   */
  async resolve(options: ResolveCandidateOptions): Promise<ConflictResolutionDecision> {
    const { candidateA, candidateB, candidateBEnhanced, cellType, context, snippet } = options;

    const rawA = (candidateA.rawValue ?? '').trim();

    // -------------------------------------------------------------------------
    // Step 1: Deterministic Resolution — No Candidate B or Candidate B Failed to OCR
    // -------------------------------------------------------------------------
    if (!candidateB || candidateB.attemptStatus === 'FAILED') {
      if (candidateA.validationStatus === 'ACCEPTED' || candidateA.validationStatus === 'WARNING') {
        return {
          resolutionStatus: 'RESOLVED',
          resolutionMethod: 'DETERMINISTIC',
          selectedCandidateId: candidateA.id || null,
          selectedCandidateSource: candidateA.source,
          finalRawValue: candidateA.rawValue,
          finalNormalizedValue: candidateA.normalizedValue || null,
          finalValidationStatus: candidateA.validationStatus,
          reasonCode: 'PRIMARY_RETAINED_NO_SECONDARY',
          reasonMessage: 'Primary candidate retained because secondary OCR produced no candidate',
        };
      }

      // If enhanced candidate exists, check it
      if (candidateBEnhanced && candidateBEnhanced.attemptStatus === 'COMPLETED') {
        const revalEnhanced = CandidateRevalidator.revalidate(
          candidateBEnhanced.rawValue,
          cellType,
          candidateBEnhanced.confidenceScore,
          candidateBEnhanced.confidenceSource
        );

        if (revalEnhanced.isValid) {
          return {
            resolutionStatus: 'RESOLVED',
            resolutionMethod: 'SECONDARY_OCR_ENHANCED',
            selectedCandidateId: null, // assigned by caller
            selectedCandidateSource: 'SECONDARY_OCR_ENHANCED',
            finalRawValue: candidateBEnhanced.rawValue,
            finalNormalizedValue: revalEnhanced.normalizedValue,
            finalValidationStatus: revalEnhanced.validationStatus,
            reasonCode: 'ENHANCED_RETRY_VALIDATED',
            reasonMessage: 'Enhanced retry candidate satisfied all validation constraints',
          };
        }
      }

      return {
        resolutionStatus: 'HUMAN_REVIEW_REQUIRED',
        resolutionMethod: 'NONE',
        selectedCandidateId: candidateA.id || null,
        selectedCandidateSource: candidateA.source,
        finalRawValue: candidateA.rawValue,
        finalNormalizedValue: candidateA.normalizedValue || null,
        finalValidationStatus: 'REVIEW_REQUIRED',
        reasonCode: 'SECONDARY_OCR_FAILED',
        reasonMessage: 'Secondary OCR failed and primary candidate requires review',
      };
    }

    const rawB = (candidateB.rawValue ?? '').trim();

    // -------------------------------------------------------------------------
    // Step 2: Deterministic Resolution — Exact Match
    // -------------------------------------------------------------------------
    if (rawA === rawB) {
      const reval = CandidateRevalidator.revalidate(
        rawB,
        cellType,
        Math.max(candidateA.confidenceScore || 0, candidateB.confidenceScore || 0),
        'SECONDARY_OCR'
      );

      return {
        resolutionStatus: reval.isValid ? 'RESOLVED' : 'HUMAN_REVIEW_REQUIRED',
        resolutionMethod: 'DETERMINISTIC',
        selectedCandidateId: null, // caller can select candidate B or A
        selectedCandidateSource: 'SECONDARY_OCR',
        finalRawValue: rawB,
        finalNormalizedValue: reval.normalizedValue,
        finalValidationStatus: reval.validationStatus,
        reasonCode: 'EXACT_MATCH',
        reasonMessage: 'Primary and secondary OCR candidates match exactly',
      };
    }

    // -------------------------------------------------------------------------
    // Step 3: Revalidate Candidate B against deterministic rules
    // -------------------------------------------------------------------------
    const revalB = CandidateRevalidator.revalidate(
      rawB,
      cellType,
      candidateB.confidenceScore,
      candidateB.confidenceSource
    );

    const isAValid = candidateA.validationStatus === 'ACCEPTED' || candidateA.validationStatus === 'WARNING';
    const isBValid = revalB.isValid;

    // Case 3a: Candidate B is valid, Candidate A was invalid
    if (isBValid && !isAValid) {
      return {
        resolutionStatus: 'RESOLVED',
        resolutionMethod: 'SECONDARY_OCR',
        selectedCandidateId: null, // assigned by caller
        selectedCandidateSource: 'SECONDARY_OCR',
        finalRawValue: rawB,
        finalNormalizedValue: revalB.normalizedValue,
        finalValidationStatus: revalB.validationStatus,
        reasonCode: 'SECONDARY_OCR_CORRECTED_DEFECT',
        reasonMessage: 'Secondary OCR resolved validation defects present in primary extraction',
      };
    }

    // Case 3b: Candidate A was valid, Candidate B is invalid
    if (isAValid && !isBValid) {
      return {
        resolutionStatus: 'RESOLVED',
        resolutionMethod: 'DETERMINISTIC',
        selectedCandidateId: candidateA.id || null,
        selectedCandidateSource: candidateA.source,
        finalRawValue: candidateA.rawValue,
        finalNormalizedValue: candidateA.normalizedValue || null,
        finalValidationStatus: candidateA.validationStatus,
        reasonCode: 'PRIMARY_RETAINED_SECONDARY_INVALID',
        reasonMessage: 'Primary extraction retained because secondary OCR was invalid',
      };
    }

    // -------------------------------------------------------------------------
    // Step 4: Enhanced Retry Check (if initial candidates still conflict or both invalid)
    // -------------------------------------------------------------------------
    if (candidateBEnhanced && candidateBEnhanced.attemptStatus === 'COMPLETED') {
      const rawBEnhanced = (candidateBEnhanced.rawValue ?? '').trim();
      const revalEnhanced = CandidateRevalidator.revalidate(
        rawBEnhanced,
        cellType,
        candidateBEnhanced.confidenceScore,
        candidateBEnhanced.confidenceSource
      );

      if (revalEnhanced.isValid && !isAValid) {
        return {
          resolutionStatus: 'RESOLVED',
          resolutionMethod: 'SECONDARY_OCR_ENHANCED',
          selectedCandidateId: null,
          selectedCandidateSource: 'SECONDARY_OCR_ENHANCED',
          finalRawValue: rawBEnhanced,
          finalNormalizedValue: revalEnhanced.normalizedValue,
          finalValidationStatus: revalEnhanced.validationStatus,
          reasonCode: 'ENHANCED_RETRY_VALIDATED',
          reasonMessage: 'Enhanced retry candidate satisfied all validation constraints',
        };
      }
    }

    // -------------------------------------------------------------------------
    // Step 5: Gemini Last-Resort Adjudication
    // (Only called when deterministic resolution and enhanced retry fail)
    // -------------------------------------------------------------------------
    if (snippet) {
      console.log(`[ConflictResolutionEngine] Triggering Gemini last-resort adjudication for cell ${context.cellId}...`);
      const adjudication = await this.geminiAdjudicator.adjudicate(snippet, rawA, rawB, context);

      if (adjudication.decision === 'A') {
        const revalA = CandidateRevalidator.revalidate(
          rawA,
          cellType,
          adjudication.confidence,
          'GEMINI'
        );

        return {
          resolutionStatus: revalA.isValid ? 'RESOLVED' : 'HUMAN_REVIEW_REQUIRED',
          resolutionMethod: 'GEMINI',
          selectedCandidateId: candidateA.id || null,
          selectedCandidateSource: candidateA.source,
          finalRawValue: candidateA.rawValue,
          finalNormalizedValue: revalA.normalizedValue,
          finalValidationStatus: revalA.validationStatus,
          reasonCode: 'GEMINI_ADJUDICATED_A',
          reasonMessage: adjudication.reason,
          semanticDecision: 'A',
          semanticConfidence: adjudication.confidence,
        };
      }

      if (adjudication.decision === 'B') {
        return {
          resolutionStatus: revalB.isValid ? 'RESOLVED' : 'HUMAN_REVIEW_REQUIRED',
          resolutionMethod: 'GEMINI',
          selectedCandidateId: null,
          selectedCandidateSource: 'SECONDARY_OCR',
          finalRawValue: rawB,
          finalNormalizedValue: revalB.normalizedValue,
          finalValidationStatus: revalB.validationStatus,
          reasonCode: 'GEMINI_ADJUDICATED_B',
          reasonMessage: adjudication.reason,
          semanticDecision: 'B',
          semanticConfidence: adjudication.confidence,
        };
      }
    }

    // -------------------------------------------------------------------------
    // Step 6: Irreconcilable Conflict -> Human Review Required
    // Invariant: UNRESOLVED / HUMAN_REVIEW_REQUIRED MUST have validation_status = REVIEW_REQUIRED
    // -------------------------------------------------------------------------
    return {
      resolutionStatus: 'HUMAN_REVIEW_REQUIRED',
      resolutionMethod: 'NONE',
      selectedCandidateId: candidateA.id || null,
      selectedCandidateSource: candidateA.source,
      finalRawValue: candidateA.rawValue,
      finalNormalizedValue: candidateA.normalizedValue || null,
      finalValidationStatus: 'REVIEW_REQUIRED',
      reasonCode: 'IRRECONCILABLE_CONFLICT',
      reasonMessage: 'Both candidates conflict and could not be deterministically resolved',
      semanticDecision: 'UNKNOWN',
      semanticConfidence: 0,
    };
  }
}
