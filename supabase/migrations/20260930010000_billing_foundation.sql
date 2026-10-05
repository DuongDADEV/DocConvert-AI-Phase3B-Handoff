-- ==============================================================================
-- MIGRATION: 20260930010000_billing_foundation.sql
-- DESCRIPTION: Phase 1 — Billing Foundation for DocConvert AI
--   - pricing_versions: Versioned pricing catalog ('pricing-v1')
--   - billing_products: Commercial products (Subscription, Credit Packs, API, etc.)
--   - billing_prices: Granular prices separated from products (VND integer minor units)
--   - plan_entitlements: Structured plan limits & capabilities (credits, max file, etc.)
--   - user_subscriptions: Initial foundation for customer subscription lifecycle
--   - Backward compatibility: Retains legacy public.plans & syncs standard plan IDs
-- ==============================================================================

-- 1. PRICING VERSIONS TABLE
CREATE TABLE IF NOT EXISTS public.pricing_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. BILLING PRODUCTS TABLE
CREATE TABLE IF NOT EXISTS public.billing_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    product_type VARCHAR(50) NOT NULL,
    pricing_channel VARCHAR(50) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_billing_products_type CHECK (
        product_type IN ('SUBSCRIPTION', 'CREDIT_PACK', 'USAGE', 'ENTERPRISE')
    ),
    CONSTRAINT chk_billing_products_channel CHECK (
        pricing_channel IN ('WEB', 'API', 'ENTERPRISE')
    )
);

-- 3. BILLING PRICES TABLE
CREATE TABLE IF NOT EXISTS public.billing_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES public.billing_products(id) ON DELETE CASCADE,
    pricing_version_id UUID NOT NULL REFERENCES public.pricing_versions(id) ON DELETE RESTRICT,
    currency VARCHAR(10) NOT NULL DEFAULT 'VND',
    amount_minor BIGINT NOT NULL, -- Integer currency amount (VND has no decimals)
    billing_interval VARCHAR(20) NOT NULL DEFAULT 'NONE',
    interval_count INT NOT NULL DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT true,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_billing_prices_interval CHECK (
        billing_interval IN ('NONE', 'MONTH', 'YEAR')
    ),
    CONSTRAINT chk_billing_prices_amount CHECK (
        amount_minor >= 0
    ),
    CONSTRAINT unq_billing_prices_product_version_interval UNIQUE (product_id, pricing_version_id, billing_interval)
);

-- 4. PLAN ENTITLEMENTS TABLE
CREATE TABLE IF NOT EXISTS public.plan_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES public.billing_products(id) ON DELETE CASCADE,
    pricing_version_id UUID NOT NULL REFERENCES public.pricing_versions(id) ON DELETE RESTRICT,
    included_credits INT NOT NULL DEFAULT 0,
    max_file_mb INT NOT NULL DEFAULT 20,
    batch_enabled BOOLEAN NOT NULL DEFAULT false,
    priority_queue BOOLEAN NOT NULL DEFAULT false,
    api_access VARCHAR(20) NOT NULL DEFAULT 'NONE',
    retention_days INT NOT NULL DEFAULT 3,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_plan_entitlements_api CHECK (
        api_access IN ('NONE', 'BETA', 'FULL')
    ),
    CONSTRAINT chk_plan_entitlements_credits CHECK (
        included_credits >= 0
    ),
    CONSTRAINT unq_plan_entitlements_product_version UNIQUE (product_id, pricing_version_id)
);

-- 5. USER SUBSCRIPTIONS TABLE (Foundation for future lifecycle)
CREATE TABLE IF NOT EXISTS public.user_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES public.billing_products(id) ON DELETE RESTRICT,
    price_id UUID NOT NULL REFERENCES public.billing_prices(id) ON DELETE RESTRICT,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ,
    auto_renew BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_user_subscriptions_status CHECK (
        status IN ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED')
    )
);

-- 6. INDEXES FOR PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_billing_products_channel_active 
    ON public.billing_products(pricing_channel, active);

CREATE INDEX IF NOT EXISTS idx_billing_prices_lookup 
    ON public.billing_prices(product_id, pricing_version_id, active);

CREATE INDEX IF NOT EXISTS idx_plan_entitlements_lookup 
    ON public.plan_entitlements(product_id, pricing_version_id);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user 
    ON public.user_subscriptions(user_id, status);

-- 7. ROW LEVEL SECURITY (RLS)
ALTER TABLE public.pricing_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;

