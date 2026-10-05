import React from 'react';
import { Coins } from 'lucide-react';
import { UserCreditBalance, CreditAccountUiState } from '../../types';
import { formatCredits } from '../../utils/creditFormatter';

interface CreditBalanceBadgeProps {
  balance: UserCreditBalance | null;
  uiState: CreditAccountUiState;
  onClick: () => void;
}

export const CreditBalanceBadge: React.FC<CreditBalanceBadgeProps> = ({
  balance,
  uiState,
  onClick,
}) => {
  if (uiState === 'LOADING') {
    return (
      <div
        id="navbar-credit-badge-loading"
        className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-400 animate-pulse"
      >
        <Coins className="w-3.5 h-3.5 text-amber-400/50" />
        <span>Đang tải...</span>
      </div>
    );
  }

  // Safe Non-Financial State (Do NOT show fake 0 credits)
  if (uiState === 'NO_CREDIT_ACCOUNT' || !balance || balance.status === 'NONE') {
    return (
      <div
        id="navbar-credit-badge-none"
        onClick={onClick}
        className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-400 hover:border-slate-600 cursor-pointer transition"
        title="Tài khoản credit chưa được kích hoạt"
      >
        <Coins className="w-3.5 h-3.5 text-slate-500" />
        <span>Credit: Chưa kích hoạt</span>
      </div>
    );
  }

  if (uiState === 'API_ERROR' || uiState === 'AUTH_ERROR') {
    return null;
  }

  const availableFormatted = formatCredits(balance.totalAvailableUnits);
  const reservedFormatted = formatCredits(balance.reservedUnits);
  const grossFormatted = formatCredits(balance.grossRemainingUnits);

  return (
    <div
      id="navbar-credit-badge"
      onClick={onClick}
      className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-300 hover:border-slate-600 cursor-pointer transition"
      title={`Khả dụng: ${availableFormatted} credits | Đang giữ: ${reservedFormatted} credits | Tổng còn lại: ${grossFormatted} credits`}
    >
      <Coins className="w-3.5 h-3.5 text-amber-400" />
      <span>
        <strong className="text-white font-semibold">{availableFormatted}</strong> credits
      </span>
    </div>
  );
};
