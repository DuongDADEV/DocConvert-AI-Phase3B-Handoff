import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  X,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Trash2,
  Edit2,
  Check,
  Search,
  Filter,
  ShieldCheck,
  Download,
  FileSpreadsheet,
  FileText,
  Sparkles,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Layers,
  CheckSquare,
  AlertCircle,
  GripVertical,
  Maximize2,
  Minimize2,
  Eye,
} from 'lucide-react';
import { DocumentItem, DocumentOCRData, ExtractedTable, ExtractedRow, ExtractedCell, OCRMetadataItem, UnifiedTransactionTable, UnifiedRow, UnifiedCell } from '../../types';
import { api, ApiError } from '../../services/api';
import { StatusBadge } from '../common/StatusBadge';
import { LoadingSpinner } from '../common/LoadingSpinner';

export interface DocumentMetadataItem {
  label: string;
  value: string;
  rawValue?: string;
  confidence?: number;
  sourcePage?: number;
  boundingPolygon?: number[];
}

export type FrontendCellState =
  | 'CLEAN'
  | 'AUTO_RESOLVED'
  | 'REVIEW_REQUIRED'
  | 'HUMAN_RESOLVED'
  | 'WARNING_ONLY';

/**
 * Phase 8 Canonical Frontend Cell State Derivation
 * Strictly uses existing persisted fields without inventing fake backend enum values.
 */
export const deriveCellState = (cell: UnifiedCell | ExtractedCell | any): FrontendCellState => {
  if (!cell || cell.isPlaceholder) return 'CLEAN';

  const resStatus = cell.resolutionStatus;
  const resMethod = cell.resolutionMethod;
  const valStatus = cell.validationStatus;
  const qa = cell.qualityAssessment;

  // 1. HUMAN_RESOLVED: Human confirmed or edited value via Phase 7/8 architecture
  if (resStatus === 'RESOLVED' && resMethod === 'HUMAN') {
    return 'HUMAN_RESOLVED';
  }

  // 2. AUTO_RESOLVED: AI automatically resolved via Secondary OCR or Gemini
  if (
    resStatus === 'RESOLVED' &&
    ['DETERMINISTIC', 'SECONDARY_OCR', 'SECONDARY_OCR_ENHANCED', 'GEMINI'].includes(resMethod)
  ) {
    return 'AUTO_RESOLVED';
  }

  // 3. REVIEW_REQUIRED: Must block Completion Gate (PENDING, UNRESOLVED, HUMAN_REVIEW_REQUIRED, or REVIEW_REQUIRED)
  if (
    valStatus === 'REVIEW_REQUIRED' ||
    ['PENDING', 'UNRESOLVED', 'HUMAN_REVIEW_REQUIRED'].includes(resStatus)
  ) {
    return 'REVIEW_REQUIRED';
  }

  // Legacy/Quality severity fallback for unreviewed critical defects
  if (!cell.isReviewed) {
    if (qa?.severity === 'CRITICAL' || (typeof cell.confidence === 'number' && cell.confidence < 0.7)) {
      return 'REVIEW_REQUIRED';
    }
  }

  // 4. WARNING_ONLY: Non-blocking warning (format outlier, mild warning)
  if (
    valStatus === 'WARNING' ||
    qa?.severity === 'WARNING' ||
    (typeof cell.confidence === 'number' && cell.confidence >= 0.7 && cell.confidence < 0.85)
  ) {
    return 'WARNING_ONLY';
  }

  // 5. CLEAN: Accepted and valid
  return 'CLEAN';
};

// Friendly Vietnamese labels for recognized banking semantic types
const SEMANTIC_VI_LABELS: Record<string, string> = {
  ACCOUNT_HOLDER: 'Chủ tài khoản',
  ACCOUNT_NUMBER: 'Số tài khoản',
  CUSTOMER_ID: 'Mã khách hàng / CIF',
  TAX_CODE: 'Mã số thuế',
  CURRENCY: 'Loại tiền',
  ACCOUNT_TYPE: 'Loại tài khoản',
  BRANCH: 'Chi nhánh',
  ADDRESS: 'Địa chỉ',
  STATEMENT_DATE: 'Ngày sao kê',
  STATEMENT_FROM: 'Từ ngày',
  STATEMENT_TO: 'Đến ngày',
  STATEMENT_PERIOD: 'Kỳ sao kê',
  OPENING_DATE: 'Ngày mở',
  OPENING_BALANCE: 'Số dư đầu kỳ',
  CLOSING_BALANCE: 'Số dư cuối kỳ',
  STATEMENT_TIMESTAMP: 'Thời gian in',
};

// Display priority order for CORE metadata
const CORE_PRIORITY_ORDER: Record<string, number> = {
  ACCOUNT_HOLDER: 1,
  ACCOUNT_NUMBER: 2,
  CUSTOMER_ID: 3,
  TAX_CODE: 4,
  STATEMENT_PERIOD: 5,
  STATEMENT_FROM: 5,
  STATEMENT_TO: 5,
  CURRENCY: 6,
  ACCOUNT_TYPE: 7,
  BRANCH: 8,
  ADDRESS: 9,
  STATEMENT_DATE: 10,
};

// Human-readable explanations for backend quality reason codes
export const QUALITY_REASON_LABELS: Record<string, string> = {
  LOW_OCR_CONFIDENCE: 'OCR chưa chắc chắn với nội dung này',
  MEDIUM_OCR_CONFIDENCE: 'Độ tin cậy OCR mức trung bình',
  OCR_CONFIDENCE_UNAVAILABLE: 'Không có dữ liệu độ tin cậy OCR cho ô có nội dung',
  ALPHA_IN_MONEY: 'Giá trị tiền có ký tự chữ bất thường',
  LEADING_NOISE: 'Có ký tự bất thường ở đầu giá trị',
  TRAILING_SEPARATOR: 'Có dấu phân cách bất thường ở cuối giá trị',
  MULTIPLE_SEPARATOR_NOISE: 'Có dấu phân cách bất thường',
  FORMAT_OUTLIER: 'Định dạng khác với phần lớn dữ liệu trong cột',
  REFERENCE_STRUCTURE_OUTLIER: 'Cấu trúc mã khác với phần lớn dữ liệu trong cột',
  COLUMN_STRUCTURE_OUTLIER: 'Nội dung có cấu trúc khác thường so với các ô cùng cột',
  POSSIBLE_CHARACTER_CONFUSION: 'Có khả năng OCR nhầm ký tự',
  DATE_TEXT_CONTAMINATION: 'Chứa văn bản lạ trong ô ngày tháng',
  INVALID_DATE_STRUCTURE: 'Cấu trúc ngày tháng không hợp lệ',
  DATE_FORMAT_OUTLIER: 'Định dạng ngày khác với phần lớn dữ liệu trong cột',
  STT_TEXT_CONTAMINATION: 'Chứa văn bản trong ô số thứ tự',
  STT_NON_INTEGER: 'Số thứ tự không phải số nguyên',
  CORRUPT_CHARACTERS: 'Chứa ký tự điều khiển hoặc ký tự lạ',
  // Phase 6 Validation Engine codes
  LOW_STRUCTURE_CONFIDENCE: 'Độ tin cậy cấu trúc bảng vector thấp',
  INVALID_DATE: 'Định dạng hoặc giá trị ngày tháng không hợp lệ',
  INVALID_MONEY: 'Định dạng số tiền không hợp lệ',
  INVALID_NUMBER: 'Định dạng số không hợp lệ',
  INVALID_EMAIL: 'Định dạng email không đúng chuẩn',
  INVALID_PHONE: 'Số điện thoại không hợp lý',
  TYPE_MISMATCH: 'Kiểu dữ liệu ô không khớp với nội dung',
  EMPTY_REQUIRED_VALUE: 'Ô bắt buộc bị bỏ trống',
  COLUMN_COUNT_MISMATCH: 'Số cột của dòng không khớp với bảng',
  TABLE_STRUCTURE_ANOMALY: 'Bất thường cấu trúc bảng',
  LOGICAL_RULE_FAILED: 'Quy tắc logic nghiệp vụ không thỏa mãn',
};

export const formatQualityReason = (reason: { code: string; message?: string }): string => {
  return QUALITY_REASON_LABELS[reason.code] || reason.message || reason.code;
};

/**
 * Shared single-source predicate for generic human review.
 * A cell requires human review IF AND ONLY IF:
 * 1. It is not a placeholder cell
 * 2. Its derived state is REVIEW_REQUIRED
 */
export const isUnifiedCellNeedsReview = (cell: UnifiedCell | any): boolean => {
  if (!cell || cell.isPlaceholder) return false;
  return deriveCellState(cell) === 'REVIEW_REQUIRED';
};

// Backwards-compatible alias for existing test scripts
export const isUnifiedCellReviewWorthy = isUnifiedCellNeedsReview;

/**
 * Legacy fallback predicate for physical tables without unified quality assessment.
 */
export const isLegacyCellReviewWorthy = (cell: ExtractedCell | any): boolean => {
  if (!cell || cell.isPlaceholder) return false;
  return !cell.isReviewed && typeof cell.confidence === 'number' && cell.confidence < 0.85;
};

// 3-tier dark-mode compatible confidence styling
const getConfidenceColor = (confidence: number) => {
  if (confidence >= 0.9) {
    return {
      badge: 'bg-emerald-950/70 text-emerald-300 border border-emerald-800/60',
      dot: 'bg-emerald-400',
      border: 'border-emerald-900/40 hover:border-emerald-700/60',
      text: 'text-emerald-400',
    };
  }
  if (confidence >= 0.7) {
    return {
      badge: 'bg-amber-950/70 text-amber-300 border border-amber-800/60',
      dot: 'bg-amber-400',
      border: 'border-amber-900/40 hover:border-amber-700/60',
      text: 'text-amber-400',
    };
  }
  return {
    badge: 'bg-rose-950/70 text-rose-300 border border-rose-800/60',
    dot: 'bg-rose-500',
    border: 'border-rose-900/40 hover:border-rose-700/60',
    text: 'text-rose-400',
  };
};

interface OcrReviewWorkspaceProps {
  documentId: string;
  onClose: () => void;
  onDocumentUpdated?: (doc: DocumentItem) => void;
  metadata?: OCRMetadataItem[] | DocumentMetadataItem[];
}

