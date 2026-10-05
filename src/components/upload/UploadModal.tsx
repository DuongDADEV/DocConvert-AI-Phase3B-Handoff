import React, { useState, useRef, useEffect } from 'react';
import {
  UploadCloud,
  FileText,
  X,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Sparkles,
  ShieldCheck,
  FileType,
  FileSpreadsheet,
  Check,
  Coins,
  ArrowRight,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../services/api';
import { ErrorAlert } from '../common/ErrorAlert';
import { DocumentItem, PreflightDetails } from '../../types';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (documentId: string) => void;
  resumeDocumentId?: string | null;
}

type ModalStep = 'UPLOAD' | 'PREFLIGHT_LOADING' | 'CONFIRMATION';

export const UploadModal: React.FC<UploadModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  resumeDocumentId,
}) => {
  const { quota, updateQuota } = useAuth();
  const [step, setStep] = useState<ModalStep>('UPLOAD');
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflightData, setPreflightData] = useState<{
    document: DocumentItem;
    pageCount: number;
    summary: PreflightDetails['summary'];
    estimatedCredits: number;
  } | null>(null);
  const [outputType, setOutputType] = useState<'EXCEL' | 'WORD'>('EXCEL');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle Resume Preflight flow when resumeDocumentId is provided
  useEffect(() => {
    let active = true;
    const isValidResumeId = typeof resumeDocumentId === 'string' &&
      resumeDocumentId.trim() !== '' &&
      resumeDocumentId !== '[object Object]';
    if (isOpen && isValidResumeId) {
      setStep('PREFLIGHT_LOADING');
      setError(null);
      api
        .getDocumentPreflight(resumeDocumentId)
        .then((res) => {
          if (active && res.success && res.document) {
            setPreflightData({
              document: res.document,
              pageCount: res.pageCount,
              summary: res.summary,
              estimatedCredits: res.estimatedCredits,
            });
            setStep('CONFIRMATION');
          }
        })
        .catch((err) => {
          if (active) {
            setError(err.message || 'Không thể tải thông tin phân tích tài liệu cũ.');
            setStep('UPLOAD');
          }
        });
    } else if (isOpen && !resumeDocumentId) {
      setStep('UPLOAD');
      setFile(null);
      setPreflightData(null);
      setError(null);
    }

    return () => {
      active = false;
    };
  }, [isOpen, resumeDocumentId]);

  if (!isOpen) return null;

  const validateFile = (selectedFile: File): boolean => {
    setError(null);
    const validExtensions = ['.pdf', '.jpg', '.jpeg', '.png'];
    const ext = selectedFile.name.substring(selectedFile.name.lastIndexOf('.')).toLowerCase();

    if (!validExtensions.includes(ext)) {
      setError('Định dạng tệp không được hỗ trợ. Vui lòng chỉ chọn tệp PDF, JPG, JPEG hoặc PNG.');
      return false;
    }

    const maxSize = 20 * 1024 * 1024; // 20 MB
    if (selectedFile.size > maxSize) {
      setError('Kích thước tệp vượt quá giới hạn cho phép (tối đa 20MB).');
      return false;
    }

    return true;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      if (validateFile(selected)) {
        setFile(selected);
      }
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const dropped = e.dataTransfer.files[0];
      if (validateFile(dropped)) {
        setFile(dropped);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  // STEP 1: Upload & Preflight
  const handleStartPreflight = async () => {
    if (!file) {
      setError('Vui lòng chọn một tệp để tải lên.');
      return;
    }

    if (quota && !quota.allowed) {
      setError(quota.message || 'Bạn đã sử dụng hết số tài liệu của gói hiện tại. Vui lòng nâng cấp gói.');
      return;
    }

    setStep('PREFLIGHT_LOADING');
    setError(null);

    try {
      const result = await api.uploadDocument(file);
      if (result.success && result.document && result.preflight) {
        setPreflightData({
          document: result.document,
          pageCount: result.preflight.pageCount,
          summary: result.preflight.summary,
          estimatedCredits: result.preflight.estimatedCredits,
        });
        setStep('CONFIRMATION');
      } else {
        setError(result.message || 'Có lỗi xảy ra khi phân tích tài liệu.');
        setStep('UPLOAD');
      }
    } catch (err: any) {
      setError(err.message || 'Có lỗi xảy ra khi phân tích tài liệu. Vui lòng thử lại.');
      setStep('UPLOAD');
    }
  };

  // STEP 2: Confirm & Process (Only here is quota consumed and OCR started!)
  const handleConfirmProcessing = async () => {
    if (!preflightData?.document?.id) return;

    if (outputType === 'WORD') {
      setError('Tính năng chuyển đổi Word đang phát triển. Vui lòng chọn Excel.');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const result = await api.confirmDocumentProcessing(preflightData.document.id, 'EXCEL');
      if (result.success && result.document) {
        if (result.quota) {
          updateQuota(result.quota);
        }
        onSuccess(result.document.id);
        onClose();
      } else {
        setError(result.message || 'Không thể bắt đầu xử lý tài liệu.');
      }
    } catch (err: any) {
      setError(err.message || 'Có lỗi xảy ra khi kích hoạt xử lý. Vui lòng thử lại.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCloseModal = () => {
    if (isProcessing) return;
    onClose();
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div
      id="upload-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in"
    >
      <div
        id="upload-modal-container"
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden animate-scale-up"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center font-bold">
              {step === 'CONFIRMATION' ? <Sparkles className="w-4 h-4" /> : <UploadCloud className="w-4 h-4" />}
            </div>
            <div>
              <h3 className="font-bold text-slate-800 text-base">
                {step === 'CONFIRMATION' ? 'XÁC NHẬN XỬ LÝ TÀI LIỆU' : 'Tải tài liệu mới'}
              </h3>
              <p className="text-xs text-slate-500">
                {step === 'CONFIRMATION'
                  ? 'Kiểm tra cấu trúc tài liệu và xác nhận bắt đầu chuyển đổi'
                  : 'Sao kê ngân hàng, hóa đơn scan hoặc bảng biểu hình ảnh'}
              </p>
            </div>
          </div>
          <button
            id="btn-close-upload-modal"
            type="button"
            onClick={handleCloseModal}
            disabled={isProcessing || step === 'PREFLIGHT_LOADING'}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
          {error && <ErrorAlert message={error} onClose={() => setError(null)} />}

          {/* ============================================================== */}
          {/* STEP 1: FILE SELECTION / UPLOAD                                */}
          {/* ============================================================== */}
          {step === 'UPLOAD' && (
            <div className="space-y-4">
              {/* Quota Alert */}
              {quota && !quota.allowed && (
                <div
                  id="quota-exceeded-alert"
                  className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm flex items-start gap-3"
                >
                  <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">{quota.message}</p>
                    <p className="text-xs text-amber-700 mt-1">
                      Hãy nâng cấp gói để tiếp tục chuyển đổi các tập tin tiếp theo.
                    </p>
                  </div>
                </div>
              )}

              {/* Drag & Drop Zone */}
              <div
                id="dropzone-area"
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition flex flex-col items-center justify-center ${
                  isDragging
                    ? 'border-blue-500 bg-blue-50/50'
                    : 'border-slate-300 hover:border-blue-400 bg-slate-50/40 hover:bg-blue-50/20'
                }`}
              >
                <input
                  ref={fileInputRef}
                  id="file-input-upload"
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                  className="hidden"
                  onChange={handleFileChange}
                />

                <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mb-3 shadow-xs">
                  <UploadCloud className="w-6 h-6" />
                </div>

                <p className="text-sm font-semibold text-slate-800 mb-1">
                  Kéo và thả tệp vào đây, hoặc <span className="text-blue-600 underline">chọn từ thiết bị</span>
                </p>
                <p className="text-xs text-slate-400">Hỗ trợ: PDF Scan, JPG, JPEG, PNG (Tối đa 20MB / tệp)</p>
              </div>

              {/* Selected File Card */}
              {file && (
                <div
                  id="selected-file-card"
                  className="p-3.5 rounded-xl bg-blue-50/60 border border-blue-200 flex items-center justify-between"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
                      <FileType className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{file.name}</p>
                      <p className="text-xs text-slate-500">{formatFileSize(file.size)}</p>
                    </div>
                  </div>
                  <button
                    id="btn-remove-selected-file"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                    }}
                    className="text-slate-400 hover:text-rose-500 p-1.5 rounded-lg transition"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Security & Preflight Information */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <Sparkles className="w-4 h-4 text-blue-600" />
                  <span>Phân tích cấu trúc nhanh (Preflight)</span>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Tài liệu sẽ được kiểm tra cấu trúc trang và tính toàn vẹn cục bộ trước khi bạn quyết định bắt đầu xử lý.
                </p>
                <div className="flex items-center gap-2 text-[11px] text-slate-500 pt-1 border-t border-slate-200/50">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Dữ liệu của bạn được cô lập 100% trong kho lưu trữ riêng tư.</span>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* STEP 1.5: HONEST PREFLIGHT LOADING STATE                       */}
          {/* ============================================================== */}
          {step === 'PREFLIGHT_LOADING' && (
            <div id="preflight-loading-view" className="py-8 px-4 flex flex-col items-center justify-center space-y-6 text-center">
              <div className="relative">
                <div className="w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 shadow-inner">
                  <Loader2 className="w-8 h-8 animate-spin" />
                </div>
              </div>

              <div>
                <h4 className="text-base font-bold text-slate-800">Đang phân tích tài liệu...</h4>
                <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                  Hệ thống đang tiến hành kiểm tra cấu trúc từng trang để tối ưu hóa lộ trình xử lý.
                </p>
              </div>

              {/* Honest Progress Indicators */}
              <div className="w-full max-w-xs space-y-2.5 text-left bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
                <div className="flex items-center gap-2.5 text-emerald-600 font-medium">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  <span>Đã tải tài liệu lên lưu trữ an toàn</span>
                </div>
                <div className="flex items-center gap-2.5 text-emerald-600 font-medium">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  <span>Đã kiểm tra cấu trúc tệp</span>
                </div>
                <div className="flex items-center gap-2.5 text-blue-600 font-semibold animate-pulse">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>Đang phân tích cấu trúc từng trang...</span>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* STEP 2: PREFLIGHT CONFIRMATION                                 */}
          {/* ============================================================== */}
          {step === 'CONFIRMATION' && preflightData && (
            <div id="preflight-confirmation-view" className="space-y-5 animate-fade-in">
              {/* Document Overview Header */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-xs">
                    {preflightData.document.file_type}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 truncate" title={preflightData.document.original_filename}>
                      {preflightData.document.original_filename}
                    </p>
                    <p className="text-xs text-slate-500">
                      Tổng số trang:{' '}
                      <span className="font-bold text-blue-600">{preflightData.pageCount} trang</span>
                    </p>
                  </div>
                </div>
                <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                  Đã phân tích
                </span>
              </div>

              {/* Classification Summary Card */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Phân tích tài liệu
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <div className="p-3 rounded-xl bg-blue-50/60 border border-blue-100 flex flex-col items-center justify-center text-center">
                    <span className="text-lg font-black text-blue-600">{preflightData.summary.nativeTextPages}</span>
                    <span className="text-[11px] font-medium text-slate-600 mt-0.5">Tài liệu số</span>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-100 border border-slate-200 flex flex-col items-center justify-center text-center">
                    <span className="text-lg font-black text-slate-700">{preflightData.summary.scannedPages}</span>
                    <span className="text-[11px] font-medium text-slate-600 mt-0.5">Trang scan</span>
                  </div>

                  <div className="p-3 rounded-xl bg-purple-50/60 border border-purple-100 flex flex-col items-center justify-center text-center">
                    <span className="text-lg font-black text-purple-600">{preflightData.summary.mixedPages}</span>
                    <span className="text-[11px] font-medium text-slate-600 mt-0.5">Trang hỗn hợp</span>
                  </div>

                  <div className="p-3 rounded-xl bg-amber-50/60 border border-amber-100 flex flex-col items-center justify-center text-center">
                    <span className="text-lg font-black text-amber-600">{preflightData.summary.uncertainPages}</span>
                    <span className="text-[11px] font-medium text-slate-600 mt-0.5">Chưa xác định</span>
                  </div>
                </div>
              </div>

              {/* Output Selection (Excel enabled, Word coming soon) */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Đầu ra mong muốn
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  {/* Excel Option */}
                  <div
                    id="output-option-excel"
                    onClick={() => setOutputType('EXCEL')}
                    className={`p-3.5 rounded-xl border-2 cursor-pointer transition flex items-center justify-between ${
                      outputType === 'EXCEL'
                        ? 'border-blue-600 bg-blue-50/40 shadow-xs'
                        : 'border-slate-200 hover:border-slate-300 bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
                        <FileSpreadsheet className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-slate-800">Excel (.xlsx)</p>
                        <p className="text-[10px] text-slate-500">Chuẩn kế toán & đối soát</p>
                      </div>
                    </div>
                    {outputType === 'EXCEL' && (
                      <div className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0">
                        <Check className="w-3 h-3" />
                      </div>
                    )}
                  </div>

                  {/* Word Option (Disabled / Coming Soon) */}
                  <div
                    id="output-option-word"
                    className="p-3.5 rounded-xl border-2 border-slate-200 bg-slate-50/80 opacity-70 cursor-not-allowed flex items-center justify-between"
                    title="Chức năng chuyển đổi Word đang phát triển"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-800 flex items-center justify-center">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-slate-700">Word (.docx)</p>
                        <span className="inline-block px-1.5 py-0.5 text-[9px] font-semibold bg-amber-100 text-amber-800 rounded">
                          Sắp ra mắt
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Estimated Credits Card */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center">
                    <Coins className="w-4 h-4" />
                  </div>
                  <div>
                    <h5 className="text-xs font-bold text-slate-800">Chi phí dự kiến</h5>
                    <p className="text-[10px] text-slate-500">Hạn mức sẽ được trừ sau khi bạn bấm xác nhận</p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-base font-extrabold text-blue-600">
                    {preflightData.estimatedCredits} Credits
                  </span>
                  <p className="text-[10px] text-slate-400">1 trang = 1 Credit</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100 bg-slate-50/50">
          <button
            id="btn-cancel-upload"
            type="button"
            onClick={handleCloseModal}
            disabled={isProcessing || step === 'PREFLIGHT_LOADING'}
            className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition"
          >
            Hủy
          </button>

          {/* Step 1 Action: [Tiếp tục] */}
          {step === 'UPLOAD' && (
            <button
              id="btn-continue-preflight"
              type="button"
              onClick={handleStartPreflight}
              disabled={!file || (quota ? !quota.allowed : false)}
              className={`inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white shadow-sm transition ${
                !file || (quota ? !quota.allowed : false)
                  ? 'bg-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-500 active:scale-95'
              }`}
            >
              <span>Tiếp tục</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}

          {/* Step 2 Action: [Xử lý tài liệu] */}
          {step === 'CONFIRMATION' && (
            <button
              id="btn-confirm-processing"
              type="button"
              onClick={handleConfirmProcessing}
              disabled={isProcessing || outputType === 'WORD'}
              className={`inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white shadow-sm transition ${
                isProcessing || outputType === 'WORD'
                  ? 'bg-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-500 active:scale-95'
              }`}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Đang khởi tạo xử lý OCR...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Xử lý tài liệu</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
