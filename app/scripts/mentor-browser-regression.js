const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const localPrograms = path.join(process.env.LOCALAPPDATA || '', 'Programs');
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'playwright-core'),
    path.join(localPrograms, 'Antigravity IDE', 'resources', 'app', 'node_modules', 'playwright-core')
  ];
  const vscodeRoot = path.join(localPrograms, 'Microsoft VS Code');
  if (fs.existsSync(vscodeRoot)) {
    for (const version of fs.readdirSync(vscodeRoot)) {
      candidates.push(path.join(vscodeRoot, version, 'resources', 'app', 'node_modules', 'playwright-core'));
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error('playwright-core is not installed in a supported local runtime.');
}

async function waitForServer(url, process, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (process.exitCode !== null) throw new Error('Mentor browser test server exited early.');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the mentor browser test server.');
}

async function expectText(locator, text, timeout = 5000) {
  await locator.filter({ hasText: text }).first().waitFor({ state: 'visible', timeout });
}

async function createNewConversation(page) {
  const previousUrl = page.url();
  await page.locator('.mentor-new-chat').click();
  await page.waitForURL((url) => url.toString() !== previousUrl);
  await page.locator('.mentor-voice-command-bar').waitFor({ state: 'visible' });
}

async function attachCurrentPhysicalBoard(page) {
  return page.evaluate(async () => {
    const conversationId = location.pathname.split('/').at(-1);
    const available = await fetch('/api/mentor/physical-board').then((response) => response.json());
    const response = await fetch(`/api/mentor/conversations/${conversationId}/physical-board`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverInstanceId: available.serverInstanceId,
        sessionGeneration: available.sessionGeneration
      })
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
}

async function submitInternalTranscriptTurn(page, text) {
  return page.evaluate(async (prompt) => {
    const conversationId = location.pathname.split('/').at(-1);
    const response = await fetch(`/api/mentor/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: `browser-${Date.now()}`, text: prompt })
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, text);
}

async function runViewport(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:3010/');
  await expectText(page.locator('.logo-container'), 'Companion Board');
  await page.getByRole('link', { name: 'Open Mentor Page' }).click();
  await page.waitForURL(/\/mentor\/[^/]+$/);
  await page.locator('.mentor-shell').waitFor({ state: 'visible' });
  await page.locator('[data-square="a1"]').waitFor({ state: 'visible' });

  assert.strictEqual(await page.locator('textarea').count(), 0, 'The primary mentor must not expose text input.');
  assert.strictEqual(await page.locator('.mentor-suggestions').count(), 0, 'Text suggestion prompts must be hidden.');
  assert.strictEqual(await page.getByRole('button', { name: 'Start activity' }).count(), 0);
  assert.strictEqual(await page.getByRole('button', { name: 'Learner profile' }).count(), 0);
  assert.strictEqual(await page.getByRole('group', { name: 'Board source' }).count(), 0);
  assert.strictEqual(await page.getByRole('button', { name: 'Load FEN' }).count(), 0);
  assert.strictEqual(await page.getByRole('button', { name: 'Reset board' }).count(), 0);
  await expectText(page.locator('.mentor-voice-command-bar'), 'Use voice to start or attach the physical board');
  await expectText(page.locator('.mentor-activity-bar'), 'Ask the voice mentor to play or teach a reviewed opening');

  const sidebar = await page.locator('.mentor-sidebar').boundingBox();
  const boardPanel = await page.locator('.mentor-board-panel').boundingBox();
  assert.strictEqual(Math.round(sidebar.width), 280);
  assert.strictEqual(Math.round(boardPanel.width), 480);
  assert.strictEqual(await page.locator('.mentor-shell').evaluate((element) => element.scrollWidth), viewport.width);

  const theme = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const shell = getComputedStyle(document.querySelector('.mentor-shell'));
    return {
      accent: root.getPropertyValue('--accent-color').trim(),
      mentorAccent: shell.getPropertyValue('--mentor-accent').trim(),
      text: root.getPropertyValue('--text-primary').trim(),
      mentorText: shell.getPropertyValue('--mentor-text').trim(),
      fontFamily: shell.fontFamily
    };
  });
  assert.strictEqual(theme.mentorAccent, theme.accent);
  assert.strictEqual(theme.mentorText, theme.text);
  assert.match(theme.fontFamily, /Outfit/i);

  const mentorSettings = page.locator('.mentor-board-panel .shared-game-settings');
  await mentorSettings.getByRole('button', { name: 'Black', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mentor-board-panel .shared-side-selector button.is-active')?.textContent.trim() === 'Black');
  await mentorSettings.getByRole('button', { name: 'White', exact: true }).click();

  await attachCurrentPhysicalBoard(page);
  await page.reload();
  await expectText(page.locator('.mentor-physical-status'), 'Waiting for your move');
  await expectText(page.locator('.mentor-voice-command-bar'), 'Physical board connected');
  assert.strictEqual(await page.locator('.mentor-coaching-toggle').count(), 0);

  await page.getByRole('button', { name: 'Start voice mentor' }).click();
  await expectText(page.locator('.mentor-live-status'), 'Live voice listening');
  await expectText(page.locator('.mentor-model-label'), 'Gemini 3.1 Flash Live');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expectText(page.locator('.mentor-live-status'), 'Live voice muted');
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Start voice mentor' }).waitFor({ state: 'visible' });

  const owningConversationId = page.url().split('/').at(-1);
  await createNewConversation(page);
  await page.evaluate(async () => {
    const conversationId = location.pathname.split('/').at(-1);
    const response = await fetch(`/api/test/mentor-physical-handoff/${conversationId}`, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
  });
  await expectText(page.locator('.mentor-physical-handoff'), 'Physical board in use');
  await page.getByRole('button', { name: 'Continue game' }).click();
  await page.waitForURL(`http://127.0.0.1:3010/mentor/${owningConversationId}`);

  await createNewConversation(page);
  await page.evaluate(async () => {
    const conversationId = location.pathname.split('/').at(-1);
    const response = await fetch(`/api/test/mentor-physical-handoff/${conversationId}`, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
  });
  await expectText(page.locator('.mentor-physical-handoff'), 'Physical board in use');
  await page.getByRole('button', { name: 'End & use this chat' }).click();
  await expectText(page.locator('.mentor-physical-status'), 'Waiting for your move');
  await page.locator('.mentor-physical-handoff').waitFor({ state: 'detached' });
  assert.strictEqual(await page.locator('.mentor-physical-handoff').count(), 0);

  await page.evaluate(() => fetch('/api/test/mentor-physical-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phase: 'sync_warning',
      statusText: 'Restore or center e2.',
      board: { ready: false, missingSquares: ['e2'], extraSquares: ['e4'] },
      syncWarningReason: { type: 'missing_piece' }
    })
  }));
  await expectText(page.locator('.mentor-physical-status'), 'Restore or center e2');
  await expectText(page.locator('.mentor-message.is-physical'), 'e2');
  assert.notStrictEqual(
    await page.locator('[data-square="e2"] > div').first().evaluate((element) => getComputedStyle(element).boxShadow),
    'none'
  );

  await page.evaluate(() => fetch('/api/test/mentor-physical-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phase: 'ready',
      statusText: 'Waiting for your move.',
      board: { ready: true, missingSquares: [], extraSquares: [] },
      syncWarningReason: null
    })
  }));
  await submitInternalTranscriptTurn(page, 'Run the browser scrolling demo.');
  await expectText(page.locator('.mentor-message.is-model'), 'Streaming line 90', 10000);
  const scrollArea = page.locator('.mentor-message-scroll');
  const overflow = await scrollArea.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight
  }));
  assert.strictEqual(overflow.overflowY, 'auto');
  assert.ok(overflow.scrollHeight > overflow.clientHeight);
  const boardTop = (await page.locator('.mentor-board-frame').boundingBox()).y;
  await scrollArea.evaluate((element) => { element.scrollTop = 0; });
  assert.ok(Math.abs((await page.locator('.mentor-board-frame').boundingBox()).y - boardTop) < 1);

  const firstConversationId = page.url().split('/').at(-1);
  await createNewConversation(page);
  await page.waitForFunction(() => !document.querySelector('.mentor-message-scroll')?.textContent.includes('Streaming line 90'));
  assert.strictEqual(await page.locator('.mentor-message').count(), 0);
  await page.goto(`http://127.0.0.1:3010/mentor/${firstConversationId}`);
  await expectText(page.locator('.mentor-message.is-model'), 'Streaming line 90');

  await page.goto(`http://127.0.0.1:3010/mentor-v2/${firstConversationId}`);
  await page.waitForURL(`http://127.0.0.1:3010/mentor/${firstConversationId}`);
  await page.goto('http://127.0.0.1:3010/mentor-live');
  await page.waitForURL(/\/mentor(?:\/[^/]+)?$/);
  assert.strictEqual(await page.getByText('Live Multimodal Mentor').count(), 0);

  await page.screenshot({
    path: path.join(__dirname, '..', 'tmp', `mentor-voice-first-${viewport.width}x${viewport.height}.png`),
    fullPage: true
  });
  await context.close();
}