export const OcrReviewWorkspace: React.FC<OcrReviewWorkspaceProps> = ({
  documentId,
  onClose,
  onDocumentUpdated,
  metadata,
}) => {
  // Core OCR Data State
  const [ocrData, setOcrData] = useState<DocumentOCRData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Document Blob Preview
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Draggable Split Pane State (Desktop-first: default 40% PDF, 60% Data)
  const [splitPercent, setSplitPercent] = useState<number>(40);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // DOM Refs for Split Container and Table Scrolling
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const latestClientXRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  // Table & Editing State
  const [selectedTableIndex, setSelectedTableIndex] = useState(0);
  const [selectedPageNumber, setSelectedPageNumber] = useState<number | 'ALL'>('ALL');
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [editingCellId, setEditingCellId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editType, setEditType] = useState<'TEXT' | 'MONEY' | 'DATE' | 'NUMBER'>('TEXT');
  const [isSavingCell, setIsSavingCell] = useState(false);
  const [confirmingCellId, setConfirmingCellId] = useState<string | null>(null);
  const [cellEditError, setCellEditError] = useState<string | null>(null);

  // Review Queue & Filter Tabs State
  const [reviewFilterTab, setReviewFilterTab] = useState<'ALL' | 'REVIEW_REQUIRED' | 'AUTO_RESOLVED' | 'HUMAN_RESOLVED' | 'WARNING_ONLY'>('ALL');
  const [currentIssueIndex, setCurrentIssueIndex] = useState(0);

  // Filter & Search State
  const [filterLowConfidenceOnly, setFilterLowConfidenceOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isTableFocused, setIsTableFocused] = useState(false);

  // Blocking Error Modal State
  const [blockingErrorModal, setBlockingErrorModal] = useState<{
    blockingCount: number;
    blockingCells: any[];
  } | null>(null);


  // Action States
  const [isRetryingOcr, setIsRetryingOcr] = useState(false);
  const [isCompletingReview, setIsCompletingReview] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [exportMode, setExportMode] = useState<'NORMALIZED' | 'ORIGINAL'>('NORMALIZED');
  const [showExportModal, setShowExportModal] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showAdditionalMetadata, setShowAdditionalMetadata] = useState(false);

  // --- 1. LOAD OCR DATA ---
  const loadOcrData = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const res = await api.getDocumentOcrResult(documentId);
      if (res.success) {
        setOcrData(res as DocumentOCRData);
      } else {
        if (!silent) setError('Không thể tải dữ liệu trích xuất OCR.');
      }
    } catch (err: any) {
      if (!silent) setError(err.message || 'Lỗi khi tải dữ liệu đối soát.');
      throw err;
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    loadOcrData();
  }, [loadOcrData]);

  // Polling when document status is QUEUED or PROCESSING
  useEffect(() => {
    let timer: any = null;
    if (ocrData?.document && (ocrData.document.status === 'QUEUED' || ocrData.document.status === 'PROCESSING')) {
      timer = setInterval(async () => {
        try {
          const res = await api.getDocumentOcrResult(documentId);
          if (res.success) {
            setOcrData(res as DocumentOCRData);
            if (res.document.status !== 'QUEUED' && res.document.status !== 'PROCESSING') {
              clearInterval(timer);
            }
          }
        } catch {
          // ignore transient poll errors
        }
      }, 3000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [documentId, ocrData?.document?.status]);

  // --- 2. LOAD SECURE PDF BLOB FOR PREVIEW ---
  useEffect(() => {
    let active = true;
    let url: string | null = null;

    if (documentId) {
      setIsPreviewLoading(true);
      api
        .getDocumentBlob(documentId)
        .then((blob) => {
          if (active) {
            url = window.URL.createObjectURL(blob);
            setPreviewUrl(url);
          }
        })
        .catch((err) => {
          console.error('Failed to load document preview blob:', err);
        })
        .finally(() => {
          if (active) setIsPreviewLoading(false);
        });
    }

    return () => {
      active = false;
      if (url) window.URL.revokeObjectURL(url);
    };
  }, [documentId]);

  // Reset horizontal scroll position when active table changes
  useEffect(() => {
    if (tableScrollRef.current) tableScrollRef.current.scrollLeft = 0;
  }, [selectedTableIndex]);

  // --- 4. STABLE SPLIT PANE POINTER HANDLERS ---
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    latestClientXRef.current = e.clientX;

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (!splitContainerRef.current) return;
        const rect = splitContainerRef.current.getBoundingClientRect();
        if (rect.width <= 0) return;
        const rawPercent = ((latestClientXRef.current - rect.left) / rect.width) * 100;
        // Strict safe split limits: 30% to 60%
        const clamped = Math.min(60, Math.max(30, rawPercent));
        setSplitPercent(clamped);
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDragging(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const handleDividerDoubleClick = () => {
    setSplitPercent(40); // Reset to default 40% PDF / 60% Review
  };

  // Cursor and selection lock during dragging
  useEffect(() => {
    if (isDragging) {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [isDragging]);

  const startEditCell = (cell: ExtractedCell | UnifiedCell) => {
    if (!cell.id || (cell as UnifiedCell).isPlaceholder) return;
    setSelectedCellId(cell.id);
    setEditingCellId(cell.id);
    setEditValue(cell.rawValue || '');
    setEditType((cell.cellType as any) || 'TEXT');
    setCellEditError(null);
  };

  const cancelEditCell = () => {
    setEditingCellId(null);
    setEditValue('');
    setCellEditError(null);
  };

  const saveCellEdit = async () => {
    if (!editingCellId || !ocrData || isSavingCell) return;
    setIsSavingCell(true);
    setCellEditError(null);
    try {
      const res = await api.updateExtractedCell(documentId, editingCellId, {
        rawValue: editValue,
        cellType: editType,
      });

      if (!res.success) {
        throw new Error(res.message || 'Không thể cập nhật ô dữ liệu.');
      }

      // Re-fetch fresh OCR result from backend to recompute UnifiedTable and dynamic CellQualityEvaluator
      await loadOcrData(true);
      setEditingCellId(null);
      setCellEditError(null);
      setSuccessMessage('Đã lưu chỉnh sửa và cập nhật trạng thái người dùng đối soát.');
      setTimeout(() => setSuccessMessage(null), 2500);
    } catch (err: any) {
      if (err.status === 422 || err.code === 'HUMAN_EDIT_VALIDATION_FAILED') {
        const issuesMsg = err.validationIssues?.length
          ? err.validationIssues.map((i: any) => i.message || i.code).join('; ')
          : (err.message || 'Giá trị chỉnh sửa không hợp lệ theo quy tắc kiểm tra.');
        setCellEditError(issuesMsg);
        // Do NOT close editingCellId so user can fix their input!
      } else if (err.status === 400 && err.code === 'CANNOT_EDIT_PLACEHOLDER_CELL') {
        alert('Không thể chỉnh sửa ô giả lập.');
        setEditingCellId(null);
        setCellEditError(null);
      } else {
        setCellEditError(err.message || 'Lỗi khi lưu ô.');
      }
    } finally {
      setIsSavingCell(false);
    }
  };

  const handleConfirmCell = async (cell: ExtractedCell | UnifiedCell) => {
    if (!cell.id || (cell as UnifiedCell).isPlaceholder || confirmingCellId) return;
    setConfirmingCellId(cell.id);
    try {
      const res = await api.confirmExtractedCell(documentId, cell.id);
      if (!res.success) {
        throw new Error(res.message || 'Không thể xác nhận ô dữ liệu.');
      }

      // Re-fetch fresh authoritative OCR result from backend
      await loadOcrData(true);
      setSuccessMessage('Đã xác nhận giá trị ô đúng theo tài liệu gốc.');
      setTimeout(() => setSuccessMessage(null), 2500);
    } catch (err: any) {
      if (err.status === 409 || err.code === 'CURRENT_VALUE_CANDIDATE_MISMATCH') {
        alert('Dữ liệu hiện tại không đồng bộ với lịch sử xử lý. Đang làm mới dữ liệu...');
        await loadOcrData(true);
      } else {
        alert(err.message || 'Lỗi khi xác nhận ô dữ liệu.');
      }
    } finally {
      setConfirmingCellId(null);
    }
  };

  // --- 5. ROW OPERATIONS ---
  const handleDeleteRow = async (table: ExtractedTable, rowIndex: number) => {
    if (!confirm(`Bạn có chắc chắn muốn xóa dòng số ${rowIndex + 1}?`)) return;
    try {
      await api.deleteExtractedRow(documentId, table.id, rowIndex);
      await loadOcrData();
      setSuccessMessage('Đã xóa dòng khỏi bảng.');
      setTimeout(() => setSuccessMessage(null), 2500);
    } catch (err: any) {
      alert(err.message || 'Lỗi khi xóa dòng.');
    }
  };

  // --- 6. ACTION WORKFLOWS ---
  const handleRerunOcr = async () => {
    if (isRetryingOcr) return;
    setIsRetryingOcr(true);
    try {
      await api.triggerDocumentOcr(documentId);
      setSuccessMessage('Đã kích hoạt lại tiến trình xử lý OCR.');
      setTimeout(() => {
        loadOcrData();
        setIsRetryingOcr(false);
      }, 1500);
    } catch (err: any) {
      alert(err.message || 'Lỗi khi kích hoạt lại OCR.');
      setIsRetryingOcr(false);
    }
  };

  const handleCompleteReview = async () => {
    if (isCompletingReview) return;
    setIsCompletingReview(true);
    try {
      const res = await api.completeDocumentReview(documentId);
      if (res.success && res.document) {
        if (onDocumentUpdated) {
          onDocumentUpdated(res.document);
        }
        await loadOcrData(true);
        setSuccessMessage('Đã hoàn tất đối soát! Tài liệu đã sẵn sàng xuất dữ liệu.');
        setTimeout(() => setSuccessMessage(null), 3000);
      }
    } catch (err: any) {
      if (err.status === 400 && err.code === 'BLOCKING_CELLS_REMAIN') {
        setBlockingErrorModal({
          blockingCount: err.blockingCount || (err.blockingCells?.length ?? 1),
          blockingCells: err.blockingCells || [],
        });
      } else {
        alert(err.message || 'Lỗi khi hoàn tất đối soát.');
      }
    } finally {
      setIsCompletingReview(false);
    }
  };

  const handleExportExcel = async (selectedMode: 'NORMALIZED' | 'ORIGINAL' = exportMode) => {
    setIsExportingExcel(true);
    setShowExportModal(false);
    try {
      const res = await api.exportDocumentToExcel(documentId, {
        mode: selectedMode,
        includeReviewLog: true,
        includeValidationSheet: true,
        highlightLowConfidence: true,
      });

      if (res.success && res.export) {
        setSuccessMessage(
          `Đã tạo tệp Excel thành công (${selectedMode === 'ORIGINAL' ? 'Dữ liệu gốc' : 'Chuẩn hóa'}). Đang tải xuống...`
        );
        await api.downloadExportedFile(documentId, res.export.exportId, res.export.fileName);
        setTimeout(() => setSuccessMessage(null), 4000);
      }
    } catch (err: any) {
      alert(err.message || 'Lỗi khi xuất tệp Excel.');
    } finally {
      setIsExportingExcel(false);
    }
  };

  // --- MEMOIZED COMPUTATIONS ---
  const unifiedTable = ocrData?.unifiedTransactionTable;
  const isUnified = Boolean(unifiedTable && unifiedTable.rows && unifiedTable.rows.length > 0);
  const activeTable = ocrData?.tables?.[selectedTableIndex];
  const isTableEmpty = isUnified
    ? (!unifiedTable || !unifiedTable.rows || unifiedTable.rows.length === 0)
    : (!activeTable || !activeTable.rows || activeTable.rows.length === 0);

  // Structural column count calculation
  const columnCount = useMemo(() => {
    if (isUnified && unifiedTable) {
      return unifiedTable.columns?.length || unifiedTable.headers?.length || 0;
    }
    if (!activeTable) return 0;
    let maxCol = activeTable.columnCount || 0;
    if (activeTable.headers && activeTable.headers.length > maxCol) {
      maxCol = activeTable.headers.length;
    }
    activeTable.rows?.forEach((r) => {
      r.cells?.forEach((c) => {
        if (typeof c.columnIndex === 'number' && c.columnIndex + 1 > maxCol) {
          maxCol = c.columnIndex + 1;
        }
      });
    });
    return maxCol;
  }, [isUnified, unifiedTable, activeTable]);

  // Effective dynamic header labels
  const effectiveHeaders = useMemo(() => {
    if (isUnified && unifiedTable) {
      return (unifiedTable.headers || []).map((h, i) => (h && h.trim() ? h.trim() : `Cột ${i + 1}`));
    }
    if (!activeTable || columnCount === 0) return [];
    const result: string[] = [];
    for (let i = 0; i < columnCount; i++) {
      const rawHead = activeTable.headers?.[i];
      if (rawHead && rawHead.trim().length > 0) {
        result.push(rawHead.trim());
      } else {
        result.push(`Cột ${i + 1}`);
      }
    }
    return result;
  }, [isUnified, unifiedTable, activeTable, columnCount]);



  // Data rows source (unified table or physical table fallback)
  const dataRows = useMemo(() => {
    if (isUnified && unifiedTable) {
      return unifiedTable.rows || [];
    }
    if (!activeTable || !activeTable.rows) return [];
    return activeTable.rows.filter((row) => {
      if (row.isHeader) return false;
      // If row 0 is identical to headers, omit it from body rows
      if (row.rowIndex === 0 && activeTable.headers && activeTable.headers.length > 0) {
        const matchesHeaders = row.cells?.every(
          (c) => activeTable.headers[c.columnIndex] === c.rawValue
        );
        if (matchesHeaders) return false;
      }
      return true;
    });
  }, [isUnified, unifiedTable, activeTable]);

  // Filtered rows for display according to Search and Low-Confidence Filter
  const displayedRows = useMemo(() => {
    return dataRows.filter((row: any) => {
      // 1. Filter by Review Tab (ALL / REVIEW_REQUIRED / AUTO_RESOLVED / HUMAN_RESOLVED / WARNING_ONLY)
      if (reviewFilterTab !== 'ALL') {
        const hasMatchingCell = row.cells?.some((c: any) => {
          if (!c || c.isPlaceholder) return false;
          return deriveCellState(c) === reviewFilterTab;
        });
        if (!hasMatchingCell) return false;
      }

      // 2. Review filter condition: row must contain at least one real cell needing review
      if (filterLowConfidenceOnly) {
        const hasSuspiciousCell = row.cells?.some((c: any) => {
          if (!c || c.isPlaceholder) return false;
          return deriveCellState(c) === 'REVIEW_REQUIRED';
        });
        if (!hasSuspiciousCell) return false;
      }

      // 3. Search query condition: row must match search text or page
      if (searchQuery) {
        const q = searchQuery.toLowerCase().trim();
        // Allow page query: "trang 2" or "p2" in unified mode
        if (isUnified && row.sourcePage) {
          if (q === `trang ${row.sourcePage}` || q === `p${row.sourcePage}`) {
            return true;
          }
        }
        return row.cells?.some(
          (c: any) => !c.isPlaceholder && (c.rawValue || '').toLowerCase().includes(q)
        );
      }

      return true;
    });
  }, [dataRows, reviewFilterTab, filterLowConfidenceOnly, searchQuery, isUnified]);

  // Reviewed count & metrics calculation
  const metrics = useMemo(() => {
    if (isUnified && unifiedTable) {
      let total = 0;
      let lowConf = 0;
      let reviewed = 0;
      let confSum = 0;
      let confCount = 0;

      unifiedTable.rows.forEach((r) => {
        r.cells.forEach((c) => {
          if (!c.isPlaceholder) {
            total++;
            if (typeof c.confidence === 'number') {
              confSum += c.confidence;
              confCount++;
            }
            if (c.qualityAssessment) {
              if (c.qualityAssessment.severity === 'WARNING' || c.qualityAssessment.severity === 'CRITICAL') {
                lowConf++;
              }
            } else if (typeof c.confidence === 'number' && c.confidence < 0.7) {
              lowConf++;
            }
            if (c.isReviewed) reviewed++;
          }
        });
      });

      const avgConfidence = confCount > 0 ? confSum / confCount : 0.95;
      return {
        totalCells: total,
        lowConfCount: lowConf,
        reviewedCount: reviewed,
        avgConfidence,
      };
    }

    if (!ocrData || !ocrData.tables) {
      return { totalCells: 0, lowConfCount: 0, reviewedCount: 0, avgConfidence: 0.95 };
    }

    let total = 0;
    let lowConf = 0;
    let reviewed = 0;
    let confSum = 0;
    let confCount = 0;

    ocrData.tables.forEach((t) => {
      t.rows.forEach((r) => {
        r.cells.forEach((c) => {
          total++;
          if (typeof c.confidence === 'number') {
            confSum += c.confidence;
            confCount++;
            if (c.confidence < 0.7) lowConf++;
          }
          if (c.isReviewed) reviewed++;
        });
      });
    });

    const avgConfidence = confCount > 0 ? confSum / confCount : (ocrData.tables[0]?.confidence || 0.95);

    return {
      totalCells: total,
      lowConfCount: lowConf,
      reviewedCount: reviewed,
      avgConfidence,
    };
  }, [isUnified, unifiedTable, ocrData]);

  // Review counter and severity breakdown (WARNING + CRITICAL for unified, < 0.85 for legacy)
  const reviewStats = useMemo(() => {
    if (isUnified && unifiedTable) {
      let warningCount = 0;
      let criticalCount = 0;

      unifiedTable.rows.forEach((r) => {
        r.cells?.forEach((c) => {
          if (!isUnifiedCellNeedsReview(c)) return;
          const severity = c.qualityAssessment?.severity;
          if (severity === 'CRITICAL') {
            criticalCount++;
          } else if (severity === 'WARNING') {
            warningCount++;
          }
        });
      });

      return {
        totalReviewCount: warningCount + criticalCount,
        warningCount,
        criticalCount,
      };
    }

    if (!dataRows) return { totalReviewCount: 0, warningCount: 0, criticalCount: 0 };
    let legacyCount = 0;
    dataRows.forEach((r: any) => {
      r.cells?.forEach((c: any) => {
        if (isLegacyCellReviewWorthy(c)) {
          legacyCount++;
        }
      });
    });
    return {
      totalReviewCount: legacyCount,
      warningCount: legacyCount,
      criticalCount: 0,
    };
  }, [isUnified, unifiedTable, dataRows]);

  const lowConfidenceCount = reviewStats.totalReviewCount;

  // Selected cell object (preserved for future highlight compatibility)
  const selectedCell = useMemo(() => {
    if (!selectedCellId) return null;
    if (isUnified && unifiedTable) {
      for (const r of unifiedTable.rows) {
        for (const c of r.cells) {
          if (!c.isPlaceholder && c.id === selectedCellId) return c;
        }
      }
      return null;
    }
    if (!activeTable) return null;
    for (const r of activeTable.rows) {
      for (const c of r.cells) {
        if (c.id === selectedCellId) return c;
      }
    }
    return null;
  }, [selectedCellId, isUnified, unifiedTable, activeTable]);

  // Phase 8 Review Queue: Sorted list of all cells needing user attention
  const reviewQueueCells = useMemo(() => {
    const list: Array<{ cell: UnifiedCell | ExtractedCell; rowIndex: number; pageNumber?: number }> = [];
    if (isUnified && unifiedTable) {
      unifiedTable.rows.forEach((r) => {
        r.cells.forEach((c) => {
          if (!c.isPlaceholder && deriveCellState(c) === 'REVIEW_REQUIRED') {
            list.push({ cell: c, rowIndex: r.displayRowIndex, pageNumber: r.sourcePage });
          }
        });
      });
    } else if (activeTable?.rows) {
      activeTable.rows.forEach((r) => {
        r.cells.forEach((c) => {
          if (!c.isPlaceholder && deriveCellState(c) === 'REVIEW_REQUIRED') {
            list.push({ cell: c, rowIndex: r.rowIndex, pageNumber: activeTable.pageNumber });
          }
        });
      });
    }
    return list;
  }, [isUnified, unifiedTable, activeTable]);

  // Navigation handlers for Review Queue
  const jumpToReviewIssue = (index: number) => {
    if (reviewQueueCells.length === 0) return;
    const targetIdx = (index + reviewQueueCells.length) % reviewQueueCells.length;
    setCurrentIssueIndex(targetIdx);
    const target = reviewQueueCells[targetIdx];
    if (target?.cell?.id) {
      setSelectedCellId(target.cell.id);
      if (target.pageNumber) {
        setSelectedPageNumber(target.pageNumber);
      }
      setTimeout(() => {
        const el = document.getElementById(`cell-${target.cell.id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        }
      }, 50);
    }
  };

  const handleNextIssue = () => {
    jumpToReviewIssue(currentIssueIndex + 1);
  };

  const handlePrevIssue = () => {
    jumpToReviewIssue(currentIssueIndex - 1);
  };

  // --- METADATA SELECTION & DYNAMIC PRESENTATION ---
  const metadataItems: OCRMetadataItem[] = useMemo(() => {
    if (ocrData?.documentMetadata && ocrData.documentMetadata.length > 0) {
      return ocrData.documentMetadata;
    }
    if (metadata && metadata.length > 0) {
      return metadata as OCRMetadataItem[];
    }
    return [];
  }, [ocrData?.documentMetadata, metadata]);

  // Process CORE & ADDITIONAL items with display priority and period combination
  const { coreDisplayItems, additionalItems } = useMemo(() => {
    const rawCore = metadataItems.filter((m) => m.visibilityClass === 'CORE');
    const additional = metadataItems.filter((m) => m.visibilityClass === 'ADDITIONAL');

    // Check if STATEMENT_PERIOD is already present in rawCore
    const existingPeriod = rawCore.find((m) => m.semanticType === 'STATEMENT_PERIOD');
    const stmtFrom = rawCore.find((m) => m.semanticType === 'STATEMENT_FROM');
    const stmtTo = rawCore.find((m) => m.semanticType === 'STATEMENT_TO');

    const combinedList: Array<{
      id?: string;
      label: string;
      value: string;
      confidence: number;
      qualityScore?: number;
      semanticType?: string;
      sourcePage?: number;
      isCombined?: boolean;
      status?: string;
    }> = [];

    if (existingPeriod) {
      // Backend already provided a canonical STATEMENT_PERIOD item!
      // Exclude STATEMENT_FROM and STATEMENT_TO from CORE display cards to prevent duplicates
      for (const item of rawCore) {
        if (item.semanticType === 'STATEMENT_FROM' || item.semanticType === 'STATEMENT_TO') {
          continue;
        }
        combinedList.push({
          id: item.id,
          label: item.semanticType ? SEMANTIC_VI_LABELS[item.semanticType] || item.label : item.label,
          value: item.value,
          confidence: item.confidence,
          qualityScore: item.qualityScore,
          semanticType: item.semanticType,
          sourcePage: item.sourcePage,
          status: item.status,
        });
      }
    } else if (stmtFrom && stmtTo) {
      // Visually combine them into one item "Kỳ sao kê" only when no STATEMENT_PERIOD exists
      const combinedPeriodItem = {
        id: `combined-period-${stmtFrom.id || 'from'}-${stmtTo.id || 'to'}`,
        label: 'Kỳ sao kê',
        value: `${stmtFrom.value} → ${stmtTo.value}`,
        confidence: Math.min(stmtFrom.confidence, stmtTo.confidence),
        qualityScore: Math.min(stmtFrom.qualityScore ?? 1, stmtTo.qualityScore ?? 1),
        semanticType: 'STATEMENT_PERIOD',
        sourcePage: stmtFrom.sourcePage,
        isCombined: true,
        status: stmtFrom.status === 'CONFLICT' || stmtTo.status === 'CONFLICT' ? 'CONFLICT' : 'AUTO',
      };

      for (const item of rawCore) {
        if (item.semanticType === 'STATEMENT_FROM' || item.semanticType === 'STATEMENT_TO') {
          continue;
        }
        combinedList.push({
          id: item.id,
          label: item.semanticType ? SEMANTIC_VI_LABELS[item.semanticType] || item.label : item.label,
          value: item.value,
          confidence: item.confidence,
          qualityScore: item.qualityScore,
          semanticType: item.semanticType,
          sourcePage: item.sourcePage,
          status: item.status,
        });
      }
      combinedList.push(combinedPeriodItem);
    } else {
      // Only one or neither exists
      for (const item of rawCore) {
        combinedList.push({
          id: item.id,
          label: item.semanticType ? SEMANTIC_VI_LABELS[item.semanticType] || item.label : item.label,
          value: item.value,
          confidence: item.confidence,
          qualityScore: item.qualityScore,
          semanticType: item.semanticType,
          sourcePage: item.sourcePage,
          status: item.status,
        });
      }
    }

    // Singleton Dedup: Ensure each singleton semantic concept appears at most once in CORE cards
    const seenSemantics = new Set<string>();
    const deduplicatedCore: typeof combinedList = [];
    for (const item of combinedList) {
      if (item.semanticType && item.semanticType !== 'OTHER') {
        if (seenSemantics.has(item.semanticType)) {
          continue;
        }
        seenSemantics.add(item.semanticType);
      }
      deduplicatedCore.push(item);
    }

    // Sort according to preferred display priority
    deduplicatedCore.sort((a, b) => {
      const pA = a.semanticType ? CORE_PRIORITY_ORDER[a.semanticType] || 99 : 99;
      const pB = b.semanticType ? CORE_PRIORITY_ORDER[b.semanticType] || 99 : 99;
      return pA - pB;
    });

    return {
      coreDisplayItems: deduplicatedCore,
      additionalItems: additional,
    };
  }, [metadataItems]);

  return (
    <div
      id="ocr-review-workspace-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-3 bg-slate-950/85 backdrop-blur-xs select-none"
    >
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl w-full max-w-[98vw] h-[95vh] flex flex-col overflow-hidden text-slate-100 font-sans">
        {/* ========================================================= */}
        {/* TOP TOOLBAR */}
        {/* ========================================================= */}
        <header className="px-5 py-3 bg-slate-950 border-b border-slate-800 flex items-center justify-between shrink-0">
          {/* File Title & Status */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 text-blue-400 flex items-center justify-center shrink-0 font-bold">
              <Sparkles className="w-4 h-4 text-blue-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2
                  className="text-xs sm:text-sm font-bold text-slate-100 truncate max-w-xs sm:max-w-md"
                  title={ocrData?.document?.original_filename || 'Tài liệu Đối Soát OCR'}
                >
                  {ocrData?.document?.original_filename || 'Tài liệu Đối Soát OCR'}
                </h2>
                {ocrData?.document && <StatusBadge status={ocrData.document.status} size="sm" />}
                {ocrData?.document && (
                  <div className="flex items-center gap-1.5">
                    {ocrData.document.review_status === 'REVIEWED' ? (
                      <span
                        id="badge-doc-review-status"
                        className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-950/90 text-emerald-300 border border-emerald-700/80 flex items-center gap-1 shadow-xs"
                        title={ocrData.document.reviewed_at ? `Hoàn tất lúc: ${new Date(ocrData.document.reviewed_at).toLocaleString('vi-VN')}` : 'Đã hoàn tất đối soát'}
                      >
                        <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        <span>Đã đối soát</span>
                      </span>
                    ) : ocrData.document.review_status === 'IN_PROGRESS' ? (
                      <span
                        id="badge-doc-review-status"
                        className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-950/90 text-amber-300 border border-amber-700/80 flex items-center gap-1 shadow-xs"
                        title="Đang trong tiến trình đối soát"
                      >
                        <RefreshCw className="w-2.5 h-2.5 text-amber-400 animate-spin" />
                        <span>Đang đối soát</span>
                      </span>
                    ) : (
                      <span
                        id="badge-doc-review-status"
                        className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-800 text-slate-300 border border-slate-700 flex items-center gap-1 shadow-xs"
                        title="Tài liệu chưa được đối soát"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                        <span>Chưa đối soát</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-400 flex items-center gap-2 mt-0.5">
                <span>Trạng thái đối soát dữ liệu bảng</span>
              </p>
            </div>
          </div>

          {/* Metrics & Actions Hierarchy */}
          <div className="flex items-center gap-3 shrink-0">
            {/* Quick Metrics Badges */}
            {ocrData?.tables && (
              <div className="hidden md:flex items-center gap-3 bg-slate-900/90 px-3 py-1.5 rounded-xl border border-slate-800 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400">Độ tin cậy TB:</span>
                  <span className="font-bold text-emerald-400">
                    {(metrics.avgConfidence * 100).toFixed(1)}%
                  </span>
                </div>
                <span className="text-slate-700">|</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400">Cần kiểm tra:</span>
                  <span
                    className={`font-bold ${
                      reviewStats.totalReviewCount > 0 ? 'text-amber-400' : 'text-slate-300'
                    }`}
                  >
                    {reviewStats.totalReviewCount}
                  </span>
                </div>
                <span className="text-slate-700">|</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400">Đã đối soát:</span>
                  <span className="font-bold text-blue-400">{metrics.reviewedCount}</span>
                </div>
              </div>
            )}

            {/* Secondary Action: Re-run OCR */}
            <button
              id="btn-rerun-ocr"
              onClick={handleRerunOcr}
              disabled={isRetryingOcr}
              className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 flex items-center gap-1.5 transition disabled:opacity-50"
              title="Kích hoạt lại tiến trình nhận dạng Azure AI"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRetryingOcr ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Chạy lại OCR</span>
            </button>

            {/* Primary Action 1: Complete Review */}
            <button
              id="btn-complete-review"
              onClick={handleCompleteReview}
              disabled={isCompletingReview || ocrData?.document?.review_status === 'REVIEWED'}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition ${
                ocrData?.document?.review_status === 'REVIEWED'
                  ? 'bg-emerald-950/40 text-emerald-400/80 border border-emerald-800/40 cursor-default'
                  : 'bg-emerald-950/80 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-800/80 shadow-xs'
              } disabled:opacity-60`}
              title={ocrData?.document?.review_status === 'REVIEWED' ? 'Tài liệu đã hoàn tất đối soát' : 'Đánh dấu tài liệu đã hoàn tất đối soát'}
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>{isCompletingReview ? 'Đang lưu...' : ocrData?.document?.review_status === 'REVIEWED' ? 'Đã hoàn tất đối soát' : 'Hoàn tất đối soát'}</span>
            </button>

            {/* Primary Action 2: Export Excel (.XLSX) */}
            <button
              id="btn-export-excel-dropdown"
              onClick={() => setShowExportModal(true)}
              disabled={isExportingExcel}
              className="px-3.5 py-1.5 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm shadow-emerald-600/30 flex items-center gap-1.5 transition disabled:opacity-50"
              title="Xuất bảng trích xuất sang định dạng Excel (.xlsx)"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>{isExportingExcel ? 'Đang xuất Excel...' : 'Xuất Excel (.xlsx)'}</span>
            </button>

            {/* Close Modal Button */}
            <button
              id="btn-close-ocr-workspace"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
              title="Đóng không gian làm việc"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* EXPORT OPTIONS MODAL */}
        {showExportModal && (
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl max-w-md w-full p-6 text-slate-100">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center font-bold">
                    <FileSpreadsheet className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-100">Xuất Excel (.xlsx)</h3>
                    <p className="text-xs text-slate-400">Tùy chọn chế độ giá trị ô tính toán</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowExportModal(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3 mb-6">
                <label
                  onClick={() => setExportMode('NORMALIZED')}
                  className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition ${
                    exportMode === 'NORMALIZED'
                      ? 'border-emerald-500 bg-emerald-950/40'
                      : 'border-slate-800 hover:bg-slate-800/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="exportMode"
                    value="NORMALIZED"
                    checked={exportMode === 'NORMALIZED'}
                    onChange={() => setExportMode('NORMALIZED')}
                    className="mt-1 text-emerald-600 focus:ring-emerald-500"
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-slate-100">Mode B — Normalized (Chuẩn hóa)</span>
                      <span className="text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded">Khuyên dùng</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Chuyển đổi số tiền, ngày tháng thành kiểu dữ liệu Excel chuyên dụng (dễ tính SUM, hàm công thức và lọc cột).
                    </p>
                  </div>
                </label>

                <label
                  onClick={() => setExportMode('ORIGINAL')}
                  className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition ${
                    exportMode === 'ORIGINAL'
                      ? 'border-emerald-500 bg-emerald-950/40'
                      : 'border-slate-800 hover:bg-slate-800/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="exportMode"
                    value="ORIGINAL"
                    checked={exportMode === 'ORIGINAL'}
                    onChange={() => setExportMode('ORIGINAL')}
                    className="mt-1 text-emerald-600 focus:ring-emerald-500"
                  />
                  <div>
                    <span className="font-bold text-sm text-slate-100">Mode A — Original (Dữ liệu gốc OCR)</span>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Giữ nguyên 100% văn bản chuỗi nhận dạng gốc từ Azure AI (phù hợp đối chiếu nguyên bản sao kê).
                    </p>
                  </div>
                </label>
              </div>

              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowExportModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-xl transition"
                >
                  Hủy
                </button>
                <button
                  type="button"
                  id="btn-confirm-export-excel"
                  onClick={() => handleExportExcel(exportMode)}
                  disabled={isExportingExcel}
                  className="px-5 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl shadow-sm shadow-emerald-600/30 flex items-center gap-2 transition disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{isExportingExcel ? 'Đang tạo Excel...' : 'Tải tệp .xlsx'}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* BLOCKING CELLS ERROR MODAL (REVIEW COMPLETION GATE) */}
        {blockingErrorModal && (
          <div
            id="modal-blocking-cells-gate"
            className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs"
          >
            <div className="bg-slate-900 border border-rose-800/80 rounded-2xl shadow-2xl max-w-lg w-full p-6 text-slate-100">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center justify-center font-bold">
                    <AlertCircle className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-100">Chưa thể hoàn tất đối soát</h3>
                    <p className="text-xs text-rose-300">
                      Còn {blockingErrorModal.blockingCount} ô dữ liệu có lỗi hoặc chưa được kiểm tra
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setBlockingErrorModal(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <p className="text-xs text-slate-300 mb-4 leading-relaxed">
                Hệ thống yêu cầu tất cả các ô có lỗi định dạng, xung đột hoặc trạng thái chờ xử lý phải được giải quyết hoặc xác nhận trước khi khóa trạng thái tài liệu.
              </p>

              {blockingErrorModal.blockingCells.length > 0 && (
                <div className="mb-5 max-h-48 overflow-y-auto space-y-1.5 pr-1">
                  {blockingErrorModal.blockingCells.slice(0, 5).map((b, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800 text-xs flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-200 truncate">
                          Trang {b.pageNumber || 1} · Dòng {(b.rowIndex ?? 0) + 1}: &quot;{b.rawValue || '—'}&quot;
                        </div>
                        <div className="text-[11px] text-rose-400 mt-0.5">{b.reason}</div>
                      </div>
                      <button
                        onClick={() => {
                          setBlockingErrorModal(null);
                          setSelectedCellId(b.cellId);
                          if (b.pageNumber) setSelectedPageNumber(b.pageNumber);
                          setTimeout(() => {
                            const el = document.getElementById(`cell-${b.cellId}`);
                            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }, 50);
                        }}
                        className="px-2.5 py-1 text-[11px] font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-md shrink-0 transition"
                      >
                        Kiểm tra
                      </button>
                    </div>
                  ))}
                  {blockingErrorModal.blockingCount > 5 && (
                    <div className="text-center text-[11px] text-slate-500 pt-1">
                      và {blockingErrorModal.blockingCount - 5} ô dữ liệu khác...
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setBlockingErrorModal(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-xl transition"
                >
                  Đóng
                </button>
                {blockingErrorModal.blockingCells.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const first = blockingErrorModal.blockingCells[0];
                      setBlockingErrorModal(null);
                      if (first?.cellId) {
                        setSelectedCellId(first.cellId);
                        if (first.pageNumber) setSelectedPageNumber(first.pageNumber);
                        setTimeout(() => {
                          const el = document.getElementById(`cell-${first.cellId}`);
                          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }, 50);
                      }
                    }}
                    className="px-5 py-2 text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white rounded-xl shadow-sm flex items-center gap-1.5 transition"
                  >
                    <span>Kiểm tra ô lỗi đầu tiên</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* NOTIFICATION BANNER */}
        {successMessage && (
          <div className="bg-emerald-500/10 border-b border-emerald-500/20 px-6 py-2 text-emerald-400 text-xs font-semibold flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-400" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* ========================================================= */}
        {/* WORKSPACE BODY WITH DRAGGABLE SPLIT PANE */}
        {/* ========================================================= */}
        {isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <div className="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-sm font-medium text-slate-400">Đang tải và phân tích dữ liệu OCR Azure AI...</p>
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-rose-500/10 text-rose-400 flex items-center justify-center mb-3">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h3 className="text-base font-bold text-slate-100 mb-1">Không thể tải dữ liệu OCR</h3>
            <p className="text-xs text-slate-400 max-w-md mb-4">{error}</p>
            <button
              onClick={loadOcrData}
              className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-semibold hover:bg-blue-500 transition"
            >
              Thử lại
            </button>
          </div>
        ) : (
          <div
            ref={splitContainerRef}
            id="ocr-workspace-split-container"
            className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden relative"
          >
            {/* ========================================================= */}
            {/* LEFT PANEL: PDF VIEWER */}
            {/* ========================================================= */}
            <div
              style={{ width: `${splitPercent}%` }}
              className="bg-slate-950 border-r border-slate-800 flex flex-col overflow-hidden relative shrink-0 min-w-[200px]"
            >
              {/* PDF Top Bar & Page Navigation */}
              <div className="px-4 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs text-slate-300 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="w-4 h-4 text-blue-400 shrink-0" />
                  <span className="font-semibold text-slate-200 truncate">Văn bản gốc</span>
                </div>

                {/* Page Navigation Selector */}
                {ocrData && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setSelectedPageNumber('ALL')}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold transition shrink-0 ${
                        selectedPageNumber === 'ALL'
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Tất cả
                    </button>
                  </div>
                )}
              </div>

              {/* PDF View Container */}
              <div className="flex-1 p-2 overflow-hidden flex items-center justify-center bg-slate-950 relative">
                {isPreviewLoading ? (
                  <div className="flex flex-col items-center gap-2 text-slate-400">
                    <LoadingSpinner size="md" />
                    <span className="text-xs">Đang tải tệp an toàn...</span>
                  </div>
                ) : previewUrl ? (
                  <div className="w-full h-full relative flex items-center justify-center">
                    <iframe
                      src={selectedPageNumber !== 'ALL' ? `${previewUrl}#page=${selectedPageNumber}` : previewUrl}
                      title="PDF Viewer"
                      className={`w-full h-full rounded-lg border border-slate-800 bg-white ${
                        isDragging ? 'pointer-events-none' : ''
                      }`}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Không có bản xem trước tệp.</p>
                )}
              </div>
            </div>

            {/* ========================================================= */}
            {/* DRAGGABLE DIVIDER (STABLE POINTER EVENTS + EXPANDED HIT AREA) */}
            {/* ========================================================= */}
            <div
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onDoubleClick={handleDividerDoubleClick}
              className={`hidden lg:flex relative w-2.5 items-center justify-center cursor-col-resize select-none shrink-0 group z-20 bg-slate-900 border-x border-slate-800 transition-colors ${
                isDragging ? 'bg-blue-600/50' : 'hover:bg-blue-600/30'
              }`}
              title="Kéo sang trái/phải để thay đổi kích thước khung (30% - 60%). Nhấp đúp để đặt lại 40/60."
            >
              {/* Expanded hit target ~12px */}
              <div className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize" />
              {/* Visual handle indicator */}
              <div
                className={`w-1 h-8 rounded-full transition-colors ${
                  isDragging ? 'bg-blue-400' : 'bg-slate-700 group-hover:bg-blue-400'
                }`}
              />
            </div>

            {/* ========================================================= */}
            {/* RIGHT PANEL: DATA & EDITING WORKSPACE */}
            {/* ========================================================= */}
            <div
              style={{ width: `calc(${100 - splitPercent}% - 0.625rem)` }}
              className="flex-1 flex flex-col bg-slate-900 overflow-hidden min-w-[300px]"
            >
              {/* ========================================================= */}
              {/* THÔNG TIN SAO KÊ (DYNAMIC DATA-DRIVEN METADATA PANEL)     */}
              {/* ========================================================= */}
              {metadataItems.length > 0 && (
                <section
                  id="ocr-statement-metadata-panel"
                  className="px-4 py-2.5 bg-slate-950/95 border-b border-slate-800 text-xs shrink-0 transition-all"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded-md bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold">
                        <Info className="w-3.5 h-3.5" />
                      </div>
                      <span className="font-bold text-xs uppercase tracking-wider text-slate-300">
                        Thông tin sao kê
                      </span>
                      {coreDisplayItems.length > 0 && (
                        <span className="text-[10px] text-slate-500 font-mono">
                          ({coreDisplayItems.length} trường chính)
                        </span>
                      )}
                    </div>

                    {additionalItems.length > 0 && (
                      <button
                        type="button"
                        id="btn-toggle-additional-metadata"
                        onClick={() => setShowAdditionalMetadata(!showAdditionalMetadata)}
                        className="text-[11px] font-semibold text-slate-400 hover:text-slate-200 flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-900 border border-slate-800 hover:bg-slate-800 transition"
                        title="Xem thông tin bổ sung trích xuất từ tài liệu"
                      >
                        <span>Thông tin khác ({additionalItems.length})</span>
                        {showAdditionalMetadata ? (
                          <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                        )}
                      </button>
                    )}
                  </div>

                  {/* Responsive Core Grid */}
                  {coreDisplayItems.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2">
                      {coreDisplayItems.map((item, idx) => {
                        const confStyle = getConfidenceColor(item.confidence);
                        return (
                          <div
                            key={item.id || idx}
                            className={`bg-slate-900/90 p-2 rounded-lg border ${confStyle.border} transition flex flex-col justify-between min-h-[50px] group`}
                          >
                            <div className="flex items-center justify-between gap-1 mb-0.5">
                              <span
                                className="text-[10px] font-medium text-slate-400 uppercase tracking-wider truncate"
                                title={item.label}
                              >
                                {item.label}
                              </span>
                              <span
                                className={`text-[9px] font-mono px-1 py-0.2 rounded shrink-0 flex items-center gap-1 ${confStyle.badge}`}
                                title={`Độ tin cậy OCR: ${(item.confidence * 100).toFixed(1)}% (P${item.sourcePage || 1})`}
                              >
                                <span className={`w-1.5 h-1.5 rounded-full ${confStyle.dot}`} />
                                {(item.confidence * 100).toFixed(0)}%
                              </span>
                            </div>
                            <div className="flex items-baseline justify-between gap-1">
                              <span
                                className="font-bold text-slate-100 text-xs truncate select-all"
                                title={item.value}
                              >
                                {item.value}
                              </span>
                              {item.status === 'CONFLICT' && (
                                <span
                                  className="text-[9px] font-semibold text-amber-300 bg-amber-950/80 border border-amber-800/80 px-1 py-0.2 rounded shrink-0"
                                  title="Phát hiện sự khác nhau về giá trị giữa các trang"
                                >
                                  Xung đột
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Collapsible Additional Metadata Area */}
                  {showAdditionalMetadata && additionalItems.length > 0 && (
                    <div className="mt-2.5 pt-2 border-t border-slate-800/80">
                      <div className="text-[11px] font-bold text-slate-400 mb-1.5 flex items-center gap-1.5">
                        <span>Chi tiết mở rộng:</span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2">
                        {additionalItems.map((item, idx) => {
                          const confStyle = getConfidenceColor(item.confidence);
                          const isConflict = item.status === 'CONFLICT';
                          return (
                            <div
                              key={item.id || idx}
                              className={`bg-slate-900/60 p-2 rounded-lg border ${
                                isConflict ? 'border-amber-700/60 bg-amber-950/20' : 'border-slate-800/80'
                              } transition`}
                            >
                              <div className="flex items-center justify-between gap-1 mb-0.5">
                                <span
                                  className="text-[10px] text-slate-400 truncate"
                                  title={item.label || item.rawLabel}
                                >
                                  {item.label || item.rawLabel}
                                </span>
                                <span
                                  className={`text-[9px] font-mono px-1 py-0.2 rounded shrink-0 flex items-center gap-1 ${confStyle.badge}`}
                                  title={`Độ tin cậy OCR: ${(item.confidence * 100).toFixed(1)}%`}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full ${confStyle.dot}`} />
                                  {(item.confidence * 100).toFixed(0)}%
                                </span>
                              </div>
                              <div className="flex items-baseline justify-between gap-1">
                                <span className="font-semibold text-slate-300 text-xs truncate" title={item.value}>
                                  {item.value}
                                </span>
                                {isConflict && (
                                  <span
                                    className="text-[9px] text-amber-300 font-semibold bg-amber-950/80 border border-amber-800/80 px-1 py-0.2 rounded shrink-0 flex items-center gap-0.5"
                                    title={
                                      item.alternatives?.length
                                        ? `Các biến thể khác: ${item.alternatives.map((a) => a.rawValue).join(', ')}`
                                        : 'Xung đột giữa các trang'
                                    }
                                  >
                                    <AlertTriangle className="w-2.5 h-2.5 text-amber-400" />
                                    Xung đột
                                  </span>
                                )}
                              </div>
                              {item.alternatives && item.alternatives.length > 0 && (
                                <div className="mt-1 pt-1 border-t border-slate-800/60 text-[10px] text-slate-400 space-y-0.5">
                                  <span className="text-[9px] text-slate-500 block">Biến thể khác:</span>
                                  {item.alternatives.map((alt, aIdx) => (
                                    <div key={aIdx} className="truncate text-slate-300">
                                      • {alt.rawValue} <span className="text-slate-500 font-mono">(P{alt.sourcePage})</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* BACKDROP FOR TABLE FOCUS MODE */}
              {isTableFocused && (
                <div className="fixed inset-0 bg-black/75 backdrop-blur-xs z-54 transition-opacity" />
              )}

              {/* TABLE WORKSPACE CONTAINER (NORMAL SPLIT PANE OR FIXED FOCUS OVERLAY) */}
              <div
                className={
                  isTableFocused
                    ? 'fixed inset-2 sm:inset-4 md:inset-5 z-55 flex flex-col bg-slate-950 border border-slate-700/90 rounded-2xl shadow-2xl shadow-black/90 overflow-hidden'
                    : 'flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden relative'
                }
              >
                {/* DEDICATED HEADER FOR FOCUS MODE */}
                {isTableFocused && (
                  <div className="px-5 py-2.5 bg-slate-900 border-b border-slate-800 flex items-center gap-2.5 shrink-0">
                    <div className="w-7 h-7 rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/30 flex items-center justify-center shrink-0">
                      <FileSpreadsheet className="w-4 h-4 text-blue-400" />
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-bold text-xs sm:text-sm text-slate-100 truncate">
                        Bảng dữ liệu trích xuất
                      </span>
                      <span className="text-[11px] text-slate-400 font-mono bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700/60 shrink-0">
                        {displayedRows.length} dòng · {columnCount} cột
                      </span>
                    </div>
                  </div>
                )}

              {/* TABLE SWITCHER & CONTROL BAR */}
              <div className="p-3 bg-slate-900 border-b border-slate-800 space-y-2.5 shrink-0">
                {/* Scalable Table Selector Navigator (Rendered only in legacy fallback mode) */}
                {!isUnified && ocrData?.tables && ocrData.tables.length > 0 && (
                  <div className="flex items-center gap-2 bg-slate-950 p-2 rounded-xl border border-slate-800 text-xs">
                    <span className="font-bold text-slate-400 flex items-center gap-1.5 shrink-0 pl-1">
                      <Layers className="w-3.5 h-3.5 text-blue-400" />
                      <span className="hidden sm:inline">Bảng:</span>
                    </span>

                    {/* Previous Table Button */}
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedTableIndex > 0) {
                          setSelectedTableIndex(selectedTableIndex - 1);
                          setSelectedCellId(null);
                        }
                      }}
                      disabled={selectedTableIndex === 0}
                      className="p-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition shrink-0 flex items-center gap-1 px-2"
                      title="Bảng trước"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      <span className="hidden sm:inline text-[11px] font-semibold">Bảng trước</span>
                    </button>

                    {/* Scalable Select Dropdown */}
                    <div className="relative flex-1 min-w-0">
                      <select
                        value={selectedTableIndex}
                        onChange={(e) => {
                          setSelectedTableIndex(Number(e.target.value));
                          setSelectedCellId(null);
                        }}
                        className="w-full appearance-none bg-slate-900 border border-slate-800 rounded-lg pl-3 pr-8 py-1.5 text-xs font-semibold text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer truncate"
                      >
                        {ocrData.tables.map((t, idx) => (
                          <option key={t.id || idx} value={idx} className="bg-slate-900 text-slate-100">
                            Bảng #{t.tableIndex + 1} · Trang {t.pageNumber} · {t.rowCount} dòng · {t.columnCount} cột
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5 pointer-events-none" />
                    </div>

                    {/* Next Table Button */}
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedTableIndex < ocrData.tables.length - 1) {
                          setSelectedTableIndex(selectedTableIndex + 1);
                          setSelectedCellId(null);
                        }
                      }}
                      disabled={selectedTableIndex >= ocrData.tables.length - 1}
                      className="p-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition shrink-0 flex items-center gap-1 px-2"
                      title="Bảng sau"
                    >
                      <span className="hidden sm:inline text-[11px] font-semibold">Bảng sau</span>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* Review Queue Navigation Bar */}
                <div className="flex items-center justify-between gap-2 bg-slate-950 p-2 rounded-xl border border-slate-800 text-xs flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-300 flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
                      <span>Hàng đợi đối soát:</span>
                    </span>
                    <span
                      id="badge-queue-count"
                      className={`px-2 py-0.5 rounded-full font-bold text-[11px] ${
                        reviewQueueCells.length > 0
                          ? 'bg-rose-950/80 text-rose-300 border border-rose-800/80'
                          : 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/80'
                      }`}
                    >
                      {reviewQueueCells.length > 0 ? `${reviewQueueCells.length} ô cần xử lý` : '0 ô cần xử lý (Sạch)'}
                    </span>
                  </div>

                  {reviewQueueCells.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        id="btn-queue-prev"
                        onClick={handlePrevIssue}
                        className="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 flex items-center gap-1 text-[11px] font-semibold transition cursor-pointer"
                        title="Chuyển đến ô cần đối soát trước đó"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                        <span>Trước</span>
                      </button>
                      <span className="text-[11px] text-slate-400 font-mono px-2">
                        {currentIssueIndex + 1} / {reviewQueueCells.length}
                      </span>
                      <button
                        type="button"
                        id="btn-queue-next"
                        onClick={handleNextIssue}
                        className="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 flex items-center gap-1 text-[11px] font-semibold transition cursor-pointer"
                        title="Chuyển đến ô cần đối soát tiếp theo"
                      >
                        <span>Sau</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Filter & Search Bar */}
                <div className="flex items-center gap-2.5 flex-wrap">
                  {/* Category Filter Tabs */}
                  <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs shrink-0">
                    {(
                      [
                        { id: 'ALL', label: 'Tất cả' },
                        { id: 'REVIEW_REQUIRED', label: 'Cần kiểm tra' },
                        { id: 'AUTO_RESOLVED', label: 'Đã AI xử lý' },
                        { id: 'HUMAN_RESOLVED', label: 'Đã người dùng xử lý' },
                        { id: 'WARNING_ONLY', label: 'Cảnh báo' },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setReviewFilterTab(tab.id)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition cursor-pointer ${
                          reviewFilterTab === tab.id
                            ? 'bg-blue-600 text-white shadow-xs'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  <div className="relative flex-1 min-w-[160px]">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                    <input
                      type="text"
                      placeholder="Tìm nội dung ô..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-8 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="absolute right-2 top-2 text-slate-400 hover:text-white"
                        title="Xóa tìm kiếm"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Focus Mode Toggle Button */}
                  <button
                    type="button"
                    onClick={() => setIsTableFocused(!isTableFocused)}
                    className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition shrink-0 cursor-pointer ${
                      isTableFocused
                        ? 'bg-blue-600/20 text-blue-300 border-blue-500/50 hover:bg-blue-600/30'
                        : 'bg-slate-950 text-slate-300 border-slate-800 hover:bg-slate-900 hover:text-white hover:border-slate-700'
                    }`}
                    title={isTableFocused ? 'Thu nhỏ bảng' : 'Phóng to bảng'}
                    aria-label={isTableFocused ? 'Thu nhỏ bảng' : 'Phóng to bảng'}
                  >
                    {isTableFocused ? (
                      <>
                        <Minimize2 className="w-3.5 h-3.5 text-blue-400" />
                        <span className="inline">Thu nhỏ</span>
                      </>
                    ) : (
                      <>
                        <Maximize2 className="w-3.5 h-3.5 text-slate-400" />
                        <span className="hidden sm:inline">Phóng to</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* --------------------------------------------------------- */}
              {/* ADVANCED STICKY DATA GRID & TABLE */}
              {/* --------------------------------------------------------- */}
              <div className="flex-1 min-h-0 min-w-0 flex flex-col p-3 bg-slate-950 overflow-hidden">
                <style>{`
                  .table-viewport-scroll {
                    scrollbar-width: thin;
                    scrollbar-color: #334155 #090d16;
                  }
                  .table-viewport-scroll::-webkit-scrollbar {
                    width: 8px;
                    height: 10px;
                  }
                  .table-viewport-scroll::-webkit-scrollbar-track {
                    background: #090d16;
                    border-radius: 9999px;
                  }
                  .table-viewport-scroll::-webkit-scrollbar-thumb {
                    background: #334155;
                    border-radius: 9999px;
                    border: 2px solid #090d16;
                  }
                  .table-viewport-scroll::-webkit-scrollbar-thumb:hover {
                    background: #3b82f6;
                  }
                `}</style>
                {isTableEmpty ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-500 py-12 border border-slate-800 rounded-xl">
                    <FileSpreadsheet className="w-10 h-10 mb-2 opacity-40" />
                    <p className="text-xs font-medium">Không tìm thấy dữ liệu bảng trong tài liệu này.</p>
                  </div>
                ) : (
                  <div className="flex-1 min-h-0 min-w-0 flex flex-col relative">
                    {/* A. TABLE VIEWPORT (Sticky header & rows with native horizontal scroll) */}
                    <div
                      ref={tableScrollRef}
                      className="table-viewport-scroll flex-1 min-h-0 min-w-0 overflow-auto relative border border-slate-800 rounded-xl bg-slate-900/40 shadow-xs focus:outline-none"
                    >
                      <table
                        ref={tableRef}
                        className="min-w-full w-max text-left border-collapse text-xs"
                      >
                      {/* STICKY HEADER */}
                      <thead>
                        <tr className="bg-slate-900 text-slate-200">
                          {/* Top-left Sticky Index Header (#) */}
                          <th className="sticky top-0 left-0 z-30 bg-slate-900 border-b border-r border-slate-800 py-2.5 px-3 w-12 text-center font-bold text-slate-400 shadow-xs">
                            #
                          </th>

                          {/* Dynamic Column Headers */}
                          {effectiveHeaders.map((head, hIdx) => (
                            <th
                              key={hIdx}
                              className="sticky top-0 z-20 bg-slate-900 border-b border-r border-slate-800 py-2.5 px-3.5 font-bold uppercase tracking-wider text-[11px] text-slate-200 min-w-[150px] shadow-xs"
                            >
                              {head}
                            </th>
                          ))}

                          {/* System "Trang" Column Header in Unified Mode */}
                          {isUnified && (
                            <th className="sticky top-0 z-20 bg-slate-900 border-b border-r border-slate-800 py-2.5 px-3 w-20 text-center font-bold uppercase tracking-wider text-[11px] text-slate-400 shadow-xs">
                              Trang
                            </th>
                          )}

                          {/* Sticky Actions Header (Legacy Fallback Only) */}
                          {!isUnified && (
                            <th className="sticky top-0 right-0 z-20 bg-slate-900 border-b border-slate-800 py-2.5 px-2 w-14 text-center font-bold text-slate-400 shadow-xs">
                              Thao tác
                            </th>
                          )}
                        </tr>
                      </thead>

                      {/* TABLE BODY */}
                      <tbody className="divide-y divide-slate-800/60 bg-slate-900/60">
                        {displayedRows.map((row: any, rIdx: number) => (
                          <tr key={row.id || (row as UnifiedRow).sourceRowId || rIdx} className="hover:bg-blue-950/30 transition group">
                            {/* STICKY INDEX COLUMN */}
                            <td className="sticky left-0 z-10 bg-slate-900 py-2 px-3 text-center text-slate-400 font-mono text-[11px] border-r border-slate-800/80">
                              {isUnified ? (row as UnifiedRow).displayRowIndex + 1 : (row as ExtractedRow).rowIndex + 1}
                            </td>

                            {/* DYNAMIC CELL RENDERING BY STRUCTURAL COLUMN INDEX */}
                            {Array.from({ length: columnCount }, (_, colIdx) => {
                              const cell: any = isUnified
                                ? (row.cells as UnifiedCell[])?.find((c) => c.canonicalColumnIndex === colIdx)
                                : (row.cells as ExtractedCell[])?.find((c) => Number(c.columnIndex) === colIdx);

                              if (!cell || (isUnified && cell.isPlaceholder)) {
                                return (
                                  <td
                                    key={colIdx}
                                    className="py-2 px-3 border-r border-slate-800/60 last:border-r-0 min-w-[150px] select-none"
                                  >
                                    <span className="text-slate-600 italic">—</span>
                                  </td>
                                );
                              }

                              const cellState = deriveCellState(cell);
                              const isEditing = editingCellId === cell.id;
                              const isSelected = selectedCellId === cell.id;
                              const isConfirming = confirmingCellId === cell.id;

                              const qa = cell.qualityAssessment;
                              const valIssues = (cell as any).validationIssues || [];
                              const hasConf = typeof cell.confidence === 'number' && cell.confidence !== null;
                              const isLocal = (cell as any).confidenceSource === 'LOCAL_HEURISTIC' || !hasConf;
                              const confDisplay = isLocal
                                ? ((cell as any).structureConfidence ? `Cấu trúc ${(Number((cell as any).structureConfidence) * 100).toFixed(0)}%` : 'Trực tiếp (PDF)')
                                : `${(cell.confidence! * 100).toFixed(1)}%`;

                              let cellTooltip = `Giá trị hiện tại: ${cell.rawValue ?? cell.normalizedValue ?? '—'}`;
                              if ((cell as any).originalRawValue && (cell as any).originalRawValue !== cell.rawValue) {
                                cellTooltip += `\nGiá trị gốc: ${(cell as any).originalRawValue}`;
                              }
                              if ((cell as any).resolutionMethod) {
                                cellTooltip += `\nPhương thức: ${(cell as any).resolutionMethod}`;
                              }
                              if (valIssues.length > 0) {
                                cellTooltip += `\nVấn đề phát hiện:\n` + valIssues.map((i: any) => `• [${i.code}] ${i.message}`).join('\n');
                              } else if (qa?.reasons && qa.reasons.length > 0) {
                                cellTooltip += `\nĐánh giá chất lượng:\n` + qa.reasons.map((r: any) => `• ${formatQualityReason(r)}`).join('\n');
                              }
                              cellTooltip += `\nĐộ tin cậy OCR: ${confDisplay}`;

                              // Background & highlight class based on derived cellState
                              let bgHighlightClass = 'hover:bg-slate-800/40';
                              if (isSelected) {
                                bgHighlightClass = 'bg-blue-950/80 ring-2 ring-blue-500 z-5';
                              } else if (cellState === 'REVIEW_REQUIRED') {
                                bgHighlightClass = 'bg-rose-950/40 border-b border-b-rose-700/60 hover:bg-rose-950/60';
                              } else if (cellState === 'WARNING_ONLY') {
                                bgHighlightClass = 'bg-amber-950/25 border-b border-b-amber-700/50 hover:bg-amber-950/40';
                              } else if (cellState === 'AUTO_RESOLVED') {
                                bgHighlightClass = 'bg-teal-950/20 border-b border-b-teal-800/40 hover:bg-teal-950/30';
                              } else if (cellState === 'HUMAN_RESOLVED') {
                                bgHighlightClass = 'bg-cyan-950/25 border-b border-b-cyan-800/50 hover:bg-cyan-950/35';
                              }

                              return (
                                <td
                                  key={cell.id || colIdx}
                                  id={cell.id ? `cell-${cell.id}` : undefined}
                                  onClick={() => {
                                    if (cell.id) {
                                      setSelectedCellId(cell.id);
                                      if (cell.sourcePage) {
                                        setSelectedPageNumber(cell.sourcePage);
                                      }
                                    }
                                  }}
                                  onDoubleClick={() => !cell.isPlaceholder && cell.id && startEditCell(cell)}
                                  className={`py-2 px-3 border-r border-slate-800/60 last:border-r-0 relative transition cursor-pointer min-w-[150px] ${bgHighlightClass}`}
                                >
                                  {isEditing ? (
                                    <div className="flex flex-col gap-1 min-w-[200px]" onClick={(e) => e.stopPropagation()}>
                                      <div className="flex items-center gap-1.5">
                                        <input
                                          id={`input-edit-${cell.id}`}
                                          type="text"
                                          value={editValue}
                                          onChange={(e) => {
                                            setEditValue(e.target.value);
                                            if (cellEditError) setCellEditError(null);
                                          }}
                                          autoFocus
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') saveCellEdit();
                                            if (e.key === 'Escape') cancelEditCell();
                                          }}
                                          disabled={isSavingCell}
                                          className={`flex-1 px-2 py-1 text-xs border rounded bg-slate-950 text-slate-100 focus:outline-none ring-1 ${
                                            cellEditError ? 'border-rose-500 ring-rose-500' : 'border-blue-500 ring-blue-500'
                                          }`}
                                        />
                                        <select
                                          value={editType}
                                          onChange={(e: any) => setEditType(e.target.value)}
                                          disabled={isSavingCell}
                                          className="text-[10px] bg-slate-800 border border-slate-700 rounded px-1 py-1 text-slate-200"
                                        >
                                          <option value="TEXT">Chữ</option>
                                          <option value="MONEY">Tiền VND</option>
                                          <option value="DATE">Ngày</option>
                                          <option value="NUMBER">Số</option>
                                        </select>
                                        <button
                                          id={`btn-save-${cell.id}`}
                                          onClick={saveCellEdit}
                                          disabled={isSavingCell}
                                          className="p-1 bg-emerald-600 text-white rounded hover:bg-emerald-500 transition disabled:opacity-50"
                                          title="Lưu (Enter)"
                                        >
                                          {isSavingCell ? <LoadingSpinner size="xs" /> : <Check className="w-3.5 h-3.5" />}
                                        </button>
                                        <button
                                          id={`btn-cancel-${cell.id}`}
                                          onClick={cancelEditCell}
                                          disabled={isSavingCell}
                                          className="p-1 bg-slate-800 text-slate-400 rounded hover:text-white transition disabled:opacity-50"
                                          title="Hủy (Esc)"
                                        >
                                          <X className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                      {cellEditError && (
                                        <div className="text-[10px] text-rose-300 font-medium flex items-center gap-1 bg-rose-950/90 px-1.5 py-0.5 rounded border border-rose-800/80">
                                          <AlertCircle className="w-3 h-3 text-rose-400 shrink-0" />
                                          <span>{cellEditError}</span>
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="flex items-center justify-between gap-1.5 group/cell">
                                      <span
                                        className={`font-medium whitespace-nowrap ${
                                          cell.cellType === 'MONEY'
                                            ? 'font-mono text-slate-200 font-semibold'
                                            : cell.cellType === 'DATE'
                                            ? 'font-mono text-slate-300'
                                            : 'text-slate-200'
                                        }`}
                                        title={cellTooltip}
                                      >
                                        {cell.rawValue ?? cell.normalizedValue ?? (
                                          <span className="text-slate-600 italic">—</span>
                                        )}
                                      </span>

                                      {/* Status Badges & Quick Action Controls */}
                                      <div className="flex items-center gap-1 shrink-0 ml-1">
                                        {/* State D: HUMAN_RESOLVED Badge */}
                                        {cellState === 'HUMAN_RESOLVED' && (
                                          <span
                                            className="flex items-center text-[10px] text-cyan-300 font-medium bg-cyan-950/80 px-1.5 py-0.5 rounded border border-cyan-700/60 shadow-xs"
                                            title={`Người dùng đã xử lý${(cell as any).originalRawValue ? ` (Giá trị gốc: ${(cell as any).originalRawValue})` : ''}`}
                                          >
                                            <ShieldCheck className="w-2.5 h-2.5 mr-0.5 text-cyan-400 shrink-0" />
                                            Đã đối soát
                                          </span>
                                        )}

                                        {/* State B: AUTO_RESOLVED Badge */}
                                        {cellState === 'AUTO_RESOLVED' && (
                                          <span
                                            className="flex items-center text-[10px] text-teal-300 font-medium bg-teal-950/70 px-1.5 py-0.5 rounded border border-teal-800/60 shadow-xs"
                                            title={`Đã tự động giải quyết bằng ${(cell as any).resolutionMethod || 'AI'}${
                                              (cell as any).originalRawValue ? ` (Giá trị gốc: ${(cell as any).originalRawValue})` : ''
                                            }`}
                                          >
                                            <Sparkles className="w-2.5 h-2.5 mr-0.5 text-teal-400 shrink-0" />
                                            {(cell as any).resolutionMethod === 'SECONDARY_OCR'
                                              ? 'OCR lại'
                                              : (cell as any).resolutionMethod === 'SECONDARY_OCR_ENHANCED'
                                              ? 'OCR nâng cao'
                                              : (cell as any).resolutionMethod === 'GEMINI'
                                              ? 'AI Thẩm định'
                                              : 'AI xử lý'}
                                          </span>
                                        )}

                                        {/* State C: REVIEW_REQUIRED Badge */}
                                        {cellState === 'REVIEW_REQUIRED' && (
                                          <span
                                            className="flex items-center text-[10px] text-rose-200 font-semibold bg-rose-950/90 px-1.5 py-0.5 rounded border border-rose-700/80 shadow-xs"
                                            title={cellTooltip}
                                          >
                                            <AlertCircle className="w-3 h-3 mr-0.5 text-rose-400 shrink-0" />
                                            Cần kiểm tra
                                          </span>
                                        )}

                                        {/* State E: WARNING_ONLY Badge */}
                                        {cellState === 'WARNING_ONLY' && (
                                          <span
                                            className="flex items-center text-[10px] text-amber-200 font-semibold bg-amber-950/80 px-1.5 py-0.5 rounded border border-amber-700/70 shadow-xs"
                                            title={cellTooltip}
                                          >
                                            <AlertTriangle className="w-3 h-3 mr-0.5 text-amber-400 shrink-0" />
                                            Cảnh báo
                                          </span>
                                        )}

                                        {/* Action: Confirm As-Is for cells needing review or warning */}
                                        {!cell.isPlaceholder && (cellState === 'REVIEW_REQUIRED' || cellState === 'WARNING_ONLY') && (
                                          <button
                                            id={`btn-confirm-${cell.id}`}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleConfirmCell(cell);
                                            }}
                                            disabled={isConfirming}
                                            className="p-0.5 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/60 rounded transition flex items-center disabled:opacity-50"
                                            title="Xác nhận giá trị hiện tại là đúng (Confirm As-Is)"
                                          >
                                            {isConfirming ? (
                                              <LoadingSpinner size="xs" />
                                            ) : (
                                              <CheckCircle2 className="w-3.5 h-3.5" />
                                            )}
                                          </button>
                                        )}

                                        {/* Action: Start Inline Edit (Never for placeholders) */}
                                        {!cell.isPlaceholder && (
                                          <button
                                            id={`btn-edit-${cell.id}`}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              startEditCell(cell);
                                            }}
                                            className="opacity-0 group-hover/cell:opacity-100 p-0.5 text-slate-400 hover:text-blue-400 transition"
                                            title="Sửa ô này"
                                          >
                                            <Edit2 className="w-3 h-3" />
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </td>
                              );
                            })}

                            {/* System "Trang" Column in Unified Mode */}
                            {isUnified && (
                              <td className="py-2 px-3 text-center border-r border-slate-800/60 last:border-r-0 w-20 shrink-0 select-none">
                                <span
                                  className="px-2 py-0.5 rounded-md text-[11px] font-mono font-medium bg-slate-800/70 text-slate-400 border border-slate-700/50"
                                  title={`Trang ${(row as UnifiedRow).sourcePage}`}
                                >
                                  P{(row as UnifiedRow).sourcePage}
                                </span>
                              </td>
                            )}

                            {/* Row Actions (Legacy Fallback Only) */}
                            {!isUnified && (
                              <td className="py-2 px-2 text-center">
                                <button
                                  onClick={() => handleDeleteRow(activeTable, row.rowIndex)}
                                  className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-400 hover:bg-rose-950/50 rounded transition"
                                  title="Xóa dòng"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* ========================================================= */}
                  {/* SELECTED CELL INSPECTOR PANEL */}
                  {/* ========================================================= */}
                  {selectedCell && (
                    <div className="bg-slate-900/95 border-t border-slate-800 px-4 py-2 flex items-center justify-between gap-4 text-xs text-slate-300 shrink-0">
                      <div className="flex items-center gap-3 min-w-0 flex-wrap">
                        <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                          <Eye className="w-3.5 h-3.5 text-blue-400" />
                          <span>Chi tiết ô:</span>
                          <span className="font-mono text-blue-400">
                            P{selectedCell.sourcePage || 1} · {selectedCell.rawValue || '—'}
                          </span>
                        </div>

                        {/* State Pill */}
                        {(() => {
                          const state = deriveCellState(selectedCell);
                          if (state === 'HUMAN_RESOLVED') {
                            return (
                              <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-cyan-950 text-cyan-300 border border-cyan-800 flex items-center gap-1">
                                <ShieldCheck className="w-3 h-3 text-cyan-400" />
                                Đã người dùng xử lý (HUMAN)
                              </span>
                            );
                          }
                          if (state === 'AUTO_RESOLVED') {
                            return (
                              <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-teal-950 text-teal-300 border border-teal-800 flex items-center gap-1">
                                <Sparkles className="w-3 h-3 text-teal-400" />
                                Đã AI xử lý ({(selectedCell as any).resolutionMethod || 'AI'})
                              </span>
                            );
                          }
                          if (state === 'REVIEW_REQUIRED') {
                            return (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-950 text-rose-300 border border-rose-800 flex items-center gap-1">
                                <AlertCircle className="w-3 h-3 text-rose-400" />
                                Cần kiểm tra
                              </span>
                            );
                          }
                          if (state === 'WARNING_ONLY') {
                            return (
                              <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-950 text-amber-300 border border-amber-800 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3 text-amber-400" />
                                Cảnh báo
                              </span>
                            );
                          }
                          return (
                            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-800 text-slate-300 border border-slate-700">
                              Hợp lệ (CLEAN)
                            </span>
                          );
                        })()}

                        {/* Provenance: Original vs Current Value */}
                        {(selectedCell as any).originalRawValue && (selectedCell as any).originalRawValue !== selectedCell.rawValue && (
                          <div className="flex items-center gap-1 text-[11px] text-slate-400">
                            <span>Giá trị gốc:</span>
                            <span className="font-mono text-slate-300 line-through">
                              {(selectedCell as any).originalRawValue}
                            </span>
                            <span>→</span>
                            <span className="font-mono text-emerald-400 font-semibold">
                              {selectedCell.rawValue}
                            </span>
                          </div>
                        )}

                        {/* Coordinates & Source Unit */}
                        {(selectedCell as any).coordinateUnit && (
                          <div className="text-[11px] text-slate-400 flex items-center gap-1 font-mono">
                            <span>Đơn vị: {(selectedCell as any).coordinateUnit}</span>
                            {(selectedCell as any).boundingPolygon && (
                              <span className="text-slate-500" title={JSON.stringify((selectedCell as any).boundingPolygon)}>
                                [tọa độ vùng nguồn]
                              </span>
                            )}
                          </div>
                        )}

                        {/* Validation Issues summary */}
                        {(selectedCell as any).validationIssues && (selectedCell as any).validationIssues.length > 0 && (
                          <div className="flex items-center gap-1 text-[11px] text-rose-300 bg-rose-950/60 px-2 py-0.5 rounded border border-rose-900/60">
                            <AlertCircle className="w-3 h-3 text-rose-400 shrink-0" />
                            <span>{(selectedCell as any).validationIssues.map((i: any) => i.message).join('; ')}</span>
                          </div>
                        )}
                      </div>

                      {/* Quick Action Button for Selected Cell */}
                      <div className="flex items-center gap-2 shrink-0">
                        {!selectedCell.isPlaceholder && (
                          <button
                            type="button"
                            onClick={() => startEditCell(selectedCell)}
                            className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md font-medium flex items-center gap-1 transition"
                          >
                            <Edit2 className="w-3 h-3" />
                            <span>Chỉnh sửa</span>
                          </button>
                        )}
                        {!selectedCell.isPlaceholder && (deriveCellState(selectedCell) === 'REVIEW_REQUIRED' || deriveCellState(selectedCell) === 'WARNING_ONLY') && (
                          <button
                            type="button"
                            onClick={() => handleConfirmCell(selectedCell)}
                            disabled={confirmingCellId === selectedCell.id}
                            className="px-2.5 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-md font-medium flex items-center gap-1 transition disabled:opacity-50"
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            <span>Xác nhận giá trị này</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                </div>
              )}
            </div>

              {/* FOOTER CAPTION & QUALITY LEGEND */}
              <div className="px-4 py-2 bg-slate-950 border-t border-slate-800 flex flex-col gap-1.5 text-xs text-slate-400 shrink-0">
                <div className="flex items-center gap-4 flex-wrap">
                  <span className="flex items-center gap-1.5 text-[11px] text-slate-400" title="Dữ liệu đồng nhất về cấu trúc, định dạng và độ tin cậy">
                    <span className="w-2 h-2 rounded-full bg-slate-500"></span>
                    Không phát hiện bất thường
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-amber-300" title="Có dấu hiệu bất thường về cấu trúc hoặc độ tin cậy cần người dùng xem xét">
                    <AlertTriangle className="w-3 h-3 text-amber-400" />
                    Cần kiểm tra
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-rose-400" title="Độ tin cậy rất thấp hoặc chứa nhiều dấu hiệu bất thường">
                    <AlertCircle className="w-3 h-3 text-rose-400" />
                    Ưu tiên kiểm tra
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-emerald-300" title="Đã được người dùng kiểm tra hoặc xác nhận">
                    <ShieldCheck className="w-3 h-3 text-emerald-400" />
                    Đã kiểm tra
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 leading-normal">
                  <span className="text-slate-500 font-medium">Ghi chú: </span>
                  Độ tin cậy OCR là tín hiệu hỗ trợ đối soát. Hệ thống sẽ chủ động đánh dấu những nội dung cần lưu ý để bạn kiểm tra nhanh trước khi hoàn tất.
                </div>
              </div>
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
