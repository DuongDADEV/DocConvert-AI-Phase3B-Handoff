# DocConvert AI — Phase 3B Migration Cutover & Live Verification Runbook

## Document Information
- **Target Migration**: `supabase/migrations/20261004010000_atomic_credit_reserve_before_processing_queue.sql`
- **Scope**: Two-Stage Cutover Architecture (Stage A: Maintenance Bridge -> Stage B: Atomic Reservation Cutover)
- **Role Required**: Product Owner / Lead DevOps Engineer with Supabase Admin access
- **Status**: READY FOR OPERATOR EXECUTION

---

## 1. PRE-CUTOVER ARCHITECTURAL FOUNDATION

### 1.1 The Cutover Dependency Cycle Problem
A critical dependency cycle exists between the database migration and application deployment:
- **Old Backend + New DB = INCOMPATIBLE**: The legacy 3-arg RPC `confirm_document_processing(p_document_id UUID, p_user_id UUID, p_output_type VARCHAR DEFAULT 'EXCEL')` hard-fails with `PROCESSING_CONFIRM_SIGNATURE_DEPRECATED` after migration.
- **New Backend + Old DB = INCOMPATIBLE**: The full Phase 3B backend invokes the 8-arg RPC `confirm_document_processing(p_document_id UUID, p_user_id UUID, p_output_type VARCHAR, p_estimated_units BIGINT, p_pricing_version VARCHAR, p_quote_snapshot JSONB, p_idempotency_key TEXT, p_reservation_metadata JSONB)` and expects columns (`reservation_id`, `pricing_version`, `estimated_billable_units`, `quote_snapshot`) that do not exist in the old DB.
- **New Worker + Old Active Jobs = INCOMPATIBLE**: The full Phase 3B worker rejects any job lacking an active reservation (`MISSING_CREDIT_RESERVATION`), which would fail historical active jobs instead of allowing them to finish.

### 1.2 The Two-Stage Resolution Architecture
To eliminate this circular dependency and prevent any historical active job failure or cutover race condition, the deployment is divided into **TWO DISTINCT STAGES**:
1. **STAGE A — BACKWARD-COMPATIBLE MAINTENANCE BRIDGE**:
   - Runs against the **OLD DB**.
   - Uses the **OLD RPC contract** (3-arg `confirm_document_processing(UUID, UUID, VARCHAR)`).
   - Uses the **OLD worker behavior** (no reservation validation gate; drains historical jobs normally).
   - Introduces ONLY the `PROCESSING_MAINTENANCE_MODE=true` guard on external processing entry points.
2. **STAGE B — ATOMIC RESERVATION CUTOVER**:
   - Executed only after Stage A drains all active jobs to zero (`active_jobs_count = 0`).
   - Applies the Phase 3B database migration.
   - Deploys the Full Phase 3B backend (calling the 8-arg RPC) and worker.
   - Verifies database and runs smoke test.
   - Disables maintenance mode to resume normal operations.

---

## 2. COMPATIBILITY MATRIX

| Environment Combination | Compatibility Status | Operational Meaning |
| :--- | :--- | :--- |
| **OLD DB + OLD Backend** | **YES (Compatible)** | Current production baseline before cutover. |
| **OLD DB + MAINTENANCE BRIDGE (Stage A)** | **YES (Compatible)** | **Stage A bridge deployment**. Safe to deploy before migration; handles maintenance and draining. |
| **OLD DB + FULL Phase 3B Backend** | **NO (Incompatible)** | Fails because old DB lacks 8-arg RPC and Phase 3B columns. |
| **NEW DB + OLD Backend / Bridge** | **NO (Incompatible)** | Fails because migration makes 3-arg RPC hard-fail (`PROCESSING_CONFIRM_SIGNATURE_DEPRECATED`). |
| **NEW DB + FULL Phase 3B Backend (Stage B)** | **YES (Compatible)** | **Stage B target state**. Full atomic reservation and credit protection active. |

> [!CRITICAL]
> **Mixed-version deployment is strictly prohibited**. Never allow old backend or bridge instances to remain running after the database migration is applied in Stage B. Furthermore, during Stage A, **ALL** backend instances must run the Bridge artifact (no mixed old-backend / bridge instances).

---

## 3. STAGE A — BACKWARD-COMPATIBLE MAINTENANCE BRIDGE