async function verifyStaleBackendSettingsMessage(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.route('**/api/game-settings', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Not found' })
  }));
  await page.goto('http://127.0.0.1:3010/');
  await expectText(page.locator('.shared-setting-note'), 'Backend update required; restart the ChessProject server.');
  await context.close();
}

async function main() {
  const { chromium } = loadPlaywright();
  const viewports = process.env.MENTOR_BROWSER_VIEWPORT === '1920'
    ? [{ width: 1920, height: 1080 }]
    : process.env.MENTOR_BROWSER_VIEWPORT === '1440'
      ? [{ width: 1440, height: 900 }]
      : [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
  for (const viewport of viewports) {
    const serverProcess = spawn(process.execPath, ['scripts/mentor-browser-server.js'], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverOutput = '';
    serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk; });
    serverProcess.stderr.on('data', (chunk) => { serverOutput += chunk; });
    let browser;
    try {
      await waitForServer('http://127.0.0.1:3010/api/mentor/conversations', serverProcess);
      browser = await chromium.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
      });
      await runViewport(browser, viewport);
      await verifyStaleBackendSettingsMessage(browser);
    } catch (error) {
      if (serverOutput) console.error(serverOutput);
      throw error;
    } finally {
      if (browser) await browser.close();
      serverProcess.kill();
      await Promise.race([
        new Promise((resolve) => serverProcess.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ]);
    }
  }
  console.log('Mentor Playwright voice-first desktop regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
