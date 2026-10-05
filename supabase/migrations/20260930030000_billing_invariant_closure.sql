-- ==============================================================================
-- MIGRATION: 20260930030000_billing_invariant_closure.sql
-- DESCRIPTION: Phase 1.2 — Billing Invariant Closure
--   1. Safely resolve legacy BASIC / PRO / BUSINESS inside public.plans:
--      Keep public.plans strictly for legacy document-count plans (FREE, 7_DAYS_FULL, 30_DAYS_FULL).
--   2. Enforce Credit Pack capability boundary:
--      Strip Credit Packs from plan_entitlements so Credit Packs never grant subscription capabilities.
--   3. Create dedicated canonical credit grant source:
--      public.product_credit_grants (id, product_id, pricing_version_id, credits_granted, grant_type).
--   4. Fix Pricing Immutability trigger fn_guard_locked_pricing_immutability:
--      Correctly handle BEFORE DELETE by returning OLD instead of NEW (which is NULL).
--   5. Enforce monotonic pricing version lock fn_guard_pricing_version_lock_monotonic:
--      false -> true is ALLOWED; true -> false is BLOCKED; DELETE of locked version is BLOCKED.
--   6. Attach immutability trigger to product_credit_grants and configure RLS.
-- ==============================================================================

-- 1. SAFELY RESOLVE LEGACY BASIC / PRO / BUSINESS INSIDE public.plans
-- Audited state: 0 profiles and 0 subscriptions reference BASIC, PRO, BUSINESS.
-- Legacy public.plans represents DOCUMENT COUNT quota (consumed +1 in confirm_document_processing),
-- NOT commercial credits. We strictly clean them from public.plans to eliminate any risk of conflation.
DELETE FROM public.plans WHERE id IN ('BASIC', 'PRO', 'BUSINESS');