### 3.1 Bridge Deployment Unit & Non-Regression Baseline
The Stage A Maintenance Bridge is a backward-compatible deployment unit derived from the **Latest Pre-Phase-3B Compatible Application State**:
- **Baseline Non-Regression Principle**:
  - Historical commit `3b4e410` (dated Sep 30) predates the entire Billing and Credit system (Phase 1, Phase 2A, Phase 2B, Phase 2C, Phase 3A, Phase 3A.4). It is **STRICTLY REJECTED** as a deployment baseline because deploying it would wipe out all billing catalog, credit ledger, pricing, and free bootstrap features (constituting an unacceptable system rollback/downgrade).
  - The **TRUE BRIDGE BASE** is defined as the latest application state immediately before Phase 3B atomic-reservation cutover (Phase 3A.4.2 baseline). It preserves 100% of all accepted functional features (Auth, Dashboard, Upload/Preflight, Review Workspace, Billing Catalog, Credit Ledger, Reservation Foundation, Processing Eligibility Guard, Pricing Engine v1, and Free Bootstrap).
- **Frozen Stage A Release Identity**:
  - **Release ID**: `stage-a-3b-bridge-20261004-03`
  - **Release Manifest**: `scripts/stage_a/stage_a_release_manifest.json`
  - **Source Manifest**: `scripts/stage_a/stage_a_source_manifest.txt` (content-based manifest of 150+ source files)
  - **Dist Manifest**: `scripts/stage_a/stage_a_dist_manifest.txt` (5 files full dist content-based)
  - **Dist Manifest SHA256**: `03a1c5389ee5ecdee6e59705542261a9838adc8873b72216f2fa2d356d49d2d5`
  - **Server Bundle SHA256**: `93e8c12dd1789165d26987da7e0459ce73fe33bb0d333c8243c445b1c81eabc3`
  - **Patch SHA256**: `b0ff240b66f9f68508e7aa6f8bbbe5a67fb58ce4bc26b83e238b9abe97a13c81`
  - **Materializer SHA256**: `355fe9766e7b2b2ed970afdda155b1a1ff4f289e12d635225664c9e43634b5cf`
  - **Release Verifier Script**: `scripts/stage_a/verify_stage_a_release.ts`
  - **Hosting Safety Checklist**: `scripts/stage_a/stage_a_hosting_verification_checklist.md`
- **Materialized Stage A Artifact Directory**:
  - **Directory**: `.stage_a_artifact/` (isolated, non-destructive standalone deployable build directory)
  - **Patch File**: `scripts/stage_a/stage_a_runtime_deltas.patch`
  - **Reproduction Script**: `npx tsx scripts/stage_a/materialize_stage_a.ts`
  - **Pre-Deploy Supabase Check SQL**: `scripts/stage_a/stage_a_predeploy_supabase_check.sql` (100% read-only)
  - **Surgically Excluded Runtime Deltas**:
    1. `server/routes/documents.ts`: Excludes 8-arg quote parameters from `confirmDocumentProcessing` (calls legacy 3-arg contract) and excludes reservation metadata from response, while **retaining** the fail-closed `PROCESSING_MAINTENANCE_MODE=true` guard (HTTP 503).
    2. `server/services/ocrWorker.ts`: Excludes Phase 3B `getValidatedReservationForJob` hard gate to allow legacy historical jobs to drain to zero without `MISSING_CREDIT_RESERVATION` failure.
- **Preserved Feature Surface**: 100% preserved (all billing routes, credit routes, auth routes, review workspace, pricing engine v1, preflight services, and Phase 3B.3.7 UUID defect fixes).
- **Deployment Platform & Auto-Migration Separation**:
  - **REPOSITORY_AUTO_MIGRATION = NO**: Checked and verified in package scripts, build configs, and server startup.
  - **HOSTING_PLATFORM = NOT_VERIFIED**: Hosting backend dashboard settings must be manually confirmed via `scripts/stage_a/stage_a_hosting_verification_checklist.md`.
  - **HOSTING_PLATFORM_AUTO_MIGRATION = NOT_VERIFIED**: Operator must confirm hosting dashboard contains no migration commands before final deploy.
  - Deployment is strictly application code bundle only (`dist/server.cjs` and Vite client assets).
- **Fleet Consistency Requirement**: **ALL_STAGE_A_INSTANCES_REQUIRE_SAME_RELEASE = YES**. Every instance must run release `stage-a-3b-bridge-20261004-03`.
- **Artifact Immutability Rule**: If server bundle hash, patch hash, source manifest hash, or dist manifest hash changes, the artifact must be treated as a new release requiring re-verification.

### 3.2 Step-by-Step Stage A Execution Sequence
Follow the exact 12-step release sequence:

