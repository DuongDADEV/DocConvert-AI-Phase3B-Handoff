import { getSupabaseAdminClient } from '../supabaseClient.js';
import {
  PricingPlanDto,
  CreditPackDto,
  PricingChannel,
  PricingVersionRecord,
  BillingProductRecord,
  BillingPriceRecord,
  PlanEntitlementsRecord,
  ProductCreditGrantRecord,
} from '../../types/billing.js';

export class BillingCatalogUnavailableError extends Error {
  code = 'BILLING_CATALOG_UNAVAILABLE';
  constructor(message = 'Bảng giá thương mại hiện không khả dụng trên cơ sở dữ liệu.') {
    super(message);
    this.name = 'BillingCatalogUnavailableError';
  }
}

// Seed Catalog Fallback (strictly for explicit offline / dev demonstration)
const SEED_FALLBACK_VERSION: PricingVersionRecord = {
  id: '00000000-0000-0000-0000-000000000001',
  code: 'pricing-v1',
  description: 'Bảng giá chuẩn SaaS v1 - DocConvert AI',
  active: true,
  is_locked: false,
  effective_from: '2026-09-30T00:00:00Z',
  created_at: '2026-09-30T00:00:00Z',
};

const SEED_FALLBACK_PLANS: PricingPlanDto[] = [
  {
    id: 'prod-free',
    code: 'FREE',
    name: 'Gói Miễn Phí (Free)',
    description: 'Gói khởi đầu cho cá nhân trải nghiệm tính năng OCR văn bản và bảng',
    channel: 'WEB',
    product_type: 'SUBSCRIPTION',
    price: 0,
    currency: 'VND',
    billing_interval: 'NONE',
    interval_count: 1,
    credits: 10,
    entitlements: {
      included_credits: 10,
      max_file_mb: 20,
      batch_enabled: false,
      priority_queue: false,
      api_access: 'NONE',
      retention_days: 3,
      pdf_to_word: true,
      pdf_to_excel: true,
    },
    metadata: { badge: null, sort_order: 1 },
    pricing_version: 'pricing-v1',
  },
  {
    id: 'prod-basic',
    code: 'BASIC',
    name: 'Gói Cơ Bản (Basic)',
    description: 'Tối ưu cho kế toán độc lập và cá nhân có nhu cầu chuyển đổi định kỳ',
    channel: 'WEB',
    product_type: 'SUBSCRIPTION',
    price: 129000,
    currency: 'VND',
    billing_interval: 'MONTH',
    interval_count: 1,
    credits: 120,
    entitlements: {
      included_credits: 120,
      max_file_mb: 50,
      batch_enabled: false,
      priority_queue: false,
      api_access: 'NONE',
      retention_days: 7,
      pdf_to_word: true,
      pdf_to_excel: true,
    },
    metadata: { badge: null, sort_order: 2 },
    pricing_version: 'pricing-v1',
  },
  {
    id: 'prod-pro',
    code: 'PRO',
    name: 'Gói Chuyên Nghiệp (Pro)',
    description: 'Dành cho chuyên viên ngân hàng và văn phòng tài chính xử lý liên tục',
    channel: 'WEB',
    product_type: 'SUBSCRIPTION',
    price: 349000,
    currency: 'VND',
    billing_interval: 'MONTH',
    interval_count: 1,
    credits: 450,
    entitlements: {
      included_credits: 450,
      max_file_mb: 100,
      batch_enabled: true,
      priority_queue: true,
      api_access: 'BETA',
      retention_days: 30,
      pdf_to_word: true,
      pdf_to_excel: true,
    },
    metadata: { badge: 'PHỔ BIẾN NHẤT', sort_order: 3 },
    pricing_version: 'pricing-v1',
  },
  {
    id: 'prod-business',
    code: 'BUSINESS',
    name: 'Gói Doanh Nghiệp (Business)',
    description: 'Giải pháp toàn diện cho doanh nghiệp và đội ngũ cần bảo mật và hạn mức cao',
    channel: 'WEB',
    product_type: 'SUBSCRIPTION',
    price: 899000,
    currency: 'VND',
    billing_interval: 'MONTH',
    interval_count: 1,
    credits: 1400,
    entitlements: {
      included_credits: 1400,
      max_file_mb: 200,
      batch_enabled: true,
      priority_queue: true,
      api_access: 'FULL',
      retention_days: 90,
      pdf_to_word: true,
      pdf_to_excel: true,
    },
    metadata: { badge: null, sort_order: 4 },
    pricing_version: 'pricing-v1',
  },
];

