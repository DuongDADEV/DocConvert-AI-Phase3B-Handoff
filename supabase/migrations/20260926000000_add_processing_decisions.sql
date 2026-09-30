-- ==========================================================
-- MIGRATION: ADD PROCESSING DECISION ENGINE FIELDS TO document_pages
-- Phase 5: Processing Decision Engine & Page-Level Routing
-- ==========================================================

-- 1. ADD PROCESSING DECISION COLUMNS TO document_pages
ALTER TABLE public.document_pages
  ADD COLUMN IF NOT EXISTS processing_strategy VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS fallback_strategy VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS requires_azure BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS requires_region_analysis BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS decision_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS decision_version VARCHAR(50) NULL DEFAULT 'pde-v1';

-- 2. ADD CHECK CONSTRAINTS SAFELY
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_document_pages_processing_strategy'
  ) THEN
    ALTER TABLE public.document_pages
      ADD CONSTRAINT chk_document_pages_processing_strategy
      CHECK (processing_strategy IS NULL OR processing_strategy IN ('LOCAL_NATIVE', 'AZURE_FULL_PAGE', 'HYBRID', 'LOCAL_RECHECK', 'AZURE_FALLBACK'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_document_pages_fallback_strategy'
  ) THEN
    ALTER TABLE public.document_pages
      ADD CONSTRAINT chk_document_pages_fallback_strategy
      CHECK (fallback_strategy IS NULL OR fallback_strategy IN ('LOCAL_NATIVE', 'AZURE_FULL_PAGE', 'HYBRID', 'LOCAL_RECHECK', 'AZURE_FALLBACK'));
  END IF;
END $$;

-- 3. INDEX FOR STRATEGY LOOKUP & AUDITING
CREATE INDEX IF NOT EXISTS idx_document_pages_strategy ON public.document_pages(processing_strategy);
