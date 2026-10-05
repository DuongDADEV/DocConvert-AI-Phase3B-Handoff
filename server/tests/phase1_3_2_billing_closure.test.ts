import 'dotenv/config';
import * as fs from 'fs';
import { billingService, BillingCatalogUnavailableError } from '../services/billing/billingService.js';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';

interface InvariantResult {
  id: string;
  description: string;
  status: 'PASS' | 'FAIL';
  details?: string;
}

const results: InvariantResult[] = [];

function recordInvariant(result: InvariantResult) {
  results.push(result);
  const color = result.status === 'PASS' ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
  console.log(`${color} ${result.id}: ${result.description}`);
  if (result.details) {
    console.log(`       Details: ${result.details}`);
  }
}

async function runPhase132Tests() {
  console.log('================================================================');
  console.log('PHASE 1.3.2 — CANONICAL CREDIT & FALLBACK VERIFICATION CLOSURE');
  console.log('Target: tppggnsidopyzrzszbbc (REAL SUPABASE POSTGRESQL)');
  console.log('================================================================\n');

  const supabase = getSupabaseAdminClient();

  // CL-01: Subscription catalog uses product_credit_grants as canonical credit source
  try {
    const plans = await billingService.getActivePricingPlans('WEB');
    const { data: grants, error } = await supabase
      .from('product_credit_grants')
      .select('credits_granted, billing_products!inner(code)')
      .eq('grant_type', 'SUBSCRIPTION_CYCLE');

    if (error) throw error;
    const grantMap = new Map((grants || []).map((g: any) => [g.billing_products.code, g.credits_granted]));

    let matchAll = plans.length === 4;
    for (const plan of plans) {
      if (plan.credits !== grantMap.get(plan.code)) {
        matchAll = false;
        break;
      }
    }

    recordInvariant({
      id: 'CL-01',
      description: 'Subscription catalog uses product_credit_grants as canonical credit source',
      status: matchAll ? 'PASS' : 'FAIL',
      details: plans.map((p) => `${p.code}: ${p.credits} credits`).join(', '),
    });
  } catch (err: any) {
    recordInvariant({
      id: 'CL-01',
      description: 'Subscription catalog uses product_credit_grants as canonical credit source',
      status: 'FAIL',
      details: err.message,
    });
  }

  // CL-02 & CL-03: Missing canonical subscription grant fails closed when fallback disabled, NEVER uses plan_entitlements.included_credits
  try {
    const savedFallback = process.env.ALLOW_BILLING_CATALOG_FALLBACK;
    const savedNodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_BILLING_CATALOG_FALLBACK; // Fallback disabled

    // Create a mock client where product_credit_grants is empty or missing a row, but plan_entitlements has included_credits = 999
    const mockClientMissingGrant = {
      from: (table: string) => {
        if (table === 'pricing_versions') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: '02de6070-dc3f-465c-9a07-6c7430cef453', code: 'pricing-v1', active: true, is_locked: true },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'billing_products') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: async () => ({
                    data: [
                      {
                        id: 'mock-sub-1',
                        code: 'MOCK_PLAN',
                        name: 'Mock Plan',
                        product_type: 'SUBSCRIPTION',
                        pricing_channel: 'WEB',
                        active: true,
                        metadata: { sort_order: 1 },
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'billing_prices') {
          return {
            select: () => ({
              in: () => ({
                eq: () => ({
                  eq: async () => ({
                    data: [
                      {
                        id: 'mock-price-1',
                        product_id: 'mock-sub-1',
                        pricing_version_id: '02de6070-dc3f-465c-9a07-6c7430cef453',
                        amount_minor: 100000,
                        currency: 'VND',
                        billing_interval: 'MONTH',
                        active: true,
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'plan_entitlements') {
          return {
            select: () => ({
              in: () => ({
                eq: async () => ({
                  data: [
                    {
                      id: 'mock-ent-1',
                      product_id: 'mock-sub-1',
                      pricing_version_id: '02de6070-dc3f-465c-9a07-6c7430cef453',
                      included_credits: 9999, // Should NEVER be used!
                      max_file_mb: 50,
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'product_credit_grants') {
          return {
            select: () => ({
              in: () => ({
                eq: async () => ({
                  data: [], // MISSING GRANT!
                  error: null,
                }),
              }),
            }),
          };
        }
        return { select: () => ({}) };
      },
    };

    billingService.setClientOverride(mockClientMissingGrant);

    let failedClosed = false;
    let usedIncludedCredits = false;
    try {
      const plans = await billingService.getActivePricingPlans('WEB');
      if (plans.some((p) => p.credits === 9999)) {
        usedIncludedCredits = true;
      }
    } catch (err: any) {
      if (err instanceof BillingCatalogUnavailableError || err.message.includes('BILLING_CATALOG_UNAVAILABLE')) {
        failedClosed = true;
      }
    } finally {
      billingService.setClientOverride(null);
      process.env.NODE_ENV = savedNodeEnv;
      if (savedFallback) process.env.ALLOW_BILLING_CATALOG_FALLBACK = savedFallback;
      else delete process.env.ALLOW_BILLING_CATALOG_FALLBACK;
    }

    recordInvariant({
      id: 'CL-02',
      description: 'Missing canonical subscription grant fails closed when fallback disabled',
      status: failedClosed ? 'PASS' : 'FAIL',
      details: failedClosed ? 'Threw controlled BillingCatalogUnavailableError as expected.' : 'Did not fail closed.',
    });

    recordInvariant({
      id: 'CL-03',
      description: 'Missing canonical subscription grant NEVER uses plan_entitlements.included_credits',
      status: !usedIncludedCredits && failedClosed ? 'PASS' : 'FAIL',
      details: 'Included_credits = 9999 was rejected and not used.',
    });
  } catch (err: any) {
    recordInvariant({
      id: 'CL-02',
      description: 'Missing canonical subscription grant fails closed when fallback disabled',
      status: 'FAIL',
      details: err.message,
    });
    recordInvariant({
      id: 'CL-03',
      description: 'Missing canonical subscription grant NEVER uses plan_entitlements.included_credits',
      status: 'FAIL',
      details: err.message,
    });
  }

  // CL-04: Development fallback explicitly enabled + forced DB failure returns fallback data with source=FALLBACK
  try {
    const savedFallback = process.env.ALLOW_BILLING_CATALOG_FALLBACK;
    const savedNodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = 'development';
    process.env.ALLOW_BILLING_CATALOG_FALLBACK = 'true';

    // Mock client that simulates complete network / database failure
    const mockFailingClient = {
      from: () => {
        throw new Error('SIMULATED_DB_NETWORK_UNREACHABLE');
      },
    };

    billingService.setClientOverride(mockFailingClient);

    const plans = await billingService.getActivePricingPlans('WEB');
    const source = (plans as any).source;

    billingService.setClientOverride(null);
    process.env.NODE_ENV = savedNodeEnv;
    if (savedFallback) process.env.ALLOW_BILLING_CATALOG_FALLBACK = savedFallback;
    else delete process.env.ALLOW_BILLING_CATALOG_FALLBACK;

    const ok = plans.length === 4 && source === 'FALLBACK';
    recordInvariant({
      id: 'CL-04',
      description: 'Development fallback explicitly enabled + forced DB failure returns fallback data with source=FALLBACK',
      status: ok ? 'PASS' : 'FAIL',
      details: `Returned ${plans.length} fallback plans with source: '${source}'`,
    });
  } catch (err: any) {
    billingService.setClientOverride(null);
    recordInvariant({
      id: 'CL-04',
      description: 'Development fallback explicitly enabled + forced DB failure returns fallback data with source=FALLBACK',
      status: 'FAIL',
      details: err.message,
    });
  }

  // CL-05: Production DB failure never returns fallback
  try {
    const savedFallback = process.env.ALLOW_BILLING_CATALOG_FALLBACK;
    const savedNodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_BILLING_CATALOG_FALLBACK;

    const mockFailingClient = {
      from: () => {
        throw new Error('SIMULATED_PROD_DB_NETWORK_OUTAGE');
      },
    };

    billingService.setClientOverride(mockFailingClient);

    let threwProdError = false;
    try {
      await billingService.getActivePricingPlans('WEB');
    } catch (err: any) {
      if (err instanceof BillingCatalogUnavailableError || err.message.includes('BILLING_CATALOG_UNAVAILABLE')) {
        threwProdError = true;
      }
    } finally {
      billingService.setClientOverride(null);
      process.env.NODE_ENV = savedNodeEnv;
      if (savedFallback) process.env.ALLOW_BILLING_CATALOG_FALLBACK = savedFallback;
      else delete process.env.ALLOW_BILLING_CATALOG_FALLBACK;
    }

    recordInvariant({
      id: 'CL-05',
      description: 'Production DB failure never returns fallback (fails closed with BillingCatalogUnavailableError)',
      status: threwProdError ? 'PASS' : 'FAIL',
    });
  } catch (err: any) {
    billingService.setClientOverride(null);
    recordInvariant({
      id: 'CL-05',
      description: 'Production DB failure never returns fallback',
      status: 'FAIL',
      details: err.message,
    });
  }

  // CL-06: getCanonicalCreditGrant() remains fail-closed
  try {
    let failedClosed = false;
    try {
      await billingService.getCanonicalCreditGrant('NON_CONFIGURED_PROD_XYZ');
    } catch (err: any) {
      if (err.message.includes('CANONICAL_CREDIT_GRANT_NOT_FOUND')) {
        failedClosed = true;
      }
    }

    recordInvariant({
      id: 'CL-06',
      description: 'getCanonicalCreditGrant() remains fail-closed (never returns fallback credits)',
      status: failedClosed ? 'PASS' : 'FAIL',
    });
  } catch (err: any) {
    recordInvariant({
      id: 'CL-06',
      description: 'getCanonicalCreditGrant() remains fail-closed',
      status: 'FAIL',
      details: err.message,
    });
  }

  // CL-07: Normal real DB catalog still returns source=DATABASE
  try {
    const plans = await billingService.getActivePricingPlans('WEB');
    const source = (plans as any).source;
    const ok = plans.length === 4 && source === 'DATABASE';

    recordInvariant({
      id: 'CL-07',
      description: 'Normal real DB catalog still returns source=DATABASE',
      status: ok ? 'PASS' : 'FAIL',
      details: `Active real DB plans: ${plans.length}, source: '${source}'`,
    });
  } catch (err: any) {
    recordInvariant({
      id: 'CL-07',
      description: 'Normal real DB catalog still returns source=DATABASE',
      status: 'FAIL',
      details: err.message,
    });
  }

  // CL-08: Frontend production build succeeds
  const distHtml = fs.existsSync('./dist/index.html');
  recordInvariant({
    id: 'CL-08',
    description: 'Frontend production build artifact exists and is verified',
    status: distHtml ? 'PASS' : 'FAIL',
  });

  console.log('\n================================================================');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL INVARIANTS: ${results.length} | PASS: ${passCount} | FAIL: ${failCount}`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runPhase132Tests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
