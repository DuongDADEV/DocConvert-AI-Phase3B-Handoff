-- ==========================================================
-- MIGRATION: PHASE 7 — TARGETED SECONDARY OCR & CONFLICT RESOLUTION (FINAL HARDENED)
-- Target: Targeted cell recovery, candidates audit, conflict resolution & atomic RPC
-- ==========================================================

-- 1. EXTEND extracted_cells WITH original_raw_value & RESOLUTION COLUMNS
ALTER TABLE public.extracted_cells
  ADD COLUMN IF NOT EXISTS original_raw_value TEXT NULL,
  ADD COLUMN IF NOT EXISTS resolution_status VARCHAR(50) NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN IF NOT EXISTS resolution_method VARCHAR(50) NOT NULL DEFAULT 'NONE';

-- Safe backfill for existing cells
UPDATE public.extracted_cells
SET original_raw_value = raw_value
WHERE original_raw_value IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_extracted_cells_resolution_status'
  ) THEN
    ALTER TABLE public.extracted_cells
      ADD CONSTRAINT chk_extracted_cells_resolution_status
      CHECK (resolution_status IN ('NOT_REQUIRED', 'PENDING', 'RESOLVED', 'UNRESOLVED', 'HUMAN_REVIEW_REQUIRED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_extracted_cells_resolution_method'
  ) THEN
    ALTER TABLE public.extracted_cells
      ADD CONSTRAINT chk_extracted_cells_resolution_method
      CHECK (resolution_method IN ('NONE', 'DETERMINISTIC', 'SECONDARY_OCR', 'SECONDARY_OCR_ENHANCED', 'GEMINI', 'HUMAN'));
  END IF;
END $$;

-- 2. CREATE extraction_candidates TABLE (Authoritative Candidate History)
CREATE TABLE IF NOT EXISTS public.extraction_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  cell_id UUID NOT NULL REFERENCES public.extracted_cells(id) ON DELETE CASCADE,
  candidate_source VARCHAR(50) NOT NULL,
  raw_value TEXT NOT NULL DEFAULT '',
  normalized_value TEXT NULL,
  confidence_score NUMERIC NULL,
  confidence_source VARCHAR(50) NULL,
  provider VARCHAR(100) NOT NULL,
  provider_version VARCHAR(50) NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  attempt_status VARCHAR(50) NOT NULL DEFAULT 'COMPLETED',
  preprocessing_variant VARCHAR(50) NULL,
  render_dpi INTEGER NULL,
  validation_status VARCHAR(50) NOT NULL DEFAULT 'ACCEPTED',
  validation_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_selected BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key VARCHAR(150) NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_candidate_source CHECK (candidate_source IN ('AZURE_PRIMARY', 'LOCAL_NATIVE', 'SECONDARY_OCR', 'SECONDARY_OCR_ENHANCED', 'HUMAN_EDIT')),
  CONSTRAINT chk_candidate_confidence_source CHECK (confidence_source IS NULL OR confidence_source IN ('AZURE_MODEL', 'AZURE_WORD_AGGREGATE', 'AZURE_CELL', 'LOCAL_HEURISTIC', 'UNAVAILABLE', 'EMPTY_CELL')),
  CONSTRAINT chk_candidate_attempt_status CHECK (attempt_status IN ('PENDING', 'COMPLETED', 'FAILED')),
  CONSTRAINT chk_candidate_attempt_number CHECK (attempt_number >= 1),
  CONSTRAINT chk_candidate_confidence CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
  CONSTRAINT chk_candidate_validation_status CHECK (validation_status IN ('ACCEPTED', 'WARNING', 'REVIEW_REQUIRED')),
  CONSTRAINT chk_candidate_render_dpi CHECK (render_dpi IS NULL OR render_dpi >= 72)
);

CREATE INDEX IF NOT EXISTS idx_candidates_document_id ON public.extraction_candidates(document_id);
CREATE INDEX IF NOT EXISTS idx_candidates_cell_id ON public.extraction_candidates(cell_id);

-- Enforce exactly at most ONE candidate selected per cell at database level
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_one_selected_per_cell 
  ON public.extraction_candidates(cell_id) 
  WHERE is_selected = TRUE;

-- Enforce retry idempotency per cell attempt
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_idempotency 
  ON public.extraction_candidates(cell_id, idempotency_key) 
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.extraction_candidates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can view candidates of own documents'
  ) THEN
    CREATE POLICY "Users can view candidates of own documents"
      ON public.extraction_candidates FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.documents d
          WHERE d.id = extraction_candidates.document_id AND d.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- 3. CREATE extraction_resolutions TABLE (Current Resolution Snapshot per Cell)
