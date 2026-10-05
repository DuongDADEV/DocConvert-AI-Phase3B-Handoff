-- ==============================================================================
-- MIGRATION: 20261002010000_credit_reservation_foundation.sql
-- DESCRIPTION: Phase 2B — Credit Reservation / Capture / Release Foundation
--   1. credit_grants: Add reserved_units BIGINT with constraint 0 <= reserved_units <= remaining_units.
--   2. credit_reservations: Lifecycle tracking for in-flight credit reservations.
--   3. credit_reservation_allocations: Deterministic bucket-level allocation across credit grants.
--   4. credit_reservation_events: Append-only immutable operational audit trail for capture/release.
--   5. credit_ledger: Extended with 'CAPTURE' entry_type (delta_units < 0).
--   6. Immutability triggers: Protect credit_reservation_events against UPDATE and DELETE.
--   7. Composite Foreign Keys & Identity guards: Strict account/user/grant/reservation alignment.
--   8. Atomic RPCs: reserve_credit_units, capture_credit_reservation, release_credit_reservation.
--   9. Updated get_user_credit_balance RPC: Gross remaining, reserved, and available balance model.
--  10. RLS Security: Owner SELECT-only; zero direct client mutations; service_role-only RPC execution.
--
-- FINANCIAL INVARIANTS:
--   - Invariant: 0 <= reserved_units <= remaining_units <= original_units.
--   - Integer scaled units: 1 credit = 1000 credit_units (BIGINT). NO FLOAT.
--   - Deterministic allocation order: expires_at ASC NULLS LAST, granted_at ASC, id ASC.
--   - Reserve: Locks eligible grants; fails closed on insufficient available balance; no partial reserve.
--   - Capture: Permanently decrements remaining_units and reserved_units; writes immutable CAPTURE ledger entries.
--   - Release: Decrements reserved_units only; NEVER alters remaining_units; writes NO financial ledger delta.
--   - Concurrency safety: Row-level locks (FOR UPDATE) + advisory locks + DB constraints prevent overspend.
--   - Preserved history: ON DELETE RESTRICT protects all operational and financial records.
-- ==============================================================================

-- 1. ALTER credit_grants: Add reserved_units column & constraint
ALTER TABLE public.credit_grants
    ADD COLUMN IF NOT EXISTS reserved_units BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.credit_grants
    DROP CONSTRAINT IF EXISTS chk_credit_grants_reserved_units;

ALTER TABLE public.credit_grants
    ADD CONSTRAINT chk_credit_grants_reserved_units
    CHECK (reserved_units >= 0 AND reserved_units <= remaining_units);

-- 2. CREATE TABLE: credit_reservations
CREATE TABLE IF NOT EXISTS public.credit_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    requested_units BIGINT NOT NULL,
    reserved_units BIGINT NOT NULL,
    captured_units BIGINT NOT NULL DEFAULT 0,
    released_units BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'RESERVED',
    idempotency_key TEXT NOT NULL UNIQUE,
    reference_type VARCHAR(100) NULL,
    reference_id TEXT NULL,
    reservation_expires_at TIMESTAMPTZ NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ NULL,
    CONSTRAINT fk_credit_reservations_account_user
        FOREIGN KEY (account_id, user_id)
        REFERENCES public.credit_accounts(id, user_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_credit_reservations_id_account_user
        UNIQUE (id, account_id, user_id),
    CONSTRAINT chk_credit_reservations_status
        CHECK (status IN ('RESERVED', 'PARTIALLY_CAPTURED', 'CAPTURED', 'RELEASED', 'SETTLED', 'EXPIRED')),
    CONSTRAINT chk_credit_reservations_requested_units
        CHECK (requested_units > 0),
    CONSTRAINT chk_credit_reservations_reserved_units
        CHECK (reserved_units > 0),
    CONSTRAINT chk_credit_reservations_captured_units
        CHECK (captured_units >= 0),
    CONSTRAINT chk_credit_reservations_released_units
        CHECK (released_units >= 0),
    CONSTRAINT chk_credit_reservations_settlement_sum
        CHECK (captured_units + released_units <= reserved_units),
    CONSTRAINT chk_credit_reservations_requested_eq_reserved
        CHECK (requested_units = reserved_units)
);