-- Ensure legitimate historical legacy plans are accurately preserved
INSERT INTO public.plans (id, name, price_vnd, duration_days, document_quota, features, is_active)
VALUES
    ('FREE', 'Gói Miễn Phí (Free)', 0, 3650, 3, '["3 tài liệu miễn phí", "Nhận dạng văn bản OCR & Bảng", "Xuất file Excel & Word"]'::jsonb, true),
    ('7_DAYS_FULL', 'Gói 7 Ngày Đầy Đủ', 29000, 7, 50, '["Hạn mức 50 tài liệu / 7 ngày", "Ưu tiên xử lý Azure AI tốc độ cao"]'::jsonb, true),
    ('30_DAYS_FULL', 'Gói 30 Ngày Toàn Diện', 79000, 30, 250, '["Hạn mức 250 tài liệu / 30 ngày", "Đầy đủ mọi tính năng AI cao cấp"]'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    document_quota = EXCLUDED.document_quota,
    is_active = EXCLUDED.is_active;

-- 2. CREATE CANONICAL CREDIT GRANTS TABLE (Single Canonical Source for Commercial Credit Grants)
CREATE TABLE IF NOT EXISTS public.product_credit_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES public.billing_products(id) ON DELETE CASCADE,
    pricing_version_id UUID NOT NULL REFERENCES public.pricing_versions(id) ON DELETE RESTRICT,
    credits_granted INT NOT NULL CHECK (credits_granted >= 0),
    grant_type VARCHAR(50) NOT NULL CHECK (grant_type IN ('SUBSCRIPTION_CYCLE', 'ONE_TIME_PACK')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unq_product_credit_grants UNIQUE (product_id, pricing_version_id)
);

CREATE INDEX IF NOT EXISTS idx_product_credit_grants_lookup
    ON public.product_credit_grants(product_id, pricing_version_id);

-- 3. SEED CANONICAL CREDIT GRANTS FOR PRICING-V1
DO $$
DECLARE
    v_version_id UUID;
    v_prod_id UUID;
BEGIN
    SELECT id INTO v_version_id FROM public.pricing_versions WHERE code = 'pricing-v1';

    IF v_version_id IS NOT NULL THEN
        -- Subscription Plans (Recurring cycle credit grants)
        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'FREE';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.product_credit_grants (product_id, pricing_version_id, credits_granted, grant_type)
            VALUES (v_prod_id, v_version_id, 10, 'SUBSCRIPTION_CYCLE')
            ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET credits_granted = 10, grant_type = 'SUBSCRIPTION_CYCLE';
        END IF;

        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'BASIC';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.product_credit_grants (product_id, pricing_version_id, credits_granted, grant_type)
            VALUES (v_prod_id, v_version_id, 120, 'SUBSCRIPTION_CYCLE')
            ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET credits_granted = 120, grant_type = 'SUBSCRIPTION_CYCLE';
        END IF;

        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PRO';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.product_credit_grants (product_id, pricing_version_id, credits_granted, grant_type)
            VALUES (v_prod_id, v_version_id, 450, 'SUBSCRIPTION_CYCLE')
            ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET credits_granted = 450, grant_type = 'SUBSCRIPTION_CYCLE';
        END IF;

        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'BUSINESS';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.product_credit_grants (product_id, pricing_version_id, credits_granted, grant_type)
            VALUES (v_prod_id, v_version_id, 1400, 'SUBSCRIPTION_CYCLE')
            ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET credits_granted = 1400, grant_type = 'SUBSCRIPTION_CYCLE';
        END IF;

        -- Credit Packs (One-time purchased credit grants)
        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_50';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.product_credit_grants (product_id, pricing_version_id, credits_granted, grant_type)
            VALUES (v_prod_id, v_version_id, 50, 'ONE_TIME_PACK')
            ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET credits_granted = 50, grant_type = 'ONE_TIME_PACK';
        END IF;

        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_200';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.product_credit_grants (product_id, pricing_version_id, credits_granted, grant_type)
            VALUES (v_prod_id, v_version_id, 200, 'ONE_TIME_PACK')
            ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET credits_granted = 200, grant_type = 'ONE_TIME_PACK';
        END IF;

        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_500';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.product_credit_grants (product_id, pricing_version_id, credits_granted, grant_type)
            VALUES (v_prod_id, v_version_id, 500, 'ONE_TIME_PACK')
            ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET credits_granted = 500, grant_type = 'ONE_TIME_PACK';
        END IF;

        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_2000';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.product_credit_grants (product_id, pricing_version_id, credits_granted, grant_type)
            VALUES (v_prod_id, v_version_id, 2000, 'ONE_TIME_PACK')
            ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET credits_granted = 2000, grant_type = 'ONE_TIME_PACK';
        END IF;
    END IF;
END $$;

-- 4. STRIP CREDIT PACKS FROM plan_entitlements
-- Credit Packs grant credits only. They must NOT grant subscription capability entitlements
-- such as max_file_mb, batch_enabled, priority_queue, api_access, retention_days.
DELETE FROM public.plan_entitlements
WHERE product_id IN (
    SELECT id FROM public.billing_products
    WHERE product_type = 'CREDIT_PACK'
);

-- 5. FIX PRICING IMMUTABILITY TRIGGER (Correct BEFORE DELETE handling)
-- Previous bug: returned NEW unconditionally. For BEFORE DELETE triggers, NEW is NULL,
-- causing delete operations to be silently aborted.
-- Correct contract: IF locked THEN RAISE EXCEPTION; ELSIF DELETE THEN RETURN OLD; ELSE RETURN NEW.
CREATE OR REPLACE FUNCTION public.fn_guard_locked_pricing_immutability()
RETURNS TRIGGER AS $$
DECLARE
    v_is_locked BOOLEAN;
    v_version_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_version_id := OLD.pricing_version_id;
    ELSE
        v_version_id := NEW.pricing_version_id;
    END IF;

    SELECT is_locked INTO v_is_locked
    FROM public.pricing_versions
    WHERE id = v_version_id;

    IF v_is_locked THEN
        RAISE EXCEPTION 'PRICING_VERSION_LOCKED: Cannot modify prices, entitlements, or credit grants for locked pricing version. Create a new pricing version instead.';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach immutability trigger to product_credit_grants
DROP TRIGGER IF EXISTS trg_guard_product_credit_grants_immutability ON public.product_credit_grants;
CREATE TRIGGER trg_guard_product_credit_grants_immutability
    BEFORE UPDATE OR DELETE ON public.product_credit_grants
    FOR EACH ROW EXECUTE FUNCTION public.fn_guard_locked_pricing_immutability();

-- 6. MONOTONIC PRICING VERSION LOCK GUARD
-- Invariant: false -> true is ALLOWED; true -> false is STRICTLY FORBIDDEN.
-- A locked version cannot be deleted.
CREATE OR REPLACE FUNCTION public.fn_guard_pricing_version_lock_monotonic()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Block unlocking
        IF OLD.is_locked = true AND NEW.is_locked = false THEN
            RAISE EXCEPTION 'PRICING_VERSION_LOCK_MONOTONIC: A locked pricing version cannot be unlocked.';
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        -- Block deletion of locked version
        IF OLD.is_locked = true THEN
            RAISE EXCEPTION 'PRICING_VERSION_LOCKED: Cannot delete a locked pricing version.';
        END IF;
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_pricing_versions_lock ON public.pricing_versions;
CREATE TRIGGER trg_guard_pricing_versions_lock
    BEFORE UPDATE OR DELETE ON public.pricing_versions
    FOR EACH ROW EXECUTE FUNCTION public.fn_guard_pricing_version_lock_monotonic();

-- 7. ROW LEVEL SECURITY (RLS) FOR product_credit_grants
ALTER TABLE public.product_credit_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_credit_grants_read ON public.product_credit_grants;
CREATE POLICY product_credit_grants_read ON public.product_credit_grants
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.billing_products bp
            WHERE bp.id = product_credit_grants.product_id
              AND bp.active = true
        )
    );
