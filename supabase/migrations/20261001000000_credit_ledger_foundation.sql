-- ==============================================================================
-- MIGRATION: 20261001000000_credit_ledger_foundation.sql
-- DESCRIPTION: Phase 2A / 2A.1 — Financial Credit Foundation (Hardened)
--   1. credit_accounts: Isolated persistent credit account per user.
--   2. credit_grants: Financial credit grant buckets with cycle binding and expiration.
--   3. credit_ledger: Append-only immutable financial ledger.
--   4. Immutability triggers: Strictly reject UPDATE and DELETE on credit_ledger.
--   5. Identity consistency: Declarative composite FKs & trigger preventing user/account/grant mismatch.
--   6. Atomic RPC: grant_user_credits with advisory locking, idempotency, and semantic validation.
--   7. Balance computation & adjustment foundation.
--   8. RLS security & least-privilege execution: Owner SELECT-only; zero direct client mutations.
--
-- FINANCIAL INVARIANTS:
--   - Integer scaled units: 1 credit = 1000 credit_units (BIGINT). NO FLOAT.
--   - Invariant: 0 <= remaining_units <= original_units.
--   - Subscription credits: expires_at = billing_cycle_end (monthly anniversary model).
--   - Purchased credit packs: expires_at IS NULL (non-expiring).
--   - Immutable ledger: UPDATE/DELETE raises CREDIT_LEDGER_IMMUTABLE exception.
--   - Preserved history: ON DELETE RESTRICT protects all financial records from accidental cascading destruction.
--   - Concurrent idempotency: Transaction-scoped advisory lock prevents duplicate races.
-- ==============================================================================

-- 1. CREDIT ACCOUNTS TABLE (One per user)
CREATE TABLE IF NOT EXISTS public.credit_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_credit_accounts_id_user UNIQUE (id, user_id),
    CONSTRAINT chk_credit_accounts_status CHECK (
        status IN ('ACTIVE', 'FROZEN', 'CLOSED')
    )
);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_user
    ON public.credit_accounts(user_id);