CREATE INDEX IF NOT EXISTS idx_credit_reservations_user_status_created
    ON public.credit_reservations(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_reservations_account
    ON public.credit_reservations(account_id);

-- 3. CREATE TABLE: credit_reservation_allocations
CREATE TABLE IF NOT EXISTS public.credit_reservation_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL,
    account_id UUID NOT NULL,
    user_id UUID NOT NULL,
    grant_id UUID NOT NULL,
    allocation_order INTEGER NOT NULL,
    reserved_units BIGINT NOT NULL,
    captured_units BIGINT NOT NULL DEFAULT 0,
    released_units BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_alloc_reservation_account_user
        FOREIGN KEY (reservation_id, account_id, user_id)
        REFERENCES public.credit_reservations(id, account_id, user_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_alloc_grant_account_user
        FOREIGN KEY (grant_id, account_id, user_id)
        REFERENCES public.credit_grants(id, account_id, user_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_credit_reservation_allocations_res_grant
        UNIQUE (reservation_id, grant_id),
    CONSTRAINT uq_credit_reservation_allocations_res_order
        UNIQUE (reservation_id, allocation_order),
    CONSTRAINT chk_alloc_reserved_units
        CHECK (reserved_units > 0),
    CONSTRAINT chk_alloc_captured_units
        CHECK (captured_units >= 0),
    CONSTRAINT chk_alloc_released_units
        CHECK (released_units >= 0),
    CONSTRAINT chk_alloc_settlement_sum
        CHECK (captured_units + released_units <= reserved_units)
);

CREATE INDEX IF NOT EXISTS idx_credit_reservation_allocations_grant
    ON public.credit_reservation_allocations(grant_id);

CREATE INDEX IF NOT EXISTS idx_credit_reservation_allocations_res_order
    ON public.credit_reservation_allocations(reservation_id, allocation_order);

-- 4. CREATE TABLE: credit_reservation_events (Append-only operational audit trail)
CREATE TABLE IF NOT EXISTS public.credit_reservation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL,
    account_id UUID NOT NULL,
    user_id UUID NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    units BIGINT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_credit_reservation_events_res_account_user
        FOREIGN KEY (reservation_id, account_id, user_id)
        REFERENCES public.credit_reservations(id, account_id, user_id)
        ON DELETE RESTRICT,
    CONSTRAINT chk_credit_reservation_events_type
        CHECK (event_type IN ('CAPTURE', 'RELEASE')),
    CONSTRAINT chk_credit_reservation_events_units
        CHECK (units > 0)
);

CREATE INDEX IF NOT EXISTS idx_credit_reservation_events_res_created
    ON public.credit_reservation_events(reservation_id, created_at ASC);

-- Immutability trigger on credit_reservation_events (APPEND-ONLY)
CREATE OR REPLACE FUNCTION public.fn_guard_credit_reservation_events_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CREDIT_RESERVATION_EVENTS_IMMUTABLE: Records in credit_reservation_events cannot be updated or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_credit_reservation_events_immutability ON public.credit_reservation_events;
CREATE TRIGGER trg_guard_credit_reservation_events_immutability
    BEFORE UPDATE OR DELETE ON public.credit_reservation_events
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_guard_credit_reservation_events_immutability();

-- 5. EXTEND credit_ledger CONSTRAINTS FOR CAPTURE
ALTER TABLE public.credit_ledger
    DROP CONSTRAINT IF EXISTS chk_credit_ledger_entry_type;

ALTER TABLE public.credit_ledger
    ADD CONSTRAINT chk_credit_ledger_entry_type CHECK (
        entry_type IN ('GRANT', 'ADJUSTMENT', 'EXPIRATION', 'CAPTURE')
    );

ALTER TABLE public.credit_ledger
    DROP CONSTRAINT IF EXISTS chk_credit_ledger_capture_delta;

ALTER TABLE public.credit_ledger
    ADD CONSTRAINT chk_credit_ledger_capture_delta CHECK (
        entry_type <> 'CAPTURE' OR delta_units < 0
    );

-- 6. ATOMIC RPC: reserve_credit_units
-- Transactionally locks user account and eligible grants, performs bucket allocation,
-- increases reserved_units, creates reservation and allocations.
CREATE OR REPLACE FUNCTION public.reserve_credit_units(
    p_user_id UUID,
    p_requested_units BIGINT,
    p_idempotency_key TEXT,
    p_reference_type VARCHAR DEFAULT NULL,
    p_reference_id TEXT DEFAULT NULL,
    p_reservation_expires_at TIMESTAMPTZ DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_account_id UUID;
    v_account_status VARCHAR;
    v_existing_res RECORD;
    v_reservation_id UUID;
    v_total_available BIGINT := 0;
    v_remaining_to_reserve BIGINT;
    v_grant RECORD;
    v_grant_available BIGINT;
    v_alloc_units BIGINT;
    v_alloc_id UUID;
    v_alloc_order INTEGER := 1;
    v_allocations_arr JSONB := '[]'::jsonb;
    v_balance_after BIGINT;
BEGIN
    -- 1. Input Validation
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_user_id is required';
    END IF;
    IF p_requested_units IS NULL OR p_requested_units <= 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_requested_units must be positive';
    END IF;
    IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_idempotency_key is required';
    END IF;

    -- 2. Concurrency Safety: Transaction-scoped advisory lock on idempotency key hash
    PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));

    -- 3. Idempotency Check
    SELECT
        id,
        account_id,
        user_id,
        requested_units,
        reserved_units,
        captured_units,
        released_units,
        status,
        reference_type,
        reference_id,
        reservation_expires_at
    INTO v_existing_res
    FROM public.credit_reservations
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        -- Fail closed on payload conflict
        IF v_existing_res.user_id <> p_user_id
           OR v_existing_res.requested_units <> p_requested_units
           OR v_existing_res.reference_type IS DISTINCT FROM p_reference_type
           OR v_existing_res.reference_id IS DISTINCT FROM p_reference_id
           OR v_existing_res.reservation_expires_at IS DISTINCT FROM p_reservation_expires_at
        THEN
            RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Idempotency key "%" was already processed with a different business payload', p_idempotency_key;
        END IF;

        -- Return existing reservation with allocations and current available balance
        SELECT COALESCE(SUM(remaining_units - reserved_units), 0)
        INTO v_total_available
        FROM public.credit_grants
        WHERE account_id = v_existing_res.account_id
          AND status = 'ACTIVE'
          AND (expires_at IS NULL OR expires_at > NOW());

        SELECT jsonb_agg(
            jsonb_build_object(
                'allocation_id', a.id,
                'grant_id', a.grant_id,
                'allocation_order', a.allocation_order,
                'reserved_units', a.reserved_units,
                'captured_units', a.captured_units,
                'released_units', a.released_units
            ) ORDER BY a.allocation_order ASC
        )
        INTO v_allocations_arr
        FROM public.credit_reservation_allocations a
        WHERE a.reservation_id = v_existing_res.id;

        RETURN jsonb_build_object(
            'reservation_id', v_existing_res.id,
            'account_id', v_existing_res.account_id,
            'user_id', p_user_id,
            'requested_units', v_existing_res.requested_units,
            'reserved_units', v_existing_res.reserved_units,
            'total_available_units', v_total_available,
            'status', v_existing_res.status,
            'allocations', COALESCE(v_allocations_arr, '[]'::jsonb),
            'already_processed', true
        );
    END IF;

    -- 4. Resolve and Lock User Credit Account
    SELECT id, status INTO v_account_id, v_account_status
    FROM public.credit_accounts
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CREDIT_ACCOUNT_NOT_FOUND: User % has no credit account', p_user_id;
    END IF;

    IF v_account_status = 'FROZEN' THEN
        RAISE EXCEPTION 'CREDIT_ACCOUNT_FROZEN: Account for user % is frozen', p_user_id;
    ELSIF v_account_status = 'CLOSED' THEN
        RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Account for user % is closed', p_user_id;
    END IF;

    -- 5. Deterministically Lock Eligible Grants FOR UPDATE first
    PERFORM id
    FROM public.credit_grants
    WHERE account_id = v_account_id
      AND status = 'ACTIVE'
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (remaining_units - reserved_units) > 0
    ORDER BY expires_at ASC NULLS LAST, granted_at ASC, id ASC
    FOR UPDATE;

    -- 6. Calculate Total Available Balance from locked rows
    SELECT COALESCE(SUM(remaining_units - reserved_units), 0)
    INTO v_total_available
    FROM public.credit_grants
    WHERE account_id = v_account_id
      AND status = 'ACTIVE'
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (remaining_units - reserved_units) > 0;

    -- 7. Fail-closed on Insufficient Available Credit (All-or-nothing atomicity)
    IF v_total_available < p_requested_units THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDIT: Requested % units, but only % available', p_requested_units, v_total_available;
    END IF;

    -- 7. Insert credit_reservations Header
    INSERT INTO public.credit_reservations (
        account_id,
        user_id,
        requested_units,
        reserved_units,
        captured_units,
        released_units,
        status,
        idempotency_key,
        reference_type,
        reference_id,
        reservation_expires_at,
        metadata
    ) VALUES (
        v_account_id,
        p_user_id,
        p_requested_units,
        p_requested_units,
        0,
        0,
        'RESERVED',
        p_idempotency_key,
        p_reference_type,
        p_reference_id,
        p_reservation_expires_at,
        p_metadata
    )
    RETURNING id INTO v_reservation_id;

    -- 8. Deterministic Bucket Allocation across Grants
    -- Priority: expires_at ASC NULLS LAST, granted_at ASC, id ASC
    v_remaining_to_reserve := p_requested_units;

    FOR v_grant IN
        SELECT id, remaining_units, reserved_units
        FROM public.credit_grants
        WHERE account_id = v_account_id
          AND status = 'ACTIVE'
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (remaining_units - reserved_units) > 0
        ORDER BY expires_at ASC NULLS LAST, granted_at ASC, id ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining_to_reserve <= 0;

        v_grant_available := v_grant.remaining_units - v_grant.reserved_units;
        v_alloc_units := LEAST(v_grant_available, v_remaining_to_reserve);

        -- Increase reserved_units on grant bucket
        UPDATE public.credit_grants
        SET reserved_units = reserved_units + v_alloc_units,
            updated_at = NOW()
        WHERE id = v_grant.id;

        -- Create allocation line item
        INSERT INTO public.credit_reservation_allocations (
            reservation_id,
            account_id,
            user_id,
            grant_id,
            allocation_order,
            reserved_units,
            captured_units,
            released_units
        ) VALUES (
            v_reservation_id,
            v_account_id,
            p_user_id,
            v_grant.id,
            v_alloc_order,
            v_alloc_units,
            0,
            0
        )
        RETURNING id INTO v_alloc_id;

        v_allocations_arr := v_allocations_arr || jsonb_build_object(
            'allocation_id', v_alloc_id,
            'grant_id', v_grant.id,
            'allocation_order', v_alloc_order,
            'reserved_units', v_alloc_units,
            'captured_units', 0,
            'released_units', 0
        );

        v_remaining_to_reserve := v_remaining_to_reserve - v_alloc_units;
        v_alloc_order := v_alloc_order + 1;
    END LOOP;

    -- Invariant safeguard: all requested units must have been allocated
    IF v_remaining_to_reserve > 0 THEN
        RAISE EXCEPTION 'RESERVATION_ALLOCATION_MISMATCH: Remaining unallocated units: %', v_remaining_to_reserve;
    END IF;

    v_balance_after := v_total_available - p_requested_units;

    RETURN jsonb_build_object(
        'reservation_id', v_reservation_id,
        'account_id', v_account_id,
        'user_id', p_user_id,
        'requested_units', p_requested_units,
        'reserved_units', p_requested_units,
        'total_available_units', v_balance_after,
        'status', 'RESERVED',
        'allocations', v_allocations_arr,
        'already_processed', false
    );
