import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

async function inspectDb() {
  const supabase = getSupabaseAdminClient();

  console.log('=== REALITY CHECK 1: public.plans ===');
  const { data: plans, error: plansErr } = await supabase.from('plans').select('*');
  if (plansErr) {
    console.error('plans error:', plansErr.message);
  } else {
    console.log(JSON.stringify(plans, null, 2));
  }

  console.log('\n=== REALITY CHECK 2: public.profiles GROUP BY current_plan_id ===');
  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('id, email, current_plan_id, used_documents');
  if (profErr) {
    console.error('profiles error:', profErr.message);
  } else {
    const counts: Record<string, number> = {};
    profiles.forEach((p) => {
      counts[p.current_plan_id] = (counts[p.current_plan_id] || 0) + 1;
    });
    console.log('Profile count grouped by current_plan_id:', counts);
    console.log('Detailed profiles list:');
    profiles.forEach((p) => {
      console.log(` - user: ${p.id}, email: ${p.email}, plan: ${p.current_plan_id}, used_docs: ${p.used_documents}`);
    });
  }

  console.log('\n=== REALITY CHECK 3: public.subscriptions ===');
  const { data: subs, error: subErr } = await supabase.from('subscriptions').select('*');
  if (subErr) {
    console.error('subscriptions error:', subErr.message);
  } else {
    console.log(`Total subscription rows: ${subs?.length || 0}`);
    subs?.forEach((s) => {
      console.log(` - sub: ${s.id}, user: ${s.user_id}, plan_id: ${s.plan_id}, status: ${s.status}`);
    });
  }

  console.log('\n=== REALITY CHECK 4: public.billing_products ===');
  const { data: prods, error: prodErr } = await supabase.from('billing_products').select('id, code, name, product_type, active');
  if (prodErr) {
    console.log('billing_products error or not in schema cache:', prodErr.message);
  } else {
    console.log('Billing products in DB:', prods);
  }
}

inspectDb()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