CREATE TABLE IF NOT EXISTS public.extraction_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  cell_id UUID NOT NULL REFERENCES public.extracted_cells(id) ON DELETE CASCADE,
  selected_candidate_id UUID NULL REFERENCES public.extraction_candidates(id) ON DELETE SET NULL,
  resolution_status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  resolution_method VARCHAR(50) NOT NULL DEFAULT 'NONE',
  reason_code VARCHAR(100) NOT NULL,
  reason_message TEXT NULL,
  semantic_decision VARCHAR(50) NULL,
  semantic_confidence NUMERIC NULL,
  resolution_version VARCHAR(50) NOT NULL DEFAULT 'resolve-v1',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_resolution_cell UNIQUE (cell_id),
  CONSTRAINT chk_resolution_status CHECK (resolution_status IN ('NOT_REQUIRED', 'PENDING', 'RESOLVED', 'UNRESOLVED', 'HUMAN_REVIEW_REQUIRED')),
  CONSTRAINT chk_resolution_method CHECK (resolution_method IN ('NONE', 'DETERMINISTIC', 'SECONDARY_OCR', 'SECONDARY_OCR_ENHANCED', 'GEMINI', 'HUMAN')),
  CONSTRAINT chk_semantic_decision CHECK (semantic_decision IS NULL OR semantic_decision IN ('A', 'B', 'UNKNOWN')),
  CONSTRAINT chk_semantic_confidence CHECK (semantic_confidence IS NULL OR (semantic_confidence >= 0 AND semantic_confidence <= 1)),
  -- Invariant: If RESOLVED, selected_candidate_id cannot be null
  CONSTRAINT chk_resolved_requires_candidate CHECK (resolution_status <> 'RESOLVED' OR selected_candidate_id IS NOT NULL),
  -- Invariant: Gemini UNKNOWN cannot be RESOLVED
  CONSTRAINT chk_gemini_unknown_not_resolved CHECK (semantic_decision <> 'UNKNOWN' OR resolution_status <> 'RESOLVED')
);

CREATE INDEX IF NOT EXISTS idx_resolutions_document_id ON public.extraction_resolutions(document_id);
CREATE INDEX IF NOT EXISTS idx_resolutions_status ON public.extraction_resolutions(resolution_status);

ALTER TABLE public.extraction_resolutions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can view resolutions of own documents'
  ) THEN
    CREATE POLICY "Users can view resolutions of own documents"
      ON public.extraction_resolutions FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.documents d
          WHERE d.id = extraction_resolutions.document_id AND d.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- 4. CREATE extraction_resolution_events TABLE (Append-Only Decision Audit Log)
