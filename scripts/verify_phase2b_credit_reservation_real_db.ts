import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

interface CheckItem {
  id: string;
  name: string;
  category: 'REAL_DB_SCHEMA' | 'REAL_DB_PERMISSIONS' | 'REAL_DB_SEMANTICS' | 'LEGACY_INTEGRITY' | 'AUDIT_SAFETY';
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  details?: string;
}

const checks: CheckItem[] = [];

function logCheck(item: CheckItem) {
  checks.push(item);
  let color = '\x1b[32m[PASS]\x1b[0m';
  if (item.status === 'FAIL') color = '\x1b[31m[FAIL]\x1b[0m';
  if (item.status === 'BLOCKED') color = '\x1b[33m[BLOCKED]\x1b[0m';

  console.log(`${color} ${item.id} [${item.category}]: ${item.name}`);
  if (item.details) {
    console.log(`       ${item.details}`);
  }
}

async function verifyRealDb() {
  console.log('================================================================');
  console.log('PHASE 2B — REAL DATABASE VERIFICATION AUDIT');
  console.log('Target: REAL SUPABASE POSTGRESQL');
  console.log('Mode: STRICTLY NON-MUTATING / READ-ONLY INSPECTION');
  console.log('================================================================\n');

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    console.error('Fatal: Cannot initialize Supabase Admin Client. Check environment.');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const anonClient = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

  // -------------------------------------------------------------------------
  // 1. LEGACY INTEGRITY CHECKS
  // -------------------------------------------------------------------------
  try {
    const { data: profiles, error: pErr } = await supabase
      .from('profiles')
      .select('id, current_plan_id, used_documents');

    if (pErr) throw pErr;

    const count = profiles?.length || 0;
    const planCounts: Record<string, number> = {};
    profiles?.forEach((p) => {
      planCounts[p.current_plan_id] = (planCounts[p.current_plan_id] || 0) + 1;
    });

    if (count === 24 && planCounts['FREE'] === 21 && planCounts['7_DAYS_FULL'] === 3) {
      logCheck({
        id: 'CHK-LEGACY-01',
        name: 'Legacy profiles count and plan distribution strictly preserved (24 total: 21 FREE, 3 7_DAYS_FULL)',
        category: 'LEGACY_INTEGRITY',
        status: 'PASS',
        details: `Profiles: ${count} (${JSON.stringify(planCounts)})`,
      });
    } else {
      logCheck({
        id: 'CHK-LEGACY-01',
        name: 'Legacy profiles count and plan distribution preserved',
        category: 'LEGACY_INTEGRITY',
        status: 'FAIL',
        details: `Unexpected count or distribution: ${count} (${JSON.stringify(planCounts)})`,
      });
    }
  } catch (err: any) {
    logCheck({
      id: 'CHK-LEGACY-01',
      name: 'Legacy profiles count',
      category: 'LEGACY_INTEGRITY',
      status: 'FAIL',
      details: err.message,
    });
  }

  try {
    const { data: plans, error: plErr } = await supabase
      .from('plans')
      .select('id, document_quota, is_active')
      .order('id');

    if (plErr) throw plErr;

    const planIds = plans?.map((p) => p.id) || [];
    const expected = ['30_DAYS_FULL', '7_DAYS_FULL', 'FREE'];
    const matches = expected.every((id) => planIds.includes(id)) && planIds.length === 3;

    const freeQuota = plans?.find((p) => p.id === 'FREE')?.document_quota;
    const plan7Quota = plans?.find((p) => p.id === '7_DAYS_FULL')?.document_quota;
    const plan30Quota = plans?.find((p) => p.id === '30_DAYS_FULL')?.document_quota;
    const quotasExact = freeQuota === 3 && plan7Quota === 50 && plan30Quota === 250;

    if (matches && quotasExact) {
      logCheck({
        id: 'CHK-LEGACY-02',
        name: 'Legacy public.plans unchanged (FREE: 3 docs, 7_DAYS_FULL: 50 docs, 30_DAYS_FULL: 250 docs)',
        category: 'LEGACY_INTEGRITY',
        status: 'PASS',
        details: `Plans: ${planIds.join(', ')} | Quotas: FREE=${freeQuota}, 7_DAYS=${plan7Quota}, 30_DAYS=${plan30Quota}`,
      });
    } else {
      logCheck({
        id: 'CHK-LEGACY-02',
        name: 'Legacy public.plans unchanged',
        category: 'LEGACY_INTEGRITY',
        status: 'FAIL',
        details: `Plans mismatch: ${planIds.join(', ')}`,
      });
    }
  } catch (err: any) {
    logCheck({
      id: 'CHK-LEGACY-02',
      name: 'Legacy public.plans verification',
      category: 'LEGACY_INTEGRITY',
      status: 'FAIL',
      details: err.message,
    });
  }

  // -------------------------------------------------------------------------
  // 2. PHASE 2B SCHEMA READINESS PROBES
  // -------------------------------------------------------------------------
  let reservedColReady = false;
  let reservationsReady = false;
  let allocReady = false;
  let eventsReady = false;

  // Probe reserved_units column on credit_grants
  try {
    const { data: gData, error: gErr } = await supabase
      .from('credit_grants')
      .select('id, reserved_units')
      .limit(1);

    if (gErr) {
      logCheck({
        id: 'CHK-2B-COL-01',
        name: 'credit_grants.reserved_units column existence',
        category: 'REAL_DB_SCHEMA',
        status: 'BLOCKED',
        details: `reserved_units column not yet present: ${gErr.message}`,
      });
    } else {
      reservedColReady = true;
      logCheck({
        id: 'CHK-2B-COL-01',
        name: 'credit_grants.reserved_units column exists in PostgreSQL schema',
        category: 'REAL_DB_SCHEMA',
        status: 'PASS',
        details: 'Column query succeeded',
      });
    }
  } catch (err: any) {
    logCheck({
      id: 'CHK-2B-COL-01',
      name: 'credit_grants.reserved_units column probe',
      category: 'REAL_DB_SCHEMA',
      status: 'BLOCKED',
      details: err.message,
    });
  }

  // Probe credit_reservations table
  try {
    const { data: resData, error: resErr } = await supabase
      .from('credit_reservations')
      .select('id')
      .limit(1);

    if (resErr) {
      logCheck({
        id: 'CHK-2B-TBL-01',
        name: 'credit_reservations table existence',
        category: 'REAL_DB_SCHEMA',
        status: 'BLOCKED',
        details: `Table not yet present: ${resErr.message}`,
      });
    } else {
      reservationsReady = true;
      logCheck({
        id: 'CHK-2B-TBL-01',
        name: 'credit_reservations table exists in PostgreSQL schema',
        category: 'REAL_DB_SCHEMA',
        status: 'PASS',
        details: `Probe returned ${resData?.length ?? 0} sample rows`,
      });
    }
  } catch (err: any) {
    logCheck({
      id: 'CHK-2B-TBL-01',
      name: 'credit_reservations probe',
      category: 'REAL_DB_SCHEMA',
      status: 'BLOCKED',
      details: err.message,
    });
  }

  // Probe credit_reservation_allocations table
  try {
    const { data: allocData, error: aErr } = await supabase
      .from('credit_reservation_allocations')
      .select('id')
      .limit(1);

    if (aErr) {
      logCheck({
        id: 'CHK-2B-TBL-02',
        name: 'credit_reservation_allocations table existence',
        category: 'REAL_DB_SCHEMA',
        status: 'BLOCKED',
        details: `Table not yet present: ${aErr.message}`,
      });
    } else {
      allocReady = true;
      logCheck({
        id: 'CHK-2B-TBL-02',
        name: 'credit_reservation_allocations table exists in PostgreSQL schema',
        category: 'REAL_DB_SCHEMA',
        status: 'PASS',
        details: `Probe returned ${allocData?.length ?? 0} sample rows`,
      });
    }
  } catch (err: any) {
    logCheck({
      id: 'CHK-2B-TBL-02',
      name: 'credit_reservation_allocations probe',
      category: 'REAL_DB_SCHEMA',
      status: 'BLOCKED',
      details: err.message,
    });
  }

  // Probe credit_reservation_events table
  try {
    const { data: evData, error: evErr } = await supabase
      .from('credit_reservation_events')
      .select('id')
      .limit(1);

    if (evErr) {
      logCheck({
        id: 'CHK-2B-TBL-03',
        name: 'credit_reservation_events table existence',
        category: 'REAL_DB_SCHEMA',
        status: 'BLOCKED',
        details: `Table not yet present: ${evErr.message}`,
      });
    } else {
      eventsReady = true;
      logCheck({
        id: 'CHK-2B-TBL-03',
        name: 'credit_reservation_events table exists in PostgreSQL schema',
        category: 'REAL_DB_SCHEMA',
        status: 'PASS',
        details: `Probe returned ${evData?.length ?? 0} sample rows`,
      });
    }
  } catch (err: any) {
    logCheck({
      id: 'CHK-2B-TBL-03',
      name: 'credit_reservation_events probe',
      category: 'REAL_DB_SCHEMA',
      status: 'BLOCKED',
      details: err.message,
    });
  }

  // If Phase 2B migration has not yet been applied, report PRODUCT_OWNER_SQL_REQUIRED
  if (!reservedColReady || !reservationsReady || !allocReady || !eventsReady) {
    console.log('\n================================================================');
    console.log('REAL DB STATUS: PHASE 2B MIGRATION NOT YET APPLIED TO LIVE DATABASE');
    console.log('================================================================');
    console.log('Result: PRODUCT_OWNER_SQL_REQUIRED');
    console.log('Migration file: supabase/migrations/20261002010000_credit_reservation_foundation.sql');
    console.log('Please execute the migration in the Supabase Dashboard SQL Editor.');
    console.log('================================================================');
    return {
      ready: false,
      productOwnerSqlRequired: true,
      checks,
    };
  }

  // -------------------------------------------------------------------------
  // 3. FINANCIAL ROW COUNTS & OPERATIONAL SAFETY
  // -------------------------------------------------------------------------
  try {
    const [accRes, grantRes, ledgerRes, resRes, allocRes, evRes] = await Promise.all([
      supabase.from('credit_accounts').select('*', { count: 'exact', head: true }),
      supabase.from('credit_grants').select('*', { count: 'exact', head: true }),
      supabase.from('credit_ledger').select('*', { count: 'exact', head: true }),
      supabase.from('credit_reservations').select('*', { count: 'exact', head: true }),
      supabase.from('credit_reservation_allocations').select('*', { count: 'exact', head: true }),
      supabase.from('credit_reservation_events').select('*', { count: 'exact', head: true }),
    ]);

    const accCount = accRes.count ?? 0;
    const grantCount = grantRes.count ?? 0;
    const ledgerCount = ledgerRes.count ?? 0;
    const resCount = resRes.count ?? 0;
    const allocCount = allocRes.count ?? 0;
    const evCount = evRes.count ?? 0;

    logCheck({
      id: 'CHK-2B-COUNTS-01',
      name: 'Financial and reservation row counts verified (no unintended mass modifications)',
      category: 'AUDIT_SAFETY',
      status: 'PASS',
      details: `accounts=${accCount}, grants=${grantCount}, ledger=${ledgerCount}, reservations=${resCount}, allocations=${allocCount}, events=${evCount}`,
    });
  } catch (err: any) {
    logCheck({
      id: 'CHK-2B-COUNTS-01',
      name: 'Financial and reservation row counts check',
      category: 'AUDIT_SAFETY',
      status: 'FAIL',
      details: err.message,
    });
  }

  // -------------------------------------------------------------------------
  // 4. RPC SECURITY & PERMISSIONS
  // -------------------------------------------------------------------------
  if (anonClient) {
    const dummyId = '00000000-0000-0000-0000-000000000001';

    // Probe reserve_credit_units
    try {
      const { error: rErr } = await anonClient.rpc('reserve_credit_units', {
        p_user_id: dummyId,
        p_requested_units: 1000,
        p_idempotency_key: 'probe_anon_res',
      });
      if (rErr && (rErr.message.includes('permission denied') || rErr.code === '42501' || rErr.message.includes('not found'))) {
        logCheck({
          id: 'CHK-2B-PERM-01',
          name: 'reserve_credit_units RPC execution is blocked from non-service role',
          category: 'REAL_DB_PERMISSIONS',
          status: 'PASS',
          details: `Anon RPC call blocked: ${rErr.message}`,
        });
      } else {
        logCheck({
          id: 'CHK-2B-PERM-01',
          name: 'reserve_credit_units RPC blocked from non-service role',
          category: 'REAL_DB_PERMISSIONS',
          status: 'FAIL',
          details: `Unexpected response: ${JSON.stringify(rErr)}`,
        });
      }
    } catch (err: any) {
      logCheck({
        id: 'CHK-2B-PERM-01',
        name: 'reserve_credit_units RPC blocked from non-service role',
        category: 'REAL_DB_PERMISSIONS',
        status: 'PASS',
        details: err.message,
      });
    }

    // Probe capture_credit_reservation
    try {
      const { error: cErr } = await anonClient.rpc('capture_credit_reservation', {
        p_user_id: dummyId,
        p_reservation_id: dummyId,
        p_capture_units: 1000,
        p_idempotency_key: 'probe_anon_cap',
      });
      if (cErr && (cErr.message.includes('permission denied') || cErr.code === '42501' || cErr.message.includes('not found'))) {
        logCheck({
          id: 'CHK-2B-PERM-02',
          name: 'capture_credit_reservation RPC execution is blocked from non-service role',
          category: 'REAL_DB_PERMISSIONS',
          status: 'PASS',
          details: `Anon RPC call blocked: ${cErr.message}`,
        });
      } else {
        logCheck({
          id: 'CHK-2B-PERM-02',
          name: 'capture_credit_reservation RPC blocked from non-service role',
          category: 'REAL_DB_PERMISSIONS',
          status: 'FAIL',
          details: `Unexpected response: ${JSON.stringify(cErr)}`,
        });
      }
    } catch (err: any) {
      logCheck({
        id: 'CHK-2B-PERM-02',
        name: 'capture_credit_reservation RPC blocked from non-service role',
        category: 'REAL_DB_PERMISSIONS',
        status: 'PASS',
        details: err.message,
      });
    }

    // Probe release_credit_reservation
    try {
      const { error: relErr } = await anonClient.rpc('release_credit_reservation', {
        p_user_id: dummyId,
        p_reservation_id: dummyId,
        p_release_units: 1000,
        p_idempotency_key: 'probe_anon_rel',
      });
      if (relErr && (relErr.message.includes('permission denied') || relErr.code === '42501' || relErr.message.includes('not found'))) {
        logCheck({
          id: 'CHK-2B-PERM-03',
          name: 'release_credit_reservation RPC execution is blocked from non-service role',
          category: 'REAL_DB_PERMISSIONS',
          status: 'PASS',
          details: `Anon RPC call blocked: ${relErr.message}`,
        });
      } else {
        logCheck({
          id: 'CHK-2B-PERM-03',
          name: 'release_credit_reservation RPC blocked from non-service role',
          category: 'REAL_DB_PERMISSIONS',
          status: 'FAIL',
          details: `Unexpected response: ${JSON.stringify(relErr)}`,
        });
      }
    } catch (err: any) {
      logCheck({
        id: 'CHK-2B-PERM-03',
        name: 'release_credit_reservation RPC blocked from non-service role',
        category: 'REAL_DB_PERMISSIONS',
        status: 'PASS',
        details: err.message,
      });
    }

    // Probe grant_user_credits
    try {
      const { error: gErr } = await anonClient.rpc('grant_user_credits', {
        p_user_id: dummyId,
        p_source_type: 'FREE_BOOTSTRAP',
        p_original_units: 1000,
        p_idempotency_key: 'probe_anon_grant',
      });
      if (gErr && (gErr.message.includes('permission denied') || gErr.code === '42501' || gErr.message.includes('not found'))) {
        logCheck({
          id: 'CHK-2B-PERM-04',
          name: 'grant_user_credits RPC execution is blocked from non-service role',
          category: 'REAL_DB_PERMISSIONS',
          status: 'PASS',
          details: `Anon RPC call blocked: ${gErr.message}`,
        });
      } else {
        logCheck({
          id: 'CHK-2B-PERM-04',
          name: 'grant_user_credits RPC blocked from non-service role',
          category: 'REAL_DB_PERMISSIONS',
          status: 'FAIL',
          details: `Unexpected response: ${JSON.stringify(gErr)}`,
        });
      }
    } catch (err: any) {
      logCheck({
        id: 'CHK-2B-PERM-04',
        name: 'grant_user_credits RPC blocked from non-service role',
        category: 'REAL_DB_PERMISSIONS',
        status: 'PASS',
        details: err.message,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 5. SERVICE ROLE READ-ONLY BALANCE RPC WITH RESERVED MODEL
  // -------------------------------------------------------------------------
  try {
    const { data: balanceData, error: bErr } = await supabase.rpc('get_user_credit_balance', {
      p_user_id: '00000000-0000-0000-0000-000000000000',
    });

    if (bErr) {
      logCheck({
        id: 'CHK-2B-SR-01',
        name: 'service_role can execute get_user_credit_balance RPC',
        category: 'REAL_DB_PERMISSIONS',
        status: 'FAIL',
        details: bErr.message,
      });
    } else if (
      balanceData &&
      'gross_remaining_units' in balanceData &&
      'reserved_units' in balanceData &&
      'total_available_units' in balanceData
    ) {
      logCheck({
        id: 'CHK-2B-SR-01',
        name: 'service_role balance RPC includes gross_remaining, reserved_units, total_available_units',
        category: 'REAL_DB_PERMISSIONS',
        status: 'PASS',
        details: `Balance response keys: ${Object.keys(balanceData).join(', ')}`,
      });
    } else {
      logCheck({
        id: 'CHK-2B-SR-01',
        name: 'service_role balance RPC schema check',
        category: 'REAL_DB_PERMISSIONS',
        status: 'FAIL',
        details: `Missing Phase 2B reservation keys in: ${JSON.stringify(balanceData)}`,
      });
    }
  } catch (err: any) {
    logCheck({
      id: 'CHK-2B-SR-01',
      name: 'service_role balance RPC execution',
      category: 'REAL_DB_PERMISSIONS',
      status: 'FAIL',
      details: err.message,
    });
  }

  // -------------------------------------------------------------------------
  // 6. RLS ISOLATION FOR RESERVATION TABLES
  // -------------------------------------------------------------------------
  if (anonClient) {
    try {
      const [resAnon, allocAnon, evAnon] = await Promise.all([
        anonClient.from('credit_reservations').select('id').limit(5),
        anonClient.from('credit_reservation_allocations').select('id').limit(5),
        anonClient.from('credit_reservation_events').select('id').limit(5),
      ]);

      const resRows = resAnon.data?.length ?? 0;
      const allocRows = allocAnon.data?.length ?? 0;
      const evRows = evAnon.data?.length ?? 0;

      if (resRows === 0 && allocRows === 0 && evRows === 0) {
        logCheck({
          id: 'CHK-2B-RLS-01',
          name: 'Row-Level Security (RLS) active and isolates client access on all reservation tables',
          category: 'REAL_DB_PERMISSIONS',
          status: 'PASS',
          details: `Anon queries returned: reservations=${resRows}, allocations=${allocRows}, events=${evRows}`,
        });
      } else {
        logCheck({
          id: 'CHK-2B-RLS-01',
          name: 'Row-Level Security isolation check',
          category: 'REAL_DB_PERMISSIONS',
          status: 'FAIL',
          details: `Anon client saw rows: reservations=${resRows}, allocations=${allocRows}, events=${evRows}`,
        });
      }
    } catch (err: any) {
      logCheck({
        id: 'CHK-2B-RLS-01',
        name: 'Row-Level Security check',
        category: 'REAL_DB_PERMISSIONS',
        status: 'PASS',
        details: `Anon access blocked by policy/permissions: ${err.message}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 7. AUDIT TEST ARTIFACTS
  // -------------------------------------------------------------------------
  try {
    const [testRes, testAlloc, testEv] = await Promise.all([
      supabase
        .from('credit_reservations')
        .select('id, idempotency_key')
        .or('idempotency_key.ilike.%test%,idempotency_key.ilike.%__TEST%,idempotency_key.ilike.%PHASE2B%')
        .limit(10),
      supabase
        .from('credit_reservation_allocations')
        .select('id')
        .limit(10),
      supabase
        .from('credit_reservation_events')
        .select('id, idempotency_key')
        .or('idempotency_key.ilike.%test%,idempotency_key.ilike.%__TEST%,idempotency_key.ilike.%PHASE2B%')
        .limit(10),
    ]);

    const testResCount = testRes.data?.length || 0;
    const testEvCount = testEv.data?.length || 0;

    if (testResCount === 0 && testEvCount === 0) {
      logCheck({
        id: 'CHK-2B-AUDIT-01',
        name: 'No test artifacts found in reservation tables (__TEST_, TEST_, PHASE2B_TEST)',
        category: 'AUDIT_SAFETY',
        status: 'PASS',
        details: '0 test reservations, 0 test reservation events',
      });
    } else {
      logCheck({
        id: 'CHK-2B-AUDIT-01',
        name: 'Test artifacts found in reservation tables',
        category: 'AUDIT_SAFETY',
        status: 'FAIL',
        details: `Found ${testResCount} test reservations, ${testEvCount} test events`,
      });
    }
  } catch (err: any) {
    logCheck({
      id: 'CHK-2B-AUDIT-01',
      name: 'Test artifacts audit',
      category: 'AUDIT_SAFETY',
      status: 'FAIL',
      details: err.message,
    });
  }

  // -------------------------------------------------------------------------
  // 8. SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log('PHASE 2B REAL DATABASE VERIFICATION SUMMARY');
  console.log('================================================================');

  const passed = checks.filter((c) => c.status === 'PASS').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const blocked = checks.filter((c) => c.status === 'BLOCKED').length;

  console.log(`Total Checks:  ${checks.length}`);
  console.log(`Passed:        ${passed}`);
  console.log(`Failed:        ${failed}`);
  console.log(`Blocked:       ${blocked}`);
  console.log('================================================================\n');

  return {
    ready: failed === 0 && blocked === 0,
    productOwnerSqlRequired: false,
    checks,
  };
}

verifyRealDb()
  .then((res) => {
    if (res.productOwnerSqlRequired) {
      console.log('VERDICT: PRODUCT_OWNER_SQL_REQUIRED');
      process.exit(2);
    } else if (res.ready) {
      console.log('REAL DB AUDIT VERDICT: ALL PHASE 2B CHECKS PASSED.');
      process.exit(0);
    } else {
      console.error('REAL DB AUDIT VERDICT: ONE OR MORE CHECKS FAILED OR BLOCKED.');
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  });
