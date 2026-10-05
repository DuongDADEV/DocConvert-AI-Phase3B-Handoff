import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DatabaseService } from '../db/db.js';
import {
  CreditService,
  validatePolicyTimestamp,
  getFreeBootstrapPolicyEffectiveAt,
  setTestPolicyEffectiveAtOverride,
} from '../services/credit/creditService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

let passed = 0;
let failed = 0;

async function runTest(id: string, name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result && typeof (result as any).then === 'function') {
      await result;
    }
    console.log(`[PASS] ${id}: ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`[FAIL] ${id}: ${name} ->`, err.message || err);
    failed++;
  }
}

function createMockClientWithAuth(options: {
  authUser?: { id: string; created_at: string } | null;
  profile?: { id: string; created_at: string } | null;
  existingGrant?: any;
  account?: any;
  product?: any;
}) {
  return {
    auth: {
      admin: {
        getUserById: async (userId: string) => {
          if (options.authUser === null) {
            return { data: { user: null }, error: new Error('User not found') };
          }
          if (options.authUser) {
            return { data: { user: options.authUser }, error: null };
          }
          return { data: { user: { id: userId, created_at: '2026-10-04T00:00:00.000Z' } }, error: null };
        },
      },
    },
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === 'profiles') {
            return { data: options.profile !== undefined ? options.profile : { id: 'test-user', created_at: '2026-10-04T00:00:00.000Z' } };
          }
          if (table === 'credit_grants') {
            return { data: options.existingGrant || null };
          }
          if (table === 'credit_accounts') {
            return { data: options.account || null };
          }
          if (table === 'billing_products') {
            return { data: options.product || { id: 'prod-free-uuid' } };
          }
          return { data: null };
        },
      };
      return builder;
    },
  };
}

async function runSuite() {
  console.log('================================================================');
  console.log('PHASE 3B.3.7 — PRODUCTION HEALTH-CHECK DEFECT FIXES TEST SUITE');
  console.log('================================================================\n');

  const testUserId = '30ed6381-0d2f-4d4a-a2f6-d8e0ac07452c';
  const testDocId = '80636c44-d41c-4a62-a502-a198d9d4fde3';
  const policyTimestamp = '2026-10-03T01:00:00.000Z';
  const historicalUserTime = '2026-10-01T12:00:00.000Z';
  const newUserTime = '2026-10-04T12:00:00.000Z';

  // ===========================================================================
  // SECTION 1: UUID DEFECT TESTS (UUID-01 to UUID-06)
  // ===========================================================================

  // UUID-01: getUserDocumentById receives a string document UUID in normal preflight flow
  await runTest('UUID-01', 'getUserDocumentById receives a string document UUID in normal preflight flow', async () => {
    let clientQueried = false;
    let passedDocId: any = null;

    const mockService = new DatabaseService();
    (mockService as any).getClient = () => ({
      from: () => ({
        select: () => ({
          eq: (field: string, val: any) => {
            if (field === 'id') passedDocId = val;
            return {
              eq: () => ({
                is: () => ({
                  maybeSingle: async () => {
                    clientQueried = true;
                    return { data: { id: testDocId, user_id: testUserId }, error: null };
                  },
                }),
              }),
            };
          },
        }),
      }),
    });

    const doc = await mockService.getUserDocumentById(testUserId, testDocId);
    assert.strictEqual(typeof testDocId, 'string', 'documentId must be string');
    assert.strictEqual(passedDocId, testDocId, 'Query filter received exact string documentId');
    assert.strictEqual(clientQueried, true, 'Database was queried for valid string UUID');
    assert.ok(doc !== null && doc.id === testDocId, 'Document returned successfully');
  });

  // UUID-02: object input cannot reach Supabase UUID filter
  await runTest('UUID-02', 'object input cannot reach Supabase UUID filter', async () => {
    let clientQueried = false;

    const mockService = new DatabaseService();
    (mockService as any).getClient = () => ({
      from: () => {
        clientQueried = true;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      },
    });

    // 1. Literal object input fails before DB query
    let objectRejected = false;
    try {
      await mockService.getUserDocumentById(testUserId, { id: testDocId } as any);
    } catch (err: any) {
      objectRejected = true;
      assert.ok(err instanceof TypeError, 'Must throw TypeError on object argument');
      assert.ok(err.message.includes('INVALID_ARGUMENT'), 'Must have INVALID_ARGUMENT error message');
    }
    assert.strictEqual(objectRejected, true, 'Object argument must be rejected before DB query');
    assert.strictEqual(clientQueried, false, 'Supabase client must NOT be called for object input');

    // 2. Coerced string '[object Object]' returns null without querying DB
    clientQueried = false;
    const nullDoc = await mockService.getUserDocumentById(testUserId, '[object Object]');
    assert.strictEqual(nullDoc, null, 'Must return null for [object Object]');
    assert.strictEqual(clientQueried, false, 'Supabase client must NOT be called for [object Object]');
  });

  // UUID-03: invalid non-string documentId fails clearly before DB query
  await runTest('UUID-03', 'invalid non-string documentId fails clearly before DB query', async () => {
    const mockService = new DatabaseService();
    let dbCalled = false;
    (mockService as any).getClient = () => {
      dbCalled = true;
      return {} as any;
    };

    const nonStringInputs = [
      12345,
      true,
      null,
      undefined,
      ['array-item'],
      { foo: 'bar' },
    ];

    for (const input of nonStringInputs) {
      dbCalled = false;
      let rejected = false;
      try {
        await mockService.getUserDocumentById(testUserId, input as any);
      } catch (err: any) {
        rejected = true;
        assert.ok(err instanceof TypeError, `Must throw TypeError for non-string input ${typeof input}`);
      }
      assert.strictEqual(rejected, true, `Non-string input ${typeof input} must fail fast`);
      assert.strictEqual(dbCalled, false, `Database must not be queried for ${typeof input}`);
    }
  });

  // UUID-04: preflight still works for valid document
  await runTest('UUID-04', 'preflight still works for valid document', async () => {
    const mockService = new DatabaseService();
    (mockService as any).getClient = () => ({
      from: (table: string) => ({
        select: () => ({
          eq: (field: string, val: any) => ({
            eq: () => ({
              is: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: testDocId,
                    user_id: testUserId,
                    page_count: 2,
                    status: 'WAITING_CONFIRMATION',
                    preflight_summary: {
                      nativeTextPages: 0,
                      scannedPages: 2,
                      mixedPages: 0,
                      uncertainPages: 0,
                    },
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    });

    const doc = await mockService.getUserDocumentById(testUserId, testDocId);
    assert.ok(doc !== null);
    assert.strictEqual(doc.id, testDocId);
    assert.strictEqual(doc.page_count, 2);
    assert.strictEqual(doc.status, 'WAITING_CONFIRMATION');
  });

  // UUID-05: metadata/document fetch call uses correct argument order
  await runTest('UUID-05', 'metadata/document fetch call uses correct argument order', () => {
    const docRoutePath = path.join(ROOT_DIR, 'server/routes/documents.ts');
    const docRouteSrc = fs.readFileSync(docRoutePath, 'utf-8');

    // Audit all call sites in documents.ts: must be db.getUserDocumentById(userId, docId, ...)
    const callPattern = /db\.getUserDocumentById\(([^)]+)\)/g;
    let match;
    let count = 0;
    while ((match = callPattern.exec(docRouteSrc)) !== null) {
      count++;
      const args = match[1].split(',').map((s) => s.trim());
      assert.strictEqual(args[0], 'userId', `Call site ${count}: First argument must be userId`);
      assert.strictEqual(args[1], 'docId', `Call site ${count}: Second argument must be docId`);
    }
    assert.ok(count >= 8, `Expected at least 8 call sites in documents.ts, found ${count}`);

    // Check router.param('id') validation
    assert.ok(
      docRouteSrc.includes("router.param('id'"),
      'documents.ts must install router.param validation for :id'
    );
  });

  // UUID-06: Stage A maintenance logic is unchanged
  await runTest('UUID-06', 'Stage A maintenance logic is unchanged', () => {
    const docRoutePath = path.join(ROOT_DIR, 'server/routes/documents.ts');
    const docRouteSrc = fs.readFileSync(docRoutePath, 'utf-8');

    assert.ok(
      docRouteSrc.includes("process.env.PROCESSING_MAINTENANCE_MODE === 'true'"),
      'Maintenance mode check must be present'
    );
    assert.ok(
      docRouteSrc.includes("code: 'PROCESSING_TEMPORARILY_UNAVAILABLE'"),
      'Maintenance mode response must return PROCESSING_TEMPORARILY_UNAVAILABLE'
    );
    assert.ok(
      docRouteSrc.includes('res.status(503)'),
      'Maintenance mode must respond with HTTP 503'
    );
  });

  // ===========================================================================
  // SECTION 2: FREE BOOTSTRAP POLICY TESTS (BOOT-01 to BOOT-08)
  // ===========================================================================

  // BOOT-01: missing FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT fails closed/non-fatally according to current design
  await runTest('BOOT-01', 'missing FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT fails closed/non-fatally in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalPolicy = process.env.FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT;
      setTestPolicyEffectiveAtOverride(null);

      const effective = getFreeBootstrapPolicyEffectiveAt();
      assert.strictEqual(effective, null, 'Must return null when policy is not configured in production');

      const testService = new CreditService();
      (testService as any).getAdminClient = () => createMockClientWithAuth({});

      const eligibility = await testService.checkFreeBootstrapEligibility('any-user-id');
      assert.strictEqual(eligibility.eligible, false, 'Must not be eligible when policy not configured');
      assert.strictEqual(eligibility.reason, 'POLICY_NOT_CONFIGURED', 'Reason must be POLICY_NOT_CONFIGURED');

      // Attempting bootstrap throws fail-closed error with exact expected code
      let threw = false;
      try {
        await testService.bootstrapNewUserFreeCredits('any-user-id', { enforceEligibility: true });
      } catch (err: any) {
        threw = true;
        assert.strictEqual(err.code, 'FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED');
        assert.ok(err.message.includes('FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED'));
      }
      assert.strictEqual(threw, true, 'Must throw FREE_BOOTSTRAP_POLICY_NOT_CONFIGURED');
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalPolicy) process.env.FREE_BOOTSTRAP_POLICY_EFFECTIVE_AT = originalPolicy;
      setTestPolicyEffectiveAtOverride(policyTimestamp);
    }
  });

  // BOOT-02: invalid timestamp is rejected
  await runTest('BOOT-02', 'invalid timestamp is rejected', () => {
    const invalidInputs = [
      '',
      '   ',
      'invalid-date',
      '2026-10-04',               // Missing time and timezone
      '2026-10-04T00:00:00',      // Missing timezone
      '2026-13-45T99:99:99Z',     // Out of range date values
      'not_a_date',
    ];

    for (const raw of invalidInputs) {
      const res = validatePolicyTimestamp(raw);
      assert.strictEqual(res.valid, false, `Timestamp "${raw}" must be invalid`);
      assert.ok(res.error !== undefined, 'Must provide error code');
    }
  });

  // BOOT-03: valid timestamp parses deterministically
  await runTest('BOOT-03', 'valid timestamp parses deterministically', () => {
    const validInputs = [
      '2026-10-03T01:00:00.000Z',
      '2026-10-03T01:00:00Z',
      '2026-10-04T08:00:00+07:00',
      '2026-10-04T00:00:00-05:00',
    ];

    for (const raw of validInputs) {
      const res = validatePolicyTimestamp(raw);
      assert.strictEqual(res.valid, true, `Timestamp "${raw}" must be valid`);
      assert.ok(res.date instanceof Date, 'Must return Date instance');
      assert.ok(!isNaN(res.date.getTime()), 'Date must not be NaN');
    }

    // Verify canonical default parses to expected epoch
    const parsed = validatePolicyTimestamp(policyTimestamp);
    assert.strictEqual(parsed.date?.toISOString(), '2026-10-03T01:00:00.000Z');
  });

  // BOOT-04: user created before effective time is not granted FREE bootstrap if policy says so
  await runTest('BOOT-04', 'user created before effective time is not granted FREE bootstrap', async () => {
    setTestPolicyEffectiveAtOverride(policyTimestamp);

    const testService = new CreditService();
    (testService as any).getAdminClient = () =>
      createMockClientWithAuth({
        authUser: { id: 'historical-user', created_at: historicalUserTime },
        profile: { id: 'historical-user', created_at: historicalUserTime },
      });

    const eligibility = await testService.checkFreeBootstrapEligibility('historical-user');
    assert.strictEqual(eligibility.eligible, false, 'Historical user must not be eligible');
    assert.strictEqual(eligibility.reason, 'HISTORICAL_USER', 'Reason must be HISTORICAL_USER');

    let threw = false;
    try {
      await testService.bootstrapNewUserFreeCredits('historical-user', { enforceEligibility: true });
    } catch (err: any) {
      threw = true;
      assert.strictEqual(err.code, 'FREE_BOOTSTRAP_NOT_ELIGIBLE');
      assert.strictEqual(err.reason, 'HISTORICAL_USER');
    }
    assert.strictEqual(threw, true, 'Bootstrap must reject historical user');
  });

  // BOOT-05: user created after/on effective time is eligible if all other invariants pass
  await runTest('BOOT-05', 'user created after/on effective time is eligible', async () => {
    setTestPolicyEffectiveAtOverride(policyTimestamp);

    const testService = new CreditService();
    (testService as any).getAdminClient = () =>
      createMockClientWithAuth({
        authUser: { id: 'new-user', created_at: newUserTime },
        profile: { id: 'new-user', created_at: newUserTime },
        existingGrant: null,
      });

    const eligibility = await testService.checkFreeBootstrapEligibility('new-user');
    assert.strictEqual(eligibility.eligible, true, 'New user must be eligible');
    assert.strictEqual(eligibility.alreadyGranted, false, 'Must not be already granted');
  });

  // BOOT-06: one-time idempotency remains intact
  await runTest('BOOT-06', 'one-time idempotency remains intact', async () => {
    setTestPolicyEffectiveAtOverride(policyTimestamp);

    const existingGrant = {
      id: 'existing-grant-uuid',
      account_id: 'acc-uuid',
      user_id: 'already-granted-user',
      original_units: 100000,
      remaining_units: 100000,
      source_type: 'FREE_BOOTSTRAP',
    };

    const testService = new CreditService();
    (testService as any).getAdminClient = () =>
      createMockClientWithAuth({
        authUser: { id: 'already-granted-user', created_at: newUserTime },
        profile: { id: 'already-granted-user', created_at: newUserTime },
        existingGrant,
      });

    const eligibility = await testService.checkFreeBootstrapEligibility('already-granted-user');
    assert.strictEqual(eligibility.eligible, false, 'Already granted user must not be eligible for new grant');
    assert.strictEqual(eligibility.alreadyGranted, true, 'Must report alreadyGranted = true');
    assert.strictEqual(eligibility.reason, 'ALREADY_GRANTED');
  });

  // BOOT-07: existing historical users are not backfilled accidentally
  await runTest('BOOT-07', 'existing historical users are not backfilled accidentally', async () => {
    setTestPolicyEffectiveAtOverride(policyTimestamp);

    // Profile created recently (e.g. login sync) but auth.users is historical
    const testService = new CreditService();
    (testService as any).getAdminClient = () =>
      createMockClientWithAuth({
        authUser: { id: 'recreated-profile-user', created_at: historicalUserTime },
        profile: { id: 'recreated-profile-user', created_at: newUserTime }, // profile newer than policy!
      });

    const eligibility = await testService.checkFreeBootstrapEligibility('recreated-profile-user');
    assert.strictEqual(
      eligibility.eligible,
      false,
      'auth.users.created_at must take precedence over profiles.created_at'
    );
    assert.strictEqual(eligibility.reason, 'HISTORICAL_USER');
  });

  // BOOT-08: signup path remains non-fatal if bootstrap grant fails
  await runTest('BOOT-08', 'signup path remains non-fatal if bootstrap grant fails', () => {
    const authRoutePath = path.join(ROOT_DIR, 'server/routes/auth.ts');
    const authRouteSrc = fs.readFileSync(authRoutePath, 'utf-8');

    // Both registration branches in auth.ts must wrap bootstrapNewUserFreeCredits in a try/catch
    assert.ok(
      authRouteSrc.includes('Non-fatal free bootstrap grant error'),
      'auth.ts must log non-fatal error when bootstrap grant fails during registration'
    );
    assert.ok(
      authRouteSrc.includes('res.status(201).json'),
      'Registration response must still return HTTP 201 on bootstrap grant failure'
    );
  });

  // Summary
  console.log('\n----------------------------------------------------------------');
  console.log(`PHASE 3B.3.7 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('----------------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Unhandled test suite error:', err);
  process.exit(1);
});
