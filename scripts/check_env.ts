import 'dotenv/config';

console.log('ENV keys:');
for (const k of Object.keys(process.env)) {
  if (/pass|db|postgres|supabase|sql/i.test(k)) {
    console.log(k, '=', k.toLowerCase().includes('key') || k.toLowerCase().includes('pass') ? '***REDACTED***' : process.env[k]);
  }
}