-- 2. CREDIT GRANTS TABLE (Credit grant buckets)
CREATE TABLE IF NOT EXISTS public.credit_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    source_type VARCHAR(50) NOT NULL,
    source_product_id UUID NULL REFERENCES public.billing_products(id) ON DELETE RESTRICT,
    pricing_version_id UUID NULL REFERENCES public.pricing_versions(id) ON DELETE RESTRICT,
    subscription_id UUID NULL,
    billing_cycle_start TIMESTAMPTZ NULL,
    billing_cycle_end TIMESTAMPTZ NULL,
    original_units BIGINT NOT NULL,
    remaining_units BIGINT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    idempotency_key TEXT NOT NULL UNIQUE,
    source_reference_type VARCHAR(100) NULL,
    source_reference_id TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_credit_grants_account_user
        FOREIGN KEY (account_id, user_id)
        REFERENCES public.credit_accounts(id, user_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_credit_grants_id_account_user
        UNIQUE (id, account_id, user_id),
    CONSTRAINT chk_credit_grants_source_type CHECK (
        source_type IN (
            'FREE_BOOTSTRAP',
            'SUBSCRIPTION_CYCLE',
            'CREDIT_PACK_PURCHASE',
            'PROMOTION',
            'ADMIN_ADJUSTMENT',
            'MIGRATION'
        )
    ),
    CONSTRAINT chk_credit_grants_original_units CHECK (
        original_units > 0
    ),
    CONSTRAINT chk_credit_grants_remaining_units CHECK (
        remaining_units >= 0 AND remaining_units <= original_units
    ),
    CONSTRAINT chk_credit_grants_status CHECK (
        status IN ('ACTIVE', 'DEPLETED', 'EXPIRED', 'REVOKED')
    ),
    CONSTRAINT chk_credit_grants_subscription_semantics CHECK (
        source_type <> 'SUBSCRIPTION_CYCLE' OR (
            source_product_id IS NOT NULL AND
            pricing_version_id IS NOT NULL AND
            billing_cycle_start IS NOT NULL AND
            billing_cycle_end IS NOT NULL AND
            billing_cycle_start < billing_cycle_end AND
            expires_at IS NOT NULL AND
            expires_at = billing_cycle_end
        )
    ),
    CONSTRAINT chk_credit_grants_pack_semantics CHECK (
        source_type <> 'CREDIT_PACK_PURCHASE' OR (
            source_product_id IS NOT NULL AND
            pricing_version_id IS NOT NULL AND
            expires_at IS NULL AND
            billing_cycle_start IS NULL AND
            billing_cycle_end IS NULL
        )
    ),
    CONSTRAINT chk_credit_grants_free_bootstrap_semantics CHECK (
        source_type <> 'FREE_BOOTSTRAP' OR (
            billing_cycle_start IS NOT NULL AND
            billing_cycle_end IS NOT NULL AND
            billing_cycle_start < billing_cycle_end AND
            expires_at IS NOT NULL AND
            expires_at = billing_cycle_end
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_credit_grants_account
    ON public.credit_grants(account_id);

CREATE INDEX IF NOT EXISTS idx_credit_grants_user_status
    ON public.credit_grants(user_id, status);

CREATE INDEX IF NOT EXISTS idx_credit_grants_consumption_priority
    ON public.credit_grants(user_id, status, expires_at ASC NULLS LAST, granted_at ASC);

-- 3. CREDIT LEDGER TABLE (Append-only immutable financial audit trail)
CREATE TABLE IF NOT EXISTS public.credit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    grant_id UUID NULL,
    entry_type VARCHAR(50) NOT NULL,
    delta_units BIGINT NOT NULL,
    balance_after_units BIGINT NULL,
    reference_type VARCHAR(100) NULL,
    reference_id TEXT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    description TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_credit_ledger_account_user
        FOREIGN KEY (account_id, user_id)
        REFERENCES public.credit_accounts(id, user_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_credit_ledger_grant_account_user
        FOREIGN KEY (grant_id, account_id, user_id)
        REFERENCES public.credit_grants(id, account_id, user_id)
        ON DELETE RESTRICT,
    CONSTRAINT chk_credit_ledger_entry_type CHECK (
        entry_type IN ('GRANT', 'ADJUSTMENT', 'EXPIRATION')
    ),
    CONSTRAINT chk_credit_ledger_delta_nonzero CHECK (
        delta_units <> 0
    ),
    CONSTRAINT chk_credit_ledger_grant_delta CHECK (
        entry_type <> 'GRANT' OR delta_units > 0
    ),
    CONSTRAINT chk_credit_ledger_expiration_delta CHECK (
        entry_type <> 'EXPIRATION' OR delta_units < 0
    )
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_account
    ON public.credit_ledger(account_id);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created
    ON public.credit_ledger(user_id, created_at DESC);

-- 3.1 IDENTITY CONSISTENCY TRIGGER ON credit_ledger
-- Ensures that credit_ledger account_id and user_id strictly match grant_id's owner
CREATE OR REPLACE FUNCTION public.fn_guard_credit_ledger_identity()
RETURNS TRIGGER AS $$
DECLARE
    v_grant_user_id UUID;
    v_grant_account_id UUID;
BEGIN
    IF NEW.grant_id IS NOT NULL THEN
        SELECT user_id, account_id INTO v_grant_user_id, v_grant_account_id
        FROM public.credit_grants
        WHERE id = NEW.grant_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'GRANT_NOT_FOUND: grant_id % does not exist', NEW.grant_id;
        END IF;

        IF v_grant_user_id <> NEW.user_id OR v_grant_account_id <> NEW.account_id THEN
            RAISE EXCEPTION 'IDENTITY_MISMATCH: credit_ledger (user_id %, account_id %) does not match credit_grant (user_id %, account_id %)',
                NEW.user_id, NEW.account_id, v_grant_user_id, v_grant_account_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_credit_ledger_identity ON public.credit_ledger;
CREATE TRIGGER trg_guard_credit_ledger_identity
    BEFORE INSERT ON public.credit_ledger
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_guard_credit_ledger_identity();

-- 4. APPEND-ONLY IMMUTABILITY TRIGGER ON credit_ledger
CREATE OR REPLACE FUNCTION public.fn_guard_credit_ledger_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CREDIT_LEDGER_IMMUTABLE: Records in credit_ledger cannot be updated or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_credit_ledger_immutability ON public.credit_ledger;
CREATE TRIGGER trg_guard_credit_ledger_immutability
    BEFORE UPDATE OR DELETE ON public.credit_ledger
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_guard_credit_ledger_immutability();

-- 5. ATOMIC RPC: grant_user_credits
-- Transactionally locks account, creates credit_grant and credit_ledger entry.
-- Guarantees all-or-nothing execution, strict semantic validation, and duplicate idempotency safety.
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

        SELECT COALESCE(SUM(remaining_units), 0)
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

            SELECT COALESCE(SUM(remaining_units), 0)
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

    -- 7. Calculate new available balance
    SELECT COALESCE(SUM(remaining_units), 0)
    INTO v_total_available
    FROM public.credit_grants
    WHERE account_id = v_account_id
      AND status = 'ACTIVE'
      AND (expires_at IS NULL OR expires_at > NOW());

    -- 8. Determine ledger entry type (DB-controlled mapping)
    IF p_source_type = 'ADMIN_ADJUSTMENT' THEN
        v_entry_type := 'ADJUSTMENT';
    ELSE
        v_entry_type := 'GRANT';
    END IF;

    -- 9. Insert immutable credit ledger entry
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
        v_total_available,
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

-- 6. RPC: get_user_credit_balance
-- Read-only balance calculator returning integer units and credit decimal representation.
-- Strictly accessible only by service_role and postgres; authenticated clients read via RLS.
CREATE OR REPLACE FUNCTION public.get_user_credit_balance(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_account_id UUID;
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
        COALESCE(SUM(CASE WHEN source_type IN ('FREE_BOOTSTRAP', 'SUBSCRIPTION_CYCLE') THEN remaining_units ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN source_type = 'CREDIT_PACK_PURCHASE' THEN remaining_units ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN source_type NOT IN ('FREE_BOOTSTRAP', 'SUBSCRIPTION_CYCLE', 'CREDIT_PACK_PURCHASE') THEN remaining_units ELSE 0 END), 0)
    INTO
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

-- 7. ROW LEVEL SECURITY (RLS)
ALTER TABLE public.credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

-- Owner SELECT-only policies
DROP POLICY IF EXISTS credit_accounts_read_own ON public.credit_accounts;
CREATE POLICY credit_accounts_read_own ON public.credit_accounts
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS credit_grants_read_own ON public.credit_grants;
CREATE POLICY credit_grants_read_own ON public.credit_grants
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS credit_ledger_read_own ON public.credit_ledger;
CREATE POLICY credit_ledger_read_own ON public.credit_ledger
    FOR SELECT USING (auth.uid() = user_id);

-- Explicitly revoke direct INSERT/UPDATE/DELETE from client roles
REVOKE INSERT, UPDATE, DELETE ON public.credit_accounts FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.credit_grants FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.credit_ledger FROM PUBLIC, anon, authenticated;

-- Function execution permissions (SECURITY HARDENED & EXPLICIT SIGNATURES)
-- grant_user_credits: service_role / postgres ONLY
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

-- get_user_credit_balance: service_role / postgres ONLY
-- Authenticated users read balance via REST route with authMiddleware + client RLS
REVOKE ALL ON FUNCTION public.get_user_credit_balance(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_credit_balance(UUID) TO postgres, service_role;
