-- ==========================================================
-- PHASE 4.2 MIGRATION: TRANSACTION & QUOTA SAFETY
-- Atomic Document Processing Confirmation RPC & Partial Unique Index
-- ==========================================================

-- 1. PARTIAL UNIQUE INDEX: Prevent multiple ACTIVE jobs for the same document
-- Terminal statuses ('READY', 'REVIEW_REQUIRED', 'FAILED') are excluded so retry/job history is preserved.
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_active_doc
ON public.processing_jobs(document_id)
WHERE status IN ('QUEUED', 'PROCESSING', 'VALIDATING', 'UPLOADING', 'PARSING', 'VALIDATING_RESULT');

-- 2. ATOMIC PROCESSING CONFIRMATION RPC FUNCTION
-- Executes: Lock Document -> Verify Ownership/Status/OutputType -> Lock Quota Row -> Check Quota ->
--           Create Processing Job -> Increment Quota -> Update Document Status to QUEUED -> Commit.
-- All operations run in a SINGLE PostgreSQL transaction. Any failure triggers automatic ROLLBACK.

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
DECLARE
    v_user_id UUID;
    v_output_type VARCHAR;
    v_doc public.documents%ROWTYPE;
    v_profile public.profiles%ROWTYPE;
    v_plan public.plans%ROWTYPE;
    v_existing_job public.processing_jobs%ROWTYPE;
    v_new_job public.processing_jobs%ROWTYPE;
    v_updated_doc public.documents%ROWTYPE;
    v_total_quota INT := 3;
    v_used_quota INT := 0;
    v_plan_id VARCHAR := 'FREE';
    v_plan_name VARCHAR := 'Gói Miễn Phí (Free)';
    v_job_id UUID;
BEGIN
    -- Step 1: User Identity Validation
    -- This function is executed only by service_role from verified backend.
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'MISSING_USER_ID';
    END IF;
    v_user_id := p_user_id;

    -- Step 2: Validate Output Type (Reject WORD upfront before any quota or job mutation)
    v_output_type := UPPER(COALESCE(p_output_type, 'EXCEL'));
    IF v_output_type = 'WORD' THEN
        RAISE EXCEPTION 'UNSUPPORTED_OUTPUT_TYPE';
    END IF;
    IF v_output_type <> 'EXCEL' THEN
        RAISE EXCEPTION 'UNSUPPORTED_OUTPUT_TYPE';
    END IF;

    -- Step 3: Lock and Fetch Document Row
    SELECT * INTO v_doc
    FROM public.documents
    WHERE id = p_document_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_FOUND';
    END IF;

    -- Step 4: Verify Document Ownership
    IF v_doc.user_id <> v_user_id THEN
        RAISE EXCEPTION 'DOCUMENT_ACCESS_DENIED';
    END IF;

    -- Step 5: Check Idempotency for Already-Processing or Completed Documents
    IF v_doc.status IN ('QUEUED', 'PROCESSING') THEN
        -- Fetch the latest ACTIVE job only (using verified active lifecycle statuses)
        SELECT * INTO v_existing_job
        FROM public.processing_jobs
        WHERE document_id = p_document_id
          AND status IN ('QUEUED', 'PROCESSING', 'VALIDATING', 'UPLOADING', 'PARSING', 'VALIDATING_RESULT')
        ORDER BY created_at DESC
        LIMIT 1;

        -- If document is QUEUED/PROCESSING but no active job exists, treat as inconsistent state requiring recovery
        IF v_existing_job.id IS NULL THEN
            RAISE EXCEPTION 'ORPHANED_PROCESSING_STATE: Document is % but no active job exists', v_doc.status;
        END IF;

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

    -- Document must be in WAITING_CONFIRMATION (or legacy UPLOADED) state
    IF v_doc.status NOT IN ('WAITING_CONFIRMATION', 'UPLOADED') THEN
        RAISE EXCEPTION 'INVALID_DOCUMENT_STATE: %', v_doc.status;
    END IF;

    -- Step 6: Lock User Quota Row in Profiles Table (Prevents multi-document quota race)
    SELECT * INTO v_profile
    FROM public.profiles
    WHERE id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROFILE_NOT_FOUND';
    END IF;

    -- Step 7: Resolve User Plan and Evaluate Quota Limit
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

    -- Step 8: Create Processing Job in QUEUED Status
    v_job_id := gen_random_uuid();
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
        updated_at
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
        NOW()
    )
    RETURNING * INTO v_new_job;

    -- Step 9: Increment Quota Exactly Once
    UPDATE public.profiles
    SET used_documents = v_used_quota + 1,
        updated_at = NOW()
    WHERE id = v_user_id;

    -- Step 10: Transition Document to QUEUED Status
    UPDATE public.documents
    SET status = 'QUEUED',
        output_type = v_output_type,
        updated_at = NOW()
    WHERE id = p_document_id
    RETURNING * INTO v_updated_doc;

    -- Step 11: Return Complete Transaction Result
    RETURN jsonb_build_object(
        'success', true,
        'already_processing', false,
        'already_completed', false,
        'message', 'Đã xác nhận và bắt đầu đưa tài liệu vào hàng đợi xử lý OCR.',
        'document', row_to_json(v_updated_doc),
        'job', row_to_json(v_new_job),
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

-- Strict Security Permissions:
-- REVOKE from PUBLIC, anon, and authenticated so browsers cannot call this RPC directly.
-- GRANT EXECUTE exclusively to service_role (used by Express backend after JWT verification).
REVOKE ALL ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_document_processing(UUID, UUID, VARCHAR) TO service_role;
