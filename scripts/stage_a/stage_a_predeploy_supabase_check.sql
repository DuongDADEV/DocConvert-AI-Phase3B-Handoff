-- ============================================================================
-- DocConvert AI — Stage A Pre-Deployment Supabase Read-Only Check
-- Phase 3B.3.5 — Stage A Release Integrity & Supabase Pre-Cutover Readiness
--
-- PURPOSE:
-- Verifies that the live Supabase database is in a safe, expected PRE-Phase3B state
-- before deploying the Stage A Maintenance Bridge artifact.
--
-- SAFETY INVARIANT:
-- 100% READ-ONLY. No INSERT, UPDATE, DELETE, ALTER, DROP, or schema mutation.
-- Safe to execute against staging or production at any time.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PRE-01: CURRENT ACTIVE PROCESSING JOBS STATUS & COUNT
-- Expected before Stage A: active_jobs_count may be >= 0 (jobs will drain after maintenance).
-- ----------------------------------------------------------------------------
SELECT 
    'PRE-01' AS check_id,
    'CURRENT_ACTIVE_JOBS' AS check_name,
    COALESCE(status, 'TOTAL') AS job_status,
    COUNT(*) AS job_count,
    CASE 
        WHEN COUNT(*) = 0 THEN 'CLEAN_ZERO_ACTIVE'
        ELSE 'ACTIVE_JOBS_EXIST_WILL_DRAIN_UNDER_STAGE_A'
    END AS operational_assessment
FROM public.processing_jobs
WHERE status IN ('QUEUED', 'PROCESSING')
GROUP BY ROLLUP(status);

-- ----------------------------------------------------------------------------
-- PRE-02: CHECK FOR PHASE 3B processing_jobs COLUMNS
-- Expected before migration: These 4 columns do NOT exist in the live database yet.
-- If absent: Stage A is compatible with OLD DB schema.
-- ----------------------------------------------------------------------------
SELECT 
    'PRE-02' AS check_id,
    'PHASE_3B_COLUMNS_PRESENCE' AS check_name,
    column_name,
    data_type,
    is_nullable,
    'COLUMN_ALREADY_MIGRATED' AS status
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'processing_jobs'
  AND column_name IN ('reservation_id', 'pricing_version', 'estimated_billable_units', 'quote_snapshot');

-- ----------------------------------------------------------------------------
-- PRE-03: VERIFY LEGACY 3-ARG confirm_document_processing RPC
-- Expected before migration: Legacy RPC signature exists and is callable.
-- ----------------------------------------------------------------------------
SELECT 
    'PRE-03' AS check_id,
    'LEGACY_RPC_SIGNATURE' AS check_name,
    p.proname AS rpc_name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    CASE 
        WHEN pg_catalog.pg_get_function_identity_arguments(p.oid) LIKE '%p_document_id uuid, p_user_id uuid, p_output_type character varying%'
        THEN 'LEGACY_RPC_AVAILABLE_FOR_STAGE_A'
        ELSE 'UNEXPECTED_ARGUMENTS'
    END AS compatibility_status
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'confirm_document_processing'
  AND p.pronargs = 3;

-- ----------------------------------------------------------------------------
-- PRE-04: CHECK FOR NEW PHASE 3B 8-ARG RPC PRESENCE
-- Expected before migration: 8-arg RPC should NOT be present (or unmigrated).
-- ----------------------------------------------------------------------------
SELECT 
    'PRE-04' AS check_id,
    'PHASE_3B_8_ARG_RPC_PRESENCE' AS check_name,
    p.proname AS rpc_name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    CASE 
        WHEN p.oid IS NOT NULL THEN 'NEW_8_ARG_RPC_ALREADY_EXISTS'
        ELSE 'NEW_RPC_NOT_YET_APPLIED'
    END AS status
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'confirm_document_processing'
  AND p.pronargs = 8;

-- ----------------------------------------------------------------------------
-- PRE-05: VERIFY PHASE 2A CREDIT LEDGER FOUNDATION TABLES
-- Expected: credit_accounts, credit_grants, credit_ledger must exist.
-- ----------------------------------------------------------------------------
SELECT 
    'PRE-05' AS check_id,
    'CREDIT_FOUNDATION_TABLES' AS check_name,
    table_name,
    CASE 
        WHEN table_name IN ('credit_accounts', 'credit_grants', 'credit_ledger') THEN 'PRESERVED'
        ELSE 'UNEXPECTED'
    END AS foundation_status
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('credit_accounts', 'credit_grants', 'credit_ledger')
ORDER BY table_name;

-- ----------------------------------------------------------------------------
-- PRE-06: VERIFY PHASE 2B RESERVATION FOUNDATION TABLES
-- Expected: credit_reservations, credit_reservation_allocations must exist.
-- ----------------------------------------------------------------------------
SELECT 
    'PRE-06' AS check_id,
    'RESERVATION_FOUNDATION_TABLES' AS check_name,
    table_name,
    CASE 
        WHEN table_name IN ('credit_reservations', 'credit_reservation_allocations') THEN 'PRESERVED'
        ELSE 'UNEXPECTED'
    END AS foundation_status
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('credit_reservations', 'credit_reservation_allocations')
ORDER BY table_name;