-- Catalog tables: Public read for active rows
DROP POLICY IF EXISTS pricing_versions_read ON public.pricing_versions;
CREATE POLICY pricing_versions_read ON public.pricing_versions
    FOR SELECT USING (active = true);

DROP POLICY IF EXISTS billing_products_read ON public.billing_products;
CREATE POLICY billing_products_read ON public.billing_products
    FOR SELECT USING (active = true);

DROP POLICY IF EXISTS billing_prices_read ON public.billing_prices;
CREATE POLICY billing_prices_read ON public.billing_prices
    FOR SELECT USING (active = true);

DROP POLICY IF EXISTS plan_entitlements_read ON public.plan_entitlements;
CREATE POLICY plan_entitlements_read ON public.plan_entitlements
    FOR SELECT USING (true);

-- User subscriptions: Owner read-only
DROP POLICY IF EXISTS user_subscriptions_read_own ON public.user_subscriptions;
CREATE POLICY user_subscriptions_read_own ON public.user_subscriptions
    FOR SELECT USING (auth.uid() = user_id);

-- ==============================================================================
-- 8. SEED DATA FOR PRICING-V1
-- ==============================================================================

-- 8.1 Seed Pricing Version
INSERT INTO public.pricing_versions (code, description, active)
VALUES ('pricing-v1', 'Bảng giá chuẩn SaaS v1 - DocConvert AI', true)
ON CONFLICT (code) DO UPDATE SET
    description = EXCLUDED.description,
    active = EXCLUDED.active;

-- 8.2 Seed Billing Products (4 Subscriptions + 4 Credit Packs)
INSERT INTO public.billing_products (code, name, description, product_type, pricing_channel, active, metadata)
VALUES
    -- Web Subscription Plans
    ('FREE', 'Gói Miễn Phí (Free)', 'Gói khởi đầu cho cá nhân trải nghiệm tính năng OCR văn bản và bảng', 'SUBSCRIPTION', 'WEB', true, '{"badge": null, "sort_order": 1}'::jsonb),
    ('BASIC', 'Gói Cơ Bản (Basic)', 'Tối ưu cho kế toán độc lập và cá nhân có nhu cầu chuyển đổi định kỳ', 'SUBSCRIPTION', 'WEB', true, '{"badge": null, "sort_order": 2}'::jsonb),
    ('PRO', 'Gói Chuyên Nghiệp (Pro)', 'Dành cho chuyên viên ngân hàng và văn phòng tài chính xử lý liên tục', 'SUBSCRIPTION', 'WEB', true, '{"badge": "PHỔ BIẾN NHẤT", "sort_order": 3}'::jsonb),
    ('BUSINESS', 'Gói Doanh Nghiệp (Business)', 'Giải pháp toàn diện cho doanh nghiệp và đội ngũ cần bảo mật và hạn mức cao', 'SUBSCRIPTION', 'WEB', true, '{"badge": null, "sort_order": 4}'::jsonb),
    -- Web Credit Packs (Pay-as-you-go)
    ('PACK_50', 'Gói Nạp 50 Credits', 'Gói nạp credit dùng một lần khi phát sinh tài liệu đột xuất', 'CREDIT_PACK', 'WEB', true, '{"credits": 50, "sort_order": 1}'::jsonb),
    ('PACK_200', 'Gói Nạp 200 Credits', 'Gói nạp credit tiết kiệm cho khối lượng công việc theo đợt', 'CREDIT_PACK', 'WEB', true, '{"credits": 200, "sort_order": 2}'::jsonb),
    ('PACK_500', 'Gói Nạp 500 Credits', 'Gói nạp phổ biến cho đợt quyết toán thuế và báo cáo quý', 'CREDIT_PACK', 'WEB', true, '{"credits": 500, "sort_order": 3}'::jsonb),
    ('PACK_2000', 'Gói Nạp 2.000 Credits', 'Gói nạp dung lượng lớn với chi phí tối ưu nhất cho văn phòng', 'CREDIT_PACK', 'WEB', true, '{"credits": 2000, "sort_order": 4}'::jsonb)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    product_type = EXCLUDED.product_type,
    pricing_channel = EXCLUDED.pricing_channel,
    active = EXCLUDED.active,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();

-- 8.3 Seed Billing Prices
DO $$
DECLARE
    v_version_id UUID;
    v_prod_id UUID;
