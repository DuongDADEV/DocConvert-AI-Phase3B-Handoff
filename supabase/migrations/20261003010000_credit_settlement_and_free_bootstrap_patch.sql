-- ==============================================================================
-- Migration: 20261003010000_credit_settlement_and_free_bootstrap_patch.sql
-- Module: Phase 3A.3 — Runtime Telemetry + Pre-Integration DB Policy Hardening
--
-- PURPOSE:
-- 1. FREE_BOOTSTRAP Constraint Patch: Allow non-expiring FREE_BOOTSTRAP credits
--    (expires_at IS NULL) and decoupling from subscription billing cycles.
-- 2. One-Time FREE Grant Invariant: Partial unique index on credit_grants(account_id)
--    WHERE source_type = 'FREE_BOOTSTRAP' preventing duplicate initial grants per account.
-- 3. grant_user_credits RPC Replacement: Update parameter validations to permit
--    non-expiring FREE_BOOTSTRAP grants while maintaining fail-closed semantics.
-- 4. Settlement Policy Patch:
--    - capture_credit_reservation: Allow CAPTURE on FROZEN accounts (CLOSED denied).
--    - release_credit_reservation: Allow RELEASE on CLOSED accounts (held funds released).
--
-- SECURITY & COMPATIBILITY:
-- - All replacement functions are SECURITY DEFINER with search_path = public, pg_temp.
-- - Permissions revoked from PUBLIC, anon, authenticated; granted to service_role, postgres.
-- - No data modified or deleted. Forward-only migration.
-- ==============================================================================

-- 1. PATCH CONSTRAINT: chk_credit_grants_free_bootstrap_semantics
ALTER TABLE public.credit_grants
    DROP CONSTRAINT IF EXISTS chk_credit_grants_free_bootstrap_semantics;

ALTER TABLE public.credit_grants
    ADD CONSTRAINT chk_credit_grants_free_bootstrap_semantics CHECK (
        source_type <> 'FREE_BOOTSTRAP' OR (
            -- Non-expiring in MVP: expires_at may be NULL. If set, must be in future of granted_at
            (expires_at IS NULL OR expires_at > granted_at) AND
            -- Not tied to subscription billing cycle (may be NULL, or valid range if supplied)
            (
                (billing_cycle_start IS NULL AND billing_cycle_end IS NULL) OR
                (billing_cycle_start IS NOT NULL AND billing_cycle_end IS NOT NULL AND billing_cycle_start < billing_cycle_end)
            )
        )
    );

-- 2. ONE-TIME FREE GRANT INVARIANT: Partial unique index per account
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_grants_one_time_free_bootstrap
    ON public.credit_grants(account_id)
    WHERE source_type = 'FREE_BOOTSTRAP';

-- 3. REPLACED ATOMIC RPC: grant_user_credits (Phase 3A.3 Patch)
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

    -- 9. Determine ledger entry type
    v_entry_type := CASE p_source_type
        WHEN 'SUBSCRIPTION_CYCLE'   THEN 'GRANT_SUBSCRIPTION'
        WHEN 'CREDIT_PACK_PURCHASE' THEN 'GRANT_PACK'
        WHEN 'FREE_BOOTSTRAP'       THEN 'GRANT_FREE'
        WHEN 'PROMOTION'            THEN 'GRANT_PROMOTION'
        WHEN 'ADMIN_ADJUSTMENT'     THEN 'ADJUSTMENT'
        WHEN 'MIGRATION'            THEN 'MIGRATION_CREDIT'
        ELSE 'GRANT_MANUAL'
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

