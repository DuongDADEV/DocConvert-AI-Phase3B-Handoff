import 'dotenv/config';
import { getSupabaseAdminClient } from '../server/services/supabaseClient.js';

if (process.env.ALLOW_DESTRUCTIVE_BILLING_TESTS !== 'true') {
  console.error('[SAFETY ERROR] This script modifies the production billing database directly.');
  console.error('To run, explicitly set ALLOW_DESTRUCTIVE_BILLING_TESTS=true in your environment.');
  process.exit(1);
}

interface TestStepResult {
  step: string;
  expected: string;
  actualStatus: 'SUCCESS' | 'BLOCKED_AS_EXPECTED' | 'UNEXPECTED_ERROR' | 'FAILED_TO_BLOCK';
  errorCode?: string;
  errorMessage?: string;
}

async function runRealDbImmutabilityTests() {
  const client = getSupabaseAdminClient();
  const results: TestStepResult[] = [];

  const TEST_VERSION_CODE = `__TEST_PRICING_LOCK_${Date.now()}__`;
  const TEST_PRODUCT_CODE = `__TEST_PROD_${Date.now()}__`;

  console.log('=== REAL DATABASE IMMUTABILITY TEST SUITE ===');
  console.log(`Test version: ${TEST_VERSION_CODE}`);
  console.log(`Test product: ${TEST_PRODUCT_CODE}\n`);

  try {
    // 1. Create temporary unlocked pricing version
    const { data: vData, error: vErr } = await client
      .from('pricing_versions')
      .insert({
        code: TEST_VERSION_CODE,
        description: 'Temporary version for Phase 1.3 Immutability Verification',
        active: false,
        is_locked: false,
      })
      .select()
      .single();

    if (vErr || !vData) throw new Error(`Failed to create test pricing version: ${vErr?.message}`);
    const testVersionId = vData.id;
    console.log(`1. Created unlocked test pricing version (id: ${testVersionId})`);

    // 2. Create temporary test billing product
    const { data: pData, error: pErr } = await client
      .from('billing_products')
      .insert({
        code: TEST_PRODUCT_CODE,
        name: 'Test Temporary Product',
        product_type: 'CREDIT_PACK',
        pricing_channel: 'WEB',
        active: false,
      })
      .select()
      .single();

    if (pErr || !pData) throw new Error(`Failed to create test product: ${pErr?.message}`);
    const testProductId = pData.id;
    console.log(`2. Created test product (id: ${testProductId})`);

    // 3. Insert test price on unlocked version
    const { data: prData, error: prErr } = await client
      .from('billing_prices')
      .insert({
        product_id: testProductId,
        pricing_version_id: testVersionId,
        currency: 'VND',
        amount_minor: 10000,
        billing_interval: 'NONE',
        interval_count: 1,
        active: true,
      })
      .select()
      .single();

    if (prErr || !prData) throw new Error(`Failed to create test price: ${prErr?.message}`);
    const testPriceId = prData.id;
    console.log(`3. Created test price (id: ${testPriceId})`);

    // 4. Insert test canonical credit grant on unlocked version
    const { data: gData, error: gErr } = await client
      .from('product_credit_grants')
      .insert({
        product_id: testProductId,
        pricing_version_id: testVersionId,
        credits_granted: 10,
        grant_type: 'ONE_TIME_PACK',
      })
      .select()
      .single();

    if (gErr || !gData) throw new Error(`Failed to create test credit grant: ${gErr?.message}`);
    const testGrantId = gData.id;
    console.log(`4. Created test credit grant (id: ${testGrantId})`);

    // 5. Test UNLOCKED behavior: UPDATE allowed
    const { error: unlockedUpdErr } = await client
      .from('billing_prices')
      .update({ amount_minor: 20000 })
      .eq('id', testPriceId);

    if (unlockedUpdErr) {
      results.push({
        step: 'UNLOCKED_PRICE_UPDATE',
        expected: 'Allowed',
        actualStatus: 'UNEXPECTED_ERROR',
        errorCode: unlockedUpdErr.code,
        errorMessage: unlockedUpdErr.message,
      });
      console.log('❌ Unlocked price update failed:', unlockedUpdErr.message);
    } else {
      results.push({
        step: 'UNLOCKED_PRICE_UPDATE',
        expected: 'Allowed',
        actualStatus: 'SUCCESS',
      });
      console.log('✅ Unlocked price update allowed as expected');
    }

    // 6. LOCK the test pricing version (is_locked: false -> true)
    console.log('\n--- LOCKING TEST PRICING VERSION (is_locked = true) ---');
    const { error: lockErr } = await client
      .from('pricing_versions')
      .update({ is_locked: true })
      .eq('id', testVersionId);

    if (lockErr) throw new Error(`Failed to lock test version: ${lockErr.message}`);
    console.log('Test version is now locked!');

    // 7. REAL TEST A: UPDATE billing_prices on locked version must FAIL
    const { error: lockedPriceUpdErr } = await client
      .from('billing_prices')
      .update({ amount_minor: 99999 })
      .eq('id', testPriceId);

    const isBlockedA = lockedPriceUpdErr?.message?.includes('PRICING_VERSION_LOCKED');
    results.push({
      step: 'TEST_A_LOCKED_PRICE_UPDATE',
      expected: 'PRICING_VERSION_LOCKED exception',
      actualStatus: isBlockedA ? 'BLOCKED_AS_EXPECTED' : 'FAILED_TO_BLOCK',
      errorCode: lockedPriceUpdErr?.code,
      errorMessage: lockedPriceUpdErr?.message,
    });
    console.log(`Test A (Locked Price UPDATE): ${isBlockedA ? '✅ BLOCKED' : '❌ FAILED'} -> ${lockedPriceUpdErr?.message}`);

    // 8. REAL TEST B: DELETE billing_prices on locked version must FAIL
    const { error: lockedPriceDelErr } = await client
      .from('billing_prices')
      .delete()
      .eq('id', testPriceId);

    const isBlockedB = lockedPriceDelErr?.message?.includes('PRICING_VERSION_LOCKED');
    results.push({
      step: 'TEST_B_LOCKED_PRICE_DELETE',
      expected: 'PRICING_VERSION_LOCKED exception',
      actualStatus: isBlockedB ? 'BLOCKED_AS_EXPECTED' : 'FAILED_TO_BLOCK',
      errorCode: lockedPriceDelErr?.code,
      errorMessage: lockedPriceDelErr?.message,
    });
    console.log(`Test B (Locked Price DELETE): ${isBlockedB ? '✅ BLOCKED' : '❌ FAILED'} -> ${lockedPriceDelErr?.message}`);

    // 9. REAL TEST C: UPDATE product_credit_grants on locked version must FAIL
    const { error: lockedGrantUpdErr } = await client
      .from('product_credit_grants')
      .update({ credits_granted: 9999 })
      .eq('id', testGrantId);

    const isBlockedC = lockedGrantUpdErr?.message?.includes('PRICING_VERSION_LOCKED');
    results.push({
      step: 'TEST_C_LOCKED_GRANT_UPDATE',
      expected: 'PRICING_VERSION_LOCKED exception',
      actualStatus: isBlockedC ? 'BLOCKED_AS_EXPECTED' : 'FAILED_TO_BLOCK',
      errorCode: lockedGrantUpdErr?.code,
      errorMessage: lockedGrantUpdErr?.message,
    });
    console.log(`Test C (Locked Grant UPDATE): ${isBlockedC ? '✅ BLOCKED' : '❌ FAILED'} -> ${lockedGrantUpdErr?.message}`);

    // 10. REAL TEST D: DELETE product_credit_grants on locked version must FAIL
    const { error: lockedGrantDelErr } = await client
      .from('product_credit_grants')
      .delete()
      .eq('id', testGrantId);

    const isBlockedD = lockedGrantDelErr?.message?.includes('PRICING_VERSION_LOCKED');
    results.push({
      step: 'TEST_D_LOCKED_GRANT_DELETE',
      expected: 'PRICING_VERSION_LOCKED exception',
      actualStatus: isBlockedD ? 'BLOCKED_AS_EXPECTED' : 'FAILED_TO_BLOCK',
      errorCode: lockedGrantDelErr?.code,
      errorMessage: lockedGrantDelErr?.message,
    });
    console.log(`Test D (Locked Grant DELETE): ${isBlockedD ? '✅ BLOCKED' : '❌ FAILED'} -> ${lockedGrantDelErr?.message}`);

    // 11. REAL TEST E: UPDATE pricing_versions SET is_locked = false must FAIL
    const { error: unlockErr } = await client
      .from('pricing_versions')
      .update({ is_locked: false })
      .eq('id', testVersionId);

    const isBlockedE = unlockErr?.message?.includes('PRICING_VERSION_LOCK_MONOTONIC');
    results.push({
      step: 'TEST_E_PRICING_VERSION_UNLOCK',
      expected: 'PRICING_VERSION_LOCK_MONOTONIC exception',
      actualStatus: isBlockedE ? 'BLOCKED_AS_EXPECTED' : 'FAILED_TO_BLOCK',
      errorCode: unlockErr?.code,
      errorMessage: unlockErr?.message,
    });
    console.log(`Test E (Version Unlock true -> false): ${isBlockedE ? '✅ BLOCKED' : '❌ FAILED'} -> ${unlockErr?.message}`);

    // 12. REAL TEST F: DELETE locked pricing_version must FAIL
    const { error: delVersionErr } = await client
      .from('pricing_versions')
      .delete()
      .eq('id', testVersionId);

    const isBlockedF = delVersionErr?.message?.includes('PRICING_VERSION_LOCKED');
    results.push({
      step: 'TEST_F_LOCKED_VERSION_DELETE',
      expected: 'PRICING_VERSION_LOCKED exception',
      actualStatus: isBlockedF ? 'BLOCKED_AS_EXPECTED' : 'FAILED_TO_BLOCK',
      errorCode: delVersionErr?.code,
      errorMessage: delVersionErr?.message,
    });
    console.log(`Test F (Locked Version DELETE): ${isBlockedF ? '✅ BLOCKED' : '❌ FAILED'} -> ${delVersionErr?.message}`);

    console.log('\n=== REAL DATABASE IMMUTABILITY TEST SUMMARY ===');
    console.table(results);
  } catch (err: any) {
    console.error('Fatal test error:', err);
    process.exit(1);
  }
}

runRealDbImmutabilityTests()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