CREATE TABLE IF NOT EXISTS public.extraction_resolution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  cell_id UUID NOT NULL REFERENCES public.extracted_cells(id) ON DELETE CASCADE,
  candidate_a_id UUID NULL REFERENCES public.extraction_candidates(id) ON DELETE SET NULL,
  candidate_b_id UUID NULL REFERENCES public.extraction_candidates(id) ON DELETE SET NULL,
  selected_candidate_id UUID NULL REFERENCES public.extraction_candidates(id) ON DELETE SET NULL,
  resolution_status VARCHAR(50) NOT NULL,
  resolution_method VARCHAR(50) NOT NULL,
  reason_code VARCHAR(100) NOT NULL,
  reason_message TEXT NULL,
  semantic_decision VARCHAR(50) NULL,
  semantic_confidence NUMERIC NULL,
  resolution_event_key VARCHAR(150) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_event_status CHECK (resolution_status IN ('NOT_REQUIRED', 'PENDING', 'RESOLVED', 'UNRESOLVED', 'HUMAN_REVIEW_REQUIRED')),
  CONSTRAINT chk_event_method CHECK (resolution_method IN ('NONE', 'DETERMINISTIC', 'SECONDARY_OCR', 'SECONDARY_OCR_ENHANCED', 'GEMINI', 'HUMAN')),
  CONSTRAINT chk_event_semantic_decision CHECK (semantic_decision IS NULL OR semantic_decision IN ('A', 'B', 'UNKNOWN')),
  CONSTRAINT chk_event_semantic_confidence CHECK (semantic_confidence IS NULL OR (semantic_confidence >= 0 AND semantic_confidence <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resolution_events_key 
  ON public.extraction_resolution_events(cell_id, resolution_event_key);

CREATE INDEX IF NOT EXISTS idx_resolution_events_cell_id ON public.extraction_resolution_events(cell_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resolution_events_document_id ON public.extraction_resolution_events(document_id);

ALTER TABLE public.extraction_resolution_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can view resolution events of own documents'
  ) THEN
    CREATE POLICY "Users can view resolution events of own documents"
      ON public.extraction_resolution_events FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.documents d
          WHERE d.id = extraction_resolution_events.document_id AND d.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- 5. FULL REVISED ATOMIC RESOLUTION RPC: resolve_extraction_cell_atomic
CREATE OR REPLACE FUNCTION public.resolve_extraction_cell_atomic(
  p_document_id UUID,
  p_user_id UUID,
  p_cell_id UUID,
  p_candidate JSONB,       -- Candidate payload to insert/upsert (null if choosing existing candidate)
  p_resolution JSONB,      -- Resolution details (status, method, reason_code, semantic_decision, candidate_a_id, candidate_b_id, resolution_event_key)
  p_cell_updates JSONB     -- Cell updates (raw_value, normalized_value, validation_status, issues, requires_secondary_ocr)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_doc_status VARCHAR(50);
  v_table_id UUID;
  v_page_number INTEGER;
  v_table_conf_source VARCHAR(50);
  v_cell_row_id UUID;
  v_current_raw TEXT;
  v_original_raw TEXT;
  v_current_norm TEXT;
  v_current_conf NUMERIC;
  v_current_conf_source VARCHAR(50);
  v_current_val_status VARCHAR(50);
  v_current_val_issues JSONB;
  v_cell_bbox JSONB;
  
  v_candidate_a_id UUID;
  v_candidate_b_id UUID;
  v_candidate_id UUID;
  v_selected_cand_id UUID;
  v_res_status VARCHAR(50);
  v_res_method VARCHAR(50);
  v_semantic_dec VARCHAR(50);
  v_new_val_status VARCHAR(50);
  v_idempotency_key VARCHAR(150);
  v_event_key VARCHAR(150);
  
  v_existing_cand_id UUID;
  v_existing_status VARCHAR(50);
  v_existing_raw TEXT;
  v_existing_source VARCHAR(50);

  -- Variables for Whole-Operation Idempotency Check
  v_prior_event_id UUID;
  v_prior_candidate_a_id UUID;
  v_prior_candidate_b_id UUID;
  v_prior_selected_cand_id UUID;
  v_prior_res_status VARCHAR(50);
  v_prior_res_method VARCHAR(50);
  v_prior_semantic_dec VARCHAR(50);

  v_cell_review_count INTEGER;
  v_cell_warning_count INTEGER;
  v_cell_accepted_count INTEGER;
  v_total_error_issues INTEGER;
  v_blocking_review_required BOOLEAN;
  v_val_run_status VARCHAR(50);
  v_doc_final_status VARCHAR(50);
  v_latest_run_id UUID;
  v_issue_item JSONB;
BEGIN
  -- 1. Security & Ownership Verification on Document (FOR UPDATE)
  SELECT status INTO v_doc_status
  FROM public.documents
  WHERE id = p_document_id AND user_id = p_user_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_FOUND_OR_UNAUTHORIZED';
  END IF;

  -- 2. Verify that Cell strictly belongs to this Document via Table/Row hierarchy (FOR UPDATE OF c)
  SELECT 
    c.row_id, c.raw_value, c.original_raw_value, c.normalized_value, 
    c.confidence_score, c.confidence_source, c.validation_status, c.validation_issues,
    c.bounding_box, t.id, t.page_number, t.confidence_source
  INTO 
    v_cell_row_id, v_current_raw, v_original_raw, v_current_norm,
    v_current_conf, v_current_conf_source, v_current_val_status, v_current_val_issues,
    v_cell_bbox, v_table_id, v_page_number, v_table_conf_source
  FROM public.extracted_cells c
  JOIN public.extracted_rows r ON c.row_id = r.id
  JOIN public.extracted_tables t ON r.table_id = t.id
  WHERE c.id = p_cell_id AND t.document_id = p_document_id
  FOR UPDATE OF c;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CELL_NOT_FOUND_OR_DOCUMENT_MISMATCH';
  END IF;

  v_original_raw := COALESCE(v_original_raw, v_current_raw, '');

  -- 3. Whole-Operation Idempotency Verification (BEFORE any mutations)
  v_event_key := p_resolution->>'resolution_event_key';
  IF v_event_key IS NULL OR trim(v_event_key) = '' THEN
    RAISE EXCEPTION 'RESOLUTION_EVENT_KEY_REQUIRED'
      USING HINT = 'Atomic resolution requires a non-empty deterministic resolution_event_key';
  END IF;

  SELECT 
    id, candidate_a_id, candidate_b_id, selected_candidate_id,
    resolution_status, resolution_method, semantic_decision
  INTO 
    v_prior_event_id, v_prior_candidate_a_id, v_prior_candidate_b_id, v_prior_selected_cand_id,
    v_prior_res_status, v_prior_res_method, v_prior_semantic_dec
  FROM public.extraction_resolution_events
  WHERE cell_id = p_cell_id AND resolution_event_key = v_event_key;

  IF v_prior_event_id IS NOT NULL THEN
    -- A prior operation with this event key committed. Verify that the replayed resolution payload matches.
    IF (p_resolution->>'selected_candidate_id')::UUID IS DISTINCT FROM v_prior_selected_cand_id
       OR COALESCE(p_resolution->>'resolution_status', 'RESOLVED') IS DISTINCT FROM v_prior_res_status
       OR COALESCE(p_resolution->>'resolution_method', 'NONE') IS DISTINCT FROM v_prior_res_method
       OR (p_resolution->>'semantic_decision') IS DISTINCT FROM v_prior_semantic_dec
       OR ((p_resolution->>'candidate_a_id')::UUID IS NOT NULL AND (p_resolution->>'candidate_a_id')::UUID IS DISTINCT FROM v_prior_candidate_a_id)
       OR ((p_resolution->>'candidate_b_id')::UUID IS NOT NULL AND (p_resolution->>'candidate_b_id')::UUID IS DISTINCT FROM v_prior_candidate_b_id)
       OR (p_candidate IS NOT NULL AND (p_candidate->>'id')::UUID IS NOT NULL AND (p_candidate->>'id')::UUID IS DISTINCT FROM v_prior_candidate_b_id)
    THEN
      RAISE EXCEPTION 'RESOLUTION_IDEMPOTENCY_PAYLOAD_MISMATCH'
        USING HINT = 'Replaying existing resolution_event_key with different resolution parameters is forbidden';
    END IF;

    -- Check candidate B idempotency key and core payload if supplied
    IF p_candidate IS NOT NULL AND p_candidate <> 'null'::jsonb AND p_candidate->>'idempotency_key' IS NOT NULL THEN
      SELECT id, raw_value, candidate_source INTO v_existing_cand_id, v_existing_raw, v_existing_source
      FROM public.extraction_candidates
      WHERE cell_id = p_cell_id AND idempotency_key = (p_candidate->>'idempotency_key');

      IF v_existing_cand_id IS NOT NULL THEN
        IF v_prior_candidate_b_id IS NOT NULL AND v_existing_cand_id <> v_prior_candidate_b_id THEN
          RAISE EXCEPTION 'RESOLUTION_IDEMPOTENCY_PAYLOAD_MISMATCH'
            USING HINT = 'Replaying existing resolution_event_key with different candidate B is forbidden';
        END IF;

        IF v_existing_raw <> COALESCE(p_candidate->>'raw_value', '') OR v_existing_source <> (p_candidate->>'candidate_source') THEN
          RAISE EXCEPTION 'RESOLUTION_IDEMPOTENCY_PAYLOAD_MISMATCH'
            USING HINT = 'Replaying existing resolution_event_key with different candidate B payload is forbidden';
        END IF;
      END IF;
    END IF;

    -- Check cell updates raw_value if supplied
    IF p_cell_updates IS NOT NULL AND (p_cell_updates ? 'raw_value') AND (p_cell_updates->>'raw_value') IS DISTINCT FROM v_current_raw THEN
      RAISE EXCEPTION 'RESOLUTION_IDEMPOTENCY_PAYLOAD_MISMATCH'
        USING HINT = 'Replaying existing resolution_event_key with different cell raw_value is forbidden';
    END IF;

    -- Exact replay of committed operation: return current state immediately as an idempotent no-op.
    -- Absolutely NO candidate mutation, NO resolution mutation, NO cell mutation, NO validation mutation, NO duplicate event.
    SELECT 
      COUNT(*) FILTER (WHERE validation_status = 'REVIEW_REQUIRED'),
      COUNT(*) FILTER (WHERE validation_status = 'WARNING'),
      COUNT(*) FILTER (WHERE validation_status = 'ACCEPTED')
    INTO v_cell_review_count, v_cell_warning_count, v_cell_accepted_count
    FROM public.extracted_cells c
    JOIN public.extracted_rows r ON c.row_id = r.id
    JOIN public.extracted_tables t ON r.table_id = t.id
    WHERE t.document_id = p_document_id;

    SELECT COUNT(*) INTO v_total_error_issues
    FROM public.validation_issues
    WHERE document_id = p_document_id AND severity = 'ERROR';

    RETURN jsonb_build_object(
      'success', true,
      'idempotent_replay', true,
      'document_id', p_document_id,
      'cell_id', p_cell_id,
      'candidate_a_id', v_prior_candidate_a_id,
      'candidate_b_id', v_prior_candidate_b_id,
      'selected_candidate_id', v_prior_selected_cand_id,
      'resolution_status', v_prior_res_status,
      'resolution_method', v_prior_res_method,
      'cell_validation_status', v_current_val_status,
      'document_status', v_doc_status,
      'review_required_cell_count', v_cell_review_count,
      'total_error_issues_remaining', v_total_error_issues
    );
  END IF;

  -- 4. Primary Candidate A Guarantee (Lazy Creation)
  SELECT id INTO v_candidate_a_id
  FROM public.extraction_candidates
  WHERE cell_id = p_cell_id AND candidate_source IN ('AZURE_PRIMARY', 'LOCAL_NATIVE')
  ORDER BY created_at ASC LIMIT 1;

  IF v_candidate_a_id IS NULL THEN
    v_candidate_a_id := gen_random_uuid();
    INSERT INTO public.extraction_candidates (
      id, document_id, cell_id, candidate_source, raw_value,
      normalized_value, confidence_score, confidence_source,
      provider, provider_version, attempt_number, attempt_status,
      preprocessing_variant, render_dpi, validation_status,
      validation_issues, is_selected, idempotency_key, metadata, created_at
    ) VALUES (
      v_candidate_a_id,
      p_document_id,
      p_cell_id,
      CASE WHEN v_current_conf_source = 'LOCAL_HEURISTIC' OR v_table_conf_source = 'LOCAL_HEURISTIC' THEN 'LOCAL_NATIVE' ELSE 'AZURE_PRIMARY' END,
      v_original_raw,
      v_current_norm,
      v_current_conf,
      v_current_conf_source,
      CASE WHEN v_current_conf_source = 'LOCAL_HEURISTIC' OR v_table_conf_source = 'LOCAL_HEURISTIC' THEN 'local-pdf-extractor' ELSE 'azure-document-intelligence' END,
      'base-v1',
      1,
      'COMPLETED',
      'original',
      NULL,
      v_current_val_status,
      COALESCE(v_current_val_issues, '[]'::jsonb),
      TRUE, -- Initially Candidate A is selected
      p_cell_id || '_candidate_a',
      jsonb_build_object('isPrimaryLazyCreated', true, 'wasNull', (v_current_raw IS NULL)),
      v_now
    );
  END IF;

  -- 5. Process Candidate Attempt with Source Restrictions & Idempotency Handling (COMPLETED, FAILED, PENDING)
  IF p_candidate IS NOT NULL AND p_candidate <> 'null'::jsonb THEN
    -- Restrict allowed candidate sources for p_candidate
    IF (p_candidate->>'candidate_source') IS NULL 
       OR (p_candidate->>'candidate_source') NOT IN ('SECONDARY_OCR', 'SECONDARY_OCR_ENHANCED', 'HUMAN_EDIT') THEN
      RAISE EXCEPTION 'INVALID_CANDIDATE_SOURCE'
        USING HINT = 'p_candidate candidate_source must be SECONDARY_OCR, SECONDARY_OCR_ENHANCED, or HUMAN_EDIT';
    END IF;

    v_candidate_id := COALESCE((p_candidate->>'id')::UUID, gen_random_uuid());
    v_idempotency_key := p_candidate->>'idempotency_key';

    IF v_idempotency_key IS NOT NULL THEN
      SELECT id, attempt_status, raw_value, candidate_source
      INTO v_existing_cand_id, v_existing_status, v_existing_raw, v_existing_source
      FROM public.extraction_candidates
      WHERE cell_id = p_cell_id AND idempotency_key = v_idempotency_key;

      IF v_existing_cand_id IS NOT NULL THEN
        IF v_existing_status IN ('COMPLETED', 'FAILED') THEN
          -- Replaying completed or failed candidate: verify immutable core-payload match
          IF v_existing_raw <> COALESCE(p_candidate->>'raw_value', '') OR v_existing_source <> (p_candidate->>'candidate_source') THEN
            RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH'
              USING HINT = 'Replaying candidate with materially different raw_value or candidate_source is forbidden';
          END IF;
          v_candidate_b_id := v_existing_cand_id;
        ELSIF v_existing_status = 'PENDING' THEN
          -- Controlled transition from PENDING to COMPLETED or FAILED
          UPDATE public.extraction_candidates
          SET attempt_status = COALESCE(p_candidate->>'attempt_status', 'COMPLETED'),
              raw_value = COALESCE(p_candidate->>'raw_value', ''),
              normalized_value = p_candidate->>'normalized_value',
              confidence_score = (p_candidate->>'confidence_score')::NUMERIC,
              validation_status = COALESCE(p_candidate->>'validation_status', 'ACCEPTED'),
              validation_issues = COALESCE(p_candidate->'validation_issues', '[]'::jsonb),
              metadata = COALESCE(p_candidate->'metadata', '{}'::jsonb)
          WHERE id = v_existing_cand_id;
          v_candidate_b_id := v_existing_cand_id;
        END IF;
      END IF;
    END IF;

    -- If no existing candidate attempt found, insert fresh candidate
    IF v_candidate_b_id IS NULL THEN
      v_candidate_b_id := v_candidate_id;
      INSERT INTO public.extraction_candidates (
        id, document_id, cell_id, candidate_source, raw_value,
        normalized_value, confidence_score, confidence_source,
        provider, provider_version, attempt_number, attempt_status,
        preprocessing_variant, render_dpi, validation_status,
        validation_issues, is_selected, idempotency_key, metadata, created_at
      ) VALUES (
        v_candidate_b_id,
        p_document_id,
        p_cell_id,
        p_candidate->>'candidate_source',
        COALESCE(p_candidate->>'raw_value', ''),
        p_candidate->>'normalized_value',
        (p_candidate->>'confidence_score')::NUMERIC,
        p_candidate->>'confidence_source',
        COALESCE(p_candidate->>'provider', 'secondary-ocr'),
        p_candidate->>'provider_version',
        COALESCE((p_candidate->>'attempt_number')::INTEGER, 1),
        COALESCE(p_candidate->>'attempt_status', 'COMPLETED'),
        p_candidate->>'preprocessing_variant',
        (p_candidate->>'render_dpi')::INTEGER,
        COALESCE(p_candidate->>'validation_status', 'ACCEPTED'),
        COALESCE(p_candidate->'validation_issues', '[]'::jsonb),
        FALSE,
        v_idempotency_key,
        COALESCE(p_candidate->'metadata', '{}'::jsonb),
        v_now
      );
    END IF;
  END IF;

  -- 6. Validate Resolution Status & Invariants
  v_res_status := COALESCE(p_resolution->>'resolution_status', 'RESOLVED');
  v_res_method := COALESCE(p_resolution->>'resolution_method', 'NONE');
  v_selected_cand_id := (p_resolution->>'selected_candidate_id')::UUID;
  v_new_val_status := COALESCE(p_cell_updates->>'validation_status', v_current_val_status);
  v_semantic_dec := p_resolution->>'semantic_decision';

  -- Invariant Check: UNRESOLVED and HUMAN_REVIEW_REQUIRED MUST have validation_status = REVIEW_REQUIRED
  IF v_res_status IN ('UNRESOLVED', 'HUMAN_REVIEW_REQUIRED') AND v_new_val_status <> 'REVIEW_REQUIRED' THEN
    RAISE EXCEPTION 'UNRESOLVED_REQUIRES_REVIEW_REQUIRED'
      USING HINT = 'UNRESOLVED and HUMAN_REVIEW_REQUIRED resolutions must have validation_status = REVIEW_REQUIRED';
  END IF;

  -- Invariant Check: RESOLVED requires selected candidate
  IF v_res_status = 'RESOLVED' AND v_selected_cand_id IS NULL THEN
    RAISE EXCEPTION 'RESOLVED_STATE_REQUIRES_SELECTED_CANDIDATE';
  END IF;

  -- Invariant Check: Gemini UNKNOWN cannot automatically be RESOLVED
  IF v_semantic_dec = 'UNKNOWN' AND v_res_status = 'RESOLVED' THEN
    RAISE EXCEPTION 'GEMINI_UNKNOWN_CANNOT_BE_RESOLVED';
  END IF;

  -- 7. Validate candidate_a_id and candidate_b_id References
  IF p_resolution ? 'candidate_a_id' AND p_resolution->>'candidate_a_id' IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.extraction_candidates 
      WHERE id = (p_resolution->>'candidate_a_id')::UUID AND cell_id = p_cell_id AND document_id = p_document_id
    ) THEN
      RAISE EXCEPTION 'CANDIDATE_A_DOCUMENT_OR_CELL_MISMATCH';
    END IF;
  END IF;

  IF p_resolution ? 'candidate_b_id' AND p_resolution->>'candidate_b_id' IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.extraction_candidates 
      WHERE id = (p_resolution->>'candidate_b_id')::UUID AND cell_id = p_cell_id AND document_id = p_document_id
    ) THEN
      RAISE EXCEPTION 'CANDIDATE_B_DOCUMENT_OR_CELL_MISMATCH';
    END IF;
  END IF;

  -- Verify selected_candidate_id strictly belongs to this document and cell
  IF v_selected_cand_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.extraction_candidates
      WHERE id = v_selected_cand_id AND cell_id = p_cell_id AND document_id = p_document_id
    ) THEN
      RAISE EXCEPTION 'SELECTED_CANDIDATE_DOCUMENT_OR_CELL_MISMATCH';
    END IF;

    -- Maintain database-level partial unique index invariant (only 1 selected candidate per cell)
    UPDATE public.extraction_candidates
    SET is_selected = (id = v_selected_cand_id)
    WHERE cell_id = p_cell_id;
  END IF;

  -- 8. Upsert Current Resolution Snapshot (extraction_resolutions)
  INSERT INTO public.extraction_resolutions (
    document_id, cell_id, selected_candidate_id, resolution_status,
    resolution_method, reason_code, reason_message, semantic_decision,
    semantic_confidence, resolution_version, metadata, created_at, updated_at
  ) VALUES (
    p_document_id,
    p_cell_id,
    v_selected_cand_id,
    v_res_status,
    v_res_method,
    COALESCE(p_resolution->>'reason_code', 'RESOLUTION_RECORDED'),
    p_resolution->>'reason_message',
    v_semantic_dec,
    (p_resolution->>'semantic_confidence')::NUMERIC,
    COALESCE(p_resolution->>'resolution_version', 'resolve-v1'),
    COALESCE(p_resolution->'metadata', '{}'::jsonb),
    v_now,
    v_now
  )
  ON CONFLICT (cell_id) DO UPDATE SET
    selected_candidate_id = EXCLUDED.selected_candidate_id,
    resolution_status = EXCLUDED.resolution_status,
    resolution_method = EXCLUDED.resolution_method,
    reason_code = EXCLUDED.reason_code,
    reason_message = EXCLUDED.reason_message,
    semantic_decision = EXCLUDED.semantic_decision,
    semantic_confidence = EXCLUDED.semantic_confidence,
    resolution_version = EXCLUDED.resolution_version,
    metadata = EXCLUDED.metadata,
    updated_at = v_now;

  -- 9. Record Append-Only Decision Event
  INSERT INTO public.extraction_resolution_events (
    document_id, cell_id, candidate_a_id, candidate_b_id,
    selected_candidate_id, resolution_status, resolution_method,
    reason_code, reason_message, semantic_decision, semantic_confidence,
    resolution_event_key, metadata, created_at
  ) VALUES (
    p_document_id,
    p_cell_id,
    COALESCE((p_resolution->>'candidate_a_id')::UUID, v_candidate_a_id),
    COALESCE((p_resolution->>'candidate_b_id')::UUID, v_candidate_b_id),
    v_selected_cand_id,
    v_res_status,
    v_res_method,
    COALESCE(p_resolution->>'reason_code', 'RESOLUTION_EVENT'),
    p_resolution->>'reason_message',
    v_semantic_dec,
    (p_resolution->>'semantic_confidence')::NUMERIC,
    v_event_key,
    COALESCE(p_resolution->'metadata', '{}'::jsonb),
    v_now
  );

  -- 10. Update Target Cell (Preserves original_raw_value immutable)
  UPDATE public.extracted_cells
  SET raw_value = COALESCE(p_cell_updates->>'raw_value', raw_value),
      normalized_value = COALESCE(p_cell_updates->>'normalized_value', normalized_value),
      validation_status = v_new_val_status,
      validation_issues = COALESCE(p_cell_updates->'validation_issues', '[]'::jsonb),
      requires_secondary_ocr = COALESCE((p_cell_updates->>'requires_secondary_ocr')::BOOLEAN, false),
      resolution_status = v_res_status,
      resolution_method = v_res_method,
      original_raw_value = v_original_raw,
      confidence_score = COALESCE((p_cell_updates->>'confidence_score')::NUMERIC, confidence_score),
      confidence_source = COALESCE(p_cell_updates->>'confidence_source', confidence_source),
      updated_at = v_now
  WHERE id = p_cell_id;

  -- 11. Synchronize Current Validation Issues in public.validation_issues using Authoritative Cell Bounding Box
  DELETE FROM public.validation_issues WHERE cell_id = p_cell_id;

  SELECT id INTO v_latest_run_id
  FROM public.validation_runs
  WHERE document_id = p_document_id
  ORDER BY created_at DESC LIMIT 1;

  IF p_cell_updates ? 'validation_issues' AND jsonb_array_length(p_cell_updates->'validation_issues') > 0 THEN
    FOR v_issue_item IN SELECT * FROM jsonb_array_elements(p_cell_updates->'validation_issues')
    LOOP
      INSERT INTO public.validation_issues (
        id, run_id, document_id, table_id, cell_id, page_number,
        rule_code, severity, message, observed_value, expected_pattern,
        requires_secondary_ocr, bounding_box, coordinate_unit, created_at
      ) VALUES (
        gen_random_uuid(),
        v_latest_run_id,
        p_document_id,
        v_table_id,
        p_cell_id,
        v_page_number,
        v_issue_item->>'code',
        v_issue_item->>'severity',
        v_issue_item->>'message',
        v_issue_item->>'observedValue',
        v_issue_item->>'expected',
        COALESCE((v_issue_item->>'requiresSecondaryOcr')::BOOLEAN, false),
        v_cell_bbox, -- Authoritative bounding box locked from database
        COALESCE(v_cell_bbox->>'unit', 'point'),
        v_now
      );
    END LOOP;
  END IF;

  -- 12. Consistent Cell-Count Semantics for validation_runs
  SELECT 
    COUNT(*) FILTER (WHERE validation_status = 'REVIEW_REQUIRED'),
    COUNT(*) FILTER (WHERE validation_status = 'WARNING'),
    COUNT(*) FILTER (WHERE validation_status = 'ACCEPTED')
  INTO v_cell_review_count, v_cell_warning_count, v_cell_accepted_count
  FROM public.extracted_cells c
  JOIN public.extracted_rows r ON c.row_id = r.id
  JOIN public.extracted_tables t ON r.table_id = t.id
  WHERE t.document_id = p_document_id;

  -- Total error issues count across document (table-level, cell-level, metadata)
  SELECT COUNT(*) INTO v_total_error_issues
  FROM public.validation_issues
  WHERE document_id = p_document_id AND severity = 'ERROR';

  -- Document blocking invariant: any review cell, any error issue, or any pending/unresolved cell
  v_blocking_review_required := (v_cell_review_count > 0) 
    OR (v_total_error_issues > 0) 
    OR EXISTS (
      SELECT 1 FROM public.extracted_cells c
      JOIN public.extracted_rows r ON c.row_id = r.id
      JOIN public.extracted_tables t ON r.table_id = t.id
      WHERE t.document_id = p_document_id 
        AND c.resolution_status IN ('PENDING', 'UNRESOLVED', 'HUMAN_REVIEW_REQUIRED')
    );

  IF v_blocking_review_required THEN
    v_val_run_status := 'REVIEW_REQUIRED';
    v_doc_final_status := 'REVIEW_REQUIRED';
  ELSIF v_cell_warning_count > 0 THEN
    v_val_run_status := 'WARNING';
    v_doc_final_status := 'READY';
  ELSE
    v_val_run_status := 'ACCEPTED';
    v_doc_final_status := 'READY';
  END IF;

  -- Update validation_runs summary keeping consistent cell-count units
  UPDATE public.validation_runs
  SET status = v_val_run_status,
      review_required_count = v_cell_review_count,
      warning_count = v_cell_warning_count,
      accepted_count = v_cell_accepted_count
  WHERE id = v_latest_run_id;

  -- Update documents final status
  UPDATE public.documents
  SET status = v_doc_final_status,
      updated_at = v_now
  WHERE id = p_document_id;

  RETURN jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'cell_id', p_cell_id,
    'candidate_a_id', v_candidate_a_id,
    'candidate_b_id', v_candidate_b_id,
    'selected_candidate_id', v_selected_cand_id,
    'resolution_status', v_res_status,
    'resolution_method', v_res_method,
    'cell_validation_status', v_new_val_status,
    'document_status', v_doc_final_status,
    'review_required_cell_count', v_cell_review_count,
    'total_error_issues_remaining', v_total_error_issues
  );
END;
$$;

-- 6. STRICT PERMISSIONS
REVOKE ALL ON FUNCTION public.resolve_extraction_cell_atomic(UUID, UUID, UUID, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_extraction_cell_atomic(UUID, UUID, UUID, JSONB, JSONB, JSONB) TO service_role;
