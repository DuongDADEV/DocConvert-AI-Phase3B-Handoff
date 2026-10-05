-- ============================================================================
-- DocConvert AI — Phase 3B Post-Migration Manual Live Verification Pack
-- File: scripts/phase3b_manual_live_verification.sql
-- Mode: STRICTLY READ-ONLY (SELECT only — NO UPDATE, NO DELETE, NO INSERT)
-- Purpose: For Product Owner to execute in Supabase SQL Editor to audit live DB
-- ============================================================================

-- ============================================================================
-- PART 0: PRE-APPLY CUTOVER SAFETY CHECK (RUN BEFORE APPLYING MIGRATION)
-- ============================================================================

-- Query 0.1: Check count of currently active processing jobs
-- If this count > 0, STOP! Wait for active jobs to complete before applying migration.
SELECT
    COUNT(*) AS active_jobs_count,
    CASE 
        WHEN COUNT(*) = 0 THEN 'SAFE_FOR_MIGRATION_CUTOVER'
        ELSE 'WAIT_ACTIVE_JOBS_STILL_RUNNING'
    END AS pre_apply_cutover_status
FROM public.processing_jobs
WHERE status IN ('QUEUED', 'PROCESSING');

-- Query 0.2: Inspect active jobs if any exist
SELECT id, document_id, user_id, status, created_at, started_at
FROM public.processing_jobs
WHERE status IN ('QUEUED', 'PROCESSING')
ORDER BY created_at ASC;


-- ============================================================================
-- PART 1: POST-APPLY EXTENSION COLUMNS VERIFICATION
-- ============================================================================

-- Query 1.1: Verify new columns on public.processing_jobs
SELECT 
    column_name, 
    data_type, 
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'processing_jobs'
  AND column_name IN ('pricing_version', 'estimated_billable_units', 'quote_snapshot', 'reservation_id')
ORDER BY column_name;


-- ============================================================================
-- PART 2: FOREIGN KEY & INDEX VERIFICATION
-- ============================================================================

-- Query 2.1: Verify Foreign Key fk_processing_jobs_reservation
SELECT
    tc.constraint_name,
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND tc.table_name = 'processing_jobs'
  AND kcu.column_name = 'reservation_id';

-- Query 2.2: Verify Indexes
SELECT
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('idx_processing_jobs_reservation_id', 'idx_credit_reservations_processing_job_ref')
ORDER BY indexname;


-- ============================================================================
-- PART 3: RPC SIGNATURES, SECURITY DEFINER & SEARCH_PATH
-- ============================================================================

-- Query 3.1: Check RPC signatures, security definer, and search_path
SELECT 
    p.proname,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    p.prosecdef AS is_security_definer,
    p.proconfig AS search_path_config
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'confirm_document_processing'
ORDER BY proname, arguments;


-- ============================================================================
-- PART 4: RPC PRIVILEGES (REVOKE FROM ANON/AUTH, GRANT TO SERVICE_ROLE/POSTGRES)
-- ============================================================================

-- Query 4.1: Audit function privileges for confirm_document_processing
SELECT 
    p.proname,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute,
    has_function_privilege('postgres', p.oid, 'EXECUTE') AS postgres_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'confirm_document_processing';


-- ============================================================================
-- PART 5: FUNCTION DEFINITION INVARIANTS (REGEX AUDIT)
-- ============================================================================

-- Query 5.1: Verify in-function rules in 8-arg confirm_document_processing
SELECT 
    p.proname,
    (p.prosrc LIKE '%DOCUMENT_NOT_PROCESSABLE%') AS rule_waiting_confirmation_only,
    (p.prosrc LIKE '%INVALID_PROCESSING_ESTIMATE%') AS rule_positive_units_only,
    (p.prosrc LIKE '%processing-pricing-v1%') AS rule_pricing_version_enforced,
    (p.prosrc LIKE '%QUOTE_AMOUNT_MISMATCH%') AS rule_quote_amount_consistency,
    (p.prosrc LIKE '%QUOTE_ESTIMATE_FIELDS_MISMATCH%') AS rule_dual_fields_consistency,
    (p.prosrc LIKE '%UNSUPPORTED_OUTPUT_TYPE%') AS rule_output_type_enforced
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'confirm_document_processing'
  AND pg_get_function_identity_arguments(p.oid) LIKE '%p_estimated_units%';

-- Query 5.2: Verify legacy 3-arg hard-fail
SELECT 
    p.proname,
    (p.prosrc LIKE '%LEGACY_CALL_NOT_PERMITTED%') AS rule_legacy_hard_fail
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'confirm_document_processing'
  AND pg_get_function_identity_arguments(p.oid) NOT LIKE '%p_estimated_units%';