END;
$$;

-- 7. ATOMIC RPC: capture_credit_reservation
-- Permanently consumes credit by decrementing remaining_units and reserved_units,
-- updates reservation and allocation captured_units, and creates immutable CAPTURE ledger entries.
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
    SELECT status INTO v_account_status
    FROM public.credit_accounts
    WHERE id = v_reservation.account_id
    FOR UPDATE;

    IF v_account_status = 'FROZEN' THEN
        RAISE EXCEPTION 'CREDIT_ACCOUNT_FROZEN: Cannot capture on frozen account';
    ELSIF v_account_status = 'CLOSED' THEN
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
          AND (reserved_units - captured_units - released_units) > 0
        ORDER BY allocation_order ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining_to_capture <= 0;

        v_alloc_outstanding := v_alloc.reserved_units - v_alloc.captured_units - v_alloc.released_units;
        v_capture_amount := LEAST(v_alloc_outstanding, v_remaining_to_capture);

        -- Lock and update grant bucket (decrease remaining_units AND reserved_units)
        SELECT * INTO v_grant
        FROM public.credit_grants
        WHERE id = v_alloc.grant_id
        FOR UPDATE;

        v_new_remaining := v_grant.remaining_units - v_capture_amount;
        v_new_reserved := v_grant.reserved_units - v_capture_amount;
        v_grant_status := v_grant.status;
        IF v_new_remaining = 0 THEN
            v_grant_status := 'DEPLETED';
        END IF;

        UPDATE public.credit_grants
        SET remaining_units = v_new_remaining,
            reserved_units = v_new_reserved,
            status = v_grant_status,
            updated_at = NOW()
        WHERE id = v_grant.id;

        -- Update allocation
        UPDATE public.credit_reservation_allocations
        SET captured_units = captured_units + v_capture_amount,
            updated_at = NOW()
        WHERE id = v_alloc.id;

        -- Running gross balance after this specific permanent financial mutation
        v_running_gross_balance := v_running_gross_balance - v_capture_amount;

        -- Insert Immutable CAPTURE Ledger Entry
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
            metadata,
            created_at
        ) VALUES (
            v_reservation.account_id,
            p_user_id,
            v_alloc.grant_id,
            'CAPTURE',
            -v_capture_amount,
            v_running_gross_balance,
            'RESERVATION_CAPTURE',
            p_reservation_id::text,
            'CAPTURE:' || p_idempotency_key || ':' || v_alloc.grant_id::text,
            'Captured ' || v_capture_amount || ' units for reservation ' || p_reservation_id::text,
            jsonb_build_object(
                'reservation_id', p_reservation_id,
                'allocation_id', v_alloc.id,
                'capture_units', v_capture_amount,
                'operation_idempotency_key', p_idempotency_key,
                'custom_metadata', p_metadata
            ),
            NOW()
        );

        v_remaining_to_capture := v_remaining_to_capture - v_capture_amount;
    END LOOP;

    -- 8.1 Defensive Allocation Integrity Assertion
    IF v_remaining_to_capture > 0 THEN
        RAISE EXCEPTION 'ALLOCATION_INTEGRITY_ERROR: Unable to fully allocate requested capture units: % units remaining unallocated', v_remaining_to_capture;
    END IF;

    -- 8.2 Update Reservation Header & Derive Status
    v_new_captured := v_reservation.captured_units + p_capture_units;
    v_new_outstanding := v_reservation.reserved_units - v_new_captured - v_reservation.released_units;

    IF (v_new_captured + v_reservation.released_units) = v_reservation.reserved_units THEN
        v_settled_at := NOW();
        IF v_new_captured = v_reservation.reserved_units THEN
            v_new_status := 'CAPTURED';
        ELSIF v_reservation.released_units = v_reservation.reserved_units THEN
            v_new_status := 'RELEASED';
        ELSE
            v_new_status := 'SETTLED';
        END IF;
    ELSIF v_new_captured > 0 THEN
        v_new_status := 'PARTIALLY_CAPTURED';
    ELSE
        v_new_status := 'RESERVED';
    END IF;

    UPDATE public.credit_reservations
    SET captured_units = v_new_captured,
        status = v_new_status,
        settled_at = COALESCE(settled_at, v_settled_at),
        updated_at = NOW()
    WHERE id = p_reservation_id;

    -- 8.3 Defensive Cross-Row Settlement Assertion
    SELECT COALESCE(SUM(captured_units), 0), COALESCE(SUM(released_units), 0), COALESCE(SUM(reserved_units), 0)
    INTO v_sum_captured, v_sum_released, v_sum_reserved
    FROM public.credit_reservation_allocations
    WHERE reservation_id = p_reservation_id;

    IF v_sum_captured <> v_new_captured THEN
        RAISE EXCEPTION 'ALLOCATION_INTEGRITY_ERROR: Allocation captured sum (%) does not match reservation captured_units (%)',
            v_sum_captured, v_new_captured;
    END IF;

    IF v_sum_reserved <> v_reservation.reserved_units THEN
        RAISE EXCEPTION 'ALLOCATION_INTEGRITY_ERROR: Allocation reserved sum (%) does not match reservation reserved_units (%)',
            v_sum_reserved, v_reservation.reserved_units;
    END IF;

    -- 9. Insert Operational Event into credit_reservation_events
    INSERT INTO public.credit_reservation_events (
        reservation_id,
        account_id,
        user_id,
        event_type,
        units,
        idempotency_key,
        metadata,
        created_at
    ) VALUES (
        p_reservation_id,
        v_reservation.account_id,
        p_user_id,
        'CAPTURE',
        p_capture_units,
        p_idempotency_key,
        p_metadata,
        NOW()
    );

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