-- 4. REPLACED ATOMIC RPC: capture_credit_reservation (Phase 3A.3 Patch)
-- Allows CAPTURE on FROZEN accounts (CLOSED remains rejected)
CREATE OR REPLACE FUNCTION public.capture_credit_reservation(
    p_user_id UUID,
    p_reservation_id UUID,
    p_capture_units BIGINT,
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reservation RECORD;
    v_account_status VARCHAR;
    v_existing_event RECORD;
    v_outstanding BIGINT;
    v_remaining_to_capture BIGINT;
    v_alloc RECORD;
    v_alloc_outstanding BIGINT;
    v_capture_amount BIGINT;
    v_grant RECORD;
    v_new_remaining BIGINT;
    v_new_reserved BIGINT;
    v_grant_status VARCHAR;
    v_running_gross_balance BIGINT;
    v_new_captured BIGINT;
    v_new_outstanding BIGINT;
    v_new_status VARCHAR;
    v_settled_at TIMESTAMPTZ := NULL;
    v_sum_captured BIGINT;
    v_sum_released BIGINT;
    v_sum_reserved BIGINT;
BEGIN
    -- 1. Input Validation
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_user_id is required';
    END IF;
    IF p_reservation_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_reservation_id is required';
    END IF;
    IF p_capture_units IS NULL OR p_capture_units <= 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_capture_units must be positive';
    END IF;
    IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_idempotency_key is required';
    END IF;

    -- 2. Concurrency Safety: Transaction-scoped advisory lock on idempotency key
    PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));

    -- 3. Idempotency Check via credit_reservation_events
    SELECT * INTO v_existing_event
    FROM public.credit_reservation_events
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_event.reservation_id <> p_reservation_id
           OR v_existing_event.event_type <> 'CAPTURE'
           OR v_existing_event.units <> p_capture_units
           OR v_existing_event.user_id <> p_user_id
        THEN
            RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Capture idempotency key "%" was already processed with a different business payload', p_idempotency_key;
        END IF;

        SELECT * INTO v_reservation FROM public.credit_reservations WHERE id = p_reservation_id;
        v_outstanding := v_reservation.reserved_units - v_reservation.captured_units - v_reservation.released_units;

        RETURN jsonb_build_object(
            'reservation_id', p_reservation_id,
            'account_id', v_reservation.account_id,
            'user_id', p_user_id,
            'captured_units', p_capture_units,
            'total_captured_units', v_reservation.captured_units,
            'outstanding_units', v_outstanding,
            'status', v_reservation.status,
            'already_processed', true
        );
    END IF;

    -- 4. Lock Reservation Header
    SELECT * INTO v_reservation
    FROM public.credit_reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'RESERVATION_NOT_FOUND: Reservation % not found', p_reservation_id;
    END IF;

    IF v_reservation.user_id <> p_user_id THEN
        RAISE EXCEPTION 'RESERVATION_NOT_FOUND: Reservation % does not belong to user %', p_reservation_id, p_user_id;
    END IF;

    -- 5. Lock and Check User Account Status
    -- Phase 3A.3 Settlement Semantics: FROZEN accounts ALLOW CAPTURE; CLOSED accounts reject CAPTURE
    SELECT status INTO v_account_status
    FROM public.credit_accounts
    WHERE id = v_reservation.account_id
    FOR UPDATE;

    IF v_account_status = 'CLOSED' THEN
        RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Cannot capture on closed account';
    END IF;

    -- 6. Validate Capture against Outstanding Reserved Units and Terminal State
    v_outstanding := v_reservation.reserved_units - v_reservation.captured_units - v_reservation.released_units;
    IF v_reservation.status IN ('CAPTURED', 'RELEASED', 'SETTLED', 'EXPIRED') OR v_outstanding <= 0 THEN
        RAISE EXCEPTION 'RESERVATION_ALREADY_SETTLED: Reservation % is already in terminal status %',
            p_reservation_id, v_reservation.status;
    END IF;

    IF p_capture_units > v_outstanding THEN
        RAISE EXCEPTION 'CAPTURE_EXCEEDS_RESERVED: Cannot capture % units; only % outstanding on reservation %',
            p_capture_units, v_outstanding, p_reservation_id;
    END IF;

    -- 7. Initialize Running Gross Balance for Multi-Grant Ledger Accounting
    SELECT COALESCE(SUM(remaining_units), 0)
    INTO v_running_gross_balance
    FROM public.credit_grants
    WHERE account_id = v_reservation.account_id
      AND remaining_units > 0;

    -- 8. Deduct from Allocations in Deterministic Order
    v_remaining_to_capture := p_capture_units;

    FOR v_alloc IN
        SELECT *
        FROM public.credit_reservation_allocations
        WHERE reservation_id = p_reservation_id
          AND (allocated_units - captured_units - released_units) > 0
        ORDER BY allocation_order ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining_to_capture <= 0;

        v_alloc_outstanding := v_alloc.allocated_units - v_alloc.captured_units - v_alloc.released_units;
        v_capture_amount := LEAST(v_remaining_to_capture, v_alloc_outstanding);

        SELECT * INTO v_grant
        FROM public.credit_grants
        WHERE id = v_alloc.grant_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'CORRUPT_RESERVATION_ALLOCATION: Grant % referenced in allocation % not found',
                v_alloc.grant_id, v_alloc.id;
        END IF;

        IF v_grant.reserved_units < v_capture_amount THEN
            RAISE EXCEPTION 'CORRUPT_RESERVATION_ALLOCATION: Grant % reserved_units (%) < capture_amount (%)',
                v_grant.id, v_grant.reserved_units, v_capture_amount;
        END IF;
        IF v_grant.remaining_units < v_capture_amount THEN
            RAISE EXCEPTION 'CORRUPT_RESERVATION_ALLOCATION: Grant % remaining_units (%) < capture_amount (%)',
                v_grant.id, v_grant.remaining_units, v_capture_amount;
        END IF;

        v_new_remaining := v_grant.remaining_units - v_capture_amount;
        v_new_reserved  := v_grant.reserved_units  - v_capture_amount;
        v_grant_status  := CASE WHEN v_new_remaining = 0 THEN 'DEPLETED' ELSE v_grant.status END;

        UPDATE public.credit_grants
        SET remaining_units = v_new_remaining,
            reserved_units  = v_new_reserved,
            status          = v_grant_status,
            updated_at      = NOW()
        WHERE id = v_grant.id;

        UPDATE public.credit_reservation_allocations
        SET captured_units = captured_units + v_capture_amount,
            updated_at     = NOW()
        WHERE id = v_alloc.id;

        v_running_gross_balance := v_running_gross_balance - v_capture_amount;

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
            v_reservation.account_id,
            p_user_id,
            v_grant.id,
            'CAPTURE',
            -v_capture_amount,
            v_running_gross_balance,
            COALESCE(v_reservation.reference_type, 'RESERVATION'),
            COALESCE(v_reservation.reference_id, p_reservation_id::text),
            p_idempotency_key || ':grant:' || v_grant.id,
            'Reservation capture deduction from grant ' || v_grant.id,
            jsonb_build_object(
                'reservation_id', p_reservation_id,
                'allocation_id', v_alloc.id,
                'captured_from_grant', v_capture_amount,
                'source_type', v_grant.source_type
            ) || p_metadata
        );

        v_remaining_to_capture := v_remaining_to_capture - v_capture_amount;
    END LOOP;

    IF v_remaining_to_capture > 0 THEN
        RAISE EXCEPTION 'CORRUPT_RESERVATION_ALLOCATION: Could not fully satisfy capture of % units across allocations (% remaining unallocated)',
            p_capture_units, v_remaining_to_capture;
    END IF;

    -- 9. Log Operation in credit_reservation_events
    INSERT INTO public.credit_reservation_events (
        reservation_id,
        user_id,
        account_id,
        event_type,
        units,
        idempotency_key,
        metadata
    ) VALUES (
        p_reservation_id,
        p_user_id,
        v_reservation.account_id,
        'CAPTURE',
        p_capture_units,
        p_idempotency_key,
        jsonb_build_object('captured_units', p_capture_units) || p_metadata
    );

    -- 10. Update Reservation Status
    v_new_captured := v_reservation.captured_units + p_capture_units;
    v_new_outstanding := v_reservation.reserved_units - v_new_captured - v_reservation.released_units;

    IF v_new_outstanding = 0 THEN
        IF v_reservation.released_units = 0 THEN
            v_new_status := 'CAPTURED';
        ELSE
            v_new_status := 'SETTLED';
        END IF;
        v_settled_at := NOW();
    ELSE
        v_new_status := 'ACTIVE';
    END IF;

    UPDATE public.credit_reservations
    SET captured_units = v_new_captured,
        status         = v_new_status,
        settled_at     = COALESCE(settled_at, v_settled_at),
        updated_at     = NOW()
    WHERE id = p_reservation_id;

    -- 11. Post-condition Cross-table Reconciliation Check
    SELECT
        COALESCE(SUM(captured_units), 0),
        COALESCE(SUM(released_units), 0),
        COALESCE(SUM(allocated_units), 0)
    INTO v_sum_captured, v_sum_released, v_sum_reserved
    FROM public.credit_reservation_allocations
    WHERE reservation_id = p_reservation_id;

    IF v_sum_captured <> v_new_captured THEN
        RAISE EXCEPTION 'CROSS_TABLE_CORRUPTION: Allocations sum captured (%) != reservation captured (%)',
            v_sum_captured, v_new_captured;
    END IF;
    IF v_sum_reserved <> v_reservation.reserved_units THEN
        RAISE EXCEPTION 'CROSS_TABLE_CORRUPTION: Allocations sum allocated (%) != reservation reserved (%)',
            v_sum_reserved, v_reservation.reserved_units;
    END IF;

    RETURN jsonb_build_object(
        'reservation_id', p_reservation_id,
        'account_id', v_reservation.account_id,
        'user_id', p_user_id,
        'captured_units', p_capture_units,
        'total_captured_units', v_new_captured,
        'outstanding_units', v_new_outstanding,
        'status', v_new_status,
        'already_processed', false
    );