#### Step A.1: Verify Release Manifest Hashes & Run Verification Script
1. Inspect `scripts/stage_a/stage_a_release_manifest.json`.
2. Run automated verifier: `npx tsx scripts/stage_a/verify_stage_a_release.ts` (PASS).
3. Confirm clean `npm ci --dry-run` against `package-lock.json`.
4. Complete operator checklist `scripts/stage_a/stage_a_hosting_verification_checklist.md`.

#### Step A.2: Run Pre-Deploy Supabase Read-Only Checks
1. In Supabase Dashboard -> **SQL Editor**, open and run:
   `scripts/stage_a/stage_a_predeploy_supabase_check.sql`
2. Confirm:
   - PRE-01: Active jobs count noted (may be >= 0; will drain under Stage A).
   - PRE-02: Phase 3B processing_jobs columns return 0 rows (not yet migrated).
   - PRE-03: Legacy 3-arg `confirm_document_processing` exists.
   - PRE-04: New 8-arg RPC does not exist or is unmigrated.
   - PRE-05: Phase 2A tables (`credit_accounts`, `credit_grants`, `credit_ledger`) exist.
   - PRE-06: Phase 2B tables (`credit_reservations`, `credit_reservation_allocations`) exist.

#### Step A.3: Deploy Exact Verified Stage A Artifact to ALL Backend Instances
1. Deploy `.stage_a_artifact/dist/server.cjs` and frontend assets to **ALL** backend instances in the fleet.
2. Confirm `STAGE_A_RELEASE_ID = stage-a-3b-bridge-20261004-03` across all instances.

#### Step A.4: Verify Fleet Consistency
1. Verify all instances report identical build timestamp and version.
2. Prohibit any mixed fleet (no old-legacy instance without bridge allowed).

#### Step A.5: Keep Maintenance OFF Initially & Configure Free Bootstrap Policy
1. Initial environment variables:
   ```env
   PROCESSING_MAINTENANCE_MODE=false
   ```
2. **Correct Railway Deployment Target**:
   - **Workspace**: `DuongAIOS's Projects`
   - **Project**: `zealous-friendship` *(Note: Railway Project name is zealous-friendship, NOT DocConvert-AI)*
   - **Environment**: `production`
   - **Service**: `DocConvert-AI`
3. **Locked Free Credit Business Policy**:
   - **SUBSCRIPTION**: Monthly billing cycle; credits granted per cycle; no rollover; next cycle grants new subscription credits.
   - **CREDIT PACK**: Purchase adds credits; credits do NOT expire in MVP; no monthly reset.
   - **FREE BOOTSTRAP**: Every NEW account after policy go-live receives 10 credits exactly once (regardless of future auth method email/password, Google Login, etc.); no monthly refresh; no expiry in MVP; no historical automatic backfill; one-time idempotency enforced.
   - `FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT` is ONLY the eligibility boundary between historical accounts and new accounts. It is NOT subscription expiration, NOT credit expiration, and NOT monthly refresh date.
4. **Set Production Policy Timestamp**:
   In Railway Dashboard -> Project **zealous-friendship** -> Service **DocConvert-AI** -> **Variables** tab:
   Set `FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT` to the official production go-live timestamp:
   ```env
   FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT="2026-10-04T20:55:00+07:00"
   ```
   *(or equivalent UTC value chosen immediately before redeploy; restart/redeploy is required after setting this variable in Railway so process.env is reloaded).*
5. Allow instances to boot cleanly.

#### Step A.6: Confirm App Health Against Live OLD DB
1. Verify basic application health:
   - User login & signup: OK (no `FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED` emitted)
   - Dashboard: OK
   - File upload: OK
   - Preflight analysis: OK (document reaches `WAITING_CONFIRMATION`, no `[object Object]` UUID errors)

#### Step A.7: Enable Processing Maintenance Mode on ALL Instances
1. In hosting environment (Vercel / server environment variables):
   ```env
   PROCESSING_MAINTENANCE_MODE=true
   ```

#### Step A.8: Restart / Reload All Backend Instances
1. Trigger rolling reload or restart on all instances to guarantee `PROCESSING_MAINTENANCE_MODE=true` is loaded.

#### Step A.9: Confirm POST /process Returns 503
1. Call `POST /api/documents/:id/process`:
   - Returns **HTTP 503 Service Unavailable** with code `PROCESSING_TEMPORARILY_UNAVAILABLE`.
   - Confirmed no job created, no quota incremented, no financial mutation.

