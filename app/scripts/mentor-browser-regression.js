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
  const sourceSquare = page.locator(`[data-square="${from}"]`);
  const targetSquare = page.locator(`[data-square="${to}"]`);
  const sourceBefore = await sourceSquare.innerHTML();
  const sourceBox = await sourceSquare.boundingBox();
  const targetBox = await targetSquare.boundingBox();
  if (!sourceBox || !targetBox) throw new Error(`Unable to locate ${from} or ${to}.`);
  const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.waitForTimeout(75);
  await page.mouse.move(source.x + 6, source.y, { steps: 2 });
  await page.mouse.move(target.x, target.y, { steps: 18 });
  await page.waitForTimeout(75);
  await page.mouse.up();
  await page.waitForTimeout(150);
  if (await sourceSquare.innerHTML() === sourceBefore) {
    await sourceSquare.locator(':scope > div').first().dragTo(targetSquare, {
      force: true,
      sourcePosition: { x: sourceBox.width / 2, y: sourceBox.height / 2 },
      targetPosition: { x: targetBox.width / 2, y: targetBox.height / 2 }
    });
  }
}

async function expectText(locator, text) {
  await assert.doesNotReject(async () => {
    await locator.filter({ hasText: text }).first().waitFor({ state: 'visible', timeout: 5000 });
  });
}

async function createNewConversation(page) {
  const previousUrl = page.url();
  await page.locator('.mentor-new-chat').click();
  await page.waitForURL((url) => url.toString() !== previousUrl);
  await page.waitForFunction(() => {
    const composer = document.querySelector('textarea[placeholder="Ask your chess mentor"]');
    return composer && !composer.disabled;
  });
}

