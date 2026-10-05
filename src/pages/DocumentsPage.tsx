import React, { useState, useEffect } from 'react';
import {
  Search,
  Filter,
  Plus,
  Trash2,
  Eye,
  Download,
  FileText,
  Clock,
  CheckCircle2,
  AlertTriangle,
  X,
  ExternalLink,
  Shield,
  FileSpreadsheet,
  PlayCircle,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { DocumentItem } from '../types';
import { api } from '../services/api';
import { StatusBadge } from '../components/common/StatusBadge';
import { EmptyState } from '../components/common/EmptyState';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorAlert } from '../components/common/ErrorAlert';
import { OcrReviewWorkspace } from '../components/ocr/OcrReviewWorkspace';

interface DocumentsPageProps {
  onOpenUpload: (resumeDocId?: string) => void;
  selectedDocId?: string;
}

export const DocumentsPage: React.FC<DocumentsPageProps> = ({ onOpenUpload, selectedDocId }) => {
  const { token, refreshProfile } = useAuth();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentItem | null>(null);
  const [reviewDocId, setReviewDocId] = useState<string | null>(selectedDocId || null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState<DocumentItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Fetch Blob securely with Bearer token for preview
  useEffect(() => {
    let active = true;
    let url: string | null = null;

    if (previewDoc) {
      setIsPreviewLoading(true);
      api
        .getDocumentBlob(previewDoc.id)
        .then((blob) => {
          if (active) {
            url = URL.createObjectURL(blob);
            setPreviewUrl(url);
          }
        })
        .catch((err) => {
          console.error('Preview error:', err);
          if (active) setPreviewUrl(null);
        })
        .finally(() => {
          if (active) setIsPreviewLoading(false);
        });
    } else {
      setPreviewUrl(null);
    }

    return () => {
      active = false;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [previewDoc]);

  const fetchDocuments = async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const res = await api.getDocuments();
      if (res.success) {
        setDocuments(res.documents);
        if (selectedDocId) {
          const matched = res.documents.find((d) => d.id === selectedDocId);
          if (matched) setPreviewDoc(matched);
        }
      }
    } catch (err: any) {
      if (!silent) setError(err.message || 'Không thể tải danh sách tài liệu.');
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, [selectedDocId]);

  // Auto-polling when any document is in transient state (QUEUED, PROCESSING, UPLOADED, etc.)
  useEffect(() => {
    const hasTransient = documents.some((d) => {
      const s = (d.status || '').toUpperCase();
      return (
        s === 'PROCESSING' ||
        s === 'QUEUED' ||
        s === 'UPLOADED' ||
        s === 'PENDING' ||
        s === 'PARSING' ||
        s === 'VALIDATING' ||
        s === 'UPLOADING' ||
        s === 'VALIDATING_RESULT'
      );
    });
    if (!hasTransient) return;

    const timer = setInterval(() => {
      fetchDocuments(true);
    }, 3000);

    return () => clearInterval(timer);
  }, [documents]);

  const handleDelete = async () => {
    if (!showDeleteModal) return;
    setIsDeleting(true);
    try {
      await api.deleteDocument(showDeleteModal.id);
      setDocuments((prev) => prev.filter((d) => d.id !== showDeleteModal.id));
      if (previewDoc?.id === showDeleteModal.id) {
        setPreviewDoc(null);
      }
      setShowDeleteModal(null);
      await refreshProfile();
    } catch (err: any) {
      setError(err.message || 'Có lỗi xảy ra khi xóa tài liệu.');
    } finally {
      setIsDeleting(false);
    }
  };

  const filteredDocs = documents.filter((doc) => {
    const matchSearch = doc.original_filename.toLowerCase().includes(searchTerm.toLowerCase());
    if (statusFilter === 'ALL') return matchSearch;
    if (statusFilter === 'WAITING_CONFIRMATION') {
      const s = (doc.status || '').toUpperCase();
      return matchSearch && s === 'WAITING_CONFIRMATION';
    }
    if (statusFilter === 'QUEUED') {
      const s = (doc.status || '').toUpperCase();
      return matchSearch && (s === 'QUEUED' || s === 'PROCESSING' || s === 'UPLOADED' || s === 'PENDING' || s === 'PARSING');
    }
    if (statusFilter === 'READY') {
      const s = (doc.status || '').toUpperCase();
      return matchSearch && (s === 'READY' || s === 'COMPLETED');
    }
    return matchSearch && doc.status === statusFilter;
  });

  const formatFileSize = (bytes: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  return (
    <div id="documents-management-page" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 animate-fade-in">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">Tài liệu của tôi</h1>
          <p className="text-xs text-slate-500 mt-1">
            Quản lý và xem lại toàn bộ các tài liệu sao kê, hình ảnh đã tải lên lưu trữ riêng tư
          </p>
        </div>

        <button
          id="btn-upload-doc-page"
          onClick={() => onOpenUpload()}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold shadow-sm transition active:scale-95 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>+ Tải tài liệu mới</span>
        </button>
      </div>

      {error && <ErrorAlert message={error} onClose={() => setError(null)} />}

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white p-3.5 rounded-2xl border border-slate-200 shadow-xs">
        {/* Search */}
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            id="input-search-docs"
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Tìm theo tên tệp..."
            className="w-full pl-9 pr-3.5 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none placeholder-slate-400"
          />
        </div>

        {/* Status Filter Tabs */}
        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto">
          <button
            onClick={() => setStatusFilter('ALL')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'ALL' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Tất cả ({documents.length})
          </button>
          <button
            id="tab-filter-waiting-confirmation"
            onClick={() => setStatusFilter('WAITING_CONFIRMATION')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'WAITING_CONFIRMATION' ? 'bg-amber-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Chờ xác nhận ({documents.filter((d) => (d.status || '').toUpperCase() === 'WAITING_CONFIRMATION').length})
          </button>
          <button
            onClick={() => setStatusFilter('REVIEW_REQUIRED')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'REVIEW_REQUIRED' ? 'bg-amber-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Cần kiểm tra ({documents.filter((d) => (d.status || '').toUpperCase() === 'REVIEW_REQUIRED').length})
          </button>
          <button
            onClick={() => setStatusFilter('QUEUED')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'QUEUED' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Đang xử lý ({
              documents.filter((d) => {
                const s = (d.status || '').toUpperCase();
                return s === 'QUEUED' || s === 'UPLOADED' || s === 'PROCESSING' || s === 'PENDING' || s === 'PARSING';
              }).length
            })
          </button>
          <button
            onClick={() => setStatusFilter('READY')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition ${
              statusFilter === 'READY' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Hoàn tất ({
              documents.filter((d) => {
                const s = (d.status || '').toUpperCase();
                return s === 'READY' || s === 'COMPLETED';
              }).length
            })
          </button>
        </div>
      </div>

      {/* Documents Table */}
      {isLoading ? (
        <LoadingSpinner message="Đang tải danh sách tài liệu..." />
      ) : filteredDocs.length === 0 ? (
        searchTerm || statusFilter !== 'ALL' ? (
          <div className="text-center py-12 bg-white rounded-2xl border border-slate-200">
            <p className="text-sm text-slate-500">Không tìm thấy tài liệu phù hợp với điều kiện tìm kiếm.</p>
            <button
              onClick={() => {
                setSearchTerm('');
                setStatusFilter('ALL');
              }}
              className="mt-2 text-xs text-blue-600 hover:underline font-semibold"
            >
              Xóa bộ lọc
            </button>
          </div>
        ) : (
          <EmptyState onAction={() => onOpenUpload()} />
        )
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-600">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="px-6 py-4">Tên tài liệu</th>
                  <th className="px-4 py-4">Loại tệp & Kích thước</th>
                  <th className="px-4 py-4">Ngày tải lên</th>
                  <th className="px-4 py-4">Trạng thái xử lý</th>
                  <th className="px-4 py-4">Bảo mật</th>
                  <th className="px-6 py-4 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredDocs.map((doc) => (
                  <tr key={doc.id} className="hover:bg-slate-50/80 transition">
                    <td className="px-6 py-4 font-semibold text-slate-900 max-w-[240px] truncate">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs shrink-0">
                          {doc.file_type}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-slate-900 font-semibold" title={doc.original_filename}>
                            {doc.original_filename}
                          </p>
                          <p className="text-[10px] text-slate-400 font-normal truncate">Mã ID: {doc.id.slice(0, 8)}...</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-slate-500">
                      {doc.file_type} • {formatFileSize(doc.file_size)}
                    </td>
                    <td className="px-4 py-4 text-slate-500">{formatDate(doc.created_at)}</td>
                    <td className="px-4 py-4">
                      <StatusBadge status={doc.status} size="sm" />
                    </td>
                    <td className="px-4 py-4">
                      <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                        <Shield className="w-3 h-3 text-emerald-600" />
                        Cô lập riêng tư
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {doc.status === 'WAITING_CONFIRMATION' ? (
                          <button
                            id={`btn-resume-process-${doc.id}`}
                            onClick={() => onOpenUpload(doc.id)}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 flex items-center gap-1.5 shadow-xs transition"
                            title="Xem phân tích sơ bộ và tiếp tục xử lý tài liệu"
                          >
                            <PlayCircle className="w-3.5 h-3.5" />
                            <span>Tiếp tục xử lý</span>
                          </button>
                        ) : (
                          <button
                            id={`btn-table-review-${doc.id}`}
                            onClick={() => setReviewDocId(doc.id)}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 flex items-center gap-1.5 shadow-xs transition"
                            title="Mở bảng trích xuất & không gian đối soát OCR"
                          >
                            <FileSpreadsheet className="w-3.5 h-3.5" />
                            <span>Đối soát OCR</span>
                          </button>
                        )}
                        <button
                          id={`btn-table-preview-${doc.id}`}
                          onClick={() => setPreviewDoc(doc)}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 flex items-center gap-1 transition"
                          title="Xem tệp gốc"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Xem tệp</span>
                        </button>
                        <button
                          id={`btn-table-delete-${doc.id}`}
                          onClick={() => setShowDeleteModal(doc)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                          title="Xóa tài liệu"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Document Preview Modal */}
      {previewDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-scale-up">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold text-xs">
                  {previewDoc.file_type}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900 truncate max-w-md">
                    {previewDoc.original_filename}
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Kích thước: {formatFileSize(previewDoc.file_size)} • Trạng thái:{' '}
                    <span className="font-semibold text-slate-700">{previewDoc.status}</span>
                  </p>
                </div>
              </div>
              <button
                onClick={() => setPreviewDoc(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200/60 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Viewer Content */}
            <div className="p-4 bg-slate-100 flex-1 overflow-auto flex items-center justify-center min-h-[400px]">
              {isPreviewLoading ? (
                <div className="flex flex-col items-center justify-center gap-3 text-slate-500 py-12">
                  <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                  <p className="text-xs font-medium">Đang tải tệp tin bảo mật từ Private Storage...</p>
                </div>
              ) : previewUrl ? (
                previewDoc.file_type === 'PDF' ? (
                  <iframe
                    src={previewUrl}
                    title={previewDoc.original_filename}
                    className="w-full h-[520px] rounded-xl border border-slate-300 bg-white"
                  />
                ) : (
                  <img
                    src={previewUrl}
                    alt={previewDoc.original_filename}
                    className="max-h-[520px] max-w-full object-contain rounded-xl shadow-xs border border-slate-200"
                  />
                )
              ) : (
                <div className="text-xs text-rose-500 font-medium py-8">
                  Không thể hiển thị bản xem trước. Tệp tin không tồn tại hoặc bạn không có quyền truy cập.
                </div>
              )}
            </div>

            {/* Footer info */}
            <div className="px-6 py-3 border-t border-slate-200 bg-white flex items-center justify-between text-xs text-slate-500">
              <div className="flex items-center gap-1.5">
                <Shield className="w-4 h-4 text-emerald-600" />
                <span>Được bảo vệ bởi cơ chế Row Level Security và Private Storage</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPreviewDoc(null)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl transition"
                >
                  Đóng
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">Bạn có chắc chắn muốn xóa tài liệu này?</h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Tệp <strong className="text-slate-800">{showDeleteModal.original_filename}</strong> và toàn bộ tệp gốc
                trong Private Storage sẽ bị xóa vĩnh viễn. Thao tác này không thể hoàn tác.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowDeleteModal(null)}
                disabled={isDeleting}
                className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-xl hover:bg-rose-500 transition flex items-center gap-1.5"
              >
                {isDeleting ? 'Đang xóa...' : 'Xác nhận xóa'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OCR Review & Table Workspace Modal */}
      {reviewDocId && (
        <OcrReviewWorkspace
          documentId={reviewDocId}
          onClose={() => {
            setReviewDocId(null);
            fetchDocuments(true);
          }}
          onDocumentUpdated={(updatedDoc) => {
            setDocuments((prev) => prev.map((d) => (d.id === updatedDoc.id ? updatedDoc : d)));
          }}
        />
      )}
    </div>
  );
};