BEGIN
    SELECT id INTO v_version_id FROM public.pricing_versions WHERE code = 'pricing-v1';

    -- FREE: 0 VND
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'FREE';
    INSERT INTO public.billing_prices (product_id, pricing_version_id, currency, amount_minor, billing_interval, interval_count, active)
    VALUES (v_prod_id, v_version_id, 'VND', 0, 'NONE', 1, true)
    ON CONFLICT (product_id, pricing_version_id, billing_interval) DO UPDATE SET
        amount_minor = EXCLUDED.amount_minor, active = EXCLUDED.active;

    -- BASIC: 129.000 VND / month
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'BASIC';
    INSERT INTO public.billing_prices (product_id, pricing_version_id, currency, amount_minor, billing_interval, interval_count, active)
    VALUES (v_prod_id, v_version_id, 'VND', 129000, 'MONTH', 1, true)
    ON CONFLICT (product_id, pricing_version_id, billing_interval) DO UPDATE SET
        amount_minor = EXCLUDED.amount_minor, active = EXCLUDED.active;

    -- PRO: 349.000 VND / month
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PRO';
    INSERT INTO public.billing_prices (product_id, pricing_version_id, currency, amount_minor, billing_interval, interval_count, active)
    VALUES (v_prod_id, v_version_id, 'VND', 349000, 'MONTH', 1, true)
    ON CONFLICT (product_id, pricing_version_id, billing_interval) DO UPDATE SET
        amount_minor = EXCLUDED.amount_minor, active = EXCLUDED.active;

    -- BUSINESS: 899.000 VND / month
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'BUSINESS';
    INSERT INTO public.billing_prices (product_id, pricing_version_id, currency, amount_minor, billing_interval, interval_count, active)
    VALUES (v_prod_id, v_version_id, 'VND', 899000, 'MONTH', 1, true)
    ON CONFLICT (product_id, pricing_version_id, billing_interval) DO UPDATE SET
        amount_minor = EXCLUDED.amount_minor, active = EXCLUDED.active;

    -- PACK_50: 59.000 VND
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_50';
    INSERT INTO public.billing_prices (product_id, pricing_version_id, currency, amount_minor, billing_interval, interval_count, active)
    VALUES (v_prod_id, v_version_id, 'VND', 59000, 'NONE', 1, true)
    ON CONFLICT (product_id, pricing_version_id, billing_interval) DO UPDATE SET
        amount_minor = EXCLUDED.amount_minor, active = EXCLUDED.active;

    -- PACK_200: 199.000 VND
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_200';
    INSERT INTO public.billing_prices (product_id, pricing_version_id, currency, amount_minor, billing_interval, interval_count, active)
    VALUES (v_prod_id, v_version_id, 'VND', 199000, 'NONE', 1, true)
    ON CONFLICT (product_id, pricing_version_id, billing_interval) DO UPDATE SET
        amount_minor = EXCLUDED.amount_minor, active = EXCLUDED.active;

    -- PACK_500: 449.000 VND
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_500';
    INSERT INTO public.billing_prices (product_id, pricing_version_id, currency, amount_minor, billing_interval, interval_count, active)
    VALUES (v_prod_id, v_version_id, 'VND', 449000, 'NONE', 1, true)
    ON CONFLICT (product_id, pricing_version_id, billing_interval) DO UPDATE SET
        amount_minor = EXCLUDED.amount_minor, active = EXCLUDED.active;

    -- PACK_2000: 1.490.000 VND
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_2000';
    INSERT INTO public.billing_prices (product_id, pricing_version_id, currency, amount_minor, billing_interval, interval_count, active)
    VALUES (v_prod_id, v_version_id, 'VND', 1490000, 'NONE', 1, true)
    ON CONFLICT (product_id, pricing_version_id, billing_interval) DO UPDATE SET
        amount_minor = EXCLUDED.amount_minor, active = EXCLUDED.active;
END $$;

-- 8.4 Seed Plan Entitlements
DO $$
DECLARE
    v_version_id UUID;
    v_prod_id UUID;
