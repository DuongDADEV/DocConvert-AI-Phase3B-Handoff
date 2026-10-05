-- ==============================================================================
-- MIGRATION: 20260930050000_cleanup_phase13_test_artifacts.sql
-- DESCRIPTION: Phase 1.3.1 — Clean up isolated Phase 1.3 test artifacts in real DB.
-- SAFETY:
--   - Targets ONLY records with code LIKE '__TEST_%'.
--   - Strictly protects 'pricing-v1' and all production commercial products.
--   - Temporarily disables immutability triggers only within this migration transaction,
--     deletes the test artifacts, and immediately re-enables all triggers.
-- ==============================================================================

DO $$
DECLARE
    v_test_count INT;
BEGIN
    -- 1. Guard check: ensure we do not touch pricing-v1
    IF EXISTS (
        SELECT 1 FROM public.pricing_versions 
        WHERE code = 'pricing-v1' AND (code LIKE '__TEST_%')
    ) THEN
        RAISE EXCEPTION 'SAFETY_ERROR: pricing-v1 would be affected. Aborting.';
    END IF;

    -- 2. Count test records to be cleaned
    SELECT COUNT(*) INTO v_test_count
    FROM public.pricing_versions
    WHERE code LIKE '__TEST_%';

    RAISE NOTICE 'Found % test pricing versions to clean up.', v_test_count;

    -- 3. Temporarily disable triggers on affected tables in this transaction
    ALTER TABLE public.billing_prices DISABLE TRIGGER trg_guard_billing_prices_immutability;
    ALTER TABLE public.product_credit_grants DISABLE TRIGGER trg_guard_product_credit_grants_immutability;
    ALTER TABLE public.pricing_versions DISABLE TRIGGER trg_guard_pricing_versions_lock;

    -- 4. Delete child test records first
    DELETE FROM public.product_credit_grants
    WHERE pricing_version_id IN (
        SELECT id FROM public.pricing_versions WHERE code LIKE '__TEST_%'
    );

    DELETE FROM public.billing_prices
    WHERE pricing_version_id IN (
        SELECT id FROM public.pricing_versions WHERE code LIKE '__TEST_%'
    );

    DELETE FROM public.billing_products
    WHERE code LIKE '__TEST_%';

    DELETE FROM public.pricing_versions
    WHERE code LIKE '__TEST_%';

    -- 5. Re-enable all triggers
    ALTER TABLE public.billing_prices ENABLE TRIGGER trg_guard_billing_prices_immutability;
    ALTER TABLE public.product_credit_grants ENABLE TRIGGER trg_guard_product_credit_grants_immutability;
    ALTER TABLE public.pricing_versions ENABLE TRIGGER trg_guard_pricing_versions_lock;

    RAISE NOTICE 'Successfully cleaned up test artifacts and restored all triggers.';
END $$;
