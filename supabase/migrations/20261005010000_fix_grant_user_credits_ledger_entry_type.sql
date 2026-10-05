-- ============================================================================
-- DocConvert AI — Phase 3B.3.8 Hotfix Migration
-- Fix credit_ledger.entry_type contract mismatch in public.grant_user_credits
--
-- Migration: 20261005010000_fix_grant_user_credits_ledger_entry_type.sql
--
-- PURPOSE:
-- Fix public.grant_user_credits which previously generated business-source
-- strings (GRANT_FREE, GRANT_PACK, GRANT_SUBSCRIPTION, GRANT_PROMOTION,
-- MIGRATION_CREDIT, GRANT_MANUAL) for credit_ledger.entry_type, violating
-- the table check constraint:
--   chk_credit_ledger_entry_type: entry_type IN ('GRANT', 'ADJUSTMENT', 'EXPIRATION', 'CAPTURE')
--
-- CANONICAL MAPPING:
--   p_source_type = 'ADMIN_ADJUSTMENT' -> entry_type = 'ADJUSTMENT'
--   all other grant source types       -> entry_type = 'GRANT'
--
-- The business origin remains intact in:
--   credit_grants.source_type (e.g. FREE_BOOTSTRAP, SUBSCRIPTION_CYCLE, etc.)
--   credit_ledger.metadata (e.g. 'source_type': p_source_type)
--
-- ALL OTHER BEHAVIORS REMAIN 100% UNCHANGED:
--   - Exact 14-parameter signature preserved
--   - RETURNS JSONB preserved
--   - SECURITY DEFINER and SET search_path = public, pg_temp preserved
--   - Advisory lock pg_advisory_xact_lock(hashtext(p_idempotency_key)) preserved
--   - Safe read-first idempotency check with payload conflict detection preserved
--   - Fail-closed semantic validation for all source types preserved
--   - Account lock/creation logic preserved
--   - Unique violation handling for idempotency and duplicate FREE_BOOTSTRAP preserved
--   - Gross vs available balance calculations preserved
--   - Append-only credit_ledger row insertion preserved
--   - Return JSONB structure preserved
--   - Strict permissions: service_role / postgres ONLY
-- ============================================================================

