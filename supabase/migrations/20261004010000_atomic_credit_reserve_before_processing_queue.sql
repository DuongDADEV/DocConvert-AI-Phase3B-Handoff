-- ==============================================================================
-- MIGRATION: 20261004010000_atomic_credit_reserve_before_processing_queue.sql
-- DESCRIPTION: Phase 3B / 3B.1 / 3B.2 — Atomic Credit Reserve Before Processing Queue
--
-- CORE TRANSACTIONAL INVARIANTS:
--   NO SUCCESSFUL CREDIT RESERVATION
--   → NO PROCESSING JOB
--   → NO QUEUED DOCUMENT
--   → NO OCR / AZURE CALL
--
-- 1. processing_jobs: Extended with pinned pricing snapshot and reservation link:
--      - pricing_version VARCHAR(50) NULL (preserves historical jobs)
--      - estimated_billable_units BIGINT NULL (preserves historical jobs)
--      - quote_snapshot JSONB NULL (preserves historical jobs)
--      - reservation_id UUID REFERENCES credit_reservations(id) NULL
-- 2. credit_reservations: Reference linkage:
--      - reference_type = 'PROCESSING_JOB'
--      - reference_id = processing_jobs.id::text
-- 3. Atomic confirm_document_processing RPC:
--      One single PostgreSQL transaction executes:
--        Document Lock FOR UPDATE -> Ownership Verification -> Status Check (WAITING_CONFIRMATION only) ->
--        Idempotency Check -> Quota Lock FOR UPDATE -> Quota Check ->
--        Job UUID Generation -> Mandatory reserve_credit_units() ->
--        Processing Job Creation -> Legacy Document Quota Increment ->
--        Document Transition to QUEUED -> Commit.
--      Any failure (e.g. INSUFFICIENT_CREDIT, FROZEN/CLOSED account, invalid quote, quote amount mismatch)
--      raises an exception that automatically ROLLS BACK all effects, leaving:
--        0 processing jobs, document in WAITING_CONFIRMATION, 0 reserved credits,
--        0 quota increments, and 0 queue visibility to OCR workers.
-- ==============================================================================

-- 1. EXTEND processing_jobs TABLE (Safe nullable columns for historical job compatibility)
ALTER TABLE public.processing_jobs
    ADD COLUMN IF NOT EXISTS pricing_version VARCHAR(50) NULL,
    ADD COLUMN IF NOT EXISTS estimated_billable_units BIGINT NULL,
    ADD COLUMN IF NOT EXISTS quote_snapshot JSONB NULL,
    ADD COLUMN IF NOT EXISTS reservation_id UUID NULL;

-- Add Foreign Key to credit_reservations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_processing_jobs_reservation'
    ) THEN
        ALTER TABLE public.processing_jobs
            ADD CONSTRAINT fk_processing_jobs_reservation
            FOREIGN KEY (reservation_id)
            REFERENCES public.credit_reservations(id)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- Indexes for fast reservation linkage lookup
CREATE INDEX IF NOT EXISTS idx_processing_jobs_reservation_id
    ON public.processing_jobs(reservation_id);

CREATE INDEX IF NOT EXISTS idx_credit_reservations_processing_job_ref
    ON public.credit_reservations(reference_type, reference_id)
    WHERE reference_type = 'PROCESSING_JOB';

