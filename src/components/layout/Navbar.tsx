import React, { useState } from 'react';
import { FileSpreadsheet, Shield, User as UserIcon, LogOut, ChevronDown, Plus, Sparkles } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { CreditBalanceBadge } from './CreditBalanceBadge';
import { useCreditBalance } from '../../hooks/useCreditBalance';
import { isCreditBillingUiEnabled } from '../../config/features';

interface NavbarProps {
  currentTab?: string;
  onNavigate: (tab: string) => void;
  onOpenUpload: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab = 'dashboard', onNavigate, onOpenUpload }) => {
  const { user, quota, isAuthenticated, logout } = useAuth();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const creditBillingEnabled = isCreditBillingUiEnabled();
  const creditBalance = useCreditBalance();

  const handleLogout = async () => {
    setDropdownOpen(false);
    await logout();
    onNavigate('landing');
  };

  return (
    <header id="main-navbar" className="sticky top-0 z-40 bg-slate-900 text-white border-b border-slate-800 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Brand */}
          <div className="flex items-center gap-8">
            <button
              id="brand-logo-btn"
              onClick={() => onNavigate(isAuthenticated ? 'dashboard' : 'landing')}
              className="flex items-center gap-2.5 text-left focus:outline-none group"
            >
              <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-md group-hover:bg-blue-500 transition">
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-1.5 font-bold text-lg tracking-tight text-white">
                  DocConvert <span className="text-blue-400">AI</span>
                </div>
                <div className="text-[10px] text-slate-400 font-medium tracking-wide">
                  CHUYÊN SAO KÊ & BẢNG BIỂU
                </div>
              </div>
            </button>

            {/* Authenticated Navigation Links */}
            {isAuthenticated && (
              <nav className="hidden md:flex items-center space-x-1">
                <button
                  id="nav-link-dashboard"
                  onClick={() => onNavigate('dashboard')}
                  className={`px-3.5 py-2 rounded-lg text-sm font-medium transition ${
                    currentTab === 'dashboard'
                      ? 'bg-slate-800 text-blue-400'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
                  }`}
                >
                  Dashboard
                </button>
                <button
                  id="nav-link-documents"
                  onClick={() => onNavigate('documents')}
                  className={`px-3.5 py-2 rounded-lg text-sm font-medium transition ${
                    currentTab === 'documents'
                      ? 'bg-slate-800 text-blue-400'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
                  }`}
                >
                  Tài liệu của tôi
                </button>
                <button
                  id="nav-link-pricing"
                  onClick={() => onNavigate('pricing')}
                  className={`px-3.5 py-2 rounded-lg text-sm font-medium transition ${
                    currentTab === 'pricing'
                      ? 'bg-slate-800 text-blue-400'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
                  }`}
                >
                  Gói cước
                </button>
              </nav>
            )}
          </div>

          {/* Right Action Area */}
          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <>
                {/* Upload Button */}
                <button
                  id="navbar-btn-upload"
                  onClick={onOpenUpload}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition active:scale-95"
                >
                  <Plus className="w-4 h-4" />
                  <span className="hidden sm:inline">Tải tài liệu</span>
                </button>

                {/* Billing Badge: Credit-aware if enabled, otherwise legacy quota */}
                {creditBillingEnabled ? (
                  <CreditBalanceBadge
                    balance={creditBalance.balance}
                    uiState={creditBalance.uiState}
                    onClick={() => onNavigate('pricing')}
                  />
                ) : (
                  quota && (
                    <div
                      id="navbar-quota-badge"
                      onClick={() => onNavigate('pricing')}
                      className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-300 hover:border-slate-600 cursor-pointer transition"
                      title={`Hạn mức: ${quota.used}/${quota.total} tài liệu`}
                    >
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      <span>
                        <strong className="text-white font-semibold">{quota.used}</strong>/{quota.total} tài liệu
                      </span>
                    </div>
                  )
                )}

                {/* User Dropdown */}
                <div className="relative">
                  <button
                    id="navbar-user-menu-btn"
                    onClick={() => setDropdownOpen(!dropdownOpen)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 border border-slate-700 text-sm font-medium text-slate-200 focus:outline-none"
                  >
                    <div className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-300 flex items-center justify-center font-bold text-xs">
                      {user?.fullName ? user.fullName[0].toUpperCase() : 'U'}
                    </div>
                    <span className="max-w-[120px] truncate hidden md:inline">{user?.fullName}</span>
                    <ChevronDown className="w-4 h-4 text-slate-400" />
                  </button>

                  {dropdownOpen && (
                    <div
                      id="navbar-user-dropdown"
                      className="absolute right-0 mt-2 w-56 bg-slate-800 rounded-xl shadow-xl border border-slate-700 py-1.5 z-50 text-slate-200 divide-y divide-slate-700 animate-fade-in"
                    >
                      <div className="px-4 py-2.5">
                        <p className="text-xs text-slate-400">Đăng nhập với tư cách</p>
                        <p className="text-sm font-semibold text-white truncate">{user?.fullName}</p>
                        <p className="text-xs text-slate-400 truncate">{user?.email}</p>
                      </div>

                      <div className="py-1">
                        <button
                          id="dropdown-link-account"
                          onClick={() => {
                            setDropdownOpen(false);
                            onNavigate('account');
                          }}
                          className="w-full text-left px-4 py-2 text-sm flex items-center gap-2.5 hover:bg-slate-700 transition"
                        >
                          <UserIcon className="w-4 h-4 text-slate-400" />
                          Thông tin tài khoản
                        </button>
                        <button
                          id="dropdown-link-pricing"
                          onClick={() => {
                            setDropdownOpen(false);
                            onNavigate('pricing');
                          }}
                          className="w-full text-left px-4 py-2 text-sm flex items-center gap-2.5 hover:bg-slate-700 transition"
                        >
                          <Sparkles className="w-4 h-4 text-amber-400" />
                          Nâng cấp gói cước
                        </button>
                      </div>

                      <div className="py-1">
                        <button
                          id="dropdown-btn-logout"
                          onClick={handleLogout}
                          className="w-full text-left px-4 py-2 text-sm text-rose-400 hover:bg-slate-700 flex items-center gap-2.5 transition"
                        >
                          <LogOut className="w-4 h-4" />
                          Đăng xuất
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  id="nav-btn-login"
                  onClick={() => onNavigate('login')}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-slate-300 hover:text-white transition"
                >
                  Đăng nhập
                </button>
                <button
                  id="nav-btn-register"
                  onClick={() => onNavigate('register')}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition"
                >
                  Thử miễn phí
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