CREATE OR REPLACE FUNCTION public.grant_user_credits(
    p_user_id UUID,
    p_source_type VARCHAR,
    p_original_units BIGINT,
    p_idempotency_key TEXT,
    p_expires_at TIMESTAMPTZ DEFAULT NULL,
    p_product_id UUID DEFAULT NULL,
    p_pricing_version_id UUID DEFAULT NULL,
    p_subscription_id UUID DEFAULT NULL,
    p_billing_cycle_start TIMESTAMPTZ DEFAULT NULL,
    p_billing_cycle_end TIMESTAMPTZ DEFAULT NULL,
    p_reference_type VARCHAR DEFAULT NULL,
    p_reference_id TEXT DEFAULT NULL,
    p_description TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_account_id UUID;
    v_grant_id UUID;
    v_existing_grant RECORD;
    v_total_available BIGINT;
    v_ledger_balance_after BIGINT;
    v_account_status VARCHAR;
    v_entry_type VARCHAR(50);
BEGIN
    -- 1. Input Validation
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_user_id is required';
    END IF;
    IF p_original_units IS NULL OR p_original_units <= 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_original_units must be positive';
    END IF;
    IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_idempotency_key is required';
    END IF;
    IF p_source_type NOT IN ('FREE_BOOTSTRAP', 'SUBSCRIPTION_CYCLE', 'CREDIT_PACK_PURCHASE', 'PROMOTION', 'ADMIN_ADJUSTMENT', 'MIGRATION') THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: Invalid p_source_type: %', p_source_type;
    END IF;

    -- 2. Concurrency Safety: Transaction-scoped advisory lock on idempotency key hash
    PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));

    -- 3. Idempotency Check (Safe read-first under advisory lock)
    SELECT
        id,
        account_id,
        user_id,
        source_type,
        original_units,
        remaining_units,
        source_product_id,
        pricing_version_id,
        subscription_id,
        billing_cycle_start,
        billing_cycle_end,
        expires_at,
        source_reference_type,
        source_reference_id,
        status
    INTO v_existing_grant
    FROM public.credit_grants
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        -- Fail closed on payload conflict: do NOT silently reuse grant if business payload differs
        IF v_existing_grant.user_id <> p_user_id
           OR v_existing_grant.source_type <> p_source_type
           OR v_existing_grant.original_units <> p_original_units
           OR v_existing_grant.source_product_id IS DISTINCT FROM p_product_id
           OR v_existing_grant.pricing_version_id IS DISTINCT FROM p_pricing_version_id
           OR v_existing_grant.subscription_id IS DISTINCT FROM p_subscription_id
           OR v_existing_grant.billing_cycle_start IS DISTINCT FROM p_billing_cycle_start
           OR v_existing_grant.billing_cycle_end IS DISTINCT FROM p_billing_cycle_end
           OR v_existing_grant.expires_at IS DISTINCT FROM p_expires_at
           OR v_existing_grant.source_reference_type IS DISTINCT FROM p_reference_type
           OR v_existing_grant.source_reference_id IS DISTINCT FROM p_reference_id
        THEN
            RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Idempotency key "%" was already processed with a different business payload', p_idempotency_key;
        END IF;

        -- Return spendable available balance
        SELECT COALESCE(SUM(GREATEST(remaining_units - reserved_units, 0)), 0)
        INTO v_total_available
        FROM public.credit_grants
        WHERE account_id = v_existing_grant.account_id
          AND status = 'ACTIVE'
          AND (expires_at IS NULL OR expires_at > NOW());

        RETURN jsonb_build_object(
            'grant_id', v_existing_grant.id,
            'account_id', v_existing_grant.account_id,
            'user_id', p_user_id,
            'original_units', v_existing_grant.original_units,
            'remaining_units', v_existing_grant.remaining_units,
            'total_available_units', v_total_available,
            'already_processed', true
        );
    END IF;

    -- 4. Fail-closed Grant Semantic Validation
    IF p_source_type = 'SUBSCRIPTION_CYCLE' THEN
        IF p_product_id IS NULL THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: SUBSCRIPTION_CYCLE requires p_product_id';
        END IF;
        IF p_pricing_version_id IS NULL THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: SUBSCRIPTION_CYCLE requires p_pricing_version_id';
        END IF;
        IF p_billing_cycle_start IS NULL OR p_billing_cycle_end IS NULL THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: SUBSCRIPTION_CYCLE requires p_billing_cycle_start and p_billing_cycle_end';
        END IF;
        IF p_billing_cycle_start >= p_billing_cycle_end THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: SUBSCRIPTION_CYCLE billing_cycle_start must be before billing_cycle_end';
        END IF;
        IF p_expires_at IS NULL OR p_expires_at <> p_billing_cycle_end THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: SUBSCRIPTION_CYCLE requires p_expires_at equal to p_billing_cycle_end';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.billing_products
            WHERE id = p_product_id AND product_type = 'SUBSCRIPTION'
        ) THEN
            RAISE EXCEPTION 'INVALID_PRODUCT_TYPE: SUBSCRIPTION_CYCLE product must have product_type = SUBSCRIPTION';
        END IF;

    ELSIF p_source_type = 'CREDIT_PACK_PURCHASE' THEN
        IF p_product_id IS NULL THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: CREDIT_PACK_PURCHASE requires p_product_id';
        END IF;
        IF p_pricing_version_id IS NULL THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: CREDIT_PACK_PURCHASE requires p_pricing_version_id';
        END IF;
        IF p_expires_at IS NOT NULL THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: CREDIT_PACK_PURCHASE must not have p_expires_at (must be NULL)';
        END IF;
        IF p_billing_cycle_start IS NOT NULL OR p_billing_cycle_end IS NOT NULL THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: CREDIT_PACK_PURCHASE must not have billing cycle dates (must be NULL)';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.billing_products
            WHERE id = p_product_id AND product_type = 'CREDIT_PACK'
        ) THEN
            RAISE EXCEPTION 'INVALID_PRODUCT_TYPE: CREDIT_PACK_PURCHASE product must have product_type = CREDIT_PACK';
        END IF;

    ELSIF p_source_type = 'FREE_BOOTSTRAP' THEN
        -- Phase 3A.3 semantics:
        -- Non-expiring in MVP (p_expires_at may be NULL)
        -- Not tied to subscription billing cycle (p_billing_cycle_start / end may be NULL)
        IF p_billing_cycle_start IS NOT NULL AND p_billing_cycle_end IS NOT NULL THEN
            IF p_billing_cycle_start >= p_billing_cycle_end THEN
                RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: FREE_BOOTSTRAP billing_cycle_start must be before billing_cycle_end';
            END IF;
        END IF;
        IF p_expires_at IS NOT NULL AND p_expires_at <= NOW() THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: FREE_BOOTSTRAP expires_at must be in the future';
        END IF;

    ELSIF p_source_type = 'ADMIN_ADJUSTMENT' THEN
        IF p_original_units <= 0 THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: ADMIN_ADJUSTMENT original units must be positive';
        END IF;
    END IF;

    -- 5. Lock or Initialize credit account
    SELECT id, status INTO v_account_id, v_account_status
    FROM public.credit_accounts
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.credit_accounts (user_id, status)
        VALUES (p_user_id, 'ACTIVE')
        ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
        RETURNING id, status INTO v_account_id, v_account_status;
    END IF;

    IF v_account_status = 'FROZEN' THEN
        RAISE EXCEPTION 'CREDIT_ACCOUNT_FROZEN: Account for user % is frozen', p_user_id;
    ELSIF v_account_status = 'CLOSED' THEN
        RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Account for user % is closed', p_user_id;
    END IF;

    -- 6. Insert credit grant
    BEGIN
        INSERT INTO public.credit_grants (
            account_id,
            user_id,
            source_type,
            source_product_id,
            pricing_version_id,
            subscription_id,
            billing_cycle_start,
            billing_cycle_end,
            original_units,
            remaining_units,
            reserved_units,
            granted_at,
            expires_at,
            status,
            idempotency_key,
            source_reference_type,
            source_reference_id,
            metadata
        ) VALUES (
            v_account_id,
            p_user_id,
            p_source_type,
            p_product_id,
            p_pricing_version_id,
            p_subscription_id,
            p_billing_cycle_start,
            p_billing_cycle_end,
            p_original_units,
            p_original_units,
            0,
            NOW(),
            p_expires_at,
            'ACTIVE',
            p_idempotency_key,
            p_reference_type,
            p_reference_id,
            p_metadata
        )
        RETURNING id INTO v_grant_id;
    EXCEPTION WHEN unique_violation THEN
        SELECT
            id,
            account_id,
            user_id,
            source_type,
            original_units,
            remaining_units,
            source_product_id,
            pricing_version_id,
            subscription_id,
            billing_cycle_start,
            billing_cycle_end,
            expires_at,
            source_reference_type,
            source_reference_id,
            status
        INTO v_existing_grant
        FROM public.credit_grants
        WHERE idempotency_key = p_idempotency_key;

        IF FOUND THEN
            IF v_existing_grant.user_id <> p_user_id
               OR v_existing_grant.source_type <> p_source_type
               OR v_existing_grant.original_units <> p_original_units
               OR v_existing_grant.source_product_id IS DISTINCT FROM p_product_id
               OR v_existing_grant.pricing_version_id IS DISTINCT FROM p_pricing_version_id
               OR v_existing_grant.subscription_id IS DISTINCT FROM p_subscription_id
               OR v_existing_grant.billing_cycle_start IS DISTINCT FROM p_billing_cycle_start
               OR v_existing_grant.billing_cycle_end IS DISTINCT FROM p_billing_cycle_end
               OR v_existing_grant.expires_at IS DISTINCT FROM p_expires_at
               OR v_existing_grant.source_reference_type IS DISTINCT FROM p_reference_type
               OR v_existing_grant.source_reference_id IS DISTINCT FROM p_reference_id
            THEN
                RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Idempotency key "%" was already processed with a different business payload', p_idempotency_key;
            END IF;

            SELECT COALESCE(SUM(GREATEST(remaining_units - reserved_units, 0)), 0)
            INTO v_total_available
            FROM public.credit_grants
            WHERE account_id = v_existing_grant.account_id
              AND status = 'ACTIVE'
              AND (expires_at IS NULL OR expires_at > NOW());

            RETURN jsonb_build_object(
                'grant_id', v_existing_grant.id,
                'account_id', v_existing_grant.account_id,
                'user_id', p_user_id,
                'original_units', v_existing_grant.original_units,
                'remaining_units', v_existing_grant.remaining_units,
                'total_available_units', v_total_available,
                'already_processed', true
            );
        ELSE
            -- If failure was due to duplicate FREE_BOOTSTRAP grant under another key
            IF p_source_type = 'FREE_BOOTSTRAP' THEN
                RAISE EXCEPTION 'DUPLICATE_FREE_BOOTSTRAP: User % has already received a one-time FREE_BOOTSTRAP grant', p_user_id;
            END IF;
            RAISE;
        END IF;
    END;

    -- 7. Calculate new spendable available balance
    SELECT COALESCE(SUM(GREATEST(remaining_units - reserved_units, 0)), 0)
    INTO v_total_available
    FROM public.credit_grants
    WHERE account_id = v_account_id
      AND status = 'ACTIVE'
      AND (expires_at IS NULL OR expires_at > NOW());

    -- 8. Calculate gross owned remaining balance for financial ledger entry
    SELECT COALESCE(SUM(remaining_units), 0)
    INTO v_ledger_balance_after
    FROM public.credit_grants
    WHERE account_id = v_account_id
      AND remaining_units > 0;

    -- 9. Determine ledger entry type (Canonical ledger event category)
    v_entry_type := CASE
        WHEN p_source_type = 'ADMIN_ADJUSTMENT' THEN 'ADJUSTMENT'
        ELSE 'GRANT'
    END;

    -- 10. Append-only ledger row
    INSERT INTO public.credit_ledger (
        account_id,
        user_id,
        grant_id,
        entry_type,
        delta_units,
        balance_after_units,
        reference_type,
        reference_id,
        idempotency_key,
        description,
        metadata
    ) VALUES (
        v_account_id,
        p_user_id,
        v_grant_id,
        v_entry_type,
        p_original_units,
        v_ledger_balance_after,
        COALESCE(p_reference_type, 'GRANT'),
        COALESCE(p_reference_id, v_grant_id::text),
        p_idempotency_key,
        COALESCE(p_description, 'Credit grant: ' || p_source_type),
        jsonb_build_object(
            'source_type', p_source_type,
            'original_units', p_original_units,
            'source_product_id', p_product_id,
            'pricing_version_id', p_pricing_version_id,
            'expires_at', p_expires_at,
            'billing_cycle_start', p_billing_cycle_start,
            'billing_cycle_end', p_billing_cycle_end
        ) || p_metadata
    );

    RETURN jsonb_build_object(
        'grant_id', v_grant_id,
        'account_id', v_account_id,
        'user_id', p_user_id,
        'original_units', p_original_units,
        'remaining_units', p_original_units,
        'total_available_units', v_total_available,
        'already_processed', false
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- Permissions: Strict service_role & postgres ONLY
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.grant_user_credits(
    UUID, VARCHAR, BIGINT, TEXT, TIMESTAMPTZ, UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, VARCHAR, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.grant_user_credits(
    UUID, VARCHAR, BIGINT, TEXT, TIMESTAMPTZ, UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, VARCHAR, TEXT, TEXT, JSONB
) TO postgres, service_role;