BEGIN
    SELECT id INTO v_version_id FROM public.pricing_versions WHERE code = 'pricing-v1';

    -- FREE Entitlements
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'FREE';
    INSERT INTO public.plan_entitlements (
        product_id, pricing_version_id, included_credits, max_file_mb, batch_enabled,
        priority_queue, api_access, retention_days, metadata
    ) VALUES (
        v_prod_id, v_version_id, 10, 20, false, false, 'NONE', 3,
        '{"pdf_to_word": true, "pdf_to_excel": true}'::jsonb
    ) ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET
        included_credits = EXCLUDED.included_credits,
        max_file_mb = EXCLUDED.max_file_mb,
        batch_enabled = EXCLUDED.batch_enabled,
        priority_queue = EXCLUDED.priority_queue,
        api_access = EXCLUDED.api_access,
        retention_days = EXCLUDED.retention_days,
        metadata = EXCLUDED.metadata;

    -- BASIC Entitlements
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'BASIC';
    INSERT INTO public.plan_entitlements (
        product_id, pricing_version_id, included_credits, max_file_mb, batch_enabled,
        priority_queue, api_access, retention_days, metadata
    ) VALUES (
        v_prod_id, v_version_id, 120, 50, false, false, 'NONE', 7,
        '{"pdf_to_word": true, "pdf_to_excel": true}'::jsonb
    ) ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET
        included_credits = EXCLUDED.included_credits,
        max_file_mb = EXCLUDED.max_file_mb,
        batch_enabled = EXCLUDED.batch_enabled,
        priority_queue = EXCLUDED.priority_queue,
        api_access = EXCLUDED.api_access,
        retention_days = EXCLUDED.retention_days,
        metadata = EXCLUDED.metadata;

    -- PRO Entitlements
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PRO';
    INSERT INTO public.plan_entitlements (
        product_id, pricing_version_id, included_credits, max_file_mb, batch_enabled,
        priority_queue, api_access, retention_days, metadata
    ) VALUES (
        v_prod_id, v_version_id, 450, 100, true, true, 'BETA', 30,
        '{"pdf_to_word": true, "pdf_to_excel": true}'::jsonb
    ) ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET
        included_credits = EXCLUDED.included_credits,
        max_file_mb = EXCLUDED.max_file_mb,
        batch_enabled = EXCLUDED.batch_enabled,
        priority_queue = EXCLUDED.priority_queue,
        api_access = EXCLUDED.api_access,
        retention_days = EXCLUDED.retention_days,
        metadata = EXCLUDED.metadata;

    -- BUSINESS Entitlements
    SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'BUSINESS';
    INSERT INTO public.plan_entitlements (
        product_id, pricing_version_id, included_credits, max_file_mb, batch_enabled,
        priority_queue, api_access, retention_days, metadata
    ) VALUES (
        v_prod_id, v_version_id, 1400, 200, true, true, 'FULL', 90,
        '{"pdf_to_word": true, "pdf_to_excel": true}'::jsonb
    ) ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET
        included_credits = EXCLUDED.included_credits,
        max_file_mb = EXCLUDED.max_file_mb,
        batch_enabled = EXCLUDED.batch_enabled,
        priority_queue = EXCLUDED.priority_queue,
        api_access = EXCLUDED.api_access,
        retention_days = EXCLUDED.retention_days,
        metadata = EXCLUDED.metadata;
END $$;

-- 8.5 BACKWARD COMPATIBILITY SYNC:
-- Populate public.plans with the 4 standard plan codes so foreign keys from public.profiles
-- and legacy RPCs (confirm_document_processing) continue to resolve without breaking.
INSERT INTO public.plans (id, name, price_vnd, duration_days, document_quota, features, is_active)
VALUES
    ('FREE', 'Gói Miễn Phí (Free)', 0, 3650, 10, '["10 credits dùng thử", "Max file 20 MB", "PDF → Word & Excel", "Lưu trữ 3 ngày"]'::jsonb, true),
    ('BASIC', 'Gói Cơ Bản (Basic)', 129000, 30, 120, '["120 credits / tháng", "Max file 50 MB", "PDF → Word & Excel", "Lưu trữ 7 ngày"]'::jsonb, true),
    ('PRO', 'Gói Chuyên Nghiệp (Pro)', 349000, 30, 450, '["450 credits / tháng", "Max file 100 MB", "Xử lý hàng loạt (Batch)", "Hàng đợi ưu tiên", "API Beta", "Lưu trữ 30 ngày"]'::jsonb, true),
    ('BUSINESS', 'Gói Doanh Nghiệp (Business)', 899000, 30, 1400, '["1.400 credits / tháng", "Max file 200 MB", "Xử lý hàng loạt", "Hàng đợi ưu tiên", "Full API Access", "Lưu trữ 90 ngày"]'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    price_vnd = EXCLUDED.price_vnd,
    duration_days = EXCLUDED.duration_days,
    document_quota = EXCLUDED.document_quota,
    features = EXCLUDED.features,
    is_active = EXCLUDED.is_active;
