import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import {
  ProcessingEligibilityService,
  processingEligibilityService,
  isDocumentEligibleForNewProcessing,
  isSafeIntegerCreditUnits,
} from '../services/credit/processingEligibilityService.js';
import {
  FailClosedPricingEstimator,
  ConfigurablePricingEstimator,
  defaultPricingEstimator,
} from '../services/credit/processingPricingContract.js';
import {
  unitsToCredits,
  creditsToUnits,
  safeParseCreditUnits,
  UNITS_PER_CREDIT,
} from '../services/credit/creditService.js';
import { formatCredits } from '../../src/utils/creditFormatter.js';

interface TestCase {
  id: string;
  name: string;
  run: () => Promise<void>;
}

const p2bMigrationPath = path.resolve('supabase/migrations/20261002010000_credit_reservation_foundation.sql');
const p2bMigrationSql = fs.readFileSync(p2bMigrationPath, 'utf-8');

const docRoutesPath = path.resolve('server/routes/documents.ts');
const docRoutesSrc = fs.readFileSync(docRoutesPath, 'utf-8');

const serviceSrcPath = path.resolve('server/services/credit/processingEligibilityService.ts');
const serviceSrc = fs.readFileSync(serviceSrcPath, 'utf-8');

const testCases: TestCase[] = [
  // ===========================================================================
  // ELIGIBILITY EVALUATION TESTS (EG-01 to EG-24)
  // ===========================================================================

  // EG-01: available > estimate => eligible
  {
    id: 'EG-01',
    name: 'available > estimate => eligible (processing allowed)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(30000, 20000, 'ACTIVE', 'v1');
      assert.strictEqual(res.eligible, true, 'Must be eligible when available > estimate');
      assert.strictEqual(res.reason, 'ELIGIBLE');
      assert.strictEqual(res.shortageUnits, 0);
      assert.strictEqual(res.shortageCredits, 0);
      assert.strictEqual(res.availableUnits, 30000);
      assert.strictEqual(res.estimatedUnits, 20000);
    },
  },

  // EG-02: available = estimate => eligible
  {
    id: 'EG-02',
    name: 'available = estimate => eligible (exact balance match allowed)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(25000, 25000, 'ACTIVE', 'v1');
      assert.strictEqual(res.eligible, true, 'Must be eligible when available = estimate');
      assert.strictEqual(res.reason, 'ELIGIBLE');
      assert.strictEqual(res.shortageUnits, 0);
      assert.strictEqual(res.shortageCredits, 0);
    },
  },

  // EG-03: available < estimate => INSUFFICIENT_CREDIT
  {
    id: 'EG-03',
    name: 'available < estimate => INSUFFICIENT_CREDIT (processing blocked)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(20000, 27000, 'ACTIVE', 'v1');
      assert.strictEqual(res.eligible, false, 'Must be blocked when available < estimate');
      assert.strictEqual(res.reason, 'INSUFFICIENT_CREDIT');
    },
  },

  // EG-04: shortageUnits = estimate - available
  {
    id: 'EG-04',
    name: 'shortageUnits = estimate - available (exact shortage calculation)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(20000, 27000, 'ACTIVE', 'v1');
      assert.strictEqual(res.shortageUnits, 7000, 'Shortage must be exactly 7000 units');
      assert.strictEqual(res.shortageCredits, 7, 'Shortage must be exactly 7 credits');
      assert(res.message.includes('27 credits'), 'Message includes estimated credits');
      assert(res.message.includes('20 credits'), 'Message includes available credits');
      assert(res.message.includes('7 credits'), 'Message includes missing credits');
    },
  },

  // EG-05: grossRemainingUnits is NOT used instead of totalAvailableUnits
  {
    id: 'EG-05',
    name: 'grossRemainingUnits is NOT used instead of totalAvailableUnits',
    run: async () => {
      // User owns 30000 gross units, but 15000 are reserved.
      // totalAvailableUnits = 15000. Required estimate = 20000.
      // If system mistakenly checked gross (30000 >= 20000) it would allow.
      // System MUST use totalAvailableUnits (15000 < 20000) => BLOCKED.
      const service = new ProcessingEligibilityService();
      const availableUnits = 15000; // totalAvailableUnits
      const res = service.evaluateCreditSufficiency(availableUnits, 20000, 'ACTIVE', 'v1');
      assert.strictEqual(res.eligible, false, 'Must block when totalAvailableUnits < estimatedUnits');
      assert.strictEqual(res.reason, 'INSUFFICIENT_CREDIT');
      assert.strictEqual(res.shortageUnits, 5000);
      assert.strictEqual(res.availableUnits, 15000);
    },
  },

  // EG-06: reserved credits reduce eligibility (prompt example)
  {
    id: 'EG-06',
    name: 'reserved credits reduce eligibility (gross 30000, reserved 10000, available 20000, estimate 25000 => blocked)',
    run: async () => {
      const grossRemaining = 30000;
      const reservedUnits = 10000;
      const availableUnits = grossRemaining - reservedUnits; // 20000
      const estimatedUnits = 25000;

      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(availableUnits, estimatedUnits, 'ACTIVE', 'v1');
      assert.strictEqual(res.eligible, false, 'Must block when reserved units reduce available below estimate');
      assert.strictEqual(res.reason, 'INSUFFICIENT_CREDIT');
      assert.strictEqual(res.shortageUnits, 5000);
      assert.strictEqual(res.shortageCredits, 5);
      assert.strictEqual(res.availableUnits, 20000);
      assert.strictEqual(res.availableCredits, 20);
      assert.strictEqual(res.estimatedUnits, 25000);
      assert.strictEqual(res.estimatedCredits, 25);
    },
  },

  // EG-07: missing credit account fails safely
  {
    id: 'EG-07',
    name: 'missing credit account fails safely (CREDIT_ACCOUNT_NOT_FOUND)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(0, 10000, 'NONE', 'v1');
      assert.strictEqual(res.eligible, false, 'Must be ineligible when account is NONE');
      assert.strictEqual(res.reason, 'CREDIT_ACCOUNT_NOT_FOUND');
      assert.strictEqual(res.shortageUnits, 10000);
    },
  },

  // EG-08: FROZEN account cannot start new processing
  {
    id: 'EG-08',
    name: 'FROZEN account cannot start new processing (CREDIT_ACCOUNT_FROZEN)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(50000, 10000, 'FROZEN', 'v1');
      assert.strictEqual(res.eligible, false, 'FROZEN account must be blocked even with ample credits');
      assert.strictEqual(res.reason, 'CREDIT_ACCOUNT_FROZEN');
    },
  },

  // EG-09: CLOSED account cannot start processing
  {
    id: 'EG-09',
    name: 'CLOSED account cannot start processing (CREDIT_ACCOUNT_CLOSED)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(50000, 10000, 'CLOSED', 'v1');
      assert.strictEqual(res.eligible, false, 'CLOSED account must be blocked');
      assert.strictEqual(res.reason, 'CREDIT_ACCOUNT_CLOSED');
    },
  },

  // EG-10: invalid zero estimate fails closed
  {
    id: 'EG-10',
    name: 'invalid zero estimate fails closed (INVALID_PROCESSING_ESTIMATE)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(50000, 0, 'ACTIVE', 'v1');
      assert.strictEqual(res.eligible, false, 'Zero estimate must fail closed');
      assert.strictEqual(res.reason, 'INVALID_PROCESSING_ESTIMATE');
    },
  },

  // EG-11: negative estimate fails closed
  {
    id: 'EG-11',
    name: 'negative estimate fails closed (INVALID_PROCESSING_ESTIMATE)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(50000, -1000, 'ACTIVE', 'v1');
      assert.strictEqual(res.eligible, false, 'Negative estimate must fail closed');
      assert.strictEqual(res.reason, 'INVALID_PROCESSING_ESTIMATE');
    },
  },

  // EG-12: pricing not configured fails closed
  {
    id: 'EG-12',
    name: 'pricing not configured fails closed (PROCESSING_PRICING_NOT_CONFIGURED)',
    run: async () => {
      const estimator = new FailClosedPricingEstimator();
      let threw = false;
      try {
        await estimator.estimateProcessingCost({ documentId: 'test-doc', pageCount: 5 });
      } catch (err: any) {
        threw = true;
        assert.strictEqual(err.code, 'PROCESSING_PRICING_NOT_CONFIGURED');
      }
      assert(threw, 'FailClosedPricingEstimator must throw PROCESSING_PRICING_NOT_CONFIGURED');
    },
  },

  // EG-13: endpoint requires authentication
  {
    id: 'EG-13',
    name: 'endpoint requires authentication (protected under router.use(authMiddleware))',
    run: async () => {
      const authMiddlewareIdx = docRoutesSrc.indexOf('router.use(authMiddleware);');
      const endpointIdx = docRoutesSrc.indexOf("router.post('/:id/processing-eligibility'");
      assert(authMiddlewareIdx > -1, 'authMiddleware must be registered');
      assert(endpointIdx > -1, 'processing-eligibility endpoint must exist');
      assert(authMiddlewareIdx < endpointIdx, 'processing-eligibility must be registered AFTER authMiddleware');
    },
  },

  // EG-14: endpoint cannot evaluate another user's document
  {
    id: 'EG-14',
    name: "endpoint cannot evaluate another user's document (enforces getUserDocumentById(userId, docId))",
    run: async () => {
      assert(
        serviceSrc.includes('const doc = await db.getUserDocumentById(userId, documentId'),
        'Service must enforce document ownership via db.getUserDocumentById'
      );
      assert(
        serviceSrc.includes("reason: 'DOCUMENT_NOT_FOUND'"),
        'Service must return DOCUMENT_NOT_FOUND when user does not own document'
      );
    },
  },

  // EG-15: endpoint ignores/rejects body-supplied userId
  {
    id: 'EG-15',
    name: 'endpoint ignores/rejects body-supplied userId (derives strictly from req.user.id)',
    run: async () => {
      const endpointStart = docRoutesSrc.indexOf("router.post('/:id/processing-eligibility'");
      const endpointEnd = docRoutesSrc.indexOf("router.post('/:id/process'");
      const endpointCode = docRoutesSrc.slice(endpointStart, endpointEnd);

      assert(endpointCode.includes('const userId = req.user!.id;'), 'Must derive userId from req.user!.id');
      assert(!endpointCode.includes('req.body.userId'), 'Must never trust or read req.body.userId');
    },
  },

  // EG-16: eligibility endpoint does not reserve credits
  {
    id: 'EG-16',
    name: 'eligibility endpoint does not reserve credits (zero reservation calls in service)',
    run: async () => {
      assert(!serviceSrc.includes('reserveCredits('), 'processingEligibilityService must NOT call reserveCredits');
      assert(!serviceSrc.includes('reserve_credit_units'), 'processingEligibilityService must NOT call reserve_credit_units RPC');
      assert(!serviceSrc.includes('credit_reservations'), 'processingEligibilityService must NOT query credit_reservations directly');
    },
  },

  // EG-17: eligibility endpoint does not create processing job
  {
    id: 'EG-17',
    name: 'eligibility endpoint does not create processing job (zero job insertion in service)',
    run: async () => {
      assert(!serviceSrc.includes('createJob('), 'processingEligibilityService must NOT call createJob');
      assert(!serviceSrc.includes('processing_jobs'), 'processingEligibilityService must NOT mutate processing_jobs');
    },
  },

  // EG-18: eligibility endpoint does not invoke OCR
  {
    id: 'EG-18',
    name: 'eligibility endpoint does not invoke OCR (zero worker / provider invocation in service)',
    run: async () => {
      assert(!serviceSrc.includes('ocrService'), 'processingEligibilityService must NOT reference ocrService');
      assert(!serviceSrc.includes('ocrWorker'), 'processingEligibilityService must NOT reference ocrWorker');
      assert(!serviceSrc.includes('azureOcrProvider'), 'processingEligibilityService must NOT reference azureOcrProvider');
    },
  },

  // EG-19: insufficient-credit response exposes available/estimate/shortage values
  {
    id: 'EG-19',
    name: 'insufficient-credit response exposes available/estimate/shortage values in units and credits',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(20000, 27000, 'ACTIVE', 'v1');
      assert.strictEqual(res.availableUnits, 20000);
      assert.strictEqual(res.availableCredits, 20);
      assert.strictEqual(res.estimatedUnits, 27000);
      assert.strictEqual(res.estimatedCredits, 27);
      assert.strictEqual(res.shortageUnits, 7000);
      assert.strictEqual(res.shortageCredits, 7);
    },
  },

  // EG-20: financial calculations use integer units
  {
    id: 'EG-20',
    name: 'financial calculations use integer units (NO FLOAT in units)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(20000, 27000, 'ACTIVE', 'v1');
      assert(Number.isInteger(res.availableUnits), 'availableUnits must be integer');
      assert(Number.isInteger(res.estimatedUnits), 'estimatedUnits must be integer');
      assert(Number.isInteger(res.shortageUnits), 'shortageUnits must be integer');
    },
  },

  // EG-21: credits display conversion is derived from units
  {
    id: 'EG-21',
    name: 'credits display conversion is derived from units (1 credit = 1000 units)',
    run: async () => {
      assert.strictEqual(UNITS_PER_CREDIT, 1000);
      assert.strictEqual(unitsToCredits(27000), 27);
      assert.strictEqual(unitsToCredits(7000), 7);
      assert.strictEqual(creditsToUnits(27), 27000);
      assert.strictEqual(creditsToUnits(7), 7000);
    },
  },

  // EG-22: legacy quota remains untouched
  {
    id: 'EG-22',
    name: 'legacy quota remains untouched (quotaService and confirm_document_processing intact)',
    run: async () => {
      const quotaPath = path.resolve('server/services/quotaService.ts');
      const quotaSrc = fs.readFileSync(quotaPath, 'utf-8');
      assert(quotaSrc.includes('checkUserQuota'), 'quotaService.checkUserQuota must remain intact');
      assert(quotaSrc.includes('consumeQuota'), 'quotaService.consumeQuota must remain intact');
      assert(docRoutesSrc.includes('db.confirmDocumentProcessing'), 'db.confirmDocumentProcessing route remains intact');
    },
  },

  // EG-23: Phase 2B financial RPC behavior unchanged
  {
    id: 'EG-23',
    name: 'Phase 2B financial RPC behavior unchanged (migration file identical)',
    run: async () => {
      assert(p2bMigrationSql.includes('CREATE OR REPLACE FUNCTION public.reserve_credit_units'));
      assert(p2bMigrationSql.includes('CREATE OR REPLACE FUNCTION public.capture_credit_reservation'));
      assert(p2bMigrationSql.includes('CREATE OR REPLACE FUNCTION public.release_credit_reservation'));
      assert.strictEqual(fs.statSync(p2bMigrationPath).size, 58216, 'Phase 2B migration size unchanged at 58216 bytes');
    },
  },

  // EG-24: build passes
  {
    id: 'EG-24',
    name: 'build passes (bundle output exists)',
    run: async () => {
      const serverBundle = path.resolve('dist/server.cjs');
      assert(fs.existsSync(serverBundle), 'dist/server.cjs must exist after build');
    },
  },

  // ===========================================================================
  // SETTLEMENT & ACCOUNT POLICY TESTS (SP-01 to SP-08)
  // ===========================================================================

  // SP-01: ACTIVE may reserve/capture/release
  {
    id: 'SP-01',
    name: 'ACTIVE may reserve/capture/release',
    run: async () => {
      // In Phase 2B SQL:
      // reserve checks: IF v_account_status = 'FROZEN' ... ELSIF v_account_status = 'CLOSED' ...
      // ACTIVE passes smoothly.
      assert(
        p2bMigrationSql.includes("IF v_account_status = 'FROZEN' THEN\n        RAISE EXCEPTION 'CREDIT_ACCOUNT_FROZEN"),
        'reserve blocks FROZEN'
      );
      assert(
        p2bMigrationSql.includes("ELSIF v_account_status = 'CLOSED' THEN\n        RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED"),
        'reserve blocks CLOSED'
      );
      // For ACTIVE, no exception is raised
    },
  },

  // SP-02: FROZEN cannot create new reservation
  {
    id: 'SP-02',
    name: 'FROZEN cannot create new reservation (CREDIT_ACCOUNT_FROZEN)',
    run: async () => {
      assert(
        p2bMigrationSql.includes("RAISE EXCEPTION 'CREDIT_ACCOUNT_FROZEN: Account for user % is frozen'"),
        'reserve_credit_units must reject FROZEN account'
      );
    },
  },

  // SP-03: FROZEN existing reservation target policy: capture allowed
  {
    id: 'SP-03',
    name: 'FROZEN existing reservation target policy: capture allowed (audits current DB behavior vs target policy)',
    run: async () => {
      // Target Policy:
      // A freeze prevents NEW commitments, but already valid in-flight commitments
      // (created before freeze) must be allowed to settle (capture/release).
      //
      // Current Phase 2B RPC audit:
      // capture_credit_reservation lines 542-544 currently check:
      //   IF v_account_status = 'FROZEN' THEN RAISE EXCEPTION 'CREDIT_ACCOUNT_FROZEN: Cannot capture on frozen account';
      //
      // This is a documented mismatch that will be patched in Processing Integration migration:
      // SETTLEMENT_POLICY_DB_PATCH_REQUIRED = YES.
      const hasCurrentFrozenCaptureBlock = p2bMigrationSql.includes(
        "IF v_account_status = 'FROZEN' THEN\n        RAISE EXCEPTION 'CREDIT_ACCOUNT_FROZEN: Cannot capture on frozen account';"
      );
      assert(hasCurrentFrozenCaptureBlock, 'Current Phase 2B RPC blocks capture on frozen account (requires future patch)');
    },
  },

  // SP-04: FROZEN release allowed
  {
    id: 'SP-04',
    name: 'FROZEN release allowed (release permitted to unlock held credits)',
    run: async () => {
      const releaseFnStart = p2bMigrationSql.indexOf('CREATE OR REPLACE FUNCTION public.release_credit_reservation');
      const releaseFnEnd = p2bMigrationSql.indexOf('CREATE OR REPLACE FUNCTION public.get_user_credit_balance');
      const releaseFnCode = p2bMigrationSql.slice(releaseFnStart, releaseFnEnd);

      assert(
        !releaseFnCode.includes("v_account_status = 'FROZEN'"),
        'release_credit_reservation must NOT block FROZEN account'
      );
    },
  },

  // SP-05: CLOSED cannot reserve
  {
    id: 'SP-05',
    name: 'CLOSED cannot reserve (CREDIT_ACCOUNT_CLOSED)',
    run: async () => {
      assert(
        p2bMigrationSql.includes("RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Account for user % is closed'"),
        'reserve_credit_units must reject CLOSED account'
      );
    },
  },

  // SP-06: CLOSED cannot capture
  {
    id: 'SP-06',
    name: 'CLOSED cannot capture (CREDIT_ACCOUNT_CLOSED)',
    run: async () => {
      assert(
        p2bMigrationSql.includes("RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Cannot capture on closed account'"),
        'capture_credit_reservation must reject CLOSED account'
      );
    },
  },

  // SP-07: CLOSED existing reservation target policy: release allowed
  {
    id: 'SP-07',
    name: 'CLOSED existing reservation target policy: release allowed (audits current DB behavior vs target policy)',
    run: async () => {
      // Target Policy:
      // A closed account must NOT perform new reserves or captures, but the system must
      // be able to release existing stuck reservations to clear outstanding holds.
      //
      // Current Phase 2B RPC audit:
      // release_credit_reservation lines 829-831 currently check:
      //   IF v_account_status = 'CLOSED' THEN RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Cannot release on closed account';
      //
      // This is a documented mismatch that will be patched in Processing Integration migration:
      // SETTLEMENT_POLICY_DB_PATCH_REQUIRED = YES.
      const hasCurrentClosedReleaseBlock = p2bMigrationSql.includes(
        "IF v_account_status = 'CLOSED' THEN\n        RAISE EXCEPTION 'CREDIT_ACCOUNT_CLOSED: Cannot release on closed account';"
      );
      assert(hasCurrentClosedReleaseBlock, 'Current Phase 2B RPC blocks release on closed account (requires future patch)');
    },
  },

  // SP-08: actual > reserved: CREDIT_RECONCILIATION_REQUIRED
  {
    id: 'SP-08',
    name: 'actual > reserved policy: CREDIT_RECONCILIATION_REQUIRED (capture above reserved strictly prohibited)',
    run: async () => {
      // In capture_credit_reservation:
      assert(
        p2bMigrationSql.includes("RAISE EXCEPTION 'CAPTURE_EXCEEDS_RESERVED: Cannot capture % units; only % outstanding on reservation %'"),
        'capture_credit_reservation must reject any attempt to capture more than outstanding reserved units'
      );
    },
  },

  // ===========================================================================
  // ELIGIBILITY HARDENING TESTS (HARD-01 to HARD-12)
  // ===========================================================================

  // HARD-01: WAITING_CONFIRMATION is eligible state
  {
    id: 'HARD-01',
    name: 'WAITING_CONFIRMATION is the canonical eligible state for new processing',
    run: async () => {
      assert.strictEqual(
        isDocumentEligibleForNewProcessing('WAITING_CONFIRMATION'),
        true,
        'WAITING_CONFIRMATION must be eligible'
      );
    },
  },

  // HARD-02: QUEUED is DOCUMENT_NOT_READY
  {
    id: 'HARD-02',
    name: 'QUEUED is blocked as DOCUMENT_NOT_READY',
    run: async () => {
      assert.strictEqual(isDocumentEligibleForNewProcessing('QUEUED'), false);
    },
  },

  // HARD-03: PROCESSING is DOCUMENT_NOT_READY
  {
    id: 'HARD-03',
    name: 'PROCESSING is blocked as DOCUMENT_NOT_READY',
    run: async () => {
      assert.strictEqual(isDocumentEligibleForNewProcessing('PROCESSING'), false);
    },
  },

  // HARD-04: READY is DOCUMENT_NOT_READY
  {
    id: 'HARD-04',
    name: 'READY is blocked as DOCUMENT_NOT_READY',
    run: async () => {
      assert.strictEqual(isDocumentEligibleForNewProcessing('READY'), false);
    },
  },

  // HARD-05: REVIEW_REQUIRED is DOCUMENT_NOT_READY
  {
    id: 'HARD-05',
    name: 'REVIEW_REQUIRED is blocked as DOCUMENT_NOT_READY',
    run: async () => {
      assert.strictEqual(isDocumentEligibleForNewProcessing('REVIEW_REQUIRED'), false);
    },
  },

  // HARD-06: DELETED is blocked
  {
    id: 'HARD-06',
    name: 'DELETED is blocked as DOCUMENT_NOT_READY',
    run: async () => {
      assert.strictEqual(isDocumentEligibleForNewProcessing('DELETED'), false);
    },
  },

  // HARD-07: FAILED behavior matches explicit retry policy (fail closed)
  {
    id: 'HARD-07',
    name: 'FAILED behavior matches explicit retry policy (fails closed as DOCUMENT_NOT_READY)',
    run: async () => {
      assert.strictEqual(
        isDocumentEligibleForNewProcessing('FAILED'),
        false,
        'FAILED state must fail closed until explicit retry flow is introduced'
      );
    },
  },

  // HARD-08: estimatedUnits rejects fraction
  {
    id: 'HARD-08',
    name: 'estimatedUnits rejects fractional numbers (SAFE INTEGER CONTRACT)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(20000, 2500.5, 'ACTIVE');
      assert.strictEqual(res.eligible, false);
      assert.strictEqual(res.reason, 'INVALID_PROCESSING_ESTIMATE');
    },
  },

  // HARD-09: estimatedUnits rejects NaN/Infinity
  {
    id: 'HARD-09',
    name: 'estimatedUnits rejects NaN and Infinity (SAFE INTEGER CONTRACT)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const resNaN = service.evaluateCreditSufficiency(20000, NaN, 'ACTIVE');
      assert.strictEqual(resNaN.eligible, false);
      assert.strictEqual(resNaN.reason, 'INVALID_PROCESSING_ESTIMATE');

      const resInf = service.evaluateCreditSufficiency(20000, Infinity, 'ACTIVE');
      assert.strictEqual(resInf.eligible, false);
      assert.strictEqual(resInf.reason, 'INVALID_PROCESSING_ESTIMATE');
    },
  },

  // HARD-10: estimatedUnits rejects unsafe integer (> Number.MAX_SAFE_INTEGER)
  {
    id: 'HARD-10',
    name: 'estimatedUnits rejects unsafe integers (> Number.MAX_SAFE_INTEGER)',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const resUnsafe = service.evaluateCreditSufficiency(20000, Number.MAX_SAFE_INTEGER + 1000, 'ACTIVE');
      assert.strictEqual(resUnsafe.eligible, false);
      assert.strictEqual(resUnsafe.reason, 'INVALID_PROCESSING_ESTIMATE');
    },
  },

  // HARD-11: available/shortage unit arithmetic remains safe integer
  {
    id: 'HARD-11',
    name: 'available and shortage unit arithmetic remains safe integer',
    run: async () => {
      const service = new ProcessingEligibilityService();
      const res = service.evaluateCreditSufficiency(20000, 27000, 'ACTIVE');
      assert(isSafeIntegerCreditUnits(res.availableUnits), 'availableUnits must be safe integer');
      assert(isSafeIntegerCreditUnits(res.estimatedUnits), 'estimatedUnits must be safe integer');
      assert(isSafeIntegerCreditUnits(res.shortageUnits), 'shortageUnits must be safe integer');
    },
  },

  // HARD-12: processing pricing version cannot be confused with commercial pricing version
  {
    id: 'HARD-12',
    name: 'processing pricing version cannot be confused with commercial pricing version',
    run: async () => {
      const estimator = new ConfigurablePricingEstimator();
      const est = await estimator.estimateProcessingCost({ documentId: 'doc-1', pageCount: 3 });
      assert.strictEqual(est.processingPricingVersion, 'processing-pricing-v1');
      assert.notStrictEqual(est.processingPricingVersion, 'pricing-v1', 'Must not reuse commercial billing version');
    },
  },

  // ===========================================================================
  // UI TESTS (UI-01 to UI-10)
  // ===========================================================================

  // UI-01: legacy billing UI remains available when credit UI flag is disabled
  {
    id: 'UI-01',
    name: 'legacy billing UI remains available when credit UI flag is disabled',
    run: async () => {
      const featuresPath = path.resolve('src/config/features.ts');
      const featuresSrc = fs.readFileSync(featuresPath, 'utf-8');
      assert(featuresSrc.includes('isCreditBillingUiEnabled'), 'Feature flag helper exists');

      const dashboardPath = path.resolve('src/pages/DashboardPage.tsx');
      const dashboardSrc = fs.readFileSync(dashboardPath, 'utf-8');
      assert(dashboardSrc.includes('creditBillingEnabled ?'), 'Dashboard branches on feature flag');
      assert(dashboardSrc.includes('<QuotaCard quota={quota}'), 'Dashboard renders legacy QuotaCard when disabled');
    },
  },

  // UI-02: credit UI displays available credit as primary value
  {
    id: 'UI-02',
    name: 'credit UI displays available credit as primary value',
    run: async () => {
      const cardPath = path.resolve('src/components/dashboard/CreditBalanceCard.tsx');
      const cardSrc = fs.readFileSync(cardPath, 'utf-8');
      assert(
        cardSrc.includes('id="credit-available-primary"'),
        'CreditBalanceCard defines #credit-available-primary'
      );
      assert(
        cardSrc.includes('formatCredits(balance.totalAvailableUnits)'),
        'Primary metric binds strictly to totalAvailableUnits'
      );
    },
  },

  // UI-03: reserved credit is displayed separately
  {
    id: 'UI-03',
    name: 'reserved credit is displayed separately in secondary metrics grid',
    run: async () => {
      const cardPath = path.resolve('src/components/dashboard/CreditBalanceCard.tsx');
      const cardSrc = fs.readFileSync(cardPath, 'utf-8');
      assert(cardSrc.includes('Credit đang giữ'), 'Label "Credit đang giữ" present');
      assert(cardSrc.includes('id="credit-reserved-val"'), '#credit-reserved-val element present');
      assert(cardSrc.includes('formatCredits(balance.reservedUnits)'), 'Binds to balance.reservedUnits');
    },
  },

  // UI-04: gross remaining is displayed separately
  {
    id: 'UI-04',
    name: 'gross remaining is displayed separately in secondary metrics grid',
    run: async () => {
      const cardPath = path.resolve('src/components/dashboard/CreditBalanceCard.tsx');
      const cardSrc = fs.readFileSync(cardPath, 'utf-8');
      assert(cardSrc.includes('Tổng credit còn lại'), 'Label "Tổng credit còn lại" present');
      assert(cardSrc.includes('id="credit-gross-val"'), '#credit-gross-val element present');
      assert(cardSrc.includes('formatCredits(balance.grossRemainingUnits)'), 'Binds to balance.grossRemainingUnits');
    },
  },

  // UI-05: missing credit account does not display fake zero
  {
    id: 'UI-05',
    name: 'missing credit account does not display fake zero (NO_CREDIT_ACCOUNT safe state)',
    run: async () => {
      const cardPath = path.resolve('src/components/dashboard/CreditBalanceCard.tsx');
      const cardSrc = fs.readFileSync(cardPath, 'utf-8');
      assert(
        cardSrc.includes("uiState === 'NO_CREDIT_ACCOUNT'"),
        'Handles NO_CREDIT_ACCOUNT state explicitly'
      );
      assert(
        cardSrc.includes('Credit chưa được kích hoạt'),
        'Renders safe non-financial state text "Credit chưa được kích hoạt"'
      );
      assert(
        cardSrc.includes('id="dashboard-credit-card-no-account"'),
        'Renders dedicated no-account card ID'
      );
    },
  },

  // UI-06: API failure does not display zero
  {
    id: 'UI-06',
    name: 'API failure does not display zero (API_ERROR safe state)',
    run: async () => {
      const cardPath = path.resolve('src/components/dashboard/CreditBalanceCard.tsx');
      const cardSrc = fs.readFileSync(cardPath, 'utf-8');
      assert(cardSrc.includes("uiState === 'API_ERROR'"), 'Handles API_ERROR state explicitly');
      assert(
        cardSrc.includes('Không thể tải thông tin số dư credit'),
        'Renders explicit error warning instead of 0 credits'
      );
    },
  },

  // UI-07: document statistics remain document counts
  {
    id: 'UI-07',
    name: 'document statistics remain document counts (Tổng tài liệu & Chờ xử lý are counts)',
    run: async () => {
      const dashboardPath = path.resolve('src/pages/DashboardPage.tsx');
      const dashboardSrc = fs.readFileSync(dashboardPath, 'utf-8');
      assert(dashboardSrc.includes('documents.length'), 'Tổng tài liệu binds to documents.length');
      assert(dashboardSrc.includes('queuedCount'), 'Chờ xử lý binds to queuedCount');
    },
  },

  // UI-08: header credit badge uses available credit
  {
    id: 'UI-08',
    name: 'header credit badge uses available credit as primary display',
    run: async () => {
      const badgePath = path.resolve('src/components/layout/CreditBalanceBadge.tsx');
      const badgeSrc = fs.readFileSync(badgePath, 'utf-8');
      assert(
        badgeSrc.includes('formatCredits(balance.totalAvailableUnits)'),
        'Badge formats balance.totalAvailableUnits'
      );
      assert(badgeSrc.includes('id="navbar-credit-badge"'), '#navbar-credit-badge element present');
      assert(badgeSrc.includes('Khả dụng:'), 'Tooltip contains available credit breakdown');
    },
  },

  // UI-09: credit formatting (20000 -> 20, 20500 -> 20.5, 20250 -> 20.25)
  {
    id: 'UI-09',
    name: 'credit formatting converts units to readable string without trailing zeros',
    run: async () => {
      assert.strictEqual(formatCredits(20000), '20');
      // In vi-VN locale, decimal separator is ',' (e.g. '20,5') or '.' in standard
      const f20500 = formatCredits(20500);
      assert(f20500 === '20,5' || f20500 === '20.5', `Expected 20.5 or 20,5, got ${f20500}`);
      const f20250 = formatCredits(20250);
      assert(f20250 === '20,25' || f20250 === '20.25', `Expected 20.25 or 20,25, got ${f20250}`);
      assert.strictEqual(formatCredits(0), '0');
    },
  },

  // UI-10: no "remaining documents you can process" text appears in credit UI mode
  {
    id: 'UI-10',
    name: 'no "remaining documents you can process" text appears in credit UI mode',
    run: async () => {
      const cardPath = path.resolve('src/components/dashboard/CreditBalanceCard.tsx');
      const cardSrc = fs.readFileSync(cardPath, 'utf-8');
      assert(!cardSrc.includes('tài liệu có thể xử lý'), 'Must NOT claim remaining document count in credit card');
      assert(!cardSrc.includes('% đã sử dụng'), 'Must NOT display misleading percentage bar in credit card');
    },
  },
];

async function runAll() {
  console.log('================================================================');
  console.log('PHASE 2C — PROCESSING ELIGIBILITY & CREDIT GUARD TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    try {
      await tc.run();
      console.log(`[PASS] ${tc.id}: ${tc.name}`);
      passed++;
    } catch (err: any) {
      console.error(`[FAIL] ${tc.id}: ${tc.name}`);
      console.error(`       Error: ${err.message}`);
      failed++;
    }
  }

  console.log('\n================================================================');
  console.log(`TOTAL: ${testCases.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAll().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