-- 2. UPGRADED ATOMIC CONFIRMATION RPC WITH CREDIT RESERVATION
CREATE OR REPLACE FUNCTION public.confirm_document_processing(
    p_document_id UUID,
    p_user_id UUID,
    p_output_type VARCHAR DEFAULT 'EXCEL',
    p_estimated_units BIGINT DEFAULT NULL,
    p_pricing_version VARCHAR DEFAULT 'processing-pricing-v1',
    p_quote_snapshot JSONB DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL,
    p_reservation_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_output_type VARCHAR;
    v_doc public.documents%ROWTYPE;
    v_profile public.profiles%ROWTYPE;
    v_plan public.plans%ROWTYPE;
    v_existing_job public.processing_jobs%ROWTYPE;
    v_existing_res public.credit_reservations%ROWTYPE;
    v_new_job public.processing_jobs%ROWTYPE;
    v_updated_doc public.documents%ROWTYPE;
    v_total_quota INT := 3;
    v_used_quota INT := 0;
    v_plan_id VARCHAR := 'FREE';
    v_plan_name VARCHAR := 'Gói Miễn Phí (Free)';
    v_job_id UUID;
    v_res_idempotency_key TEXT;
    v_res_metadata JSONB;
    v_reservation_result JSONB;
    v_reservation_id UUID := NULL;
    v_snapshot_est_units_text TEXT;
    v_snapshot_billable_units_text TEXT;
    v_snapshot_est_units BIGINT := NULL;
    v_snapshot_billable_units BIGINT := NULL;
    v_snapshot_version TEXT;
    v_snapshot_output_type TEXT;
BEGIN
    -- Step 1: User Identity Validation
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'MISSING_USER_ID';
    END IF;
    v_user_id := p_user_id;

    -- Step 2: Validate Output Type (EXCEL only for current MVP)
    v_output_type := UPPER(COALESCE(p_output_type, 'EXCEL'));
    IF v_output_type NOT IN ('EXCEL') THEN
        RAISE EXCEPTION 'UNSUPPORTED_OUTPUT_TYPE: % is not supported. Current supported output types: EXCEL', v_output_type;
    END IF;

    -- Step 3: Validate Estimated Units (Must be positive safe integer for chargeable processing)
    IF p_estimated_units IS NULL OR p_estimated_units <= 0 THEN
        RAISE EXCEPTION 'INVALID_PROCESSING_ESTIMATE: p_estimated_units must be greater than 0, got %', p_estimated_units;
    END IF;

    -- Step 3b: Validate Pricing Version (Must strictly match canonical processing pricing version)
    IF p_pricing_version IS NULL OR p_pricing_version <> 'processing-pricing-v1' THEN
        RAISE EXCEPTION 'INVALID_PROCESSING_PRICING_VERSION: Version must be "processing-pricing-v1", got %', p_pricing_version;
    END IF;

    -- Step 3c: Validate Quote Snapshot Structure & Internal Consistency (Phase 3B.2 & Phase 3B.2.1)
    IF p_quote_snapshot IS NULL OR jsonb_typeof(p_quote_snapshot) <> 'object' OR p_quote_snapshot = '{}'::jsonb THEN
        RAISE EXCEPTION 'INVALID_QUOTE_SNAPSHOT: quote snapshot must be a non-empty JSON object';
    END IF;

    -- Extract snapshot estimated amounts (supports estimatedUnits and/or estimatedBillableUnits)
    v_snapshot_est_units_text := p_quote_snapshot->>'estimatedUnits';
    v_snapshot_billable_units_text := p_quote_snapshot->>'estimatedBillableUnits';

    IF v_snapshot_est_units_text IS NULL AND v_snapshot_billable_units_text IS NULL THEN
        RAISE EXCEPTION 'INVALID_QUOTE_SNAPSHOT: snapshot estimated amount is missing';
    END IF;

    IF v_snapshot_est_units_text IS NOT NULL THEN
        IF v_snapshot_est_units_text !~ '^[0-9]+$' THEN
            RAISE EXCEPTION 'INVALID_QUOTE_SNAPSHOT: snapshot estimatedUnits is non-numeric';
        END IF;
        v_snapshot_est_units := v_snapshot_est_units_text::BIGINT;
        IF v_snapshot_est_units <= 0 THEN
            RAISE EXCEPTION 'INVALID_QUOTE_SNAPSHOT: snapshot estimatedUnits must be positive, got %', v_snapshot_est_units;
        END IF;
        IF v_snapshot_est_units <> p_estimated_units THEN
            RAISE EXCEPTION 'QUOTE_AMOUNT_MISMATCH: snapshot estimatedUnits (%) does not match p_estimated_units (%)', v_snapshot_est_units, p_estimated_units;
        END IF;
    END IF;

    IF v_snapshot_billable_units_text IS NOT NULL THEN
        IF v_snapshot_billable_units_text !~ '^[0-9]+$' THEN
            RAISE EXCEPTION 'INVALID_QUOTE_SNAPSHOT: snapshot estimatedBillableUnits is non-numeric';
        END IF;
        v_snapshot_billable_units := v_snapshot_billable_units_text::BIGINT;
        IF v_snapshot_billable_units <= 0 THEN
            RAISE EXCEPTION 'INVALID_QUOTE_SNAPSHOT: snapshot estimatedBillableUnits must be positive, got %', v_snapshot_billable_units;
        END IF;
        IF v_snapshot_billable_units <> p_estimated_units THEN
            RAISE EXCEPTION 'QUOTE_AMOUNT_MISMATCH: snapshot estimatedBillableUnits (%) does not match p_estimated_units (%)', v_snapshot_billable_units, p_estimated_units;
        END IF;
    END IF;

    -- Dual-field consistency: If both fields are present, they must be strictly identical
    IF v_snapshot_est_units IS NOT NULL AND v_snapshot_billable_units IS NOT NULL THEN
        IF v_snapshot_est_units <> v_snapshot_billable_units THEN
            RAISE EXCEPTION 'QUOTE_ESTIMATE_FIELDS_MISMATCH: snapshot estimatedUnits (%) does not match estimatedBillableUnits (%)', v_snapshot_est_units, v_snapshot_billable_units;
        END IF;
    END IF;

    -- Validate snapshot pricing version consistency if present (Section VI)
    v_snapshot_version := COALESCE(p_quote_snapshot->>'processingPricingVersion', p_quote_snapshot->>'pricingVersion');
    IF v_snapshot_version IS NOT NULL AND v_snapshot_version <> p_pricing_version THEN
        RAISE EXCEPTION 'QUOTE_VERSION_MISMATCH: snapshot pricing version (%) does not match p_pricing_version (%)', v_snapshot_version, p_pricing_version;
    END IF;

    -- Validate snapshot output type consistency if present (Section VII)
    v_snapshot_output_type := p_quote_snapshot->>'outputType';
    IF v_snapshot_output_type IS NOT NULL AND UPPER(v_snapshot_output_type) <> v_output_type THEN
        RAISE EXCEPTION 'QUOTE_OUTPUT_TYPE_MISMATCH: snapshot outputType (%) does not match p_output_type (%)', v_snapshot_output_type, v_output_type;
    END IF;

    -- Step 4: Lock and Fetch Document Row (Prevents race conditions)
    SELECT * INTO v_doc
    FROM public.documents
    WHERE id = p_document_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_FOUND';
    END IF;

    -- Step 5: Verify Document Ownership
    IF v_doc.user_id <> v_user_id THEN
        RAISE EXCEPTION 'DOCUMENT_ACCESS_DENIED';
    END IF;

    -- Step 6: Idempotency Check for In-Flight or Completed Documents
    IF v_doc.status IN ('QUEUED', 'PROCESSING') THEN
        -- Fetch the latest active job
        SELECT * INTO v_existing_job
        FROM public.processing_jobs
        WHERE document_id = p_document_id
          AND status IN ('QUEUED', 'PROCESSING', 'VALIDATING', 'UPLOADING', 'PARSING', 'VALIDATING_RESULT')
        ORDER BY created_at DESC
        LIMIT 1;

        IF v_existing_job.id IS NULL THEN
            RAISE EXCEPTION 'ORPHANED_PROCESSING_STATE: Document is % but no active job exists', v_doc.status;
        END IF;

        -- Fetch existing reservation context if linked (preserves historical compatibility if NULL)
        SELECT * INTO v_existing_res
        FROM public.credit_reservations
        WHERE reference_type = 'PROCESSING_JOB'
          AND reference_id = v_existing_job.id::text;

        SELECT COALESCE(p.used_documents, 0), COALESCE(pl.document_quota, 3), COALESCE(pl.id, 'FREE'), COALESCE(pl.name, 'Gói Miễn Phí (Free)')
        INTO v_used_quota, v_total_quota, v_plan_id, v_plan_name
        FROM public.profiles p
        LEFT JOIN public.plans pl ON pl.id = p.current_plan_id
        WHERE p.id = v_user_id;

        RETURN jsonb_build_object(
            'success', true,
            'already_processing', true,
            'already_completed', false,
            'message', 'Tài liệu đã nằm trong hàng đợi xử lý.',
            'document', row_to_json(v_doc),
            'job', row_to_json(v_existing_job),
            'reservation', CASE WHEN v_existing_res.id IS NOT NULL THEN row_to_json(v_existing_res) ELSE NULL END,
            'quota', jsonb_build_object(
                'used', v_used_quota,
                'total', v_total_quota,
                'remaining', GREATEST(0, v_total_quota - v_used_quota),
                'planId', v_plan_id,
                'planName', v_plan_name
            )
        );
    END IF;

    IF v_doc.status IN ('READY', 'REVIEW_REQUIRED') THEN
        SELECT * INTO v_existing_job
        FROM public.processing_jobs
        WHERE document_id = p_document_id
          AND status IN ('READY', 'REVIEW_REQUIRED')
        ORDER BY created_at DESC
        LIMIT 1;

        SELECT COALESCE(p.used_documents, 0), COALESCE(pl.document_quota, 3), COALESCE(pl.id, 'FREE'), COALESCE(pl.name, 'Gói Miễn Phí (Free)')
        INTO v_used_quota, v_total_quota, v_plan_id, v_plan_name
        FROM public.profiles p
        LEFT JOIN public.plans pl ON pl.id = p.current_plan_id
        WHERE p.id = v_user_id;

        RETURN jsonb_build_object(
            'success', true,
            'already_processing', false,
            'already_completed', true,
            'message', 'Tài liệu đã được xử lý hoàn tất.',
            'document', row_to_json(v_doc),
            'job', CASE WHEN v_existing_job.id IS NOT NULL THEN row_to_json(v_existing_job) ELSE NULL END,
            'quota', jsonb_build_object(
                'used', v_used_quota,
                'total', v_total_quota,
                'remaining', GREATEST(0, v_total_quota - v_used_quota),
                'planId', v_plan_id,
                'planName', v_plan_name
            )
        );
    END IF;

    -- Document must be strictly in WAITING_CONFIRMATION state (UPLOADED is strictly rejected)
    IF v_doc.status <> 'WAITING_CONFIRMATION' THEN
        RAISE EXCEPTION 'INVALID_DOCUMENT_STATE: Document status must be WAITING_CONFIRMATION, got %', v_doc.status;
    END IF;

    -- Step 7: Lock User Quota Row in Profiles Table
    SELECT * INTO v_profile
    FROM public.profiles
    WHERE id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROFILE_NOT_FOUND';
    END IF;

    -- Step 8: Resolve User Plan & Legacy Quota Limit
    SELECT * INTO v_plan
    FROM public.plans
    WHERE id = v_profile.current_plan_id;

    IF FOUND THEN
        v_total_quota := v_plan.document_quota;
        v_plan_id := v_plan.id;
        v_plan_name := v_plan.name;
    ELSE
        v_total_quota := 3;
        v_plan_id := 'FREE';
        v_plan_name := 'Gói Miễn Phí (Free)';
    END IF;

    v_used_quota := COALESCE(v_profile.used_documents, 0);

    IF v_used_quota >= v_total_quota THEN
        RAISE EXCEPTION 'INSUFFICIENT_QUOTA';
    END IF;

    -- Step 9: Generate Canonical Job UUID before reservation
    v_job_id := gen_random_uuid();

    -- Step 10: ATOMIC CREDIT RESERVATION (Strictly mandatory for all new processing confirmations)
    -- Hard financial invariant: Must succeed inside this transaction.
    -- If insufficient balance, frozen, or closed account, reserve_credit_units raises exception,
    -- causing automatic all-or-nothing PostgreSQL transaction ROLLBACK.
    v_res_idempotency_key := COALESCE(p_idempotency_key, 'proc-job:' || v_job_id::text);
    v_res_metadata := COALESCE(p_reservation_metadata, '{}'::jsonb) || jsonb_build_object(
        'document_id', p_document_id,
        'job_id', v_job_id,
        'processing_pricing_version', p_pricing_version,
        'estimated_billable_units', p_estimated_units,
        'output_type', v_output_type,
        'quote_snapshot', p_quote_snapshot
    );

    v_reservation_result := public.reserve_credit_units(
        p_user_id := v_user_id,
        p_requested_units := p_estimated_units,
        p_idempotency_key := v_res_idempotency_key,
        p_reference_type := 'PROCESSING_JOB',
        p_reference_id := v_job_id::text,
        p_reservation_expires_at := NULL,
        p_metadata := v_res_metadata
    );

    v_reservation_id := (v_reservation_result->>'reservation_id')::UUID;
    IF v_reservation_id IS NULL THEN
        RAISE EXCEPTION 'RESERVATION_FAILED: No reservation_id returned from reserve_credit_units';
    END IF;

    -- Step 11: Create Processing Job in QUEUED Status with Pinned Pricing Snapshot
    INSERT INTO public.processing_jobs (
        id,
        document_id,
        user_id,
        status,
        current_step,
        progress,
        attempt_count,
        error_code,
        error_message,
        started_at,
        completed_at,
        created_at,
        updated_at,
        pricing_version,
        estimated_billable_units,
        quote_snapshot,
        reservation_id
    ) VALUES (
        v_job_id,
        p_document_id,
        v_user_id,
        'QUEUED',
        'Đang xếp hàng chờ xử lý Azure AI Document Intelligence',
        10,
        1,
        NULL,
        NULL,
        NOW(),
        NULL,
        NOW(),
        NOW(),
        p_pricing_version,
        p_estimated_units,
        p_quote_snapshot,
        v_reservation_id
    )
    RETURNING * INTO v_new_job;

    -- Step 12: Increment Legacy Document Quota Exactly Once
    UPDATE public.profiles
    SET used_documents = v_used_quota + 1,
        updated_at = NOW()
    WHERE id = v_user_id;

    -- Step 13: Transition Document to QUEUED Status
    UPDATE public.documents
    SET status = 'QUEUED',
        output_type = v_output_type,
        updated_at = NOW()
    WHERE id = p_document_id
    RETURNING * INTO v_updated_doc;

    -- Step 14: Return Complete Atomic Transaction Result
    RETURN jsonb_build_object(
        'success', true,
        'already_processing', false,
        'already_completed', false,
        'message', 'Đã xác nhận và bắt đầu đưa tài liệu vào hàng đợi xử lý OCR.',
        'document', row_to_json(v_updated_doc),
        'job', row_to_json(v_new_job),
        'reservation', v_reservation_result,
        'quota', jsonb_build_object(
            'used', v_used_quota + 1,
            'total', v_total_quota,
            'remaining', GREATEST(0, v_total_quota - (v_used_quota + 1)),
            'planId', v_plan_id,
            'planName', v_plan_name
        )
    );
END;
$$;

-- Strict Security Permissions for 8-arg canonical RPC:
REVOKE ALL ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR, BIGINT, VARCHAR, JSONB, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR, BIGINT, VARCHAR, JSONB, TEXT, JSONB) TO service_role, postgres;

-- 3. HARD-FAIL LEGACY 3-ARGUMENT OVERLOAD
-- Deprecated: Prevents any accidental zero-unit or quote-less confirmation.
CREATE OR REPLACE FUNCTION public.confirm_document_processing(
    p_document_id UUID,
    p_user_id UUID,
    p_output_type VARCHAR DEFAULT 'EXCEL'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'PROCESSING_CONFIRM_SIGNATURE_DEPRECATED: confirm_document_processing requires estimated credit units and pricing snapshot';
END;
$$;

-- Strict Security Permissions for 3-arg legacy overload:
REVOKE ALL ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR) TO service_role, postgres;
