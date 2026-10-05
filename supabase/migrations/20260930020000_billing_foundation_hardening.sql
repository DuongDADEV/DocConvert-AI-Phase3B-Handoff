-- ==============================================================================
-- MIGRATION: 20260930020000_billing_foundation_hardening.sql
-- DESCRIPTION: Phase 1.1 — Billing Schema & Legacy Quota Hardening
--   1. Harden Billing Prices Unique Constraint: (product_id, version_id, currency, interval, count)
--   2. Enforce Pricing Version Immutability (is_locked check & trigger protection)
--   3. Unify Single Canonical Source of Truth for Credits Granted (plan_entitlements for all products)
--   4. Harden Plan Entitlements RLS Policy
--   5. Decouple Legacy Quota from Credits: Restore FREE legacy document_quota = 3
-- ==============================================================================

-- 1. HARDEN BILLING PRICES UNIQUE CONSTRAINT (Support multi-currency & interval counts)
DO $$
BEGIN
    -- Drop older narrow constraint if present
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'unq_billing_prices_product_version_interval'
          AND conrelid = 'public.billing_prices'::regclass
    ) THEN
        ALTER TABLE public.billing_prices DROP CONSTRAINT unq_billing_prices_product_version_interval;
    END IF;

    -- Add comprehensive composite constraint if not present
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'unq_billing_prices_composite'
          AND conrelid = 'public.billing_prices'::regclass
    ) THEN
        ALTER TABLE public.billing_prices 
            ADD CONSTRAINT unq_billing_prices_composite 
            UNIQUE (product_id, pricing_version_id, currency, billing_interval, interval_count);
    END IF;
END $$;

-- 2. ENFORCE PRICING VERSION IMMUTABILITY
-- Add is_locked column to pricing_versions if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'pricing_versions' 
          AND column_name = 'is_locked'
    ) THEN
        ALTER TABLE public.pricing_versions ADD COLUMN is_locked BOOLEAN NOT NULL DEFAULT false;
    END IF;
END $$;

-- Immutability guard trigger function
CREATE OR REPLACE FUNCTION public.fn_guard_locked_pricing_immutability()
RETURNS TRIGGER AS $$
DECLARE
    v_is_locked BOOLEAN;
BEGIN
    -- Check if parent pricing_version is marked locked
    SELECT is_locked INTO v_is_locked
    FROM public.pricing_versions
    WHERE id = COALESCE(OLD.pricing_version_id, NEW.pricing_version_id);

    IF v_is_locked THEN
        RAISE EXCEPTION 'PRICING_VERSION_LOCKED: Cannot modify prices or entitlements for locked pricing version. Create a new pricing version instead.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to billing_prices
DROP TRIGGER IF EXISTS trg_guard_billing_prices_immutability ON public.billing_prices;
CREATE TRIGGER trg_guard_billing_prices_immutability
    BEFORE UPDATE OR DELETE ON public.billing_prices
    FOR EACH ROW EXECUTE FUNCTION public.fn_guard_locked_pricing_immutability();

-- Attach trigger to plan_entitlements
DROP TRIGGER IF EXISTS trg_guard_plan_entitlements_immutability ON public.plan_entitlements;
CREATE TRIGGER trg_guard_plan_entitlements_immutability
    BEFORE UPDATE OR DELETE ON public.plan_entitlements
    FOR EACH ROW EXECUTE FUNCTION public.fn_guard_locked_pricing_immutability();

-- 3. UNIFY CANONICAL SOURCE OF TRUTH FOR CREDITS GRANTED
-- Insert plan_entitlements for Credit Packs so plan_entitlements.included_credits is the single canonical source of truth for ALL products
DO $$
DECLARE
    v_version_id UUID;
    v_prod_id UUID;