-- 8. ATOMIC RPC: release_credit_reservation
-- Decrements reserved_units on credit_grants and allocations without modifying remaining_units.
-- Writes NO ledger delta, logs operational RELEASE event, and updates reservation status.
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

    -- 5. Lock and Check User Account Status (ACTIVE or FROZEN allowed; CLOSED rejected)
    SELECT status INTO v_account_status
    FROM public.credit_accounts
    WHERE id = v_reservation.account_id
    FOR UPDATE;

    IF v_account_status = 'CLOSED' THEN
        RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Cannot release on closed account';
    END IF;

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
          AND (reserved_units - captured_units - released_units) > 0
        ORDER BY allocation_order ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining_to_release <= 0;

        v_alloc_outstanding := v_alloc.reserved_units - v_alloc.captured_units - v_alloc.released_units;
        v_release_amount := LEAST(v_alloc_outstanding, v_remaining_to_release);

        -- Decrement reserved_units on grant bucket ONLY. Do NOT touch remaining_units.
        UPDATE public.credit_grants
        SET reserved_units = reserved_units - v_release_amount,
            updated_at = NOW()
        WHERE id = v_alloc.grant_id;

        -- Update allocation released_units
        UPDATE public.credit_reservation_allocations
        SET released_units = released_units + v_release_amount,
            updated_at = NOW()
        WHERE id = v_alloc.id;

        v_remaining_to_release := v_remaining_to_release - v_release_amount;
    END LOOP;

    -- 8.1 Defensive Allocation Integrity Assertion
    IF v_remaining_to_release > 0 THEN
        RAISE EXCEPTION 'ALLOCATION_INTEGRITY_ERROR: Unable to fully allocate requested release units: % units remaining unallocated', v_remaining_to_release;
    END IF;

    -- 8.2 Update Reservation Header & Derive Status
    v_new_released := v_reservation.released_units + p_release_units;
    v_new_outstanding := v_reservation.reserved_units - v_reservation.captured_units - v_new_released;

    IF (v_reservation.captured_units + v_new_released) = v_reservation.reserved_units THEN
        v_settled_at := NOW();
        IF v_reservation.captured_units = v_reservation.reserved_units THEN
            v_new_status := 'CAPTURED';
        ELSIF v_new_released = v_reservation.reserved_units THEN
            v_new_status := 'RELEASED';
        ELSE
            v_new_status := 'SETTLED';
        END IF;
    ELSIF v_reservation.captured_units > 0 THEN
        v_new_status := 'PARTIALLY_CAPTURED';
    ELSE
        v_new_status := 'RESERVED';
    END IF;

    UPDATE public.credit_reservations
    SET released_units = v_new_released,
        status = v_new_status,
        settled_at = COALESCE(settled_at, v_settled_at),
        updated_at = NOW()
    WHERE id = p_reservation_id;

    -- 8.3 Defensive Cross-Row Settlement Assertion
    SELECT COALESCE(SUM(captured_units), 0), COALESCE(SUM(released_units), 0), COALESCE(SUM(reserved_units), 0)
    INTO v_sum_captured, v_sum_released, v_sum_reserved
    FROM public.credit_reservation_allocations
    WHERE reservation_id = p_reservation_id;

    IF v_sum_released <> v_new_released THEN
        RAISE EXCEPTION 'ALLOCATION_INTEGRITY_ERROR: Allocation released sum (%) does not match reservation released_units (%)',
            v_sum_released, v_new_released;
    END IF;

    IF v_sum_reserved <> v_reservation.reserved_units THEN
        RAISE EXCEPTION 'ALLOCATION_INTEGRITY_ERROR: Allocation reserved sum (%) does not match reservation reserved_units (%)',
            v_sum_reserved, v_reservation.reserved_units;
    END IF;

    -- 9. Insert Operational Event into credit_reservation_events
    INSERT INTO public.credit_reservation_events (
        reservation_id,
        account_id,
        user_id,
        event_type,
        units,
        idempotency_key,
        metadata,
        created_at
    ) VALUES (
        p_reservation_id,
        v_reservation.account_id,
        p_user_id,
        'RELEASE',
        p_release_units,
        p_idempotency_key,
        p_metadata,
        NOW()
    );

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

