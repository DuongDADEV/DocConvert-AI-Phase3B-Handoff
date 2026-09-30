import dotenv from 'dotenv';
dotenv.config();

async function inspectSchema() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      Accept: 'application/openapi+json, application/json'
    }
  });

  const spec = await res.json();
  const docPagesDef = spec.definitions?.document_pages || spec.components?.schemas?.document_pages;
  console.log('document_pages definition:', JSON.stringify(docPagesDef, null, 2));

  // Let's also check default values and nullability by testing an insert with default values or omitting fields
}

inspectSchema().catch(console.error);