#### Step A.10: Confirm POST /ocr Returns 503
1. Call `POST /api/documents/:id/ocr`:
   - Returns **HTTP 503 Service Unavailable**.

#### Step A.11: Confirm Existing Worker Is Actively Draining Jobs (Drain Active Jobs Under Old Worker)
1. Background worker instances running Stage A continue processing existing `QUEUED` / `PROCESSING` jobs.
2. Because the bridge runs the old worker without the Phase 3B reservation gate:
   - All in-flight `QUEUED` and `PROCESSING` jobs will continue to normal completion (`READY` or `REVIEW_REQUIRED`).
3. Monitor drain status in Supabase SQL Editor:
   ```sql
   SELECT status, COUNT(*) AS count
   FROM public.processing_jobs
   WHERE status IN ('QUEUED', 'PROCESSING')
   GROUP BY status;
   ```

#### Step A.12: Monitor Active Jobs Count to Zero (Double-Check Zero Active Jobs)
1. **Check 1**: Run Query 0.1 in Supabase SQL Editor:
   ```sql
   SELECT
       COUNT(*) AS active_jobs_count,
       CASE 
           WHEN COUNT(*) = 0 THEN 'SAFE_FOR_MIGRATION_CUTOVER'
           ELSE 'WAIT_ACTIVE_JOBS_STILL_RUNNING'
       END AS pre_apply_cutover_status
   FROM public.processing_jobs
   WHERE status IN ('QUEUED', 'PROCESSING');
   ```
2. Wait **15 seconds** (ensures no micro-tasks or in-flight retries are pending).
3. **Check 2**: Run the exact same query again.
4. **Precondition for proceeding**: Both Check 1 and Check 2 must return `active_jobs_count = 0` (`SAFE_FOR_MIGRATION_CUTOVER`).
   - If `active_jobs_count > 0`: **STOP**. Wait for remaining jobs to complete.
5. When both checks return `active_jobs_count = 0`, Stage A is COMPLETE. System is ready for Stage B DB Migration.

---

## 4. STAGE B — ATOMIC RESERVATION CUTOVER

### 4.1 Deployment Safety & Railway CLI Policy
> [!CRITICAL]
> **GITHUB AUTO-DEPLOYMENT PROHIBITED FOR PRODUCTION**:
> GitHub-triggered Railway auto-deployments currently fail due to `bun install --frozen-lockfile` duplicate Vite dependency / lockfile drift in Railway's default buildpack.
> All production deployments must strictly use the **Railway CLI** to deploy the sealed pre-built artifact directory:
> ```bash
> cd .phase3b_production_artifact
> railway up . --path-as-root --no-gitignore --service DocConvert-AI --environment production --message "phase3b-full-runtime-20261005-02"
> ```
> Changing environment variables via Railway dashboard can inadvertently trigger failed GitHub-based builds. Whenever environment variables are altered, the operator must redeploy the sealed artifact via CLI to maintain container health.

### 4.2 Step-by-Step Two-Stage Cutover Model

#### Step B.1: Apply Phase 3B DB Migration & Verify Baseline
1. Confirm live DB already has applied:
   - `supabase/migrations/20261004010000_atomic_credit_reserve_before_processing_queue.sql`
   - `supabase/migrations/20261005010000_fix_grant_user_credits_ledger_entry_type.sql`
2. Run read-only verification queries:
   `scripts/phase3b/phase3b_predeploy_read_only_checks.sql`
3. Confirm:
   - 4 Phase 3B columns present on `processing_jobs` (`reservation_id`, `pricing_version`, `estimated_billable_units`, `quote_snapshot`).
   - Extended 8-arg `confirm_document_processing` exists.
   - Legacy 3-arg `confirm_document_processing` raises exception (`PROCESSING_CONFIRM_SIGNATURE_DEPRECATED`).
   - `active_jobs_count = 0`.

#### Step B.2: STAGE 1 — Safe Runtime Deployment (Maintenance Mode ON)
1. Ensure hosting environment maintains:
   ```env
   PROCESSING_MAINTENANCE_MODE=true
   ```
2. Deploy the sealed Full Phase 3B production artifact via Railway CLI:
   ```bash
   cd .phase3b_production_artifact
   railway up . --path-as-root --no-gitignore --service DocConvert-AI --environment production --message "phase3b-full-runtime-20261005-02"
   ```
