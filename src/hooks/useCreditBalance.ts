import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { UserCreditBalance, CreditAccountUiState } from '../types';
import { useAuth } from '../contexts/AuthContext';

export interface UseCreditBalanceResult {
  balance: UserCreditBalance | null;
  uiState: CreditAccountUiState;
  isLoading: boolean;
  error: string | null;
  refreshCreditBalance: () => Promise<void>;
}

export function useCreditBalance(): UseCreditBalanceResult {
  const { isAuthenticated } = useAuth();
  const [balance, setBalance] = useState<UserCreditBalance | null>(null);
  const [uiState, setUiState] = useState<CreditAccountUiState>('LOADING');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const fetchBalance = useCallback(async () => {
    if (!isAuthenticated) {
      setUiState('AUTH_ERROR');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await api.getCreditBalance();
      if (!res.success) {
        setUiState('API_ERROR');
        setError('Không thể tải số dư credit.');
        return;
      }

      if (res.status === 'NONE' || !res.accountId) {
        setBalance(res);
        setUiState('NO_CREDIT_ACCOUNT');
      } else {
        setBalance(res);
        setUiState('SUCCESS');
      }
    } catch (err: any) {
      console.warn('[useCreditBalance] Failed to fetch credit balance:', err);
      setUiState('API_ERROR');
      setError(err.message || 'Lỗi kết nối khi tải số dư credit.');
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  return {
    balance,
    uiState,
    isLoading,
    error,
    refreshCreditBalance: fetchBalance,
  };
}