const SEED_FALLBACK_CREDIT_PACKS: CreditPackDto[] = [
  {
    id: 'prod-pack-50',
    code: 'PACK_50',
    name: 'Gói Nạp 50 Credits',
    description: 'Gói nạp credit dùng một lần khi phát sinh tài liệu đột xuất',
    channel: 'WEB',
    product_type: 'CREDIT_PACK',
    price: 59000,
    currency: 'VND',
    credits: 50,
    metadata: { sort_order: 1 },
    pricing_version: 'pricing-v1',
  },
  {
    id: 'prod-pack-200',
    code: 'PACK_200',
    name: 'Gói Nạp 200 Credits',
    description: 'Gói nạp credit tiết kiệm cho khối lượng công việc theo đợt',
    channel: 'WEB',
    product_type: 'CREDIT_PACK',
    price: 199000,
    currency: 'VND',
    credits: 200,
    metadata: { sort_order: 2 },
    pricing_version: 'pricing-v1',
  },
  {
    id: 'prod-pack-500',
    code: 'PACK_500',
    name: 'Gói Nạp 500 Credits',
    description: 'Gói nạp phổ biến cho đợt quyết toán thuế và báo cáo quý',
    channel: 'WEB',
    product_type: 'CREDIT_PACK',
    price: 449000,
    currency: 'VND',
    credits: 500,
    metadata: { sort_order: 3 },
    pricing_version: 'pricing-v1',
  },
  {
    id: 'prod-pack-2000',
    code: 'PACK_2000',
    name: 'Gói Nạp 2.000 Credits',
    description: 'Gói nạp dung lượng lớn với chi phí tối ưu nhất cho văn phòng',
    channel: 'WEB',
    product_type: 'CREDIT_PACK',
    price: 1490000,
    currency: 'VND',
    credits: 2000,
    metadata: { sort_order: 4 },
    pricing_version: 'pricing-v1',
  },
];

export class BillingService {
  private clientOverride?: any;

  /**
   * For testing / controlled failure simulation only.
   * Passing null restores the default Supabase admin client.
   */
  setClientOverride(client: any | null) {
    this.clientOverride = client || undefined;
  }

  private getClient() {
    return this.clientOverride || getSupabaseAdminClient();
  }

