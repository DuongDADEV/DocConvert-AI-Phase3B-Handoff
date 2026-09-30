-- ==========================================================
-- MIGRATION: 20260930000000_add_human_review_status_to_documents.sql
-- Module: Phase 8 — Human Review Workflow & Production MVP Readiness
-- Objective: Separate AI Pipeline status from Human Review status
-- DDL Safety Note: PostgreSQL 11+ avoids physical table rewrite for constant DEFAULT
--   values such as 'UNREVIEWED', but ALTER TABLE still acquires an ACCESS EXCLUSIVE
--   table/schema lock during the metadata update.
-- ==========================================================

-- 1. ADD HUMAN REVIEW METADATA COLUMNS TO public.documents
-- Note on Legacy Documents: By deliberate design in Phase 8, all existing documents
-- receive review_status = 'UNREVIEWED', reviewed_by = NULL, reviewed_at = NULL.
-- Legacy documents must pass the new Phase 8 Human Review Gate to achieve REVIEWED.
ALTER TABLE public.documents 
  ADD COLUMN IF NOT EXISTS review_status VARCHAR(50) NOT NULL DEFAULT 'UNREVIEWED',
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL;

-- 2. ENSURE CHECK CONSTRAINT FOR review_status (Scoped strictly to public.documents)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'chk_documents_review_status' 
      AND conrelid = 'public.documents'::regclass
  ) THEN
    ALTER TABLE public.documents 
      ADD CONSTRAINT chk_documents_review_status 
      CHECK (review_status IN ('UNREVIEWED', 'IN_PROGRESS', 'REVIEWED'));
  END IF;
END $$;

-- 3. ENSURE CONSISTENCY CHECK CONSTRAINT (reviewed_at lifecycle synchronization)
-- Requires reviewed_at to be populated if and only if review_status is 'REVIEWED'.
-- Does NOT require reviewed_by NOT NULL to support ON DELETE SET NULL foreign key semantics.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'chk_documents_review_consistency' 
      AND conrelid = 'public.documents'::regclass
  ) THEN
    ALTER TABLE public.documents 
      ADD CONSTRAINT chk_documents_review_consistency 
      CHECK (
        (review_status = 'REVIEWED' AND reviewed_at IS NOT NULL)
        OR
        (review_status <> 'REVIEWED' AND reviewed_at IS NULL)
      );
  END IF;
END $$;

-- 4. CREATE PERFORMANCE INDEX FOR FILTERING BY HUMAN REVIEW STATE
-- Note: idx_documents_reviewed_by is omitted in Phase 8 MVP because there are no
-- queries filtering documents primarily by reviewer identity.
CREATE INDEX IF NOT EXISTS idx_documents_review_status ON public.documents(review_status);

-- 5. COMMENTS DOCUMENTING FIELD INTENT & ARCHITECTURAL SEMANTICS
COMMENT ON COLUMN public.documents.review_status IS 'Human review lifecycle state: UNREVIEWED (default), IN_PROGRESS, REVIEWED';
COMMENT ON COLUMN public.documents.reviewed_by IS 'Auth user UUID who completed the final human review gate (nullable on account deletion)';
COMMENT ON COLUMN public.documents.reviewed_at IS 'Timestamp when the document successfully passed the review completion gate; NULL when UNREVIEWED or IN_PROGRESS';