3. Verify Stage 1 Health & Invariants:
   - [ ] Container boots cleanly without crash loops.
   - [ ] Main API & health endpoints respond normally.
   - [ ] `POST /api/documents/:id/process` returns HTTP 503 with JSON `code: 'PROCESSING_TEMPORARILY_UNAVAILABLE'`.
   - [ ] `POST /api/documents/:id/ocr` returns HTTP 503 with JSON `code: 'PROCESSING_TEMPORARILY_UNAVAILABLE'`.
   - [ ] Read-only checks confirm DB contract matches runtime.
   - [ ] `active_jobs_count = 0`.
   - [ ] Test user credit balance endpoint (`GET /api/credits/balance`) is readable.
   - [ ] Worker startup (`ocrWorker.resumeUnfinishedJobs()`) reports 0 unreserved jobs and no schema errors.

   > [!NOTE]
   > `PROCESSING_MAINTENANCE_MODE` is enforced ONLY at the HTTP intake routes `POST /:id/process` and `POST /:id/ocr` (`server/routes/documents.ts`). The OCR worker does NOT read this flag (by design, so already-queued jobs can drain). Maintenance therefore stops NEW intake only; `active_jobs_count = 0` is the separate precondition proving nothing is in flight.
4. When all 8 checks pass:
   ```env
   READY_FOR_CONTROLLED_MAINTENANCE_OFF = YES
   ```

#### Step B.3: STAGE 2 — Controlled Maintenance-Off Test
1. Set maintenance mode to false in hosting environment:
   ```env
   PROCESSING_MAINTENANCE_MODE=false
   ```
2. Redeploy the **SAME sealed Full Phase 3B release artifact** via Railway CLI:
   ```bash
   cd .phase3b_production_artifact
   railway up . --path-as-root --no-gitignore --service DocConvert-AI --environment production --message "phase3b-full-runtime-20261005-02-maintenance-off"
   ```
3. Execute **ONE controlled document test** on designated test account:
   - Use a NEW document in `WAITING_CONFIRMATION`. Use ONLY `POST /api/documents/:id/process`.
   - Do NOT use `POST /api/documents/:id/ocr` (retry) for the controlled test: that path (`ocrService.retryDocumentProcessing`) re-queues a job WITHOUT creating a new reservation, so the worker hard gate will fail it closed with `MISSING_CREDIT_RESERVATION` (no OCR cost, but not a valid smoke signal).
   - Call Preflight to inspect page count and pricing.
   - Call `POST /api/documents/:id/process`.
   - Server recomputes trusted quote (`processing-pricing-v1`).
   - Atomic DB reservation executes before queue placement.
   - Document status set to `QUEUED`.
   - Worker picks up job and runs `getValidatedReservationForJob` hard gate (must pass).
   - OCR executes.
   - Terminal status reached (`READY` or `REVIEW_REQUIRED`).
   - Credit settlement executes: reservation CAPTURED (or SETTLED when partially captured and remainder released).
4. Verify Post-Processing Database State:
   - [ ] `credit_reservations` row exists with `status IN ('CAPTURED', 'SETTLED')` (allowed values per `chk_credit_reservations_status`: RESERVED, PARTIALLY_CAPTURED, CAPTURED, RELEASED, SETTLED, EXPIRED).
   - [ ] `credit_reservations.reference_type = 'PROCESSING_JOB'` and `reference_id = processing_jobs.id`.
   - [ ] `processing_jobs.reservation_id` links to `credit_reservations.id`.
   - [ ] `processing_jobs.estimated_billable_units` persisted.
   - [ ] `processing_jobs.pricing_version` persisted.
   - [ ] `processing_jobs.quote_snapshot` persisted.
   - [ ] Worker did NOT reject job with `MISSING_CREDIT_RESERVATION`.
   - [ ] `credit_ledger` has corresponding `CAPTURE` entry.
   - [ ] Reserved units returned to zero for this reservation; available credits decreased by captured units.
   - [ ] `active_jobs_count = 0`.
5. When verified: Full Phase 3B cutover is complete and live traffic may continue.

#### Step B.4: Immediate Rollback Procedure
If the controlled test fails at any point (or unexpected error occurs):
1. **IMMEDIATELY** set:
   ```env
   PROCESSING_MAINTENANCE_MODE=true
   ```
2. Redeploy the **SAME sealed Full Phase 3B release artifact** via Railway CLI to re-engage the fail-closed maintenance barrier.
3. Verify:
   - `POST /api/documents/:id/process` returns HTTP 503.
   - `POST /api/documents/:id/ocr` returns HTTP 503.
   - `active_jobs_count` is inspected.
