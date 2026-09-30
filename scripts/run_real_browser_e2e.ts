import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

interface BrowserTestResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  details: string;
  durationMs: number;
}

const results: BrowserTestResult[] = [];

async function recordBrowserTest(id: string, name: string, fn: () => Promise<string | void>) {
  const start = Date.now();
  console.log(`\n========================================`);
  console.log(`[REAL BROWSER E2E] Running ${id}: ${name}`);
  console.log(`========================================`);
  try {
    const detail = await fn();
    const duration = Date.now() - start;
    results.push({ id, name, status: 'PASS', details: (detail as string) || 'OK', durationMs: duration });
    console.log(`>>> [PASS] ${id} passed in ${duration}ms: ${(detail as string) || 'OK'}`);
  } catch (err: any) {
    const duration = Date.now() - start;
    results.push({ id, name, status: 'FAIL', details: err.message, durationMs: duration });
    console.error(`>>> [FAIL] ${id} failed in ${duration}ms:`, err.message);
  }
}

async function main() {
  console.log('Starting Real Chromium/Edge Browser for Phase 8 E2E verification...');

  // Launch real browser engine (Microsoft Edge / Chromium)
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log('[BROWSER CONSOLE ERROR]', msg.text());
    }
  });
  page.on('pageerror', (err) => console.error('[BROWSER UNCAUGHT ERROR]', err.message));

  const docId = '11111111-2222-3333-4444-555555555555';
  const cell1Id = '44444444-5555-6666-7777-888888888881';
  const cell2Id = '44444444-5555-6666-7777-888888888882';
  const cell3Id = '44444444-5555-6666-7777-888888888883';

  try {
    // 1. AUTHENTICATION VIA UI
    console.log('Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

    // Open login modal / navigate to login page if on landing
    const loginNavBtn = page.locator('button:has-text("Đăng nhập")');
    if (await loginNavBtn.first().isVisible()) {
      await loginNavBtn.first().click();
      await page.waitForTimeout(500);
    }

    // Fill credentials into actual DOM form
    const emailInput = page.locator('input[type="email"]');
    const passwordInput = page.locator('input[type="password"]');
    if (await emailInput.isVisible()) {
      console.log('Submitting login form with test credentials...');
      await emailInput.fill('test_browser_e2e@docconvert.test');
      await passwordInput.fill('Password123!');
      await page.locator('button[type="submit"]:has-text("Đăng nhập")').click();
      await page.waitForTimeout(1500);
    }

    // 2. NAVIGATE TO DOCUMENTS PAGE
    console.log('Navigating to Documents tab...');
    const docTabBtn = page.locator('button:has-text("Tài liệu")');
    await docTabBtn.first().click();
    await page.waitForTimeout(1000);

    // Wait for the seeded document row to appear
    const reviewBtn = page.locator(`#btn-table-review-${docId}`);
    await reviewBtn.waitFor({ state: 'visible', timeout: 10000 });
    console.log('Found document row and review button in DOM.');

    // =========================================================================
    // BE1 — OPEN REVIEW WORKSPACE WITH REVIEW_REQUIRED CELL
    // =========================================================================
    await recordBrowserTest('BE1', 'Open Review Workspace with REVIEW_REQUIRED cell', async () => {
      await reviewBtn.click();

      // Wait for workspace modal to render
      const workspaceModal = page.locator('#ocr-review-workspace-modal');
      await workspaceModal.waitFor({ state: 'visible', timeout: 10000 });

      // Wait for loading spinner to finish
      await page.locator('text=Đang tải và phân tích dữ liệu OCR').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);

      // Check review status badge in header
      const statusBadge = page.locator('#badge-doc-review-status');
      await statusBadge.waitFor({ state: 'visible' });
      const badgeText = (await statusBadge.textContent())?.trim() || '';
      if (!badgeText.includes('Chưa đối soát')) {
        throw new Error(`Expected review status 'Chưa đối soát', got: '${badgeText}'`);
      }

      // Check Review Queue toolbar
      const queueText = await page.locator('text=Cần kiểm tra:').first().textContent();

      // Check Cell 1 has 'Cần kiểm tra' badge
      const cell1 = page.locator(`#cell-${cell1Id}`);
      await cell1.waitFor({ state: 'visible', timeout: 10000 });
      const cell1Text = await cell1.textContent();
      if (!cell1Text?.includes('1.25O.OOO') || !cell1Text?.includes('Cần kiểm tra')) {
        throw new Error(`Cell 1 missing expected content or review badge. DOM: ${cell1Text}`);
      }

      return `Workspace opened. Badge: '${badgeText}', Queue: '${queueText?.trim()}', Cell 1: 1.25O.OOO (Cần kiểm tra)`;
    });

    // =========================================================================
    // BE2 — VALID HUMAN EDIT
    // =========================================================================
    await recordBrowserTest('BE2', 'Valid Human Edit: double click, save, verify HUMAN badge and value change', async () => {
      const cell1 = page.locator(`#cell-${cell1Id}`);
      await cell1.dblclick();
      await page.waitForTimeout(300);

      const editInput = cell1.locator('input[type="text"]');
      await editInput.waitFor({ state: 'visible', timeout: 5000 });
      await editInput.fill('1.250.000');

      // Click Save button and wait for HTTP 200 response
      const saveBtn = page.locator(`#btn-save-${cell1Id}`);
      await Promise.all([
        page.waitForResponse((res) => res.url().includes(`/cells/${cell1Id}`) && res.status() === 200, { timeout: 10000 }),
        saveBtn.click(),
      ]);

      // Wait until edit input is hidden (reconciliation completed)
      await editInput.waitFor({ state: 'hidden', timeout: 10000 });
      await page.waitForTimeout(500);

      // Assert cell value updated
      const cell1After = await cell1.textContent();
      if (!cell1After?.includes('1.250.000')) {
        throw new Error(`Cell 1 did not update to 1.250.000. Got: ${cell1After}`);
      }
      if (!cell1After?.includes('Đã đối soát')) {
        throw new Error(`Cell 1 missing HUMAN_RESOLVED badge 'Đã đối soát'. Got: ${cell1After}`);
      }

      // Assert header review status changed to IN_PROGRESS
      const statusBadge = page.locator('#badge-doc-review-status');
      const badgeText = (await statusBadge.textContent())?.trim() || '';
      if (!badgeText.includes('Đang đối soát')) {
        throw new Error(`Expected review status 'Đang đối soát', got: '${badgeText}'`);
      }

      return `Cell 1 saved as '1.250.000', badge 'Đã đối soát' (HUMAN), Document status: '${badgeText}'`;
    });

    // =========================================================================
    // BE3 — INVALID HUMAN EDIT
    // =========================================================================
    await recordBrowserTest('BE3', 'Invalid Human Edit: 422 error inline, persisted value unchanged', async () => {
      const cell1 = page.locator(`#cell-${cell1Id}`);
      await cell1.dblclick();
      await page.waitForTimeout(300);

      const editInput = cell1.locator('input[type="text"]');
      await editInput.waitFor({ state: 'visible' });
      await editInput.fill('INVALID_MONEY');

      const saveBtn = page.locator(`#btn-save-${cell1Id}`);
      await Promise.all([
        page.waitForResponse((res) => res.url().includes(`/cells/${cell1Id}`) && res.status() === 422, { timeout: 10000 }),
        saveBtn.click(),
      ]);

      // Assert validation error message is rendered inline inside the cell
      const errorPill = cell1.locator('.text-rose-300');
      await errorPill.waitFor({ state: 'visible', timeout: 5000 });
      const errorMsgText = (await errorPill.textContent())?.trim() || '';

      // Click cancel to exit edit mode
      const cancelBtn = page.locator(`#btn-cancel-${cell1Id}`);
      await cancelBtn.click({ force: true });
      await editInput.waitFor({ state: 'hidden', timeout: 5000 });
      await page.waitForTimeout(300);

      // Assert persisted value remains 1.250.000
      const cell1Current = await cell1.textContent();
      if (!cell1Current?.includes('1.250.000') || cell1Current?.includes('INVALID_MONEY')) {
        throw new Error(`Persisted value corrupted after invalid edit! Got: ${cell1Current}`);
      }

      return `Inline error shown: '${errorMsgText}'. Persisted value preserved: '1.250.000' (no invalid overwrite)`;
    });

    // =========================================================================
    // BE4 — CONFIRM AS-IS
    // =========================================================================
    await recordBrowserTest('BE4', 'Confirm As-Is: click confirm, verify HUMAN resolved state', async () => {
      const cell2 = page.locator(`#cell-${cell2Id}`);
      await cell2.waitFor({ state: 'visible' });

      // Click confirm button on cell 2 and wait for 200 response
      const confirmBtn = page.locator(`#btn-confirm-${cell2Id}`);
      await confirmBtn.waitFor({ state: 'attached' });
      await Promise.all([
        page.waitForResponse((res) => res.url().includes(`/confirm-review`) && res.status() === 200, { timeout: 10000 }),
        confirmBtn.click({ force: true }),
      ]);

      // Wait for refetch to complete and badge to appear
      await page.locator('text=Đang tải dữ liệu...').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
      await cell2.locator('text=Đã đối soát').waitFor({ state: 'visible', timeout: 10000 });

      const cell2After = await cell2.textContent();
      if (!cell2After?.includes('500.000')) {
        throw new Error(`Cell 2 value altered! Got: ${cell2After}`);
      }

      return `Cell 2 confirmed as-is: '500.000' with badge 'Đã đối soát' (HUMAN)`;
    });

    // =========================================================================
    // BE5 — COMPLETE REVIEW WITH BLOCKER
    // =========================================================================
    await recordBrowserTest('BE5', 'Complete Review with blocker: completion gate blocks and shows blocking modal', async () => {
      // Cell 3 is still invalid ('32/13/2025' DATE)
      const completeBtn = page.locator('#btn-complete-review');
      await Promise.all([
        page.waitForResponse((res) => res.url().includes(`/review/complete`) && res.status() === 400, { timeout: 10000 }),
        completeBtn.click(),
      ]);

      // Modal blocking gate should appear
      const gateModal = page.locator('#modal-blocking-cells-gate');
      await gateModal.waitFor({ state: 'visible', timeout: 5000 });

      const modalText = await gateModal.textContent();
      if (!modalText?.includes('Chưa thể hoàn tất đối soát') || !modalText?.includes('1')) {
        throw new Error(`Blocking modal did not show correct blocker count. DOM: ${modalText}`);
      }

      // Assert doc status remains 'Đang đối soát'
      const statusBadge = page.locator('#badge-doc-review-status');
      const badgeText = (await statusBadge.textContent())?.trim() || '';
      if (!badgeText.includes('Đang đối soát')) {
        throw new Error(`Review status changed prematurely! Got: ${badgeText}`);
      }

      // Close modal
      const closeGateBtn = gateModal.locator('button:has-text("Đóng")');
      await closeGateBtn.click();
      await gateModal.waitFor({ state: 'hidden', timeout: 5000 });
      await page.waitForTimeout(300);

      return `Blocking gate triggered successfully. Modal showed 1 unresolved blocking cell. Document status remained 'Đang đối soát'.`;
    });

    // =========================================================================
    // BE6 — COMPLETE REVIEW SUCCESS
    // =========================================================================
    await recordBrowserTest('BE6', 'Complete Review success: resolve blocker, complete review, verify REVIEWED badge', async () => {
      // Resolve cell 3
      const cell3 = page.locator(`#cell-${cell3Id}`);
      await cell3.dblclick();
      await page.waitForTimeout(300);

      const editInput = cell3.locator('input[type="text"]');
      await editInput.waitFor({ state: 'visible' });
      await editInput.fill('28/02/2026');

      const saveBtn = page.locator(`#btn-save-${cell3Id}`);
      await Promise.all([
        page.waitForResponse((res) => res.url().includes(`/cells/${cell3Id}`) && res.status() === 200, { timeout: 10000 }),
        saveBtn.click(),
      ]);
      await editInput.waitFor({ state: 'hidden', timeout: 10000 });
      await page.locator('text=Đang tải dữ liệu...').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
      await cell3.locator('text=Đã đối soát').waitFor({ state: 'visible', timeout: 10000 });

      // Click complete review
      const completeBtn = page.locator('#btn-complete-review');
      await Promise.all([
        page.waitForResponse((res) => res.url().includes(`/review/complete`) && res.status() === 200, { timeout: 10000 }),
        completeBtn.click(),
      ]);

      // Wait for reviewed status badge
      const statusBadge = page.locator('#badge-doc-review-status');
      await statusBadge.locator('text=Đã đối soát').waitFor({ state: 'visible', timeout: 10000 });
      const badgeText = (await statusBadge.textContent())?.trim() || '';

      return `Final blocker resolved ('28/02/2026'). Complete review passed. Header badge: '${badgeText}'`;
    });

    // =========================================================================
    // BE7 — BROWSER REFRESH
    // =========================================================================
    await recordBrowserTest('BE7', 'Browser refresh: reload page and verify persisted decisions remain intact', async () => {
      // Reload browser page
      console.log('Reloading page via real browser navigation...');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);

      // Navigate back to Documents tab
      const docTabBtn = page.locator('button:has-text("Tài liệu")');
      if (await docTabBtn.first().isVisible()) {
        await docTabBtn.first().click();
        await page.waitForTimeout(1000);
      }

      // Reopen workspace
      const reviewBtnAfter = page.locator(`#btn-table-review-${docId}`);
      await reviewBtnAfter.waitFor({ state: 'visible', timeout: 10000 });
      await reviewBtnAfter.click();

      const workspaceModal = page.locator('#ocr-review-workspace-modal');
      await workspaceModal.waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('text=Đang tải và phân tích dữ liệu OCR').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);

      // Verify document status is still 'Đã đối soát'
      const statusBadge = page.locator('#badge-doc-review-status');
      await statusBadge.locator('text=Đã đối soát').waitFor({ state: 'visible', timeout: 10000 });
      const badgeText = (await statusBadge.textContent())?.trim() || '';

      // Verify Cell 1: 1.250.000 + Đã đối soát
      const cell1 = page.locator(`#cell-${cell1Id}`);
      const cell1Text = await cell1.textContent();
      if (!cell1Text?.includes('1.250.000') || !cell1Text?.includes('Đã đối soát')) {
        throw new Error(`Cell 1 lost persisted state after refresh! Got: ${cell1Text}`);
      }

      // Verify Cell 2: 500.000 + Đã đối soát
      const cell2 = page.locator(`#cell-${cell2Id}`);
      const cell2Text = await cell2.textContent();
      if (!cell2Text?.includes('500.000') || !cell2Text?.includes('Đã đối soát')) {
        throw new Error(`Cell 2 lost persisted state after refresh! Got: ${cell2Text}`);
      }

      // Verify Cell 3: 28/02/2026 + Đã đối soát
      const cell3 = page.locator(`#cell-${cell3Id}`);
      const cell3Text = await cell3.textContent();
      if (!cell3Text?.includes('28/02/2026') || !cell3Text?.includes('Đã đối soát')) {
        throw new Error(`Cell 3 lost persisted state after refresh! Got: ${cell3Text}`);
      }

      return `After browser reload, document is '${badgeText}'. Cell 1: 1.250.000, Cell 2: 500.000, Cell 3: 28/02/2026 all verified.`;
    });

    // =========================================================================
    // BE8 — EXPORT EXCEL
    // =========================================================================
    await recordBrowserTest('BE8', 'Export Excel: trigger export from UI and verify success', async () => {
      const exportDropdownBtn = page.locator('#btn-export-excel-dropdown');
      await exportDropdownBtn.click();
      await page.waitForTimeout(500);

      // Confirm export button in modal
      const confirmExportBtn = page.locator('#btn-confirm-export-excel');
      await confirmExportBtn.waitFor({ state: 'visible' });

      // Listen for download or API response
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes('/export') && res.status() === 200, { timeout: 15000 }),
        confirmExportBtn.click(),
      ]);

      const json = await response.json().catch(() => ({}));
      return `Export API triggered and returned HTTP 200: ${JSON.stringify(json.export || json)}`;
    });

  } finally {
    await browser.close();
  }

  // Summary
  console.log('\n========================================');
  console.log('REAL BROWSER E2E VERIFICATION SUMMARY');
  console.log('========================================');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  console.log(`Passed: ${passCount} / ${results.length}`);
  results.forEach((r) => {
    console.log(`[${r.status}] ${r.id} - ${r.name} (${r.durationMs}ms)`);
  });

  fs.writeFileSync('phase8_real_browser_e2e_results.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    browser: 'Microsoft Edge Chromium (Playwright 1.63.0)',
    total: results.length,
    passed: passCount,
    failed: results.length - passCount,
    tests: results,
  }, null, 2));

  if (passCount !== results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal Browser E2E Runner Error:', err);
  process.exit(1);
});