BEGIN
    SELECT id INTO v_version_id FROM public.pricing_versions WHERE code = 'pricing-v1';

    IF v_version_id IS NOT NULL THEN
        -- PACK_50: 50 credits
        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_50';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.plan_entitlements (
                product_id, pricing_version_id, included_credits, max_file_mb, batch_enabled,
                priority_queue, api_access, retention_days, metadata
            ) VALUES (
                v_prod_id, v_version_id, 50, 50, false, false, 'NONE', 30, '{"grant_type": "ONE_TIME_PACK"}'::jsonb
            ) ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET
                included_credits = 50,
                metadata = EXCLUDED.metadata;
        END IF;

        -- PACK_200: 200 credits
        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_200';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.plan_entitlements (
                product_id, pricing_version_id, included_credits, max_file_mb, batch_enabled,
                priority_queue, api_access, retention_days, metadata
            ) VALUES (
                v_prod_id, v_version_id, 200, 50, false, false, 'NONE', 30, '{"grant_type": "ONE_TIME_PACK"}'::jsonb
            ) ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET
                included_credits = 200,
                metadata = EXCLUDED.metadata;
        END IF;

        -- PACK_500: 500 credits
        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_500';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.plan_entitlements (
                product_id, pricing_version_id, included_credits, max_file_mb, batch_enabled,
                priority_queue, api_access, retention_days, metadata
            ) VALUES (
                v_prod_id, v_version_id, 500, 100, true, false, 'NONE', 60, '{"grant_type": "ONE_TIME_PACK"}'::jsonb
            ) ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET
                included_credits = 500,
                metadata = EXCLUDED.metadata;
        END IF;

        -- PACK_2000: 2000 credits
        SELECT id INTO v_prod_id FROM public.billing_products WHERE code = 'PACK_2000';
        IF v_prod_id IS NOT NULL THEN
            INSERT INTO public.plan_entitlements (
                product_id, pricing_version_id, included_credits, max_file_mb, batch_enabled,
                priority_queue, api_access, retention_days, metadata
            ) VALUES (
                v_prod_id, v_version_id, 2000, 200, true, true, 'BETA', 90, '{"grant_type": "ONE_TIME_PACK"}'::jsonb
            ) ON CONFLICT (product_id, pricing_version_id) DO UPDATE SET
                included_credits = 2000,
                metadata = EXCLUDED.metadata;
        END IF;
    END IF;
END $$;

-- 4. HARDEN RLS FOR PLAN ENTITLEMENTS
-- Only allow public read of entitlements when associated product is active
DROP POLICY IF EXISTS plan_entitlements_read ON public.plan_entitlements;
CREATE POLICY plan_entitlements_read ON public.plan_entitlements
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.billing_products bp
            WHERE bp.id = plan_entitlements.product_id
              AND bp.active = true
        )
    );

-- 5. DECOUPLE LEGACY DOCUMENT QUOTA FROM CREDITS
-- Architectural boundary:
--   public.plans.document_quota = DOCUMENT COUNT in legacy processing pipeline.
--   public.plan_entitlements.included_credits = CREDITS in Billing domain.
-- Restore verified historical document_quota = 3 for FREE plan in public.plans.
UPDATE public.plans
SET document_quota = 3,
    name = 'Gói Miễn Phí (Free)',
    features = '["3 tài liệu dùng thử miễn phí", "Nhận dạng văn bản OCR & Bảng", "Xuất file Excel & Word"]'::jsonb
WHERE id = 'FREE';

-- Preserve legacy packages for backward compatibility
INSERT INTO public.plans (id, name, price_vnd, duration_days, document_quota, features, is_active)
VALUES
    ('7_DAYS_FULL', 'Gói 7 Ngày Đầy Đủ', 29000, 7, 50, '["Hạn mức 50 tài liệu / 7 ngày", "Ưu tiên xử lý Azure AI"]'::jsonb, true),
    ('30_DAYS_FULL', 'Gói 30 Ngày Toàn Diện', 79000, 30, 250, '["Hạn mức 250 tài liệu / 30 ngày", "Đầy đủ mọi tính năng AI"]'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    document_quota = EXCLUDED.document_quota,
    is_active = EXCLUDED.is_active;

-- Explicit documentation comment on table
COMMENT ON COLUMN public.plans.document_quota IS 
'LEGACY ONLY: Represents document count consumed per file in confirm_document_processing RPC. Do NOT confuse with included_credits in plan_entitlements.';
