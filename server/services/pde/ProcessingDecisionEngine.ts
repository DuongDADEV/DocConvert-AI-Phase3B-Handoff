import type { DocumentPageRecord } from '../../db/db.js';
import type { DocumentPageAnalysis, PageClassification } from '../preflightService.js';
import type {
  PageProcessingDecision,
  ProcessingStrategy,
  DocumentProcessingPlan,
} from './types.js';

export const PDE_VERSION = 'pde-v1';

function extractPageSignals(page: DocumentPageRecord | DocumentPageAnalysis) {
  const p = page as any;
  return {
    pageNumber: (p.page_number ?? p.pageNumber ?? 1) as number,
    classification: ((p.classification || 'UNCERTAIN') as PageClassification),
    charCount: (p.text_char_count ?? p.textCharCount ?? 0) as number,
    textBlockCount: (p.text_block_count ?? p.textBlockCount ?? 0) as number,
    textCoverage: Number(p.text_coverage ?? p.textCoverage ?? 0),
    imageCount: (p.image_count ?? p.imageCount ?? 0) as number,
    imageCoverage: Number(p.image_coverage ?? p.imageCoverage ?? 0),
    hasFullPageImage: Boolean(p.has_full_page_image ?? p.hasFullPageImage),
  };
}

export class ProcessingDecisionEngine {
  readonly version = PDE_VERSION;

  /**
   * Deterministically evaluates a single page from its Preflight classification & structural signals.
   * Does NOT call external APIs (Azure, Gemini, PaddleOCR).
   */
  evaluatePage(
    page: DocumentPageRecord | DocumentPageAnalysis,
    options?: { resolveUncertain?: boolean }
  ): PageProcessingDecision {
    const signals = extractPageSignals(page);
    const pageNum = signals.pageNumber;
    const classification = signals.classification;
    const shouldResolveUncertain = options?.resolveUncertain ?? true;

    let preferredStrategy: ProcessingStrategy;
    let fallbackStrategy: ProcessingStrategy | undefined;
    let requiresAzure = false;
    let requiresLocalExtraction = false;
    let requiresRegionAnalysis = false;
    let requiresSecondPass = false;
    let decisionReason = '';

    switch (classification) {
      case 'NATIVE_TEXT':
        preferredStrategy = 'LOCAL_NATIVE';
        fallbackStrategy = 'AZURE_FALLBACK';
        requiresAzure = false;
        requiresLocalExtraction = true;
        requiresRegionAnalysis = false;
        requiresSecondPass = false;
        decisionReason =
          'Tài liệu chứa luồng văn bản máy đọc được; ưu tiên trích xuất cục bộ (local extraction), chuyển tiếp Azure nếu cấu trúc bảng không khả dụng.';
        break;

      case 'SCANNED':
        preferredStrategy = 'AZURE_FULL_PAGE';
        fallbackStrategy = undefined;
        requiresAzure = true;
        requiresLocalExtraction = false;
        requiresRegionAnalysis = false;
        requiresSecondPass = false;
        decisionReason =
          'Trang dạng hình ảnh quét (raster) hoặc không chứa đủ văn bản tự nhiên; yêu cầu xử lý đầy đủ bằng Azure Document Intelligence.';
        break;

      case 'MIXED':
        preferredStrategy = 'HYBRID';
        fallbackStrategy = 'AZURE_FULL_PAGE';
        requiresAzure = true; // Temporary safe Azure fallback until region OCR engine is active
        requiresLocalExtraction = true;
        requiresRegionAnalysis = true;
        requiresSecondPass = false;
        decisionReason =
          'Văn bản tự nhiên và vùng đồ hoạ/ảnh cùng tồn tại; chọn chiến lược Hybrid (ứng viên bóc tách vùng, tạm thời bảo vệ bằng Azure).';
        break;

      case 'UNCERTAIN':
      default:
        if (shouldResolveUncertain) {
          // Perform deterministic second-pass local analysis immediately
          return this.resolveSecondPass(page);
        }
        preferredStrategy = 'LOCAL_RECHECK';
        fallbackStrategy = 'AZURE_FULL_PAGE';
        requiresAzure = false;
        requiresLocalExtraction = true;
        requiresRegionAnalysis = false;
        requiresSecondPass = true;
        decisionReason =
          'Cấu trúc trang chưa rõ ràng; xếp lịch phân tích cấu trúc cục bộ lần 2 trước khi quyết định gửi API ngoại vi.';
        break;
    }

    return {
      pageNumber: pageNum,
      classification,
      preferredStrategy,
      fallbackStrategy,
      requiresAzure,
      requiresLocalExtraction,
      requiresRegionAnalysis,
      requiresSecondPass,
      decisionReason,
      decisionVersion: this.version,
    };
  }

