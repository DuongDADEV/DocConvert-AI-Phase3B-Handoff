import React, { useState, useEffect } from 'react';
import {
  Plus,
  FileSpreadsheet,
  Clock,
  CheckCircle2,
  AlertTriangle,
  FolderOpen,
  ArrowRight,
  Trash2,
  Eye,
  RefreshCw,
  Sparkles,
  PlayCircle,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { DocumentItem, AuditLog } from '../types';
import { api } from '../services/api';
import { QuotaCard } from '../components/dashboard/QuotaCard';
import { CreditBalanceCard } from '../components/dashboard/CreditBalanceCard';
import { RecentActivity } from '../components/dashboard/RecentActivity';
import { StatusBadge } from '../components/common/StatusBadge';
import { EmptyState } from '../components/common/EmptyState';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorAlert } from '../components/common/ErrorAlert';
import { useCreditBalance } from '../hooks/useCreditBalance';
import { isCreditBillingUiEnabled } from '../config/features';

interface DashboardPageProps {
  onNavigate: (tab: string, documentId?: string) => void;
  onOpenUpload: (resumeDocId?: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate, onOpenUpload }) => {
  const { user, quota, refreshProfile } = useAuth();
  const creditBillingEnabled = isCreditBillingUiEnabled();
  const credit = useCreditBalance();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState<DocumentItem | null>(null);

  const loadDashboardData = async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const [docsRes, logsRes] = await Promise.all([api.getDocuments(), api.getAuditLogs(6)]);
      if (docsRes.success) {
        setDocuments(docsRes.documents);
      }
      if (logsRes.success) {
        setAuditLogs(logsRes.logs);
      }
      if (!silent) await refreshProfile();
    } catch (err: any) {
      if (!silent) setError(err.message || 'Không thể tải dữ liệu bảng điều khiển.');
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDashboardData();
  }, []);

  // Auto-polling when any document is in transient state (PROCESSING, QUEUED, etc.)
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
      loadDashboardData(true);
    }, 3000);

    return () => clearInterval(timer);
  }, [documents]);

  const handleDeleteConfirm = async () => {
    if (!showDeleteModal) return;
    setDeletingId(showDeleteModal.id);
    try {
      await api.deleteDocument(showDeleteModal.id);
      setDocuments((prev) => prev.filter((d) => d.id !== showDeleteModal.id));
      setShowDeleteModal(null);
      await loadDashboardData();
    } catch (err: any) {
      setError(err.message || 'Không thể xóa tài liệu.');
    } finally {
      setDeletingId(null);
    }
  };

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

  const completedCount = documents.filter((d) => d.status === 'READY' || d.status === 'REVIEW_REQUIRED').length;
  const queuedCount = documents.filter((d) => d.status === 'QUEUED' || d.status === 'PROCESSING' || d.status === 'UPLOADED').length;

  return (
    <div id="dashboard-page" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 animate-fade-in">
      {/* Top Greeting Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
              Xin chào, {user?.fullName || 'Quý khách'}
            </h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
              Đang hoạt động
            </span>
          </div>
          <p className="text-sm text-slate-500">
            Chào mừng bạn đến với hệ thống xử lý sao kê & tài liệu số hóa DocConvert AI
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            id="btn-refresh-dashboard"
            onClick={loadDashboardData}
            disabled={isLoading}
            className="p-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition"
            title="Làm mới dữ liệu"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            id="btn-dashboard-main-upload"
            onClick={() => onOpenUpload()}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:scale-95 text-white text-sm font-bold shadow-sm transition"
          >
            <Plus className="w-4 h-4" />
            <span>+ Tải tài liệu mới</span>
          </button>
        </div>
      </div>

      {error && <ErrorAlert message={error} onClose={() => setError(null)} />}

      {/* Overview Grid: Quota + Metric Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Billing Card (takes 2 cols on lg): Credit-aware if enabled, otherwise legacy QuotaCard */}
        <div className="lg:col-span-2">
          {creditBillingEnabled ? (
            <CreditBalanceCard
              balance={credit.balance}
              uiState={credit.uiState}
              planName={quota?.planName || 'TÀI KHOẢN'}
              onUpgradeClick={() => onNavigate('pricing')}
              onRefresh={credit.refreshCreditBalance}
            />
          ) : (
            <QuotaCard quota={quota} onUpgradeClick={() => onNavigate('pricing')} />
          )}
        </div>

        {/* Quick Stat Summary */}
        <div className="grid grid-cols-2 gap-4">
          <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Tổng tài liệu</span>
              <FolderOpen className="w-5 h-5 text-blue-600" />
            </div>
            <div className="mt-3">
              <span className="text-3xl font-extrabold text-slate-900">{documents.length}</span>
              <p className="text-[11px] text-slate-400 mt-1">Trong kho lưu trữ riêng</p>
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Chờ xử lý</span>
              <Clock className="w-5 h-5 text-amber-500" />
            </div>
            <div className="mt-3">
              <span className="text-3xl font-extrabold text-slate-900">{queuedCount}</span>
              <p className="text-[11px] text-slate-400 mt-1">Trong hàng đợi Azure AI</p>
            </div>
          </div>

          <div className="col-span-2 p-4 rounded-2xl bg-blue-50/60 border border-blue-200/80 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-slate-700">
              <Sparkles className="w-4 h-4 text-blue-600 shrink-0" />
              <span>
                Hệ thống hỗ trợ sao kê PDF Scan từ mọi ngân hàng tại Việt Nam (Vietcombank, Techcombank, BIDV...).
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Grid: Recent Documents (Left 2/3) + Activity Timeline (Right 1/3) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Recent Documents Table (2 cols) */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Tài liệu gần đây</h2>
              <p className="text-xs text-slate-500">Các tài liệu bạn vừa tải lên và xử lý</p>
            </div>
            {documents.length > 0 && (
              <button
                id="btn-view-all-docs"
                onClick={() => onNavigate('documents')}
                className="text-xs font-semibold text-blue-600 hover:text-blue-500 flex items-center gap-1 transition"
              >
                Xem tất cả ({documents.length}) <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {isLoading ? (
            <LoadingSpinner message="Đang tải danh sách tài liệu..." />
          ) : documents.length === 0 ? (
            <EmptyState onAction={() => onOpenUpload()} />
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-slate-600">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold uppercase tracking-wider text-[10px]">
                    <tr>
                      <th className="px-5 py-3.5">Tên tài liệu</th>
                      <th className="px-4 py-3.5">Loại tệp</th>
                      <th className="px-4 py-3.5">Ngày tải lên</th>
                      <th className="px-4 py-3.5">Trạng thái</th>
                      <th className="px-5 py-3.5 text-right">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {documents.slice(0, 5).map((doc) => (
                      <tr key={doc.id} className="hover:bg-slate-50/80 transition">
                        <td className="px-5 py-3.5 font-medium text-slate-900 max-w-[200px] truncate">
                          <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs shrink-0">
                              {doc.file_type}
                            </div>
                            <span className="truncate" title={doc.original_filename}>
                              {doc.original_filename}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-slate-500">
                          {doc.file_type} • {formatFileSize(doc.file_size)}
                        </td>
                        <td className="px-4 py-3.5 text-slate-500">{formatDate(doc.created_at)}</td>
                        <td className="px-4 py-3.5">
                          <StatusBadge status={doc.status} size="sm" />
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {doc.status === 'WAITING_CONFIRMATION' ? (
                              <button
                                id={`btn-resume-doc-${doc.id}`}
                                onClick={() => onOpenUpload(doc.id)}
                                className="px-2.5 py-1 rounded-lg text-xs font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 flex items-center gap-1 transition"
                                title="Tiếp tục xử lý tài liệu"
                              >
                                <PlayCircle className="w-3.5 h-3.5" />
                                <span>Tiếp tục</span>
                              </button>
                            ) : (
                              <button
                                id={`btn-review-doc-${doc.id}`}
                                onClick={() => onNavigate('documents', doc.id)}
                                className="px-2.5 py-1 rounded-lg text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 flex items-center gap-1 transition"
                                title="Đối soát bảng & số liệu OCR"
                              >
                                <FileSpreadsheet className="w-3.5 h-3.5" />
                                <span>Đối soát</span>
                              </button>
                            )}
                            <button
                              id={`btn-view-doc-${doc.id}`}
                              onClick={() => onNavigate('documents', doc.id)}
                              className="p-1.5 rounded-lg text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition"
                              title="Xem chi tiết"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            <button
                              id={`btn-delete-doc-${doc.id}`}
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
        </div>

        {/* Right Column: Activity Timeline */}
        <div className="space-y-4">
          <RecentActivity logs={auditLogs} />
        </div>
      </div>

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
                Tệp <strong className="text-slate-800">{showDeleteModal.original_filename}</strong> và toàn bộ dữ liệu
                trích xuất sẽ bị xóa vĩnh viễn khỏi bộ lưu trữ riêng tư. Thao tác này không thể hoàn tác.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowDeleteModal(null)}
                disabled={!!deletingId}
                className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={!!deletingId}
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 rounded-xl hover:bg-rose-500 transition flex items-center gap-1.5"
              >
                {deletingId ? 'Đang xóa...' : 'Xác nhận xóa'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
