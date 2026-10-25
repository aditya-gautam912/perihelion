'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

(async () => {
  const port = 4320;
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) break;
      } catch { /* server is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
    await page.locator('#nameInput').fill('BROWSER');
    await page.locator('#playBtn').click();
    await page.waitForSelector('#hud:not([hidden])', { state: 'visible', timeout: 5000 });
    assert.match(await page.locator('#roomCode').textContent(), /^[A-Z0-9]+$/);
    await browser.close();
    console.log('browser smoke test passed');
  } finally {
    if (!child.killed) child.kill();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
