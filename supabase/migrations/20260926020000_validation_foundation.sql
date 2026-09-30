-- ==========================================================
-- MIGRATION: VALIDATION FOUNDATION & ATOMIC PERSISTENCE (FINAL PRODUCTION HARDENED)
-- Phase 6: Validation Engine & Atomic OCR Result Persistence
-- ==========================================================

-- 1. EXTEND extracted_tables WITH CONFIDENCE PROVENANCE & CONSTRAINTS
ALTER TABLE public.extracted_tables
  ADD COLUMN IF NOT EXISTS confidence_source VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS structure_confidence NUMERIC NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_extracted_tables_confidence_source'
  ) THEN
    ALTER TABLE public.extracted_tables
      ADD CONSTRAINT chk_extracted_tables_confidence_source
      CHECK (confidence_source IS NULL OR confidence_source IN ('AZURE_MODEL', 'AZURE_WORD_AGGREGATE', 'AZURE_CELL', 'LOCAL_HEURISTIC', 'UNAVAILABLE', 'EMPTY_CELL'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_extracted_tables_structure_confidence'
  ) THEN
    ALTER TABLE public.extracted_tables
      ADD CONSTRAINT chk_extracted_tables_structure_confidence
      CHECK (structure_confidence IS NULL OR (structure_confidence >= 0 AND structure_confidence <= 1));
  END IF;
END $$;

-- 1b. EXTEND extracted_rows WITH is_header
ALTER TABLE public.extracted_rows
  ADD COLUMN IF NOT EXISTS is_header BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. EXTEND extracted_cells WITH VALIDATION & CONFIDENCE COLUMNS & CONSTRAINTS
ALTER TABLE public.extracted_cells
  ADD COLUMN IF NOT EXISTS confidence_source VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS validation_status VARCHAR(50) NOT NULL DEFAULT 'ACCEPTED',
  ADD COLUMN IF NOT EXISTS validation_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS requires_secondary_ocr BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_extracted_cells_confidence_source'
  ) THEN
    ALTER TABLE public.extracted_cells
      ADD CONSTRAINT chk_extracted_cells_confidence_source
      CHECK (confidence_source IS NULL OR confidence_source IN ('AZURE_MODEL', 'AZURE_WORD_AGGREGATE', 'AZURE_CELL', 'LOCAL_HEURISTIC', 'UNAVAILABLE', 'EMPTY_CELL'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_extracted_cells_validation_status'
  ) THEN
    ALTER TABLE public.extracted_cells
      ADD CONSTRAINT chk_extracted_cells_validation_status
      CHECK (validation_status IN ('ACCEPTED', 'WARNING', 'REVIEW_REQUIRED'));
  END IF;
END $$;

-- 3. CREATE validation_runs TABLE WITH CONSTRAINTS & RLS
CREATE TABLE IF NOT EXISTS public.validation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL DEFAULT 'ACCEPTED',
  accepted_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  review_required_count INTEGER NOT NULL DEFAULT 0,
  validation_version VARCHAR(50) NOT NULL DEFAULT 'val-v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_validation_runs_status CHECK (status IN ('ACCEPTED', 'WARNING', 'REVIEW_REQUIRED')),
  CONSTRAINT chk_validation_runs_counts CHECK (accepted_count >= 0 AND warning_count >= 0 AND review_required_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_validation_runs_document_id ON public.validation_runs(document_id);

ALTER TABLE public.validation_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can view validation runs of own documents'
  ) THEN
    CREATE POLICY "Users can view validation runs of own documents"
      ON public.validation_runs FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.documents d
          WHERE d.id = validation_runs.document_id AND d.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- 4. CREATE validation_issues TABLE WITH CONSTRAINTS, CASCADE FKs & RLS
CREATE TABLE IF NOT EXISTS public.validation_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.validation_runs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  table_id UUID NULL REFERENCES public.extracted_tables(id) ON DELETE CASCADE,
  cell_id UUID NULL REFERENCES public.extracted_cells(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  row_index INTEGER NULL,
  column_index INTEGER NULL,
  rule_code VARCHAR(100) NOT NULL,
  severity VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  observed_value TEXT NULL,
  expected_pattern TEXT NULL,
  requires_secondary_ocr BOOLEAN NOT NULL DEFAULT FALSE,
  bounding_box JSONB NULL,
  coordinate_unit VARCHAR(50) NULL DEFAULT 'point',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_validation_issues_severity CHECK (severity IN ('WARNING', 'ERROR')),
  CONSTRAINT chk_validation_issues_page_number CHECK (page_number >= 1),
  CONSTRAINT chk_validation_issues_coordinate_unit CHECK (coordinate_unit IS NULL OR coordinate_unit IN ('point', 'inch', 'pixel'))
);

CREATE INDEX IF NOT EXISTS idx_validation_issues_document_id ON public.validation_issues(document_id);
CREATE INDEX IF NOT EXISTS idx_validation_issues_run_id ON public.validation_issues(run_id);
CREATE INDEX IF NOT EXISTS idx_validation_issues_table_id ON public.validation_issues(table_id);
CREATE INDEX IF NOT EXISTS idx_validation_issues_cell_id ON public.validation_issues(cell_id);
CREATE INDEX IF NOT EXISTS idx_validation_issues_severity ON public.validation_issues(severity);
CREATE INDEX IF NOT EXISTS idx_validation_issues_rule_code ON public.validation_issues(rule_code);

ALTER TABLE public.validation_issues ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can view validation issues of own documents'
  ) THEN
    CREATE POLICY "Users can view validation issues of own documents"
      ON public.validation_issues FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.documents d
          WHERE d.id = validation_issues.document_id AND d.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- 5. ATOMIC PERSISTENCE RPC FUNCTION (FINAL PRODUCTION HARDENED)