  /**
   * Determine if catalog fallback is permitted:
   * Only permitted in non-production environments when explicitly enabled via:
   * ALLOW_BILLING_CATALOG_FALLBACK === 'true'
   * Defaults to FALSE in production.
   */
  isFallbackAllowed(): boolean {
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) return false;
    return process.env.ALLOW_BILLING_CATALOG_FALLBACK === 'true';
  }

  /**
   * Fetch active pricing version record
   */
  async getPricingVersion(code = 'pricing-v1'): Promise<PricingVersionRecord | null> {
    try {
      const client = this.getClient();
      const { data, error } = await client
        .from('pricing_versions')
        .select('*')
        .eq('code', code)
        .eq('active', true)
        .maybeSingle();

      if (error || !data) {
        if (this.isFallbackAllowed()) {
          return SEED_FALLBACK_VERSION;
        }
        return null;
      }
      return data;
    } catch {
      if (this.isFallbackAllowed()) {
        return SEED_FALLBACK_VERSION;
      }
      return null;
    }
  }

  /**
   * Get active subscription plans for a sales channel (default: WEB)
   *
   * Architectural Boundary (Phase 1.3):
   * Displayed credit amount is sourced CANONICALLY from product_credit_grants.credits_granted.
   * plan_entitlements is strictly reserved for subscription capabilities (max_file_mb, batch, etc.).
   */
  async getActivePricingPlans(channel: PricingChannel = 'WEB'): Promise<PricingPlanDto[]> {
    try {
      const client = this.getClient();

      // Get active pricing version
      const version = await this.getPricingVersion('pricing-v1');
      const versionId = version?.id;

      if (!versionId && !this.isFallbackAllowed()) {
        throw new BillingCatalogUnavailableError(
          'BILLING_CATALOG_UNAVAILABLE: Active pricing version (pricing-v1) is unavailable in database.'
        );
      }

      // Query products
      let prodQuery = client
        .from('billing_products')
        .select('*')
        .eq('product_type', 'SUBSCRIPTION')
        .eq('pricing_channel', channel)
        .eq('active', true);

      const { data: products, error: prodErr } = await prodQuery;

      if (prodErr) {
        if (this.isFallbackAllowed()) {
          return channel === 'WEB' ? SEED_FALLBACK_PLANS : [];
        }
        throw new BillingCatalogUnavailableError(
          `BILLING_CATALOG_UNAVAILABLE: Failed to query subscription products (${prodErr.message})`
        );
      }

      if (!products || products.length === 0) {
        if (channel === 'WEB') {
          if (this.isFallbackAllowed()) return SEED_FALLBACK_PLANS;
          throw new BillingCatalogUnavailableError(
            'BILLING_CATALOG_UNAVAILABLE: No subscription products found for WEB channel in database.'
          );
        }
        return [];
      }

      const productIds = products.map((p) => p.id);

      // Query active prices
      let priceQuery = client
        .from('billing_prices')
        .select('*')
        .in('product_id', productIds)
        .eq('active', true);

      // Query entitlements (subscription capabilities only)
      let entQuery = client
        .from('plan_entitlements')
        .select('*')
        .in('product_id', productIds);

      // Query canonical credit grants (Single source of truth for credits)
      let grantQuery = client
        .from('product_credit_grants')
        .select('*')
        .in('product_id', productIds);

      if (versionId) {
        priceQuery = priceQuery.eq('pricing_version_id', versionId);
        entQuery = entQuery.eq('pricing_version_id', versionId);
        grantQuery = grantQuery.eq('pricing_version_id', versionId);
      }

      const [{ data: prices, error: priceErr }, { data: entitlements, error: entErr }, { data: grants, error: grantErr }] =
        await Promise.all([priceQuery, entQuery, grantQuery]);

      if (priceErr || entErr || grantErr) {
        if (this.isFallbackAllowed()) {
          return channel === 'WEB' ? SEED_FALLBACK_PLANS : [];
        }
        throw new BillingCatalogUnavailableError(
          `BILLING_CATALOG_UNAVAILABLE: Database error fetching prices, entitlements, or credit grants.`
        );
      }

      const priceMap = new Map<string, BillingPriceRecord>();
      (prices || []).forEach((pr) => {
        if (pr.active) priceMap.set(pr.product_id, pr);
      });

      const entMap = new Map<string, PlanEntitlementsRecord>();
      (entitlements || []).forEach((en) => {
        entMap.set(en.product_id, en);
      });

      const grantMap = new Map<string, ProductCreditGrantRecord>();
      (grants || []).forEach((gr) => {
        grantMap.set(gr.product_id, gr);
      });

      const results: PricingPlanDto[] = [];

      for (const prod of products) {
        const pr = priceMap.get(prod.id);
        const en = entMap.get(prod.id);
        const gr = grantMap.get(prod.id);

        // Inactive or missing price means not offered
        if (!pr || !pr.active) continue;

        const entMeta = en?.metadata || {};
        const sortOrder = prod.metadata?.sort_order || 99;

        // Canonical credit source: product_credit_grants.credits_granted ONLY.
        // If missing, fail closed. NEVER fall back to en.included_credits or metadata or 0.
        if (!gr || typeof gr.credits_granted !== 'number') {
          throw new BillingCatalogUnavailableError(
            `BILLING_CATALOG_UNAVAILABLE: Missing canonical credit grant in product_credit_grants for subscription product '${prod.code}'.`
          );
        }

        const canonicalCredits = gr.credits_granted;

        results.push({
          id: prod.id,
          code: prod.code,
          name: prod.name,
          description: prod.description || '',
          channel: prod.pricing_channel as PricingChannel,
          product_type: 'SUBSCRIPTION',
          price: Number(pr.amount_minor),
          currency: pr.currency || 'VND',
          billing_interval: pr.billing_interval,
          interval_count: pr.interval_count || 1,
          credits: canonicalCredits,
          entitlements: {
            included_credits: canonicalCredits, // Deprecated: mirrored for backward DTO compatibility only
            max_file_mb: en?.max_file_mb || 20,
            batch_enabled: !!en?.batch_enabled,
            priority_queue: !!en?.priority_queue,
            api_access: en?.api_access || 'NONE',
            retention_days: en?.retention_days || 3,
            pdf_to_word: entMeta.pdf_to_word ?? true,
            pdf_to_excel: entMeta.pdf_to_excel ?? true,
          },
          metadata: {
            badge: prod.metadata?.badge || null,
            sort_order: sortOrder,
            ...prod.metadata,
          },
          pricing_version: version?.code || 'pricing-v1',
        });
      }

      results.sort((a, b) => (a.metadata.sort_order || 0) - (b.metadata.sort_order || 0));
      const plansWithSource = results as PricingPlanDto[] & { source: 'DATABASE' | 'FALLBACK' };
      plansWithSource.source = 'DATABASE';
      return plansWithSource;
    } catch (err: any) {
      if (!this.isFallbackAllowed()) {
        if (err instanceof BillingCatalogUnavailableError) throw err;
        throw new BillingCatalogUnavailableError(`BILLING_CATALOG_UNAVAILABLE: ${err.message}`);
      }
      const fallbackPlans = [...(channel === 'WEB' ? SEED_FALLBACK_PLANS : [])] as PricingPlanDto[] & { source: 'DATABASE' | 'FALLBACK' };
      fallbackPlans.source = 'FALLBACK';
      return fallbackPlans;
    }
  }

  /**
   * Get credit packs for pay-as-you-go purchasing
   *
   * Canonical source: product_credit_grants.credits_granted.
   * Credit packs do NOT have plan_entitlements entries.
   */
  async getCreditPacks(channel: PricingChannel = 'WEB'): Promise<CreditPackDto[]> {
    try {
      const client = this.getClient();
      const version = await this.getPricingVersion('pricing-v1');
      const versionId = version?.id;

      if (!versionId && !this.isFallbackAllowed()) {
        throw new BillingCatalogUnavailableError(
          'BILLING_CATALOG_UNAVAILABLE: Active pricing version (pricing-v1) is unavailable in database.'
        );
      }

      const { data: products, error: prodErr } = await client
        .from('billing_products')
        .select('*')
        .eq('product_type', 'CREDIT_PACK')
        .eq('pricing_channel', channel)
        .eq('active', true);

      if (prodErr || !products || products.length === 0) {
        if (this.isFallbackAllowed()) {
          return channel === 'WEB' ? SEED_FALLBACK_CREDIT_PACKS : [];
        }
        throw new BillingCatalogUnavailableError(
          `BILLING_CATALOG_UNAVAILABLE: Failed to query credit packs (${prodErr?.message || 'NO_PRODUCTS'})`
        );
      }

      const productIds = products.map((p) => p.id);
      let priceQuery = client
        .from('billing_prices')
        .select('*')
        .in('product_id', productIds)
        .eq('active', true);

      // Dedicated canonical credit grant table
      let grantQuery = client
        .from('product_credit_grants')
        .select('*')
        .in('product_id', productIds);

      if (versionId) {
        priceQuery = priceQuery.eq('pricing_version_id', versionId);
        grantQuery = grantQuery.eq('pricing_version_id', versionId);
      }

      const [{ data: prices, error: priceErr }, { data: grants, error: grantErr }] = await Promise.all([
        priceQuery,
        grantQuery,
      ]);

      if (priceErr || grantErr) {
        if (this.isFallbackAllowed()) {
          return channel === 'WEB' ? SEED_FALLBACK_CREDIT_PACKS : [];
        }
        throw new BillingCatalogUnavailableError(
          `BILLING_CATALOG_UNAVAILABLE: Database error fetching credit pack prices or grants.`
        );
      }

      const priceMap = new Map<string, BillingPriceRecord>();
      (prices || []).forEach((pr) => {
        if (pr.active) priceMap.set(pr.product_id, pr);
      });

      const grantMap = new Map<string, ProductCreditGrantRecord>();
      (grants || []).forEach((gr) => {
        grantMap.set(gr.product_id, gr);
      });

      const results: CreditPackDto[] = [];

      for (const prod of products) {
        const pr = priceMap.get(prod.id);
        if (!pr || !pr.active) continue;

        const gr = grantMap.get(prod.id);
        if (!gr || typeof gr.credits_granted !== 'number') {
          throw new BillingCatalogUnavailableError(
            `BILLING_CATALOG_UNAVAILABLE: Missing canonical credit grant in product_credit_grants for credit pack '${prod.code}'.`
          );
        }

        const credits = gr.credits_granted;

        results.push({
          id: prod.id,
          code: prod.code,
          name: prod.name,
          description: prod.description || '',
          channel: prod.pricing_channel as PricingChannel,
          product_type: 'CREDIT_PACK',
          price: Number(pr.amount_minor),
          currency: pr.currency || 'VND',
          credits,
          metadata: {
            sort_order: prod.metadata?.sort_order || 99,
            ...prod.metadata,
          },
          pricing_version: version?.code || 'pricing-v1',
        });
      }

      results.sort((a, b) => (a.metadata.sort_order || 0) - (b.metadata.sort_order || 0));
      const packsWithSource = results as CreditPackDto[] & { source: 'DATABASE' | 'FALLBACK' };
      packsWithSource.source = 'DATABASE';
      return packsWithSource;
    } catch (err: any) {
      if (!this.isFallbackAllowed()) {
        if (err instanceof BillingCatalogUnavailableError) throw err;
        throw new BillingCatalogUnavailableError(`BILLING_CATALOG_UNAVAILABLE: ${err.message}`);
      }
      const fallbackPacks = [...(channel === 'WEB' ? SEED_FALLBACK_CREDIT_PACKS : [])] as CreditPackDto[] & { source: 'DATABASE' | 'FALLBACK' };
      fallbackPacks.source = 'FALLBACK';
      return fallbackPacks;
    }
  }

  /**
   * CANONICAL CREDIT GRANT RESOLUTION — FAIL CLOSED
   * Single canonical source of truth for commercial credit fulfillment in Phase 2+.
   *
   * Invariants:
   * 1. Reads exclusively from public.product_credit_grants in PostgreSQL.
   * 2. NEVER respects ALLOW_BILLING_CATALOG_FALLBACK. Commercial fulfillment is ALWAYS fail-closed.
   * 3. NEVER infers credits from product codes (e.g. PACK_200 -> 200) or metadata in money-handling path.
   *
   * @param productIdOrCode - UUID of product or product code (e.g. 'FREE', 'BASIC', 'PACK_500')
   * @param pricingVersionId - Optional pricing_version_id; resolves active version if omitted
   * @returns Exact number of credits granted
   */
  async getCanonicalCreditGrant(productIdOrCode: string, pricingVersionId?: string): Promise<number> {
    const client = this.getClient();

    // 1. Resolve pricing version ID if not provided
    let versionId = pricingVersionId;
    if (!versionId) {
      const { data: version, error: vErr } = await client
        .from('pricing_versions')
        .select('id')
        .eq('active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (vErr || !version?.id) {
        throw new Error(
          `CANONICAL_CREDIT_GRANT_FAILED: Active pricing version could not be resolved (${vErr?.message || 'NOT_FOUND'})`
        );
      }
      versionId = version.id;
    }

    // 2. Resolve product UUID if product code was provided
    let resolvedProductId = productIdOrCode;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productIdOrCode);
    if (!isUuid) {
      const { data: prod, error: pErr } = await client
        .from('billing_products')
        .select('id')
        .eq('code', productIdOrCode)
        .maybeSingle();

      if (pErr || !prod?.id) {
        throw new Error(
          `CANONICAL_CREDIT_GRANT_NOT_FOUND: Product '${productIdOrCode}' not found in billing_products (${pErr?.message || 'NOT_FOUND'})`
        );
      }
      resolvedProductId = prod.id;
    }

    // 3. Query canonical table
    const { data: grant, error: gErr } = await client
      .from('product_credit_grants')
      .select('credits_granted')
      .eq('product_id', resolvedProductId)
      .eq('pricing_version_id', versionId)
      .maybeSingle();

    if (gErr) {
      throw new Error(
        `CANONICAL_CREDIT_GRANT_QUERY_ERROR: Failed to query product_credit_grants for product '${productIdOrCode}' (version: '${versionId}'): ${gErr.message}`
      );
    }

    if (!grant || typeof grant.credits_granted !== 'number') {
      throw new Error(
        `CANONICAL_CREDIT_GRANT_NOT_FOUND: No canonical credit grant configured for product '${productIdOrCode}' in pricing version '${versionId}'`
      );
    }

    return grant.credits_granted;
  }

  /**
   * Health and readiness diagnostics for billing catalog
   */
  async checkBillingCatalogHealth(): Promise<{
    healthy: boolean;
    pricingVersion: string;
    isLocked: boolean;
    plansCount: number;
    packsCount: number;
    canonicalGrantsCount: number;
    source: 'DATABASE' | 'FALLBACK';
    error?: string;
  }> {
    try {
      const client = this.getClient();
      const version = await this.getPricingVersion('pricing-v1');
      if (!version) {
        return {
          healthy: false,
          pricingVersion: 'NONE',
          isLocked: false,
          plansCount: 0,
          packsCount: 0,
          canonicalGrantsCount: 0,
          source: 'DATABASE',
          error: 'pricing-v1 not found in database',
        };
      }

      const [plans, packs, { data: grants, error: gErr }] = await Promise.all([
        this.getActivePricingPlans('WEB'),
        this.getCreditPacks('WEB'),
        client.from('product_credit_grants').select('id'),
      ]);

      if (gErr) {
        return {
          healthy: false,
          pricingVersion: version.code,
          isLocked: !!version.is_locked,
          plansCount: plans.length,
          packsCount: packs.length,
          canonicalGrantsCount: 0,
          source: 'DATABASE',
          error: `Error querying product_credit_grants: ${gErr.message}`,
        };
      }

      const isFallback = (plans as any).source === 'FALLBACK' || (packs as any).source === 'FALLBACK';

      const healthy =
        plans.length === 4 &&
        packs.length === 4 &&
        (grants?.length ?? 0) >= 8 &&
        version.active === true &&
        version.is_locked === true;

      return {
        healthy,
        pricingVersion: version.code,
        isLocked: !!version.is_locked,
        plansCount: plans.length,
        packsCount: packs.length,
        canonicalGrantsCount: grants?.length ?? 0,
        source: isFallback ? 'FALLBACK' : 'DATABASE',
      };
    } catch (err: any) {
      return {
        healthy: false,
        pricingVersion: 'UNKNOWN',
        isLocked: false,
        plansCount: 0,
        packsCount: 0,
        canonicalGrantsCount: 0,
        source: this.isFallbackAllowed() ? 'FALLBACK' : 'DATABASE',
        error: err.message,
      };
    }
  }
}

export const billingService = new BillingService();
