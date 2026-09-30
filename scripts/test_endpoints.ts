import 'dotenv/config';

async function test() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  const endpoints = ['/pg/query', '/rest/v1/rpc', '/sql', '/pg/v1/query', '/api/v1/query'];
  for (const ep of endpoints) {
    try {
      const res = await fetch(url + ep, {
        method: 'POST',
        headers: {
          'apikey': key,
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'SELECT 1;' }),
      });
      console.log(ep, 'status:', res.status, 'body:', (await res.text()).slice(0, 100));
    } catch (e: any) {
      console.log(ep, 'failed:', e.message);
    }
  }
}

test().then(() => process.exit(0)).catch(console.error);
