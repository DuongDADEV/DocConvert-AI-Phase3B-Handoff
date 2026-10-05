/**
 * UI Feature Flags for DocConvert AI
 *
 * creditBillingUiEnabled:
 * - When false: Renders legacy document quota UI in Navbar and Dashboard.
 * - When true: Renders credit-based UI (CreditBalanceBadge and CreditBalanceCard).
 *   If credit account does not exist, safely displays non-financial state ("Credit chưa kích hoạt")
 *   or falls back to legacy quota without showing fake zero credits.
 *
 * Can be overridden via VITE_CREDIT_BILLING_UI_ENABLED environment variable or localStorage.
 */
export const isCreditBillingUiEnabled = (): boolean => {
  if (typeof window !== 'undefined') {
    const localOverride = localStorage.getItem('feature_credit_billing_ui');
    if (localOverride === 'true') return true;
    if (localOverride === 'false') return false;
  }
  return (import.meta as any).env?.VITE_CREDIT_BILLING_UI_ENABLED === 'true';
};