async function runViewport(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:3010/');
  await expectText(page.locator('.logo-container'), 'Companion Board');
  await expectText(page.locator('.mode-info'), 'Interactive lessons, analysis, and board demonstrations.');
  await page.locator('[data-square="a1"] > div').waitFor({ state: 'visible' });
  const companionSettings = page.locator('.shared-game-settings').first();
  await companionSettings.getByRole('button', { name: 'Black', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.shared-side-selector button.is-active')?.textContent.trim() === 'Black');
  await page.getByRole('button', { name: 'New Virtual Game' }).click();
  await page.locator('#moveList li').first().waitFor({ state: 'visible', timeout: 10000 });
  assert.strictEqual(await page.locator('#moveList li').count(), 1, 'Human Black should receive exactly one White engine opener.');
  await companionSettings.getByRole('button', { name: 'White', exact: true }).click();
  await page.getByRole('button', { name: 'New Virtual Game' }).click();
  assert.strictEqual(await page.locator('#moveList li').count(), 0, 'New Virtual Game should clear the previous move history.');
  const normalBoardColors = await page.evaluate(() => ({
    dark: getComputedStyle(document.querySelector('[data-square="a1"] > div')).backgroundColor,
    light: getComputedStyle(document.querySelector('[data-square="b1"] > div')).backgroundColor
  }));
  await page.getByRole('link', { name: 'Open Mentor Page' }).click();
  await page.locator('.mentor-shell').waitFor({ state: 'visible' });
  await page.locator('[data-square="e2"]').waitFor({ state: 'visible' });
  await page.waitForURL(/\/mentor\/[^/]+$/);
  const mentorSettings = page.locator('.shared-game-settings').first();
  await expectText(mentorSettings.locator('.shared-side-selector button.is-active'), 'White');
  await mentorSettings.getByRole('button', { name: 'Black', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mentor-board-panel .shared-side-selector button.is-active')?.textContent.trim() === 'Black');
  await mentorSettings.getByRole('button', { name: 'White', exact: true }).click();

  const mentorTheme = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const shell = getComputedStyle(document.querySelector('.mentor-shell'));
    return {
      accent: root.getPropertyValue('--accent-color').trim(),
      mentorAccent: shell.getPropertyValue('--mentor-accent').trim(),
      text: root.getPropertyValue('--text-primary').trim(),
      mentorText: shell.getPropertyValue('--mentor-text').trim(),
      fontFamily: shell.fontFamily,
      dark: getComputedStyle(document.querySelector('[data-square="a1"] > div')).backgroundColor,
      light: getComputedStyle(document.querySelector('[data-square="b1"] > div')).backgroundColor
    };
  });
  assert.strictEqual(mentorTheme.mentorAccent, mentorTheme.accent);
  assert.strictEqual(mentorTheme.mentorText, mentorTheme.text);
  assert.match(mentorTheme.fontFamily, /Outfit/i);
  assert.deepStrictEqual(
    { dark: mentorTheme.dark, light: mentorTheme.light },
    normalBoardColors,
    'Mentor and normal boards should use the same square colors.'
  );

  await createNewConversation(page);
  await page.getByRole('button', { name: /Analyze a game/ }).waitFor({ state: 'visible' });

  const sidebar = await page.locator('.mentor-sidebar').boundingBox();
  const boardPanel = await page.locator('.mentor-board-panel').boundingBox();
  assert.strictEqual(Math.round(sidebar.width), 280);
  assert.strictEqual(Math.round(boardPanel.width), 480);
  assert.strictEqual(await page.locator('.mentor-shell').evaluate((element) => element.scrollWidth), viewport.width);

  await page.getByRole('button', { name: /Analyze a game/ }).click();
  await expectText(page.locator('.mentor-message.is-model'), 'Let us examine the position together.');
  await dragSquare(page, 'e2', 'e4');
  try {
    await expectText(page.locator('.mentor-move-list'), 'e4');
  } catch (error) {
    const diagnostics = await page.evaluate(async () => {
      const id = location.pathname.split('/').at(-1);
      const detail = await fetch(`/api/mentor/conversations/${id}`).then((response) => response.json());
      const source = document.querySelector('[data-square="e2"]');
      const target = document.querySelector('[data-square="e4"]');
      const sourceRect = source?.getBoundingClientRect();
      const targetRect = target?.getBoundingClientRect();
      const hit = sourceRect
        ? document.elementFromPoint(sourceRect.x + sourceRect.width / 2, sourceRect.y + sourceRect.height / 2)
        : null;
      return {
        url: location.href,
        boardFen: detail.conversation?.chess?.fen,
        history: detail.conversation?.chess?.history,
        resetDisabled: document.querySelector('button[aria-label="Reset board"]')?.disabled,
        liveStatus: document.querySelector('.mentor-live-status')?.textContent,
        error: document.querySelector('.mentor-error')?.textContent,
        sourceRect: sourceRect && { x: sourceRect.x, y: sourceRect.y, width: sourceRect.width, height: sourceRect.height },
        targetRect: targetRect && { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height },
        hit: hit && { tag: hit.tagName, className: hit.className, square: hit.closest('[data-square]')?.dataset.square }
      };
    });
    throw new Error(`Mentor board drag failed. ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  await expectText(page.locator('.mentor-board-summary'), 'Black');
  const firstUrl = page.url();
  const firstConversationId = firstUrl.split('/').at(-1);

  const sourceControl = page.getByRole('group', { name: 'Board source' });
  await sourceControl.getByRole('button', { name: 'Physical', exact: true }).click();
  await expectText(page.locator('.mentor-physical-status'), 'Waiting for your move');
  assert.strictEqual(await page.getByRole('button', { name: 'Reset board' }).isDisabled(), true);
  assert.strictEqual(await page.getByRole('button', { name: 'Load FEN' }).isDisabled(), true);
  assert.strictEqual(await page.getByRole('button', { name: 'Start activity' }).isDisabled(), false);
  await page.getByRole('button', { name: 'Start activity' }).click();
  await expectText(page.locator('.mentor-activity-dialog'), 'Physical opening drill');
  assert.strictEqual(await page.locator('.mentor-activity-dialog select option').count(), 18);
  assert.ok(await page.locator('.mentor-activity-dialog select optgroup').count() >= 3);
  await page.locator('.mentor-activity-dialog').getByRole('button', { name: 'Close' }).click();
  await expectText(page.locator('.mentor-move-list-header'), '0 plies');

  await page.getByPlaceholder('Ask your chess mentor').fill('Run the browser engine analysis.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expectText(page.locator('.mentor-tool-card[data-tool-name="analyze_position"]'), 'Best:');
  await page.locator('.mentor-eval-bar.has-analysis').waitFor({ state: 'visible', timeout: 5000 });
  const physicalDetail = await page.evaluate(() => fetch(`/api/mentor/conversations/${location.pathname.split('/').at(-1)}`).then((response) => response.json()));
  const physicalAnalysis = physicalDetail.conversation.messages
    .flatMap((message) => message.toolCalls || [])
    .findLast((call) => call.name === 'analyze_position');
  assert.strictEqual(physicalAnalysis.result.sourceKey, 'physical:mentor-browser-server:1');

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
  assert.notStrictEqual(
    await page.locator('[data-square="e4"] > div').first().evaluate((element) => getComputedStyle(element).boxShadow),
    'none'
  );
  await page.screenshot({
    path: path.join(__dirname, '..', 'tmp', `mentor-physical-${viewport.width}x${viewport.height}.png`),
    fullPage: true
  });

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
  await sourceControl.getByRole('button', { name: 'Virtual', exact: true }).click();
  await expectText(page.locator('.mentor-move-list'), 'e4');
  assert.strictEqual(await page.locator('.mentor-eval-bar').evaluate((element) => element.classList.contains('has-analysis')), false);

  await sourceControl.getByRole('button', { name: 'Physical', exact: true }).click();
  await expectText(page.locator('.mentor-physical-status'), 'Waiting for your move');
  await page.evaluate(() => fetch('/api/test/mentor-physical-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionGeneration: 2, stateRevision: 1 })
  }));
  await expectText(page.locator('.mentor-physical-status.is-stale'), 'Previous physical session ended');
  await expectText(page.locator('.mentor-move-list'), 'e4');

  await page.goto(`http://127.0.0.1:3010/mentor-v2/${firstConversationId}`);
  await page.waitForURL(`http://127.0.0.1:3010/mentor/${firstConversationId}`);
  await expectText(page.locator('.mentor-move-list'), 'e4');

  const conversationCountBeforeRedirect = await page.evaluate(() => fetch('/api/mentor/conversations').then((response) => response.json()).then((payload) => payload.conversations.length));
  await page.goto('http://127.0.0.1:3010/mentor-v2');
  await page.waitForURL(/\/mentor(?:\/[^/]+)?$/);
  const conversationCountAfterRedirect = await page.evaluate(() => fetch('/api/mentor/conversations').then((response) => response.json()).then((payload) => payload.conversations.length));
  assert.strictEqual(conversationCountAfterRedirect, conversationCountBeforeRedirect, 'Legacy base redirect created a duplicate conversation.');
  await page.goto(firstUrl);

  await page.reload();
  await expectText(page.locator('.mentor-message.is-model'), 'Let us examine the position together.');
  await expectText(page.locator('.mentor-move-list'), 'e4');

  await createNewConversation(page);
  const boardTopBeforeStreaming = (await page.locator('.mentor-board-frame').boundingBox()).y;
  await page.getByPlaceholder('Ask your chess mentor').fill('Run the browser scrolling demo.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expectText(page.locator('.mentor-message.is-model'), 'Streaming line 50');
  const scrollArea = page.locator('.mentor-message-scroll');
  const overflowing = await scrollArea.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight
  }));
  assert.strictEqual(overflowing.overflowY, 'auto');
  assert.ok(overflowing.scrollHeight > overflowing.clientHeight, 'The long mentor chat did not create a scrollable area.');
  await page.waitForFunction(() => {
    const element = document.querySelector('.mentor-message-scroll');
    return element && element.scrollHeight - element.clientHeight > 100;
  });
  await scrollArea.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.getByRole('button', { name: 'Jump to latest message' }).waitFor({ state: 'visible' });
  await expectText(page.locator('.mentor-message.is-model'), 'Streaming line 80');
  assert.ok(await scrollArea.evaluate((element) => element.scrollTop) < 5, 'Streaming forced the chat back to the bottom.');
  const boardTopDuringStreaming = (await page.locator('.mentor-board-frame').boundingBox()).y;
  assert.ok(Math.abs(boardTopDuringStreaming - boardTopBeforeStreaming) < 1, 'The chess board moved while the chat grew.');
  await page.getByRole('button', { name: 'Jump to latest message' }).click();
  await page.waitForFunction(() => {
    const element = document.querySelector('.mentor-message-scroll');
    return element && element.scrollHeight - element.clientHeight - element.scrollTop < 5;
  });
  await expectText(page.locator('.mentor-message.is-model'), 'Streaming line 90');

  await createNewConversation(page);
  await expectText(page.locator('.mentor-move-list-header'), '0 plies');
  await page.goto(firstUrl);
  await expectText(page.locator('.mentor-move-list'), 'e4');

  await createNewConversation(page);
  await page.getByRole('button', { name: 'Start activity' }).click();
  await page.locator('.mentor-activity-dialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Puzzle', exact: true }).click();
  await page.getByLabel('Activity').selectOption('back-rank-mate');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expectText(page.locator('.mentor-activity-bar'), 'Your turn');
  assert.strictEqual(await page.getByRole('button', { name: 'Reset board' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Request hint' }).click();
  await expectText(page.locator('.mentor-notice'), 'Hint 1');
  await dragSquare(page, 'e1', 'e7');
  await expectText(page.locator('.mentor-error'), 'does not match this activity');
  await expectText(page.locator('.mentor-move-list-header'), '0 plies');
  await page.waitForTimeout(500);
  await dragSquare(page, 'e1', 'e8');
  await expectText(page.locator('.mentor-move-list'), 'Re8#');
  await expectText(page.locator('.mentor-activity-bar'), 'Guided practice');

  await page.locator('.mentor-board-tools').getByRole('button', { name: 'Learner profile' }).click();
  await expectText(page.locator('.mentor-profile-dialog'), 'mate patterns');
  await page.getByRole('button', { name: 'Intermediate', exact: true }).click();
  await page.getByLabel('Goals').fill('Improve calculation\nLearn openings');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.locator('.mentor-board-tools').getByRole('button', { name: 'Learner profile' }).click();
  assert.strictEqual(await page.getByRole('button', { name: 'Intermediate', exact: true }).evaluate((element) => element.classList.contains('is-selected')), true);
  assert.match(await page.getByLabel('Goals').inputValue(), /Improve calculation/);
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Start activity' }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expectText(page.locator('.mentor-activity-bar'), 'Your turn');
  await page.getByRole('button', { name: 'Pause activity' }).click();
  await expectText(page.locator('.mentor-activity-bar'), 'Paused');
  await page.getByRole('button', { name: 'Resume activity' }).click();
  await expectText(page.locator('.mentor-activity-bar'), 'Your turn');
  await page.getByRole('button', { name: 'End activity' }).click();
  await expectText(page.locator('.mentor-activity-bar'), 'Guided practice');

  await page.getByRole('button', { name: 'Load FEN' }).click();
  const promotionFen = '7k/P7/8/8/8/8/8/7K w - - 0 1';
  await page.getByLabel('Forsyth-Edwards Notation').fill(promotionFen);
  await page.getByRole('button', { name: 'Load position' }).click();
  await page.waitForFunction(async (expectedFen) => {
    const id = location.pathname.split('/').at(-1);
    const detail = await fetch(`/api/mentor/conversations/${id}`).then((response) => response.json());
    return detail.conversation?.chess?.fen === expectedFen;
  }, promotionFen);
  await page.waitForTimeout(500);
  await dragSquare(page, 'a7', 'a8');
  await page.locator('.mentor-promotion-dialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Rook' }).click();
  await expectText(page.locator('.mentor-move-list'), 'a8=R+');

  await createNewConversation(page);
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
    path: path.join(__dirname, '..', 'tmp', `mentor-tools-${viewport.width}x${viewport.height}.png`),
    fullPage: true
  });

  await createNewConversation(page);
  assert.strictEqual(await page.locator('.mentor-eval-bar').evaluate((element) => element.classList.contains('has-analysis')), false);
  await page.getByPlaceholder('Ask your chess mentor').fill('Run the browser engine analysis.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const analysisCard = page.locator('.mentor-tool-card[data-tool-name="analyze_position"]');
  await expectText(analysisCard, 'Analyze position (quick)');
  await expectText(analysisCard, 'Best:');
  await page.locator('.mentor-eval-bar.has-analysis').waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await page.locator('.mentor-eval-bar').getAttribute('title'), /Stockfish evaluation/);
  await page.screenshot({
    path: path.join(__dirname, '..', 'tmp', `mentor-analysis-${viewport.width}x${viewport.height}.png`),
    fullPage: true
  });
  await page.getByRole('button', { name: 'Flip board' }).click();
  await page.locator('.mentor-eval-bar.is-black.has-analysis').waitFor({ state: 'visible' });
  await dragSquare(page, 'e2', 'e4');
  await expectText(page.locator('.mentor-move-list'), 'e4');
  await page.waitForFunction(() => !document.querySelector('.mentor-eval-bar')?.classList.contains('has-analysis'));
  await page.reload();
  await expectText(page.locator('.mentor-tool-card[data-tool-name="analyze_position"]'), 'Best:');
  assert.strictEqual(await page.locator('.mentor-eval-bar').evaluate((element) => element.classList.contains('has-analysis')), false);
  await page.getByPlaceholder('Ask your chess mentor').fill('Run the browser latest move analysis.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const moveAnalysisCard = page.locator('.mentor-tool-card[data-tool-name="analyze_move"]');
  await expectText(moveAnalysisCard, 'Analyze latest move');
  await expectText(moveAnalysisCard, 'Best');
  await page.locator('.mentor-eval-bar.has-analysis').waitFor({ state: 'visible', timeout: 5000 });

  await createNewConversation(page);
  await page.getByPlaceholder('Ask your chess mentor').fill('Run the cancellable browser engine analysis.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const cancellableAnalysis = page.locator('.mentor-tool-card[data-tool-name="analyze_position"]');
  await expectText(cancellableAnalysis, 'Analyze position (deep)');
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expectText(page.locator('.mentor-message.is-model'), 'Response stopped');
  await expectText(cancellableAnalysis, 'Stockfish analysis was cancelled');
  assert.strictEqual(await page.locator('.mentor-eval-bar').evaluate((element) => element.classList.contains('has-analysis')), false);

  await createNewConversation(page);
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

  await createNewConversation(page);
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

  await createNewConversation(page);
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
    path: path.join(__dirname, '..', 'tmp', `mentor-${viewport.width}x${viewport.height}.png`),
    fullPage: true
  });

  const rollbackUrl = page.url();
  const rollbackHistory = page.locator('.mentor-history-item.is-active');
  await rollbackHistory.getByRole('button', { name: 'Conversation actions' }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL((url) => url.toString() !== rollbackUrl);

  await page.getByRole('link', { name: 'Companion board' }).click();
  await page.waitForURL('http://127.0.0.1:3010/');
  await expectText(page.locator('.logo-container'), 'Companion Board');
  await page.getByRole('link', { name: 'Open Mentor Page' }).click();
  await page.locator('.mentor-shell').waitFor({ state: 'visible' });
  await expectText(page.locator('.mentor-audio-output'), 'Voice output');
  assert.strictEqual(
    await page.locator('.mentor-audio-segments button.is-selected').textContent(),
    'Auto'
  );
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  assert.strictEqual(
    await page.locator('.mentor-audio-segments button.is-selected').textContent(),
    'Browser'
  );
  await page.getByRole('button', { name: 'Start Live voice' }).click();
  await expectText(page.locator('.mentor-live-status'), 'Live voice listening');
  await expectText(page.locator('.mentor-model-label'), 'Gemini 3.1 Flash Live');
  const boardTopBeforeVoice = (await page.locator('.mentor-board-frame').boundingBox()).y;
  await page.getByPlaceholder('Speak or type to your chess mentor').fill('Explain the center by voice.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expectText(page.locator('.mentor-message.is-user.is-voice'), 'Explain the center by voice.');
  await expectText(page.locator('.mentor-message.is-model.is-voice'), 'I heard your typed question');
  assert.ok(Math.abs((await page.locator('.mentor-board-frame').boundingBox()).y - boardTopBeforeVoice) < 1);

  await page.getByPlaceholder('Speak or type to your chess mentor').fill('Run the Live board tool demo.');
  const liveDemoStarted = Date.now();
  await page.getByRole('button', { name: 'Send message' }).click();
  const liveLineCard = page.locator('.mentor-tool-card[data-tool-name="play_line"]').last();
  await expectText(liveLineCard, '1 of 4 moves');
  await expectText(page.locator('.mentor-live-status'), 'Demonstrating line');
  assert.strictEqual(await page.getByRole('button', { name: 'Reset board' }).isDisabled(), true);
  assert.strictEqual(await page.getByRole('button', { name: 'Mute microphone' }).isDisabled(), false);
  assert.strictEqual(await page.getByRole('button', { name: 'Stop Live voice' }).isVisible(), true);
  assert.strictEqual(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true);
  await expectText(page.locator('.mentor-message.is-model.is-voice'), 'Live board demonstration is complete.');
  assert.ok(Date.now() - liveDemoStarted >= 2500, 'The Live move demonstration advanced too quickly.');
  await expectText(page.locator('.mentor-move-list'), 'Nc6');
  assert.strictEqual(await page.getByRole('button', { name: 'Reset board' }).isDisabled(), false);

  await page.getByPlaceholder('Speak or type to your chess mentor').fill('Run the Live analysis tool demo.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const liveAnalysisCard = page.locator('.mentor-tool-card[data-tool-name="analyze_position"]').last();
  await expectText(page.locator('.mentor-live-status'), 'Analyzing position');
  await expectText(liveAnalysisCard, 'Best:');
  await page.locator('.mentor-eval-bar.has-analysis').waitFor({ state: 'visible', timeout: 5000 });

  await page.getByPlaceholder('Speak or type to your chess mentor').fill('Run the Live annotation tool demo.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const liveAnnotationCard = page.locator('.mentor-tool-card[data-tool-name="annotate_board"]').last();
  await expectText(liveAnnotationCard, 'Annotate board');
  await expectText(page.locator('.mentor-message.is-model.is-voice'), 'teaching marks are now on the board');
  assert.notStrictEqual(
    await page.locator('[data-square="f7"] > div').first().evaluate((element) => getComputedStyle(element).boxShadow),
    'none'
  );

  await page.getByRole('button', { name: 'Mute microphone' }).click();
  await expectText(page.locator('.mentor-live-status'), 'Live voice muted');
  await expectText(page.locator('.mentor-message.is-user.is-voice'), 'Can you explain this position?');
  await expectText(page.locator('.mentor-message.is-model.is-voice'), 'Let us examine the position together.');
  await page.screenshot({
    path: path.join(__dirname, '..', 'tmp', `mentor-live-${viewport.width}x${viewport.height}.png`),
    fullPage: true
  });
  await page.getByRole('button', { name: 'Unmute microphone' }).click();
  await page.getByRole('button', { name: 'Stop Live voice' }).click();
  await page.getByRole('button', { name: 'Start Live voice' }).waitFor({ state: 'visible' });
  await page.reload();
  await expectText(page.locator('.mentor-message.is-user.is-voice'), 'Explain the center by voice.');
  await expectText(page.locator('.mentor-message.is-model.is-voice'), 'I heard your typed question');
  await expectText(page.locator('.mentor-tool-card[data-tool-name="play_line"]'), 'Demonstrate 4 moves');
  await expectText(page.locator('.mentor-tool-card[data-tool-name="analyze_position"]'), 'Best:');
  await page.locator('.mentor-eval-bar.has-analysis').waitFor({ state: 'visible' });
  assert.notStrictEqual(
    await page.locator('[data-square="f7"] > div').first().evaluate((element) => getComputedStyle(element).boxShadow),
    'none'
  );

  await page.getByRole('button', { name: 'Reset board' }).click();
  await expectText(page.locator('.mentor-move-list-header'), '0 plies');
  await page.getByRole('button', { name: 'Start Live voice' }).click();
  await expectText(page.locator('.mentor-live-status'), 'Live voice listening');
  await page.getByPlaceholder('Speak or type to your chess mentor').fill('Run the Live board tool demo.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const cancelledLiveLine = page.locator('.mentor-tool-card[data-tool-name="play_line"]').last();
  await expectText(cancelledLiveLine, '1 of 4 moves');
  await page.getByRole('button', { name: 'Stop Live voice' }).click();
  await expectText(cancelledLiveLine, 'cancelled');
  const stoppedLiveDetail = await page.evaluate(async () => {
    const id = location.pathname.split('/').at(-1);
    return fetch(`/api/mentor/conversations/${id}`).then((response) => response.json());
  });
  assert.ok(stoppedLiveDetail.conversation.chess.history.length >= 1);
  assert.ok(stoppedLiveDetail.conversation.chess.history.length < 4);
  assert.strictEqual(stoppedLiveDetail.conversation.messages.at(-1).status, 'cancelled');
  await page.reload();
  await expectText(page.locator('.mentor-tool-card[data-tool-name="play_line"]').last(), 'cancelled');
  assert.strictEqual(
    (await page.evaluate(() => fetch(`/api/mentor/conversations/${location.pathname.split('/').at(-1)}`).then((response) => response.json()))).conversation.chess.history.length,
    stoppedLiveDetail.conversation.chess.history.length
  );

  await page.goto('http://127.0.0.1:3010/mentor-live');
  await page.waitForURL(/\/mentor(?:\/[^/]+)?$/);
  await page.locator('.mentor-shell').waitFor({ state: 'visible' });
  assert.strictEqual(await page.getByText('Live Multimodal Mentor').count(), 0);
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
  await expectText(
    page.locator('.shared-setting-note'),
    'Backend update required; restart the ChessProject server.'
  );
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
  console.log('Mentor Playwright desktop regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