-- - Document row locked with FOR UPDATE to prevent race conditions during retry/writes.
-- - validation_run payload is strictly MANDATORY: prevents unvalidated results from persisting as READY.
-- - Authoritatively derives documents.status inside PostgreSQL:
--     * REVIEW_REQUIRED if validation_run.status = 'REVIEW_REQUIRED' OR review_required_count > 0
--     * READY if validation_run.status IN ('ACCEPTED', 'WARNING') AND review_required_count = 0
-- - Preserves table/cell ID consistency so validation_issues foreign keys are strictly satisfied.
-- - Native PostgreSQL single transaction: All deletions and insertions succeed together or roll back cleanly.
CREATE OR REPLACE FUNCTION public.save_document_analysis_atomic(
  p_document_id UUID,
  p_user_id UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_doc_status VARCHAR(50);
  v_now TIMESTAMPTZ := now();
  v_final_status VARCHAR(50);
  v_val_run_status VARCHAR(50);
  v_page_count INTEGER;
  v_item JSONB;
  v_val_item JSONB;
  v_run_id UUID := gen_random_uuid();
BEGIN
  -- 1. Security & Ownership Verification with Row Lock (FOR UPDATE)
  SELECT status INTO v_current_doc_status
  FROM public.documents
  WHERE id = p_document_id AND user_id = p_user_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_FOUND_OR_UNAUTHORIZED'
      USING HINT = 'Document does not exist, does not belong to user, or has been deleted';
  END IF;

  -- 2. Validate that validation_run is mandatory
  IF NOT (p_payload ? 'validation_run') OR p_payload->'validation_run' IS NULL OR (p_payload->'validation_run') = 'null'::jsonb THEN
    RAISE EXCEPTION 'VALIDATION_RUN_REQUIRED'
      USING HINT = 'Atomic persistence requires an authoritative validation_run payload from Validation Engine';
  END IF;

  v_val_item := p_payload->'validation_run';

  -- 3. Authoritatively derive validation_runs.status first, then documents.status
  -- Hierarchical resolution: REVIEW_REQUIRED > WARNING > ACCEPTED
  IF (COALESCE((v_val_item->>'review_required_count')::INTEGER, 0) > 0)
     OR (v_val_item->>'status' = 'REVIEW_REQUIRED') THEN
    v_val_run_status := 'REVIEW_REQUIRED';
  ELSIF (COALESCE((v_val_item->>'warning_count')::INTEGER, 0) > 0)
     OR (v_val_item->>'status' = 'WARNING') THEN
    v_val_run_status := 'WARNING';
  ELSE
    v_val_run_status := 'ACCEPTED';
  END IF;

  -- Derive documents.status ONLY from v_val_run_status:
  -- validation_runs.status = REVIEW_REQUIRED -> documents.status = REVIEW_REQUIRED
  -- validation_runs.status = ACCEPTED or WARNING -> documents.status = READY
  IF v_val_run_status = 'REVIEW_REQUIRED' THEN
    v_final_status := 'REVIEW_REQUIRED';
  ELSE
    v_final_status := 'READY';
  END IF;

  v_page_count := COALESCE((p_payload->>'page_count')::INTEGER, 1);

  -- 4. Clean up old extraction and validation records atomically
  -- Cascade delete child records first
  DELETE FROM public.validation_issues WHERE document_id = p_document_id;
  DELETE FROM public.validation_runs WHERE document_id = p_document_id;

  DELETE FROM public.extracted_cells
  WHERE row_id IN (
    SELECT r.id FROM public.extracted_rows r
    JOIN public.extracted_tables t ON r.table_id = t.id
    WHERE t.document_id = p_document_id
  );

  DELETE FROM public.extracted_rows
  WHERE table_id IN (
    SELECT id FROM public.extracted_tables WHERE document_id = p_document_id
  );

  DELETE FROM public.extracted_tables WHERE document_id = p_document_id;
  DELETE FROM public.ocr_results WHERE document_id = p_document_id;
  DELETE FROM public.document_metadata WHERE document_id = p_document_id;

  -- 5. Update document page_count and authoritatively derived status
  UPDATE public.documents
  SET page_count = v_page_count,
      status = v_final_status,
      updated_at = v_now
  WHERE id = p_document_id;

  -- 6. Insert ocr_results
  IF p_payload ? 'ocr_results' AND jsonb_array_length(p_payload->'ocr_results') > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'ocr_results')
    LOOP
      INSERT INTO public.ocr_results (
        id, document_id, page_number, raw_text, confidence_score, azure_model_id, metadata, created_at
      ) VALUES (
        COALESCE((v_item->>'id')::UUID, gen_random_uuid()),
        p_document_id,
        (v_item->>'page_number')::INTEGER,
        v_item->>'raw_text',
        (v_item->>'confidence_score')::NUMERIC,
        v_item->>'azure_model_id',
        COALESCE(v_item->'metadata', '{}'::jsonb),
        v_now
      );
    END LOOP;
  END IF;

  -- 7. Insert extracted_tables
  IF p_payload ? 'tables' AND jsonb_array_length(p_payload->'tables') > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'tables')
    LOOP
      INSERT INTO public.extracted_tables (
        id, document_id, page_number, table_index, row_count, column_count,
        confidence_score, confidence_source, structure_confidence, created_at
      ) VALUES (
        COALESCE((v_item->>'id')::UUID, gen_random_uuid()),
        p_document_id,
        (v_item->>'page_number')::INTEGER,
        (v_item->>'table_index')::INTEGER,
        (v_item->>'row_count')::INTEGER,
        (v_item->>'column_count')::INTEGER,
        (v_item->>'confidence_score')::NUMERIC,
        v_item->>'confidence_source',
        (v_item->>'structure_confidence')::NUMERIC,
        v_now
      );
    END LOOP;
  END IF;

  -- 8. Insert extracted_rows
  IF p_payload ? 'rows' AND jsonb_array_length(p_payload->'rows') > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'rows')
    LOOP
      INSERT INTO public.extracted_rows (
        id, table_id, row_index, is_header, created_at
      ) VALUES (
        COALESCE((v_item->>'id')::UUID, gen_random_uuid()),
        (v_item->>'table_id')::UUID,
        (v_item->>'row_index')::INTEGER,
        COALESCE((v_item->>'is_header')::BOOLEAN, false),
        v_now
      );
    END LOOP;
  END IF;

  -- 9. Insert extracted_cells
  IF p_payload ? 'cells' AND jsonb_array_length(p_payload->'cells') > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'cells')
    LOOP
      INSERT INTO public.extracted_cells (
        id, row_id, column_index, raw_value, normalized_value, cell_type,
        confidence_score, confidence_source, is_reviewed, bounding_box,
        validation_status, validation_issues, requires_secondary_ocr,
        created_at, updated_at
      ) VALUES (
        COALESCE((v_item->>'id')::UUID, gen_random_uuid()),
        (v_item->>'row_id')::UUID,
        (v_item->>'column_index')::INTEGER,
        v_item->>'raw_value',
        v_item->>'normalized_value',
        COALESCE(v_item->>'cell_type', 'TEXT'),
        (v_item->>'confidence_score')::NUMERIC,
        v_item->>'confidence_source',
        COALESCE((v_item->>'is_reviewed')::BOOLEAN, false),
        v_item->'bounding_box',
        COALESCE(v_item->>'validation_status', 'ACCEPTED'),
        COALESCE(v_item->'validation_issues', '[]'::jsonb),
        COALESCE((v_item->>'requires_secondary_ocr')::BOOLEAN, false),
        v_now,
        v_now
      );
    END LOOP;
  END IF;

  -- 10. Insert document_metadata
  IF p_payload ? 'document_metadata' AND jsonb_array_length(p_payload->'document_metadata') > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'document_metadata')
    LOOP
      INSERT INTO public.document_metadata (
        id, document_id, label, raw_label, value, raw_value,
        normalized_label, normalized_value_for_match, confidence_score,
        source_page, key_bounding_box, value_bounding_box, occurrence_count,
        status, alternatives, created_at, updated_at
      ) VALUES (
        COALESCE((v_item->>'id')::UUID, gen_random_uuid()),
        p_document_id,
        v_item->>'label',
        v_item->>'raw_label',
        v_item->>'value',
        v_item->>'raw_value',
        v_item->>'normalized_label',
        v_item->>'normalized_value_for_match',
        (v_item->>'confidence_score')::NUMERIC,
        (v_item->>'source_page')::INTEGER,
        v_item->'key_bounding_box',
        v_item->'value_bounding_box',
        COALESCE((v_item->>'occurrence_count')::INTEGER, 1),
        COALESCE(v_item->>'status', 'AUTO'),
        COALESCE(v_item->'alternatives', '[]'::jsonb),
        v_now,
        v_now
      );
    END LOOP;
  END IF;

  -- 11. Insert validation_runs & validation_issues
  v_run_id := COALESCE((v_val_item->>'id')::UUID, v_run_id);

  INSERT INTO public.validation_runs (
    id, document_id, status, accepted_count, warning_count,
    review_required_count, validation_version, created_at
  ) VALUES (
    v_run_id,
    p_document_id,
    v_val_run_status,
    COALESCE((v_val_item->>'accepted_count')::INTEGER, 0),
    COALESCE((v_val_item->>'warning_count')::INTEGER, 0),
    COALESCE((v_val_item->>'review_required_count')::INTEGER, 0),
    COALESCE(v_val_item->>'validation_version', 'val-v1'),
    v_now
  );

  IF p_payload ? 'validation_issues' AND jsonb_array_length(p_payload->'validation_issues') > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'validation_issues')
    LOOP
      INSERT INTO public.validation_issues (
        id, run_id, document_id, table_id, cell_id, page_number,
        row_index, column_index, rule_code, severity, message,
        observed_value, expected_pattern, requires_secondary_ocr,
        bounding_box, coordinate_unit, created_at
      ) VALUES (
        COALESCE((v_item->>'id')::UUID, gen_random_uuid()),
        v_run_id,
        p_document_id,
        (v_item->>'table_id')::UUID,
        (v_item->>'cell_id')::UUID,
        (v_item->>'page_number')::INTEGER,
        (v_item->>'row_index')::INTEGER,
        (v_item->>'column_index')::INTEGER,
        v_item->>'rule_code',
        v_item->>'severity',
        v_item->>'message',
        v_item->>'observed_value',
        v_item->>'expected_pattern',
        COALESCE((v_item->>'requires_secondary_ocr')::BOOLEAN, false),
        v_item->'bounding_box',
        COALESCE(v_item->>'coordinate_unit', 'point'),
        v_now
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'status', v_final_status,
    'validation_run_status', v_val_run_status,
    'tables_count', jsonb_array_length(COALESCE(p_payload->'tables', '[]'::jsonb)),
    'cells_count', jsonb_array_length(COALESCE(p_payload->'cells', '[]'::jsonb))
  );
END;
$$;

-- 6. STRICT DEFENSE-IN-DEPTH PERMISSIONS
REVOKE ALL ON FUNCTION public.save_document_analysis_atomic(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_document_analysis_atomic(UUID, UUID, JSONB) TO service_role;
