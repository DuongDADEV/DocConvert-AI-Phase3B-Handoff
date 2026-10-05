async function testEndpoints() {
  console.log('--- 1. Testing /api/billing/health ---');
  const hRes = await fetch('http://localhost:3000/api/billing/health');
  console.log('Health:', hRes.status, await hRes.json());

  console.log('\n--- 2. Testing /api/billing/plans?channel=WEB ---');
  const pRes = await fetch('http://localhost:3000/api/billing/plans?channel=WEB');
  const pJson = await pRes.json();
  console.log('Plans status:', pRes.status, 'source:', pJson.source, 'count:', pJson.plans?.length);
  pJson.plans?.forEach((p: any) => console.log(` - ${p.code}: ${p.price} VND, ${p.credits} credits (entitlements.included_credits: ${p.entitlements.included_credits})`));

  console.log('\n--- 3. Testing /api/billing/credit-packs?channel=WEB ---');
  const cRes = await fetch('http://localhost:3000/api/billing/credit-packs?channel=WEB');
  const cJson = await cRes.json();
  console.log('Credit packs status:', cRes.status, 'source:', cJson.source, 'count:', cJson.creditPacks?.length);
  cJson.creditPacks?.forEach((c: any) => console.log(` - ${c.code}: ${c.price} VND, ${c.credits} credits`));

  console.log('\n--- 4. Testing /api/billing/plans?channel=API ---');
  const aRes = await fetch('http://localhost:3000/api/billing/plans?channel=API');
  console.log('API channel status:', aRes.status, await aRes.json());

  console.log('\n--- 5. Testing /api/billing/version ---');
  const vRes = await fetch('http://localhost:3000/api/billing/version');
  console.log('Version status:', vRes.status, await vRes.json());
}

testEndpoints()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
