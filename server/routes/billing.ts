import { Router, Request, Response } from 'express';
import { billingService, BillingCatalogUnavailableError } from '../services/billing/billingService.js';
import { PricingChannel } from '../types/billing.js';

const router = Router();

/**
 * GET /api/billing/health
 * Readiness probe for billing domain
 */
router.get('/health', async (_req: Request, res: Response): Promise<void> => {
  try {
    const health = await billingService.checkBillingCatalogHealth();
    res.status(health.healthy ? 200 : 503).json({
      success: health.healthy,
      ...health,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/billing/plans
 * Query param: channel = 'WEB' | 'API' | 'ENTERPRISE' (default: 'WEB')
 */
router.get('/plans', async (req: Request, res: Response): Promise<void> => {
  try {
    const rawChannel = (req.query.channel as string || 'WEB').toUpperCase();
    const validChannels: PricingChannel[] = ['WEB', 'API', 'ENTERPRISE'];
    const channel: PricingChannel = validChannels.includes(rawChannel as PricingChannel)
      ? (rawChannel as PricingChannel)
      : 'WEB';

    const plans = await billingService.getActivePricingPlans(channel);
    const source = (plans as any).source || 'DATABASE';
    res.json({
      success: true,
      channel,
      source,
      plans,
    });
  } catch (err: any) {
    console.error('[Billing API] Error fetching plans:', err);
    if (err instanceof BillingCatalogUnavailableError || err.message?.includes('BILLING_CATALOG_UNAVAILABLE')) {
      res.status(503).json({
        success: false,
        error: 'BILLING_CATALOG_UNAVAILABLE',
        message: 'Bảng giá dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.',
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Không thể tải bảng giá sản phẩm',
    });
  }
});

/**
 * GET /api/billing/credit-packs
 * Query param: channel = 'WEB' | 'API' | 'ENTERPRISE' (default: 'WEB')
 */
router.get('/credit-packs', async (req: Request, res: Response): Promise<void> => {
  try {
    const rawChannel = (req.query.channel as string || 'WEB').toUpperCase();
    const validChannels: PricingChannel[] = ['WEB', 'API', 'ENTERPRISE'];
    const channel: PricingChannel = validChannels.includes(rawChannel as PricingChannel)
      ? (rawChannel as PricingChannel)
      : 'WEB';

    const creditPacks = await billingService.getCreditPacks(channel);
    const source = (creditPacks as any).source || 'DATABASE';
    res.json({
      success: true,
      channel,
      source,
      creditPacks,
    });
  } catch (err: any) {
    console.error('[Billing API] Error fetching credit packs:', err);
    if (err instanceof BillingCatalogUnavailableError || err.message?.includes('BILLING_CATALOG_UNAVAILABLE')) {
      res.status(503).json({
        success: false,
        error: 'BILLING_CATALOG_UNAVAILABLE',
        message: 'Danh sách gói nạp tạm thời không khả dụng. Vui lòng thử lại sau.',
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'Không thể tải danh sách gói nạp credit',
    });
  }
});

/**
 * GET /api/billing/version
 */
router.get('/version', async (_req: Request, res: Response): Promise<void> => {
  try {
    const version = await billingService.getPricingVersion('pricing-v1');
    if (!version) {
      res.status(404).json({
        success: false,
        error: 'PRICING_VERSION_NOT_FOUND',
      });
      return;
    }
    res.json({
      success: true,
      version,
    });
  } catch (err: any) {
    console.error('[Billing API] Error fetching version:', err);
    res.status(500).json({
      success: false,
      error: 'Không thể tải thông tin phiên bản bảng giá',
    });
  }
});

export default router;