4. Perform root-cause diagnosis from server/worker logs before any retry.
5. Do NOT roll back to Stage A unless the Full Phase 3B runtime itself is proven fundamentally incompatible.

---

## 5. STOP CRITERIA & EMERGENCY STRATEGY

### 5.1 Immediate Stop Conditions
Do NOT proceed to Stage B or re-enable processing if:
- `active_jobs_count > 0` before migration apply.
- Migration returns any SQL error.
- Any automated or manual catalog check fails.
- Legacy 3-arg RPC is called by an un-terminated old backend instance.
- Worker encounters unreserved active jobs.
- Controlled test fails reservation, queueing, or capture.

### 5.2 Rollback vs. Roll-Forward Policy
- **During Stage A (Bridge)**: Fully reversible at any time by unsetting `PROCESSING_MAINTENANCE_MODE`.
- **During Stage B (Before Any Real Reservation)**: Added DB columns are `NULLABLE`. RPCs can be reverted to old definition if old backend needs to be restored.
- **During Stage B (After Real Reservations Exist)**:
  - **ROLL-FORWARD IS MANDATORY**: Once real `credit_reservations` exist, deleting columns or reservations corrupts the financial ledger.
  - In an emergency: Keep `PROCESSING_MAINTENANCE_MODE=true`, leave data intact, and patch forward.
  - **NEVER** run `DELETE FROM credit_reservations` or `DELETE FROM credit_ledger`.

---

## 6. OPERATOR CHECKLIST

```markdown
=== STAGE A: MAINTENANCE BRIDGE (HISTORICAL) ===
[x] 1. Deploy Stage A Maintenance Bridge to production (OLD DB compatible)
[x] 2. Confirm service healthy against OLD DB
[x] 3. Set PROCESSING_MAINTENANCE_MODE=true in environment
[x] 4. Confirm POST /process returns 503 PROCESSING_TEMPORARILY_UNAVAILABLE
[x] 5. Confirm POST /ocr returns 503 PROCESSING_TEMPORARILY_UNAVAILABLE
[x] 6. Confirm existing worker drained historical jobs
[x] 7. Query active jobs: count = 0 (verified twice)

=== DATABASE MIGRATION BASELINE ===
[x] 8. Apply migration 20261005010000_fix_grant_user_credits_ledger_entry_type.sql (Applied)
[x] 9. Apply migration 20261004010000_atomic_credit_reserve_before_processing_queue.sql (Applied)
[ ] 10. Run scripts/phase3b/phase3b_predeploy_read_only_checks.sql (operator must confirm A–F pass immediately before deploy)

=== STAGE B: STAGE 1 — SAFE RUNTIME DEPLOYMENT (MAINTENANCE ON) ===
[ ] 11. Ensure PROCESSING_MAINTENANCE_MODE=true in Railway environment
[ ] 12. Deploy sealed artifact via Railway CLI:
        cd .phase3b_production_artifact
        railway up . --path-as-root --no-gitignore --service DocConvert-AI --environment production --message "phase3b-full-runtime-20261005-02"
[ ] 13. Verify container booted cleanly without crash loop
[ ] 14. Verify GET /api/credits/balance responds
[ ] 15. Verify POST /api/documents/:id/process returns HTTP 503
[ ] 16. Verify POST /api/documents/:id/ocr returns HTTP 503
[ ] 17. Verify active_jobs_count = 0
[ ] 18. Verify worker startup logged 0 unreserved jobs and no schema errors

=== STAGE B: STAGE 2 — CONTROLLED MAINTENANCE-OFF TEST ===
[ ] 19. Set PROCESSING_MAINTENANCE_MODE=false in Railway environment
[ ] 20. Redeploy SAME sealed artifact via Railway CLI:
        cd .phase3b_production_artifact
        railway up . --path-as-root --no-gitignore --service DocConvert-AI --environment production --message "phase3b-full-runtime-20261005-02-maintenance-off"
[ ] 21. Execute 1 controlled test document processing:
        - Upload / Preflight (page count & quote verified)
        - Confirm processing via POST /api/documents/:id/process
        - Confirm reservation created and linked to processing_job
        - Confirm worker validates reservation and completes OCR
        - Confirm reservation status = COMPLETED and credit captured
        - Confirm active_jobs_count = 0
[ ] 22. If test fails: IMMEDIATELY set PROCESSING_MAINTENANCE_MODE=true and redeploy artifact CLI
[ ] 23. If test succeeds: System is LIVE for normal production traffic.
```
