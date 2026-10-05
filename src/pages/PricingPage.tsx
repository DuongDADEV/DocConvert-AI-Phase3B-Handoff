import React, { useState, useEffect } from 'react';
import {
  Check,
  Sparkles,
  Zap,
  Shield,
  ArrowRight,
  Loader2,
  Coins,
  Info,
  X,
  FileText,
  Clock,
  Layers,
  Flame,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { BillingPricingPlan, CreditPack } from '../types';
import { api } from '../services/api';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorAlert } from '../components/common/ErrorAlert';

interface PricingPageProps {
  onNavigate: (tab: string) => void;
}

export const PricingPage: React.FC<PricingPageProps> = ({ onNavigate }) => {
  const { user, updateQuota, refreshProfile, isAuthenticated } = useAuth();
  const [plans, setPlans] = useState<BillingPricingPlan[]>([]);
  const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [upgradingPlanCode, setUpgradingPlanCode] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPackModal, setSelectedPackModal] = useState<CreditPack | null>(null);
  const [selectedSubscriptionModal, setSelectedSubscriptionModal] = useState<BillingPricingPlan | null>(null);
  const [showSubscriptionInfo, setShowSubscriptionInfo] = useState(false);
  const [showPackInfo, setShowPackInfo] = useState(false);

  useEffect(() => {
    const fetchBillingData = async () => {
      try {
        setIsLoading(true);
        const [plansRes, packsRes] = await Promise.all([
          api.getBillingPlans('WEB'),
          api.getCreditPacks('WEB'),
        ]);

        if (plansRes.success && plansRes.plans) {
          setPlans(plansRes.plans);
        }
        if (packsRes.success && packsRes.creditPacks) {
          setCreditPacks(packsRes.creditPacks);
        }
      } catch (err: any) {
        setError(err.message || 'Không thể tải bảng giá dịch vụ.');
      } finally {
        setIsLoading(false);
      }
    };
    fetchBillingData();
  }, []);

  const handleUpgrade = async (planCode: string) => {
    if (!isAuthenticated) {
      onNavigate('register');
      return;
    }

    setUpgradingPlanCode(planCode);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await api.upgradePlan(planCode);
      if (res.success) {
        setSuccessMessage(res.message);
        if (res.quota) {
          updateQuota(res.quota);
        }
        await refreshProfile();
      }
    } catch (err: any) {
      setError(err.message || 'Có lỗi xảy ra khi nâng cấp gói.');
    } finally {
      setUpgradingPlanCode(null);
    }
  };

  const formatPrice = (price: number): string => {
    if (price === 0) return '0đ';
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  };

  const formatCredits = (credits: number): string => {
    return new Intl.NumberFormat('vi-VN').format(credits);
  };

  const renderApiBadge = (level: string) => {
    if (level === 'FULL') {
      return (
        <span className="inline-flex items-center text-emerald-600 font-bold">
          <Check className="w-4 h-4 mr-0.5 inline" /> Có
        </span>
      );
    }
    if (level === 'BETA') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/20">
          Beta
        </span>
      );
    }
    return <span className="text-slate-400">—</span>;
  };

  return (
    <div id="pricing-page" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-16 animate-fade-in">
      {/* 1. Header */}
      <div className="text-center max-w-3xl mx-auto space-y-4">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-bold uppercase tracking-wider">
          <Sparkles className="w-3.5 h-3.5" />
          Bảng giá dịch vụ SaaS DocConvert AI
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
          Chọn gói phù hợp với nhu cầu xử lý tài liệu của bạn
        </h1>
        <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
          Chi phí xử lý được quy đổi minh bạch bằng Credit trước khi bạn xác nhận.
        </p>
      </div>

      {successMessage && (
        <div className="max-w-xl mx-auto p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center justify-between shadow-xs">
          <span>{successMessage}</span>
          <button onClick={() => onNavigate('dashboard')} className="text-emerald-900 underline ml-2">
            Về Dashboard
          </button>
        </div>
      )}

      {error && <ErrorAlert message={error} onClose={() => setError(null)} />}

      {/* 2. Subscription Plans Grid (4 Standard Plans: Free, Basic, Pro, Business) */}
      {isLoading ? (
        <LoadingSpinner message="Đang tải dữ liệu bảng giá chuẩn..." />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between max-w-7xl mx-auto px-1">
            <div className="flex items-center gap-2">
              <h2 className="text-xl sm:text-2xl font-bold text-slate-900">Gói Đăng Ký (Subscription)</h2>
              <div className="relative inline-block">
                <button
                  id="btn-subscription-info"
                  type="button"
                  aria-label="Thông tin gói Subscription"
                  onClick={() => setShowSubscriptionInfo(!showSubscriptionInfo)}
                  className="p-1 rounded-full text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition cursor-pointer"
                  title="Thông tin chu kỳ và bảo lưu credit"
                >
                  <Info className="w-4 h-4" />
                </button>
                {showSubscriptionInfo && (
                  <div
                    id="popover-subscription-info"
                    className="absolute z-20 left-0 top-full mt-2 w-80 sm:w-96 p-4 bg-white rounded-2xl border border-slate-200 shadow-xl text-xs text-slate-600 space-y-2 animate-fade-in"
                  >
                    <div className="flex items-center justify-between font-bold text-slate-900 pb-1 border-b border-slate-100">
                      <span>Chính sách Credit gói Subscription</span>
                      <button onClick={() => setShowSubscriptionInfo(false)} className="text-slate-400 hover:text-slate-600">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <p className="leading-relaxed">
                      Credit của gói Subscription được cấp theo từng chu kỳ thanh toán. Credit chưa sử dụng hết sẽ không cộng dồn sang chu kỳ tiếp theo.
                    </p>
                    <p className="leading-relaxed text-blue-700 font-medium">
                      Credit Pack mua riêng không bị mất khi gói Subscription gia hạn hoặc kết thúc.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
            {plans.map((plan) => {
              const isCurrent = user?.currentPlanId === plan.code;
              const isPopular = plan.metadata?.badge === 'PHỔ BIẾN NHẤT' || plan.code === 'PRO';
              const isFree = plan.code === 'FREE' || plan.price === 0;

              return (
                <div
                  key={plan.id}
                  id={`pricing-card-${plan.code.toLowerCase()}`}
                  className={`rounded-3xl flex flex-col justify-between transition-all duration-200 relative p-6 ${
                    isPopular
                      ? 'bg-gradient-to-b from-blue-900 via-slate-900 to-slate-900 text-white border-2 border-blue-500 shadow-xl shadow-blue-950/20'
                      : 'bg-white border border-slate-200 shadow-xs hover:border-slate-300 text-slate-900'
                  }`}
                >
                  {/* Badge */}
                  {plan.metadata?.badge && (
                    <div className="absolute -top-3.5 right-6 px-3 py-1 bg-gradient-to-r from-blue-500 to-indigo-600 text-white text-[11px] font-extrabold rounded-full tracking-wider uppercase shadow-md flex items-center gap-1">
                      <Flame className="w-3 h-3 text-amber-300" />
                      {plan.metadata.badge}
                    </div>
                  )}

                  <div>
                    {/* Header: Name & Status */}
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span
                        className={`text-xs font-bold uppercase tracking-wider ${
                          isPopular ? 'text-blue-400' : 'text-slate-500'
                        }`}
                      >
                        {plan.name}
                      </span>
                      {isCurrent && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                          Đang sử dụng
                        </span>
                      )}
                    </div>

                    <p className={`text-xs line-clamp-2 min-h-[32px] ${isPopular ? 'text-slate-300' : 'text-slate-500'}`}>
                      {isFree ? '10 credits dùng thử — cấp một lần cho mỗi tài khoản.' : plan.description}
                    </p>

                    {/* Price */}
                    <div className="flex items-baseline gap-1 my-5 pb-4 border-b border-slate-100 dark:border-slate-800">
                      <span className={`text-3xl sm:text-4xl font-black ${isPopular ? 'text-white' : 'text-slate-900'}`}>
                        {formatPrice(plan.price)}
                      </span>
                      <span className={`text-xs ${isPopular ? 'text-slate-400' : 'text-slate-500'}`}>
                        {isFree ? '/ dùng thử' : '/ tháng'}
                      </span>
                    </div>

                    {/* Entitlements List */}
                    <div className="space-y-3.5 text-xs mb-8">
                      {/* Credits */}
                      <div className="flex items-center justify-between py-1">
                        <span className={isPopular ? 'text-slate-300' : 'text-slate-500'}>Dung lượng:</span>
                        <strong className={`font-bold ${isPopular ? 'text-white' : 'text-slate-900'}`}>
                          {formatCredits(plan.credits)} credits
                        </strong>
                      </div>

                      {/* Max File Size */}
                      <div className="flex items-center justify-between py-1">
                        <span className={isPopular ? 'text-slate-300' : 'text-slate-500'}>Kích thước file tối đa:</span>
                        <span className={`font-medium ${isPopular ? 'text-slate-200' : 'text-slate-700'}`}>
                          {plan.entitlements.max_file_mb} MB
                        </span>
                      </div>

                      {/* PDF to Word */}
                      <div className="flex items-center justify-between py-1">
                        <span className={isPopular ? 'text-slate-300' : 'text-slate-500'}>PDF → Word:</span>
                        <span className="text-emerald-500 font-bold flex items-center gap-1">
                          <Check className="w-3.5 h-3.5" /> Có
                        </span>
                      </div>

                      {/* PDF to Excel */}
                      <div className="flex items-center justify-between py-1">
                        <span className={isPopular ? 'text-slate-300' : 'text-slate-500'}>PDF → Excel:</span>
                        <span className="text-emerald-500 font-bold flex items-center gap-1">
                          <Check className="w-3.5 h-3.5" /> Có
                        </span>
                      </div>

                      {/* Batch Processing */}
                      <div className="flex items-center justify-between py-1">
                        <span className={isPopular ? 'text-slate-300' : 'text-slate-500'}>Xử lý hàng loạt:</span>
                        {plan.entitlements.batch_enabled ? (
                          <span className="text-emerald-500 font-bold flex items-center gap-1">
                            <Check className="w-3.5 h-3.5" /> Có
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </div>

                      {/* Priority Queue */}
                      <div className="flex items-center justify-between py-1">
                        <span className={isPopular ? 'text-slate-300' : 'text-slate-500'}>Hàng đợi ưu tiên:</span>
                        {plan.entitlements.priority_queue ? (
                          <span className="text-emerald-500 font-bold flex items-center gap-1">
                            <Check className="w-3.5 h-3.5" /> Có
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </div>

                      {/* API Access */}
                      <div className="flex items-center justify-between py-1">
                        <span className={isPopular ? 'text-slate-300' : 'text-slate-500'}>Truy cập API:</span>
                        {renderApiBadge(plan.entitlements.api_access)}
                      </div>

                      {/* Retention Days */}
                      <div className="flex items-center justify-between py-1">
                        <span className={isPopular ? 'text-slate-300' : 'text-slate-500'}>Lưu trữ file:</span>
                        <span className={`font-medium ${isPopular ? 'text-slate-200' : 'text-slate-700'}`}>
                          {plan.entitlements.retention_days} ngày
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Action Button */}
                  <div>
                    <button
                      id={`btn-select-plan-${plan.code.toLowerCase()}`}
                      onClick={() => {
                        if (isFree) {
                          handleUpgrade(plan.code);
                        } else {
                          setSelectedSubscriptionModal(plan);
                        }
                      }}
                      disabled={isCurrent || !!upgradingPlanCode}
                      className={`w-full py-3 px-4 rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 ${
                        isCurrent
                          ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                          : isPopular
                          ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-600/30 active:scale-98'
                          : 'bg-slate-900 hover:bg-slate-800 text-white active:scale-98'
                      }`}
                    >
                      {upgradingPlanCode === plan.code ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Đang xử lý...</span>
                        </>
                      ) : isCurrent ? (
                        <span>Gói đang kích hoạt</span>
                      ) : (
                        <>
                          <span>{isFree ? 'Bắt đầu dùng thử' : 'Nâng cấp ngay'}</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </>
                      )}
                    </button>
                    <p className="text-[10px] text-center text-slate-400 mt-2">
                      {isCurrent ? 'Bạn đang sử dụng gói này' : 'Kích hoạt ngay lập tức'}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Pay-as-you-go Credit Packs Section */}
      <div className="pt-10 border-t border-slate-200 space-y-8">
        <div className="text-center max-w-2xl mx-auto space-y-2">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold">
            <Coins className="w-3.5 h-3.5" />
            Nạp Credit Linh Hoạt
          </div>
          <div className="flex items-center justify-center gap-2">
            <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
              Không muốn đăng ký hàng tháng? Mua credit dùng một lần từ 59.000đ
            </h2>
            <div className="relative inline-block">
              <button
                id="btn-pack-info"
                type="button"
                aria-label="Thông tin gói Credit Pack"
                onClick={() => setShowPackInfo(!showPackInfo)}
                className="p-1.5 rounded-full text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 transition cursor-pointer"
                title="Thông tin tích lũy credit pack"
              >
                <Info className="w-5 h-5" />
              </button>
              {showPackInfo && (
                <div
                  id="popover-pack-info"
                  className="absolute z-20 left-1/2 -translate-x-1/2 top-full mt-2 w-80 sm:w-96 p-4 bg-white rounded-2xl border border-slate-200 shadow-xl text-xs text-slate-600 space-y-2 text-left animate-fade-in"
                >
                  <div className="flex items-center justify-between font-bold text-slate-900 pb-1 border-b border-slate-100">
                    <span>Chính sách Credit Pack (Pay-as-you-go)</span>
                    <button onClick={() => setShowPackInfo(false)} className="text-slate-400 hover:text-slate-600">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <p className="leading-relaxed">
                    Credit Pack được cộng vào số dư hiện có và không bị reset theo chu kỳ Subscription. Trong giai đoạn hiện tại, Credit Pack được giữ lại cho đến khi sử dụng hết.
                  </p>
                </div>
              )}
            </div>
          </div>
          <p className="text-xs sm:text-sm text-slate-600">
            Mua credit một lần và sử dụng khi cần.
          </p>
        </div>

        {/* Credit Packs Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
          {creditPacks.map((pack) => (
            <div
              key={pack.id}
              id={`credit-pack-${pack.code.toLowerCase()}`}
              className="bg-white rounded-2xl border border-slate-200 hover:border-blue-400 p-6 flex flex-col justify-between shadow-xs transition-all hover:shadow-md"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500 uppercase">{pack.name}</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-extrabold bg-blue-50 text-blue-700 border border-blue-200">
                    Pay-as-you-go
                  </span>
                </div>

                <div className="flex items-baseline gap-1.5 pt-2">
                  <span className="text-3xl font-black text-slate-900">{formatCredits(pack.credits)}</span>
                  <span className="text-xs text-slate-500 font-semibold">credits</span>
                </div>

                <div className="text-base font-extrabold text-blue-600">
                  {formatPrice(pack.price)}
                </div>

                <p className="text-[11px] text-slate-500 min-h-[32px]">
                  {pack.description}
                </p>
              </div>

              <div className="pt-6">
                <button
                  id={`btn-buy-pack-${pack.code.toLowerCase()}`}
                  onClick={() => setSelectedPackModal(pack)}
                  className="w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-slate-100 hover:bg-blue-50 hover:text-blue-700 text-slate-800 border border-slate-200 hover:border-blue-300 transition flex items-center justify-center gap-1.5 active:scale-98"
                >
                  <Coins className="w-3.5 h-3.5" />
                  <span>Mua credit</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4A. Subscription Plan Checkout Confirmation Modal */}
      {selectedSubscriptionModal && (
        <div
          id="subscription-checkout-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in"
        >
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-5 relative">
            <button
              onClick={() => setSelectedSubscriptionModal(null)}
              className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Xác nhận gói {selectedSubscriptionModal.name}</h3>
                <p className="text-xs text-slate-500">
                  {formatCredits(selectedSubscriptionModal.credits)} credits/tháng • {formatPrice(selectedSubscriptionModal.price)}/tháng
                </p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-blue-50/70 border border-blue-200 text-blue-950 text-xs space-y-2">
              <div className="font-bold flex items-center gap-1.5 text-blue-900">
                <Info className="w-4 h-4 text-blue-600 shrink-0" />
                Thông tin chu kỳ thanh toán & Credit
              </div>
              <ul className="space-y-1.5 text-slate-700 list-disc list-inside">
                <li><strong>Hạn mức:</strong> {formatCredits(selectedSubscriptionModal.credits)} credits được cấp theo từng chu kỳ thanh toán hàng tháng.</li>
                <li><strong>Chu kỳ:</strong> Gia hạn tự động theo chu kỳ hàng tháng.</li>
                <li><strong>Không cộng dồn:</strong> Credit của gói Subscription chưa sử dụng hết sẽ không cộng dồn sang chu kỳ tiếp theo.</li>
                <li><strong>Credit Pack độc lập:</strong> Credit Pack mua riêng không bị mất khi gói Subscription gia hạn hoặc kết thúc.</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setSelectedSubscriptionModal(null)}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
              >
                Hủy
              </button>
              <button
                id="btn-confirm-subscription-upgrade"
                onClick={() => {
                  const code = selectedSubscriptionModal.code;
                  setSelectedSubscriptionModal(null);
                  handleUpgrade(code);
                }}
                disabled={!!upgradingPlanCode}
                className="px-5 py-2.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white transition shadow-sm flex items-center gap-1.5 cursor-pointer"
              >
                {upgradingPlanCode ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <>
                    <span>Xác nhận nâng cấp</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4B. Credit Pack Purchase Informational Modal (No Fake Payment) */}
      {selectedPackModal && (
        <div
          id="credit-pack-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 animate-fade-in"
        >
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-5 relative">
            <button
              onClick={() => setSelectedPackModal(null)}
              className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                <Coins className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">{selectedPackModal.name}</h3>
                <p className="text-xs text-slate-500">
                  {formatCredits(selectedPackModal.credits)} credits • {formatPrice(selectedPackModal.price)}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-emerald-50/80 border border-emerald-200 text-emerald-950 text-xs space-y-2">
              <div className="font-bold flex items-center gap-1.5 text-emerald-900">
                <Coins className="w-4 h-4 text-emerald-600 shrink-0" />
                Chi tiết gói nạp Credit Pack
              </div>
              <ul className="space-y-1.5 text-slate-700 list-disc list-inside">
                <li><strong>Số lượng:</strong> {formatCredits(selectedPackModal.credits)} credits được cộng vào số dư hiện có.</li>
                <li><strong>Không bị reset:</strong> Credit Pack được cộng vào số dư hiện có và không bị reset theo chu kỳ Subscription.</li>
                <li><strong>Thời hạn sử dụng:</strong> Trong giai đoạn hiện tại, Credit Pack được giữ lại cho đến khi sử dụng hết.</li>
                <li><strong>Thanh toán một lần:</strong> Mua theo nhu cầu, không tự động gia hạn định kỳ.</li>
              </ul>
            </div>

            <div className="p-4 rounded-2xl bg-amber-50/80 border border-amber-200/80 text-amber-900 text-xs space-y-2">
              <div className="flex items-center gap-1.5 font-bold text-amber-800">
                <Info className="w-4 h-4 shrink-0" />
                Cổng thanh toán tự động đang chuẩn bị ra mắt
              </div>
              <p className="text-slate-600 leading-relaxed">
                Hệ thống thanh toán tự động qua thẻ và chuyển khoản QR (PayOS / MoMo / VNPay) sẽ được kích hoạt ở Phase tiếp theo.
              </p>
              <p className="text-slate-600 leading-relaxed">
                Để nhận thêm credit dùng thử phục vụ công việc của bạn ngay bây giờ, vui lòng liên hệ bộ phận hỗ trợ khách hàng.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setSelectedPackModal(null)}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
              >
                Đóng
              </button>
              <button
                onClick={() => {
                  setSelectedPackModal(null);
                  onNavigate('dashboard');
                }}
                className="px-4 py-2.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white transition shadow-sm"
              >
                Về Trang chủ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Security & Trust Note */}
      <div className="max-w-2xl mx-auto p-4 rounded-2xl bg-slate-50 border border-slate-200 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
        <Shield className="w-4 h-4 text-emerald-600 shrink-0" />
        <span>Hệ thống bảo vệ dữ liệu doanh nghiệp. Mọi tài liệu và số liệu kế toán được bảo mật tối đa.</span>
      </div>
    </div>
  );
};
