import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  const loginNavBtn = page.locator('button:has-text("Đăng nhập")');
  if (await loginNavBtn.first().isVisible()) {
    await loginNavBtn.first().click();
    await page.waitForTimeout(500);
  }
  const emailInput = page.locator('input[type="email"]');
  if (await emailInput.isVisible()) {
    await emailInput.fill('test_browser_e2e@docconvert.test');
    await page.locator('input[type="password"]').fill('Password123!');
    await page.locator('button[type="submit"]:has-text("Đăng nhập")').click();
    await page.waitForTimeout(1500);
  }
  await page.locator('button:has-text("Tài liệu")').first().click();
  await page.waitForTimeout(1000);
  await page.locator('#btn-table-review-11111111-2222-3333-4444-555555555555').click();
  await page.waitForTimeout(4000);

  const modal = page.locator('#ocr-review-workspace-modal');
  console.log('Modal visible:', await modal.isVisible());

  const tds = await page.locator('td').all();
  console.log('Total TDs found:', tds.length);
  for (let i = 0; i < Math.min(tds.length, 10); i++) {
    const id = await tds[i].getAttribute('id');
    const text = await tds[i].textContent();
    console.log(`TD ${i}: id="${id}", text="${text?.trim().replace(/\s+/g, ' ')}"`);
  }

  await browser.close();
}

main().catch(console.error);
