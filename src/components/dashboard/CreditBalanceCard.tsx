import React from 'react';
import { ArrowRight, Coins, ShieldAlert, AlertCircle, RefreshCw } from 'lucide-react';
import { UserCreditBalance, CreditAccountUiState } from '../../types';
import { formatCredits } from '../../utils/creditFormatter';

interface CreditBalanceCardProps {
  balance: UserCreditBalance | null;
  uiState: CreditAccountUiState;
  planName?: string;
  onUpgradeClick: () => void;
  onRefresh?: () => void;
}

export const CreditBalanceCard: React.FC<CreditBalanceCardProps> = ({
  balance,
  uiState,
  planName = 'TÀI KHOẢN',
  onUpgradeClick,
  onRefresh,
}) => {
  // 1. Loading Skeleton State
  if (uiState === 'LOADING') {
    return (
      <div
        id="dashboard-credit-card-loading"
        className="p-6 rounded-2xl bg-gradient-to-br from-slate-900 via-slate-850 to-slate-900 text-white shadow-sm border border-slate-800 relative overflow-hidden animate-pulse"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="h-5 w-24 bg-slate-800 rounded-full" />
          <div className="h-4 w-20 bg-slate-800 rounded" />
        </div>
        <div className="h-10 w-36 bg-slate-800 rounded-lg mb-2" />
        <div className="h-4 w-64 bg-slate-800/60 rounded mb-6" />
        <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-800/80">
          <div className="h-8 bg-slate-800 rounded" />
          <div className="h-8 bg-slate-800 rounded" />
        </div>
      </div>
    );
  }

  // 2. Safe Non-Financial State: No Credit Account (DO NOT display fake 0 credits)
  if (uiState === 'NO_CREDIT_ACCOUNT' || !balance || balance.status === 'NONE') {
    return (
      <div
        id="dashboard-credit-card-no-account"
        className="p-6 rounded-2xl bg-gradient-to-br from-slate-900 via-slate-850 to-slate-900 text-white shadow-sm border border-slate-800 relative overflow-hidden"
      >
        <div className="flex items-center justify-between mb-4">
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase tracking-wide">
            {planName}
          </span>
          <span className="text-xs text-slate-400">Hệ thống tín dụng</span>
        </div>
        <div className="flex items-center gap-3 my-2">
          <AlertCircle className="w-6 h-6 text-amber-400 shrink-0" />
          <div>
            <h3 className="text-base font-bold text-white">Credit chưa được kích hoạt</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Tài khoản của bạn hiện đang sử dụng hệ thống hạn ngạch tài liệu tiêu chuẩn.
            </p>
          </div>
        </div>
        <div className="pt-4 mt-4 border-t border-slate-800 flex items-center justify-between">
          <span className="text-xs text-slate-400">Chế độ thanh toán hiện tại: Hạn ngạch tài liệu</span>
          <span className="text-xs text-slate-500 font-medium">Chưa kích hoạt số dư credit</span>
        </div>
      </div>
    );
  }

  // 3. API Error State (DO NOT display fake 0 credits)
  if (uiState === 'API_ERROR' || uiState === 'AUTH_ERROR') {
    return (
      <div
        id="dashboard-credit-card-error"
        className="p-6 rounded-2xl bg-gradient-to-br from-slate-900 via-slate-850 to-slate-900 text-white shadow-sm border border-rose-900/50 relative overflow-hidden"
      >
        <div className="flex items-center justify-between mb-3">
          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 uppercase tracking-wide">
            Lỗi kết nối
          </span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="text-xs text-slate-400 hover:text-white flex items-center gap-1 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Thử lại
            </button>
          )}
        </div>
        <p className="text-sm text-slate-300">
          Không thể tải thông tin số dư credit. Vui lòng làm mới trang hoặc kiểm tra kết nối mạng.
        </p>
      </div>
    );
  }

  const isFrozen = balance.status === 'FROZEN';
  const isClosed = balance.status === 'CLOSED';

  // 4. Authoritative Credit Balance State
  return (
    <div
      id="dashboard-credit-card"
      className="p-6 rounded-2xl bg-gradient-to-br from-slate-900 via-slate-850 to-slate-900 text-white shadow-sm border border-slate-800 relative overflow-hidden"
    >
      {/* Background soft glow */}
      <div className="absolute top-0 right-0 w-64 h-64 bg-blue-600/10 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none" />

      <div className="relative z-10 flex flex-col justify-between h-full space-y-5">
        <div>
          {/* Header Row */}
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30 uppercase tracking-wide">
                {planName}
              </span>
              <span className="text-xs text-slate-400 font-medium">SỐ DƯ CREDIT</span>
              {isFrozen && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  TẠM KHÓA
                </span>
              )}
              {isClosed && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">
                  ĐÃ ĐÓNG
                </span>
              )}
            </div>

            <button
              id="btn-credit-upgrade"
              onClick={onUpgradeClick}
              className="text-xs font-semibold text-blue-400 hover:text-blue-300 flex items-center gap-1 transition"
            >
              Nâng cấp gói <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Primary Metric: Available Credit */}
          <div className="flex items-baseline gap-2 mb-1.5">
            <Coins className="w-6 h-6 text-amber-400 shrink-0 self-center" />
            <span id="credit-available-primary" className="text-3xl font-extrabold text-white tracking-tight">
              {formatCredits(balance.totalAvailableUnits)}
            </span>
            <span className="text-slate-400 font-semibold text-sm">credits</span>
          </div>

          <p className="text-xs text-slate-300">
            {isFrozen ? (
              <span className="text-amber-400 font-medium flex items-center gap-1">
                <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                Tài khoản credit đang tạm khóa. Không thể tạo tác vụ xử lý mới.
              </span>
            ) : isClosed ? (
              <span className="text-rose-400 font-medium">
                Tài khoản credit đã bị đóng.
              </span>
            ) : (
              <span>Bạn có thể sử dụng số dư này cho các tác vụ xử lý tài liệu.</span>
            )}
          </p>
        </div>

        {/* Secondary Metrics Grid: Reserved & Gross Remaining */}
        <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-800/80 text-xs">
          <div className="p-3 rounded-xl bg-slate-800/50 border border-slate-750/70">
            <span className="text-slate-400 block text-[11px]">Credit đang giữ</span>
            <span id="credit-reserved-val" className="text-white font-bold text-sm">
              {formatCredits(balance.reservedUnits)} <span className="text-[10px] font-normal text-slate-400">credits</span>
            </span>
          </div>

          <div className="p-3 rounded-xl bg-slate-800/50 border border-slate-750/70">
            <span className="text-slate-400 block text-[11px]">Tổng credit còn lại</span>
            <span id="credit-gross-val" className="text-white font-bold text-sm">
              {formatCredits(balance.grossRemainingUnits)} <span className="text-[10px] font-normal text-slate-400">credits</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