END;
$$;

-- 5. REPLACED ATOMIC RPC: release_credit_reservation (Phase 3A.3 Patch)
-- Allows RELEASE on ACTIVE, FROZEN, and CLOSED accounts (held funds released cleanly)
CREATE OR REPLACE FUNCTION public.release_credit_reservation(
    p_user_id UUID,
    p_reservation_id UUID,
    p_release_units BIGINT,
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reservation RECORD;
    v_account_status VARCHAR;
    v_existing_event RECORD;
    v_outstanding BIGINT;
    v_remaining_to_release BIGINT;
    v_alloc RECORD;
    v_alloc_outstanding BIGINT;
    v_release_amount BIGINT;
    v_new_released BIGINT;
    v_new_outstanding BIGINT;
    v_new_status VARCHAR;
    v_settled_at TIMESTAMPTZ := NULL;
    v_sum_captured BIGINT;
    v_sum_released BIGINT;
    v_sum_reserved BIGINT;
BEGIN
    -- 1. Input Validation
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_user_id is required';
    END IF;
    IF p_reservation_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_reservation_id is required';
    END IF;
    IF p_release_units IS NULL OR p_release_units <= 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_release_units must be positive';
    END IF;
    IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_idempotency_key is required';
    END IF;

    -- 2. Concurrency Safety: Transaction-scoped advisory lock on idempotency key
    PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));

    -- 3. Idempotency Check via credit_reservation_events
    SELECT * INTO v_existing_event
    FROM public.credit_reservation_events
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_event.reservation_id <> p_reservation_id
           OR v_existing_event.event_type <> 'RELEASE'
           OR v_existing_event.units <> p_release_units
           OR v_existing_event.user_id <> p_user_id
        THEN
            RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Release idempotency key "%" was already processed with a different business payload', p_idempotency_key;
        END IF;

        SELECT * INTO v_reservation FROM public.credit_reservations WHERE id = p_reservation_id;
        v_outstanding := v_reservation.reserved_units - v_reservation.captured_units - v_reservation.released_units;

        RETURN jsonb_build_object(
            'reservation_id', p_reservation_id,
            'account_id', v_reservation.account_id,
            'user_id', p_user_id,
            'released_units', p_release_units,
            'total_released_units', v_reservation.released_units,
            'outstanding_units', v_outstanding,
            'status', v_reservation.status,
            'already_processed', true
        );
    END IF;

    -- 4. Lock Reservation Header
    SELECT * INTO v_reservation
    FROM public.credit_reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'RESERVATION_NOT_FOUND: Reservation % not found', p_reservation_id;
    END IF;

    IF v_reservation.user_id <> p_user_id THEN
        RAISE EXCEPTION 'RESERVATION_NOT_FOUND: Reservation % does not belong to user %', p_reservation_id, p_user_id;
    END IF;

    -- 5. Lock and Check User Account
    -- Phase 3A.3 Settlement Semantics: ACTIVE, FROZEN, and CLOSED accounts ALLOW RELEASE
    SELECT status INTO v_account_status
    FROM public.credit_accounts
    WHERE id = v_reservation.account_id
    FOR UPDATE;

    -- 6. Validate Release against Outstanding Reserved Units and Terminal State
    v_outstanding := v_reservation.reserved_units - v_reservation.captured_units - v_reservation.released_units;
    IF v_reservation.status IN ('CAPTURED', 'RELEASED', 'SETTLED', 'EXPIRED') OR v_outstanding <= 0 THEN
        RAISE EXCEPTION 'RESERVATION_ALREADY_SETTLED: Reservation % is already in terminal status %',
            p_reservation_id, v_reservation.status;
    END IF;

    IF p_release_units > v_outstanding THEN
        RAISE EXCEPTION 'RELEASE_EXCEEDS_RESERVED: Cannot release % units; only % outstanding on reservation %',
            p_release_units, v_outstanding, p_reservation_id;
    END IF;

    -- 7. Deduct reserved_units across allocations (Deterministic allocation_order ASC)
    v_remaining_to_release := p_release_units;

    FOR v_alloc IN
        SELECT *
        FROM public.credit_reservation_allocations
        WHERE reservation_id = p_reservation_id
          AND (allocated_units - captured_units - released_units) > 0
        ORDER BY allocation_order ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining_to_release <= 0;

        v_alloc_outstanding := v_alloc.allocated_units - v_alloc.captured_units - v_alloc.released_units;
        v_release_amount := LEAST(v_remaining_to_release, v_alloc_outstanding);

        UPDATE public.credit_grants
        SET reserved_units = reserved_units - v_release_amount,
            updated_at     = NOW()
        WHERE id = v_alloc.grant_id;

        UPDATE public.credit_reservation_allocations
        SET released_units = released_units + v_release_amount,
            updated_at     = NOW()
        WHERE id = v_alloc.id;

        v_remaining_to_release := v_remaining_to_release - v_release_amount;
    END LOOP;

    IF v_remaining_to_release > 0 THEN
        RAISE EXCEPTION 'CORRUPT_RESERVATION_ALLOCATION: Could not satisfy release of % units across allocations (% remaining)',
            p_release_units, v_remaining_to_release;
    END IF;

    -- 8. Log Operational Event in credit_reservation_events
    INSERT INTO public.credit_reservation_events (
        reservation_id,
        user_id,
        account_id,
        event_type,
        units,
        idempotency_key,
        metadata
    ) VALUES (
        p_reservation_id,
        p_user_id,
        v_reservation.account_id,
        'RELEASE',
        p_release_units,
        p_idempotency_key,
        jsonb_build_object('released_units', p_release_units) || p_metadata
    );

    -- 9. Update Reservation Status
    v_new_released := v_reservation.released_units + p_release_units;
    v_new_outstanding := v_reservation.reserved_units - v_reservation.captured_units - v_new_released;

    IF v_new_outstanding = 0 THEN
        IF v_reservation.captured_units = 0 THEN
            v_new_status := 'RELEASED';
        ELSE
            v_new_status := 'SETTLED';
        END IF;
        v_settled_at := NOW();
    ELSE
        v_new_status := 'ACTIVE';
    END IF;

    UPDATE public.credit_reservations
    SET released_units = v_new_released,
        status         = v_new_status,
        settled_at     = COALESCE(settled_at, v_settled_at),
        updated_at     = NOW()
    WHERE id = p_reservation_id;

    -- 10. Post-condition Cross-table Reconciliation Check
    SELECT
        COALESCE(SUM(captured_units), 0),
        COALESCE(SUM(released_units), 0),
        COALESCE(SUM(allocated_units), 0)
    INTO v_sum_captured, v_sum_released, v_sum_reserved
    FROM public.credit_reservation_allocations
    WHERE reservation_id = p_reservation_id;

    IF v_sum_released <> v_new_released THEN
        RAISE EXCEPTION 'CROSS_TABLE_CORRUPTION: Allocations sum released (%) != reservation released (%)',
            v_sum_released, v_new_released;
    END IF;
    IF v_sum_reserved <> v_reservation.reserved_units THEN
        RAISE EXCEPTION 'CROSS_TABLE_CORRUPTION: Allocations sum allocated (%) != reservation reserved (%)',
            v_sum_reserved, v_reservation.reserved_units;
    END IF;

    RETURN jsonb_build_object(
        'reservation_id', p_reservation_id,
        'account_id', v_reservation.account_id,
        'user_id', p_user_id,
        'released_units', p_release_units,
        'total_released_units', v_new_released,
        'outstanding_units', v_new_outstanding,
        'status', v_new_status,
        'already_processed', false
    );
END;
$$;

-- 6. RPC PERMISSIONS: Strict service_role & postgres ONLY
REVOKE ALL ON FUNCTION public.grant_user_credits(
    UUID, VARCHAR, BIGINT, TEXT, TIMESTAMPTZ, UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, VARCHAR, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.grant_user_credits(
    UUID, VARCHAR, BIGINT, TEXT, TIMESTAMPTZ, UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, VARCHAR, TEXT, TEXT, JSONB
) TO postgres, service_role;

REVOKE ALL ON FUNCTION public.capture_credit_reservation(
    UUID, UUID, BIGINT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.capture_credit_reservation(
    UUID, UUID, BIGINT, TEXT, JSONB
) TO postgres, service_role;

REVOKE ALL ON FUNCTION public.release_credit_reservation(
    UUID, UUID, BIGINT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.release_credit_reservation(
    UUID, UUID, BIGINT, TEXT, JSONB
) TO postgres, service_role;
