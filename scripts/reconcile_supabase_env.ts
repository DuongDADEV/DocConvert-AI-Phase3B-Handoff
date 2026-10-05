import 'dotenv/config';
import fs from 'fs';
import { getSupabaseAdminClient, getBaseSupabaseClient } from '../server/services/supabaseClient.js';

function getSafeRef(urlStr: string) {
  try {
    const u = new URL(urlStr);
    return {
      host: u.hostname,
      projectRef: u.hostname.split('.')[0],
    };
  } catch {
    return { host: 'INVALID', projectRef: 'INVALID' };
  }
}

async function reconcile() {
  console.log('====================================================');
  console.log('SUPABASE ENVIRONMENT & MIGRATION RECONCILIATION');
  console.log('====================================================\n');

  // 1. Environment sources
  const envUrl = process.env.SUPABASE_URL || '';
  const parsedEnv = getSafeRef(envUrl);

  const adminClient = getSupabaseAdminClient();
  const adminUrl = (adminClient as any).supabaseUrl || '';
  const parsedAdmin = getSafeRef(adminUrl);

  const baseClient = getBaseSupabaseClient();
  const baseUrl = (baseClient as any)?.supabaseUrl || '';
  const parsedBase = getSafeRef(baseUrl);

  console.log('1. ENVIRONMENT CONFIGURATION:');
  console.log(' - .env SUPABASE_URL Host:', parsedEnv.host);
  console.log(' - .env Project Ref:     ', parsedEnv.projectRef);
  console.log(' - Admin Client Host:    ', parsedAdmin.host);
  console.log(' - Admin Client Ref:     ', parsedAdmin.projectRef);
  console.log(' - Base Client Host:     ', parsedBase.host);
  console.log(' - Base Client Ref:      ', parsedBase.projectRef);

  // 2. Querying database tables using exact admin client
  console.log('\n2. PROBING DATABASE TABLES VIA SUPABASE REST CLIENT:');

  const tablesToProbe = [
    'pricing_versions',
    'billing_products',
    'billing_prices',
    'plan_entitlements',
    'user_subscriptions',
    'product_credit_grants',
    'plans',
    'profiles',
    'documents',
    'processing_jobs',
    'subscriptions',
    'usage',
  ];

  const tableStatus: Record<string, { exists: boolean; rowCount?: number; error?: string }> = {};

  for (const table of tablesToProbe) {
    try {
      const { data, count, error } = await adminClient
        .from(table)
        .select('*', { count: 'exact', head: true });

      if (error) {
        tableStatus[table] = {
          exists: false,
          error: `${error.code}: ${error.message}`,
        };
      } else {
        tableStatus[table] = {
          exists: true,
          rowCount: count ?? 0,
        };
      }
    } catch (err: any) {
      tableStatus[table] = {
        exists: false,
        error: err.message,
      };
    }
  }

  for (const [t, s] of Object.entries(tableStatus)) {
    if (s.exists) {
      console.log(` [EXISTS]     ${t.padEnd(25)} : ${s.rowCount} rows`);
    } else {
      console.log(` [NOT FOUND]  ${t.padEnd(25)} : ${s.error}`);
    }
  }

  // 3. Check migration tables (supabase_migrations.schema_migrations)
  console.log('\n3. CHECKING MIGRATION METADATA TABLES:');
  const migrationTables = [
    'schema_migrations',
    '_prisma_migrations',
    'supabase_migrations',
  ];

  for (const mt of migrationTables) {
    const { data, error } = await adminClient.from(mt).select('*').limit(5);
    if (!error) {
      console.log(` Found migration table '${mt}':`, data);
    } else {
      console.log(` Migration table '${mt}': ${error.message}`);
    }
  }
}

reconcile()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