  /**
   * Deterministic second-pass local analysis for UNCERTAIN pages.
   * MUST NOT call external OCR APIs. Uses local PDF structural signals only.
   * CRITICAL: Preserves original classification = 'UNCERTAIN' for auditability.
   */
  resolveSecondPass(
    page: DocumentPageRecord | DocumentPageAnalysis
  ): PageProcessingDecision {
    const signals = extractPageSignals(page);
    const pageNum = signals.pageNumber;
    const charCount = signals.charCount;
    const imgCoverage = signals.imageCoverage;
    const textCoverage = signals.textCoverage;
    const hasFullImg = signals.hasFullPageImage;

    let preferredStrategy: ProcessingStrategy;
    let fallbackStrategy: ProcessingStrategy | undefined;
    let requiresAzure = false;
    let requiresLocalExtraction = false;
    let requiresRegionAnalysis = false;
    let decisionReason = '';

    if (charCount >= 100 && imgCoverage < 0.30 && !hasFullImg) {
      preferredStrategy = 'LOCAL_NATIVE';
      fallbackStrategy = 'AZURE_FALLBACK';
      requiresAzure = false;
      requiresLocalExtraction = true;
      requiresRegionAnalysis = false;
      decisionReason =
        'Phân tích cục bộ lần 2: Xác nhận khối văn bản máy đọc được dồi dào, đồ hoạ raster không đáng kể; quy đổi sang trích xuất cục bộ.';
    } else if (imgCoverage >= 0.50 || hasFullImg || (charCount < 40 && imgCoverage >= 0.30)) {
      preferredStrategy = 'AZURE_FULL_PAGE';
      fallbackStrategy = undefined;
      requiresAzure = true;
      requiresLocalExtraction = false;
      requiresRegionAnalysis = false;
      decisionReason =
        'Phân tích cục bộ lần 2: Xác nhận lớp hình ảnh quét chiếm ưu thế; leo thang xử lý bằng Azure Document Intelligence.';
    } else if (charCount >= 50 && imgCoverage >= 0.20) {
      preferredStrategy = 'HYBRID';
      fallbackStrategy = 'AZURE_FULL_PAGE';
      requiresAzure = true;
      requiresLocalExtraction = true;
      requiresRegionAnalysis = true;
      decisionReason =
        'Phân tích cục bộ lần 2: Phát hiện cả luồng văn bản và phân vùng raster lớn; quy đổi sang lộ trình xử lý Hybrid.';
    } else {
      // Conservative escalation if still ambiguous
      preferredStrategy = 'AZURE_FULL_PAGE';
      fallbackStrategy = undefined;
      requiresAzure = true;
      requiresLocalExtraction = false;
      requiresRegionAnalysis = false;
      decisionReason =
        'Phân tích cục bộ lần 2: Tín hiệu cấu trúc vẫn mơ hồ; áp dụng nguyên tắc an toàn leo thang sang Azure Document Intelligence.';
    }

    return {
      pageNumber: pageNum,
      classification: 'UNCERTAIN', // DO NOT MUTATE original classification
      preferredStrategy,
      fallbackStrategy,
      requiresAzure,
      requiresLocalExtraction,
      requiresRegionAnalysis,
      requiresSecondPass: false, // Resolved in second pass
      decisionReason,
      decisionVersion: this.version,
    };
  }

  /**
   * Aggregates page-level decisions into a typed DocumentProcessingPlan.
   */
  buildProcessingPlan(
    documentId: string,
    pages: Array<DocumentPageRecord | DocumentPageAnalysis>,
    options?: { resolveUncertain?: boolean }
  ): DocumentProcessingPlan {
    console.log(`[PROCESSING_PLAN_STARTED] doc: ${documentId}, pages: ${pages.length}`);

    const decisions: PageProcessingDecision[] = pages.map((p) => {
      const dec = this.evaluatePage(p, options);
      console.log(
        `[PAGE_DECISION] doc: ${documentId}, page: ${dec.pageNumber}, ` +
        `class: ${dec.classification}, strategy: ${dec.preferredStrategy}, reason: "${dec.decisionReason}"`
      );
      return dec;
    });

    // Ensure decisions are ordered by pageNumber ascending
    decisions.sort((a, b) => a.pageNumber - b.pageNumber);

    let localPages = 0;
    let azurePages = 0;
    let hybridPages = 0;
    let recheckPages = 0;
    let estimatedAzurePages = 0;

    for (const d of decisions) {
      switch (d.preferredStrategy) {
        case 'LOCAL_NATIVE':
          localPages++;
          break;
        case 'AZURE_FULL_PAGE':
        case 'AZURE_FALLBACK':
          azurePages++;
          estimatedAzurePages++;
          break;
        case 'HYBRID':
          hybridPages++;
          // Currently, until region OCR is active, hybrid uses Azure fallback
          estimatedAzurePages++;
          break;
        case 'LOCAL_RECHECK':
          recheckPages++;
          break;
      }
    }

    const plan: DocumentProcessingPlan = {
      documentId,
      totalPages: pages.length,
      localPages,
      azurePages,
      hybridPages,
      recheckPages,
      estimatedAzurePages,
      decisionVersion: this.version,
      decisions,
    };

    console.log(
      `[PROCESSING_PLAN_CREATED] doc: ${documentId}, total: ${plan.totalPages}, ` +
      `local: ${plan.localPages}, azure: ${plan.azurePages}, hybrid: ${plan.hybridPages}, ` +
      `recheck: ${plan.recheckPages}, estAzure: ${plan.estimatedAzurePages}`
    );

    return plan;
  }
}

export const processingDecisionEngine = new ProcessingDecisionEngine();