-- 9. UPDATED RPC: get_user_credit_balance
-- Incorporates reserved_units into the read model:
--   - gross_remaining_units: total remaining in eligible grants
--   - reserved_units: total actively reserved
--   - total_available_units: gross_remaining_units - reserved_units
CREATE OR REPLACE FUNCTION public.get_user_credit_balance(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_account_id UUID;
    v_gross_remaining BIGINT := 0;
    v_total_reserved BIGINT := 0;
    v_total_available BIGINT := 0;
    v_subscription_units BIGINT := 0;
    v_purchased_units BIGINT := 0;
    v_other_units BIGINT := 0;
    v_status VARCHAR := 'ACTIVE';
BEGIN
    SELECT id, status INTO v_account_id, v_status
    FROM public.credit_accounts
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'user_id', p_user_id,
            'account_exists', false,
            'status', 'NONE',
            'gross_remaining_units', 0,
            'reserved_units', 0,
            'total_available_units', 0,
            'total_available_credits', 0,
            'buckets', jsonb_build_object(
                'subscriptionUnits', 0,
                'purchasedUnits', 0,
                'otherUnits', 0
            )
        );
    END IF;

    SELECT
        COALESCE(SUM(remaining_units), 0),
        COALESCE(SUM(reserved_units), 0),
        COALESCE(SUM(remaining_units - reserved_units), 0),
        COALESCE(SUM(CASE WHEN source_type IN ('FREE_BOOTSTRAP', 'SUBSCRIPTION_CYCLE') THEN (remaining_units - reserved_units) ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN source_type = 'CREDIT_PACK_PURCHASE' THEN (remaining_units - reserved_units) ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN source_type NOT IN ('FREE_BOOTSTRAP', 'SUBSCRIPTION_CYCLE', 'CREDIT_PACK_PURCHASE') THEN (remaining_units - reserved_units) ELSE 0 END), 0)
    INTO
        v_gross_remaining,
        v_total_reserved,
        v_total_available,
        v_subscription_units,
        v_purchased_units,
        v_other_units
    FROM public.credit_grants
    WHERE account_id = v_account_id
      AND status = 'ACTIVE'
      AND (expires_at IS NULL OR expires_at > NOW());

    RETURN jsonb_build_object(
        'user_id', p_user_id,
        'account_id', v_account_id,
        'account_exists', true,
        'status', v_status,
        'gross_remaining_units', v_gross_remaining,
        'reserved_units', v_total_reserved,
        'total_available_units', v_total_available,
        'total_available_credits', (v_total_available / 1000.0),
        'buckets', jsonb_build_object(
            'subscriptionUnits', v_subscription_units,
            'purchasedUnits', v_purchased_units,
            'otherUnits', v_other_units
        )
    );
