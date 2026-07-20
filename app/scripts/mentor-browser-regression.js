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

async function dragSquare(page, from, to) {
  const sourceBox = await page.locator(`[data-square="${from}"]`).boundingBox();
  const targetBox = await page.locator(`[data-square="${to}"]`).boundingBox();
  if (!sourceBox || !targetBox) throw new Error(`Unable to locate ${from} or ${to}.`);
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function expectText(locator, text) {
  await assert.doesNotReject(async () => {
    await locator.filter({ hasText: text }).first().waitFor({ state: 'visible', timeout: 5000 });
  });
}

async function runViewport(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:3010/mentor-v2');
  await page.locator('.mentor-shell').waitFor({ state: 'visible' });
  await page.locator('[data-square="e2"]').waitFor({ state: 'visible' });
  await page.waitForURL(/\/mentor-v2\/[^/]+$/);

  const initialConversationUrl = page.url();
  await page.locator('.mentor-new-chat').click();
  await page.waitForURL((url) => url.toString() !== initialConversationUrl);
  await page.getByRole('button', { name: /Analyze a game/ }).waitFor({ state: 'visible' });

  const sidebar = await page.locator('.mentor-sidebar').boundingBox();
  const boardPanel = await page.locator('.mentor-board-panel').boundingBox();
  assert.strictEqual(Math.round(sidebar.width), 280);
  assert.strictEqual(Math.round(boardPanel.width), 480);
  assert.strictEqual(await page.locator('.mentor-shell').evaluate((element) => element.scrollWidth), viewport.width);

  await page.getByRole('button', { name: /Analyze a game/ }).click();
  await expectText(page.locator('.mentor-message.is-model'), 'Let us examine the position together.');
  await dragSquare(page, 'e2', 'e4');
  await expectText(page.locator('.mentor-move-list'), 'e4');
  await expectText(page.locator('.mentor-board-summary'), 'Black');
  const firstUrl = page.url();

  await page.reload();
  await expectText(page.locator('.mentor-message.is-model'), 'Let us examine the position together.');
  await expectText(page.locator('.mentor-move-list'), 'e4');

  await page.locator('.mentor-new-chat').click();
  await page.waitForURL((url) => url.toString() !== firstUrl);
  await expectText(page.locator('.mentor-move-list-header'), '0 plies');
  await page.goto(firstUrl);
  await expectText(page.locator('.mentor-move-list'), 'e4');

  await page.locator('.mentor-new-chat').click();
  await page.getByPlaceholder('Ask your chess mentor').fill('Run the browser tool demo.');
  const demoStarted = Date.now();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expectText(page.locator('.mentor-tool-card[data-tool-name="play_line"]'), '1 of 4 moves');
  assert.strictEqual(await page.getByRole('button', { name: 'Reset board' }).isDisabled(), true);
  await expectText(page.locator('.mentor-message.is-model'), 'The line and teaching marks are now on the board.');
  assert.ok(Date.now() - demoStarted >= 2500, 'The move demonstration advanced too quickly.');
  await expectText(page.locator('.mentor-move-list'), 'Nc6');
  await expectText(page.locator('.mentor-tool-card[data-tool-name="annotate_board"]'), 'Annotate board');
  const toolDetail = await page.evaluate(async () => {
    const id = location.pathname.split('/').at(-1);
    return fetch(`/api/mentor/conversations/${id}`).then((response) => response.json());
  });
  assert.strictEqual(toolDetail.conversation.chess.history.length, 4);
  assert.strictEqual(toolDetail.conversation.chess.annotations.highlights[0].square, 'f7');
  assert.strictEqual(toolDetail.conversation.messages.at(-1).toolCalls.length, 2);
  assert.notStrictEqual(await page.locator('[data-square="f7"] > div').first().evaluate((element) => getComputedStyle(element).boxShadow), 'none');
  await page.reload();
  await expectText(page.locator('.mentor-tool-card[data-tool-name="play_line"]'), 'Demonstrate 4 moves');
  assert.notStrictEqual(await page.locator('[data-square="f7"] > div').first().evaluate((element) => getComputedStyle(element).boxShadow), 'none');
  await page.screenshot({
    path: path.join(__dirname, '..', 'tmp', `mentor-v2-tools-${viewport.width}x${viewport.height}.png`),
    fullPage: true
  });

  await page.locator('.mentor-new-chat').click();
  await page.getByPlaceholder('Ask your chess mentor').fill('Run the cancellable browser demo.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expectText(page.locator('.mentor-tool-card[data-tool-name="play_line"]'), '1 of 6 moves');
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expectText(page.locator('.mentor-message.is-model'), 'Response stopped');
  const cancelledDetail = await page.evaluate(async () => {
    const id = location.pathname.split('/').at(-1);
    return fetch(`/api/mentor/conversations/${id}`).then((response) => response.json());
  });
  assert.ok(cancelledDetail.conversation.chess.history.length >= 1);
  assert.ok(cancelledDetail.conversation.chess.history.length < 6);
  assert.strictEqual(cancelledDetail.conversation.messages.at(-1).toolCalls[0].status, 'cancelled');

  await page.locator('.mentor-new-chat').click();
  await page.getByPlaceholder('Ask your chess mentor').fill('Help me understand isolated pawns.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expectText(page.locator('.mentor-message.is-model'), 'Let us examine the position together.');

  const activeHistory = page.locator('.mentor-history-item.is-active');
  await activeHistory.getByRole('button', { name: 'Conversation actions' }).click();
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Conversation title').fill('Pawn structure lesson');
  await page.getByRole('button', { name: 'Save title' }).click();
  await page.locator('.mentor-search input').fill('Pawn structure');
  await expectText(page.locator('.mentor-history-open'), 'Pawn structure lesson');
  await page.locator('.mentor-search input').fill('');

  await page.getByRole('button', { name: 'Load FEN' }).click();
  await page.getByLabel('Forsyth-Edwards Notation').fill('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  await page.getByRole('button', { name: 'Load position' }).click();
  await expectText(page.locator('.mentor-board-summary'), 'Draw by stalemate');
  await page.getByRole('button', { name: 'Reset board' }).click();
  await expectText(page.locator('.mentor-board-summary'), 'Game in progress');

  const beforeRollbackChat = page.url();
  await page.locator('.mentor-new-chat').click();
  await page.waitForURL((url) => url.toString() !== beforeRollbackChat);
  await expectText(page.locator('.mentor-move-list-header'), '0 plies');
  await expectText(page.locator('.mentor-board-summary'), 'Game in progress');
  await page.reload();
  await expectText(page.locator('.mentor-board-summary'), 'Game in progress');

  const detail = await page.evaluate(async () => {
    const id = location.pathname.split('/').at(-1);
    return fetch(`/api/mentor/conversations/${id}`).then((response) => response.json());
  });
  let rollbackIntercepted = false;
  await page.route(/\/api\/mentor\/conversations\/[^/]+\/moves$/, async (route) => {
    rollbackIntercepted = true;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Synthetic stale revision.',
        code: 'stale_revision',
        state: detail.conversation.chess
      })
    });
  });
  const originalE2 = await page.locator('[data-square="e2"]').innerHTML();
  await dragSquare(page, 'e2', 'e4');
  await page.waitForTimeout(250);
  assert.strictEqual(rollbackIntercepted, true, 'The synthetic stale move request was not intercepted.');
  await expectText(page.locator('.mentor-error'), 'Synthetic stale revision');
  await page.waitForFunction(
    ({ expected }) => document.querySelector('[data-square="e2"]')?.innerHTML === expected,
    { expected: originalE2 }
  );

  await page.screenshot({
    path: path.join(__dirname, '..', 'tmp', `mentor-v2-${viewport.width}x${viewport.height}.png`),
    fullPage: true
  });

  const rollbackUrl = page.url();
  const rollbackHistory = page.locator('.mentor-history-item.is-active');
  await rollbackHistory.getByRole('button', { name: 'Conversation actions' }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL((url) => url.toString() !== rollbackUrl);

  await page.goto('http://127.0.0.1:3010/');
  await expectText(page.locator('.logo-container'), 'Companion Board');
  await page.goto('http://127.0.0.1:3010/mentor');
  await expectText(page.locator('body'), 'Live Multimodal Mentor');
  await page.getByRole('button', { name: 'Start Mentor' }).waitFor({ state: 'visible' });
  await context.close();
}

async function main() {
  const { chromium } = loadPlaywright();
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
      headless: true
    });
    await runViewport(browser, { width: 1440, height: 900 });
    await runViewport(browser, { width: 1920, height: 1080 });
    console.log('Mentor v2 Playwright desktop regressions passed.');
  } catch (error) {
    if (serverOutput) console.error(serverOutput);
    throw error;
  } finally {
    if (browser) await browser.close();
    serverProcess.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
