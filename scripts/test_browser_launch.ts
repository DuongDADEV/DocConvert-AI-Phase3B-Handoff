import { chromium } from 'playwright';

async function test() {
  console.log('Testing browser launch...');
  // Try launching system msedge or chromium
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    console.log('Successfully launched msedge!');
  } catch (e: any) {
    console.log('msedge launch failed, trying default chromium:', e.message);
    browser = await chromium.launch({ headless: true });
    console.log('Successfully launched default chromium!');
  }
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  const title = await page.title();
  console.log('Page title:', title);
  await browser.close();
}

test().catch(e => {
  console.error('Launch test failed:', e);
  process.exit(1);
});