END;
$$;

-- 10. ROW LEVEL SECURITY (RLS) FOR NEW TABLES
ALTER TABLE public.credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_reservation_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_reservation_events ENABLE ROW LEVEL SECURITY;

-- Owner SELECT-only policies
DROP POLICY IF EXISTS credit_reservations_read_own ON public.credit_reservations;
CREATE POLICY credit_reservations_read_own ON public.credit_reservations
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS credit_reservation_allocations_read_own ON public.credit_reservation_allocations;
CREATE POLICY credit_reservation_allocations_read_own ON public.credit_reservation_allocations
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS credit_reservation_events_read_own ON public.credit_reservation_events;
CREATE POLICY credit_reservation_events_read_own ON public.credit_reservation_events
    FOR SELECT USING (auth.uid() = user_id);

-- Explicitly revoke direct INSERT/UPDATE/DELETE from client roles
REVOKE INSERT, UPDATE, DELETE ON public.credit_reservations FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.credit_reservation_allocations FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.credit_reservation_events FROM PUBLIC, anon, authenticated;

-- 11. SECURITY DEFINER RPC PERMISSIONS
-- reserve_credit_units: service_role / postgres ONLY
REVOKE ALL ON FUNCTION public.reserve_credit_units(
    UUID,
    BIGINT,
    TEXT,
    VARCHAR,
    TEXT,
    TIMESTAMPTZ,
    JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_credit_units(
    UUID,
    BIGINT,
    TEXT,
    VARCHAR,
    TEXT,
    TIMESTAMPTZ,
    JSONB
) TO postgres, service_role;

-- capture_credit_reservation: service_role / postgres ONLY
REVOKE ALL ON FUNCTION public.capture_credit_reservation(
    UUID,
    UUID,
    BIGINT,
    TEXT,
    JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.capture_credit_reservation(
    UUID,
    UUID,
    BIGINT,
    TEXT,
    JSONB
) TO postgres, service_role;

-- release_credit_reservation: service_role / postgres ONLY
REVOKE ALL ON FUNCTION public.release_credit_reservation(
    UUID,
    UUID,
    BIGINT,
    TEXT,
    JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.release_credit_reservation(
    UUID,
    UUID,
    BIGINT,
    TEXT,
    JSONB
) TO postgres, service_role;

-- get_user_credit_balance: service_role / postgres ONLY
REVOKE ALL ON FUNCTION public.get_user_credit_balance(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_credit_balance(UUID) TO postgres, service_role;

-- 12. REPLACED ATOMIC RPC: grant_user_credits (Phase 2B Compatibility)
-- Phase 2B replaces grant_user_credits to:
--   1. Calculate total_available_units using SUM(GREATEST(remaining_units - reserved_units, 0))
--      in BOTH the normal grant path and already_processed idempotency retry path.
--   2. Set credit_ledger.balance_after_units to user's gross owned remaining balance
--      (SUM(remaining_units) WHERE remaining_units > 0), keeping ledger balance
--      and spendable available balance strictly decoupled.
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
    -- Serializes concurrent requests submitting the same idempotency key
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

        -- Phase 2B compatibility: subtract reserved_units from remaining_units for spendable available balance
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
        IF p_billing_cycle_start IS NULL OR p_billing_cycle_end IS NULL THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: FREE_BOOTSTRAP requires p_billing_cycle_start and p_billing_cycle_end';
        END IF;
        IF p_billing_cycle_start >= p_billing_cycle_end THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: FREE_BOOTSTRAP billing_cycle_start must be before billing_cycle_end';
        END IF;
        IF p_expires_at IS NULL OR p_expires_at <> p_billing_cycle_end THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: FREE_BOOTSTRAP requires p_expires_at equal to p_billing_cycle_end';
        END IF;

    ELSIF p_source_type = 'ADMIN_ADJUSTMENT' THEN
        IF p_original_units <= 0 THEN
            RAISE EXCEPTION 'INVALID_GRANT_SEMANTICS: ADMIN_ADJUSTMENT original units must be positive in Phase 2A';
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

    -- 6. Insert credit grant (with unique_violation race-condition handler and payload conflict validation)
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
            -- Fail closed on payload conflict in unique_violation recovery path
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

            -- Phase 2B compatibility: subtract reserved_units from remaining_units for spendable available balance
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
            RAISE;
        END IF;
    END;

    -- 7. Calculate new spendable available balance (remaining_units - reserved_units)
    SELECT COALESCE(SUM(GREATEST(remaining_units - reserved_units, 0)), 0)
    INTO v_total_available
    FROM public.credit_grants
    WHERE account_id = v_account_id
      AND status = 'ACTIVE'
      AND (expires_at IS NULL OR expires_at > NOW());

    -- 8. Calculate gross owned remaining balance for financial ledger entry
    -- (Excludes reservation holds; clock-time expiration alone does not change ledger balance)
    SELECT COALESCE(SUM(remaining_units), 0)
    INTO v_ledger_balance_after
    FROM public.credit_grants
    WHERE account_id = v_account_id
      AND remaining_units > 0;

    -- 9. Determine ledger entry type (DB-controlled mapping)
    IF p_source_type = 'ADMIN_ADJUSTMENT' THEN
        v_entry_type := 'ADJUSTMENT';
    ELSE
        v_entry_type := 'GRANT';
    END IF;

    -- 10. Insert immutable credit ledger entry
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
        metadata,
        created_at
    ) VALUES (
        v_account_id,
        p_user_id,
        v_grant_id,
        v_entry_type,
        p_original_units,
        v_ledger_balance_after,
        COALESCE(p_reference_type, p_source_type),
        COALESCE(p_reference_id, v_grant_id::text),
        p_idempotency_key,
        COALESCE(p_description, 'Credit granted: ' || p_source_type),
        p_metadata,
        NOW()
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

-- grant_user_credits permissions: service_role / postgres ONLY
REVOKE ALL ON FUNCTION public.grant_user_credits(
    UUID,
    VARCHAR,
    BIGINT,
    TEXT,
    TIMESTAMPTZ,
    UUID,
    UUID,
    UUID,
    TIMESTAMPTZ,
    TIMESTAMPTZ,
    VARCHAR,
    TEXT,
    TEXT,
    JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.grant_user_credits(
    UUID,
    VARCHAR,
    BIGINT,
    TEXT,
    TIMESTAMPTZ,
    UUID,
    UUID,
    UUID,
    TIMESTAMPTZ,
    TIMESTAMPTZ,
    VARCHAR,
    TEXT,
    TEXT,
    JSONB
) TO postgres, service_role;

-- 13. CANONICAL LEDGER BALANCE DOCUMENTATION
COMMENT ON COLUMN public.credit_ledger.balance_after_units IS 'Financial ledger running owned-credit balance after this permanent mutation. Reservation holds are excluded from this field. Clock-time expiration alone does not change this balance; explicit expiration mutations do.';

