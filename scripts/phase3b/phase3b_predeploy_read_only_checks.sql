-- ==============================================================================
-- DocConvert AI — Phase 3B.4 Full Production Runtime Pre-Deployment Verification
-- File: scripts/phase3b/phase3b_predeploy_read_only_checks.sql
--
-- PURPOSE:
-- 100% READ-ONLY SQL inspection for Operator to execute against live Supabase
-- prior to switching traffic or deploying Full Phase 3B production runtime.
--
-- GUARANTEE:
-- ZERO mutations. No INSERT, UPDATE, DELETE, ALTER, DROP, or schema modifications.
-- Safe to run in production at any time.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- CHECK A: processing_jobs Phase 3B Columns Verification
-- Expectation: 4 new columns exist (reservation_id, pricing_version,
--              estimated_billable_units, quote_snapshot).
-- ------------------------------------------------------------------------------
SELECT
    'CHECK-A' AS check_id,
    'PROCESSING_JOBS_PHASE3B_COLUMNS' AS check_name,
    column_name,
    data_type,
    is_nullable,
    CASE 
        WHEN column_name = 'reservation_id' AND data_type = 'uuid' THEN 'OK'
        WHEN column_name = 'pricing_version' AND data_type = 'character varying' THEN 'OK'
        WHEN column_name = 'estimated_billable_units' AND data_type = 'bigint' THEN 'OK'
        WHEN column_name = 'quote_snapshot' AND data_type = 'jsonb' THEN 'OK'
        ELSE 'UNEXPECTED'
    END AS verification_status
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'processing_jobs'
  AND column_name IN ('reservation_id', 'pricing_version', 'estimated_billable_units', 'quote_snapshot')
ORDER BY column_name;

-- ------------------------------------------------------------------------------
-- CHECK B: confirm_document_processing Overloads Audit
-- Expectation:
--   1. 8-argument extended canonical RPC (pronargs = 8)
--   2. 3-argument legacy overload (pronargs = 3)
-- ------------------------------------------------------------------------------
SELECT
    'CHECK-B' AS check_id,
    'CONFIRM_RPC_OVERLOADS' AS check_name,
    p.proname AS rpc_name,
    p.pronargs AS arg_count,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS argument_signature,
    CASE
        WHEN p.pronargs = 8 THEN 'CANONICAL_8_ARG_PHASE3B_RPC'
        WHEN p.pronargs = 3 THEN 'LEGACY_3_ARG_HARD_FAIL_RPC'
        ELSE 'UNKNOWN_OVERLOAD'
    END AS overload_role
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'confirm_document_processing'
ORDER BY p.pronargs DESC;

-- ------------------------------------------------------------------------------
-- CHECK C: Credit Foundation & Reservation Tables Presence
-- Expectation: credit_accounts, credit_grants, credit_ledger,
--              credit_reservations, credit_reservation_allocations,
--              credit_reservation_events all exist in public schema.
-- ------------------------------------------------------------------------------
SELECT
    'CHECK-C' AS check_id,
    'CREDIT_TABLES_PRESENCE' AS check_name,
    table_name,
    CASE
        WHEN table_name IN (
            'credit_accounts', 'credit_grants', 'credit_ledger',
            'credit_reservations', 'credit_reservation_allocations', 'credit_reservation_events'
        ) THEN 'VERIFIED_PRESENT'
        ELSE 'UNEXPECTED'
    END AS table_status
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
      'credit_accounts', 'credit_grants', 'credit_ledger',
      'credit_reservations', 'credit_reservation_allocations', 'credit_reservation_events'
  )
ORDER BY table_name;

-- ------------------------------------------------------------------------------
-- CHECK D: credit_ledger Check Constraint & grant_user_credits Mapping Audit
-- Expectation:
--   1. chk_credit_ledger_entry_type allows ONLY ('GRANT', 'ADJUSTMENT', 'EXPIRATION', 'CAPTURE').
--   2. grant_user_credits does NOT emit GRANT_FREE / GRANT_PACK.
-- ------------------------------------------------------------------------------
SELECT
    'CHECK-D1' AS check_id,
    'LEDGER_CHECK_CONSTRAINT' AS check_name,
    conname AS constraint_name,
    pg_get_constraintdef(oid) AS constraint_definition,
    CASE
        WHEN pg_get_constraintdef(oid) LIKE '%entry_type%GRANT%ADJUSTMENT%EXPIRATION%CAPTURE%'
        THEN 'VERIFIED_CANONICAL_CONSTRAINT'
        ELSE 'VIOLATION'
    END AS audit_status
FROM pg_constraint
WHERE conrelid = 'public.credit_ledger'::regclass
  AND conname = 'chk_credit_ledger_entry_type';

-- Verify grant_user_credits definition has hotfix applied (no GRANT_FREE)
SELECT
    'CHECK-D2' AS check_id,
    'GRANT_USER_CREDITS_MAPPING' AS check_name,
    p.proname AS function_name,
    CASE
        WHEN p.prosrc LIKE '%GRANT_FREE%' THEN 'STALE_BAD_MAPPING_DETECTED'
        WHEN p.prosrc LIKE '%ADMIN_ADJUSTMENT%THEN%ADJUSTMENT%ELSE%GRANT%'
             OR p.prosrc LIKE '%ADMIN_ADJUSTMENT%THEN ''ADJUSTMENT''%ELSE ''GRANT''%'
        THEN 'HOTFIX_CONFIRMED_CANONICAL_MAPPING'
        ELSE 'REQUIRES_MANUAL_INSPECTION'
    END AS mapping_status
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'grant_user_credits';

-- ------------------------------------------------------------------------------
-- CHECK E: Active Processing Jobs Count
-- Expectation: job_count = 0 before deployment cutover.
-- ------------------------------------------------------------------------------
SELECT
    'CHECK-E' AS check_id,
    'ACTIVE_JOBS_ZERO_DRAIN_CHECK' AS check_name,
    COALESCE(status, 'TOTAL') AS queue_status,
    COUNT(*) AS job_count,
    CASE
        WHEN COUNT(*) = 0 THEN 'ZERO_ACTIVE_JOBS_SAFE_FOR_DEPLOY'
        ELSE 'JOBS_STILL_ACTIVE_DO_NOT_CUTOVER'
    END AS operator_action
FROM public.processing_jobs
WHERE status IN ('QUEUED', 'PROCESSING')
GROUP BY ROLLUP(status);

-- ------------------------------------------------------------------------------
-- CHECK F: Legacy 3-Arg confirm RPC Hard-Fail Behavior
-- Expectation: Legacy 3-arg confirm RPC prosrc raises
--              PROCESSING_CONFIRM_SIGNATURE_DEPRECATED exception.
-- ------------------------------------------------------------------------------
SELECT
    'CHECK-F' AS check_id,
    'LEGACY_RPC_HARD_FAIL_CHECK' AS check_name,
    p.proname AS rpc_name,
    p.pronargs AS arg_count,
    CASE
        WHEN p.prosrc LIKE '%PROCESSING_CONFIRM_SIGNATURE_DEPRECATED%'
        THEN 'HARD_FAIL_GUARD_CONFIRMED'
        ELSE 'WARNING_LEGACY_RPC_NOT_FAILING_CLOSED'
    END AS guard_status
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'confirm_document_processing'
  AND p.pronargs = 3;
