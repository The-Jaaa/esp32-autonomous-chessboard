const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MentorStore } = require('../mentor/store');
const { MentorChessService } = require('../mentor/chess-service');
const { MentorService } = require('../mentor/service');
const { GeminiMentorTextProvider, MAX_TOOL_ROUNDS } = require('../mentor/text-provider');
const { MentorToolService } = require('../mentor/tool-service');
const { GameSettingsService } = require('../game-settings-service');

function temporaryDatabase(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `mentor-tools-${name}-`));
  return { directory, file: path.join(directory, 'mentor.sqlite') };
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

async function waitForTerminal(store, conversationId, requestId, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const message = store.getMessageByRequestRole(conversationId, requestId, 'model');
    if (message && ['complete', 'failed', 'cancelled'].includes(message.status)) return message;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${requestId}.`);
}

async function storeAndRestartRegressions() {
  const temp = temporaryDatabase('restart');
  let store = new MentorStore({ dbPath: temp.file });
  store.migrate();
  const conversation = store.createConversation();
  const pair = store.createMessagePair(conversation.id, { requestId: 'restart', text: 'Test tools.' });
  const created = store.createToolCall({
    conversationId: conversation.id,
    requestId: 'restart',
    assistantMessageId: pair.assistantMessage.id,
    providerCallId: 'provider-1',
    ordinal: 1,
    name: 'play_move',
    arguments: { uci: 'e2e4' },
    progressTotal: 1
  }).toolCall;
  store.updateToolCall(created.id, { status: 'running' });
  assert.strictEqual(store.listToolCalls(conversation.id).length, 1);
  store.close();

  store = new MentorStore({ dbPath: temp.file });
  const recovered = store.getToolCall(created.id);
  assert.strictEqual(recovered.status, 'failed');
  assert.match(recovered.error, /backend restart/);
  assert.strictEqual(store.deleteConversation(conversation.id), true);
  assert.deepStrictEqual(store.listToolCalls(conversation.id), []);
  store.close();
  cleanup(temp.directory);
}

async function executorRegressions() {
  const store = new MentorStore({ dbPath: ':memory:' });
  const chess = new MentorChessService({ store });
  const conversation = store.createConversation();
  const pair = store.createMessagePair(conversation.id, { requestId: 'tools', text: 'Use tools.' });
  const events = [];
  const boardUpdates = [];
  const gameSettingsService = new GameSettingsService({ store });
  const toolService = new MentorToolService({
    store,
    chessService: chess,
    gameSettingsService,
    delay: async () => {},
    emit: (id, event, payload) => events.push({ id, event, payload }),
    emitBoardUpdate: (id, result) => boardUpdates.push({ id, result })
  });
  let ordinal = 0;
  const execute = (name, args = {}, requestId = 'tools') => toolService.execute({
    conversationId: conversation.id,
    requestId,
    assistantMessageId: pair.assistantMessage.id,
    ordinal: ++ordinal,
    call: { id: `${requestId}-${ordinal}`, name, args },
    signal: new AbortController().signal
  });

  const read = await execute('get_board_state');
  assert.strictEqual(read.toolCall.status, 'complete');
  assert.strictEqual(read.response.output.legalMoves.length, 20);

  const preferences = await execute('set_game_preferences', { humanColor: 'black', difficultyLevel: 11 });
  assert.strictEqual(preferences.toolCall.status, 'complete');
  assert.strictEqual(store.getAppSettings().humanColor, 'black');
  assert.strictEqual(store.getAppSettings().difficultyLevel, 11);

  await execute('annotate_board', {
    highlights: [{ square: 'e4', role: 'idea' }],
    arrows: [{ from: 'e2', to: 'e4', role: 'good' }]
  });
  assert.strictEqual(chess.getState(conversation.id).annotations.highlights[0].square, 'e4');

  await execute('set_orientation', { orientation: 'black' });
  assert.strictEqual(chess.getState(conversation.id).orientation, 'black');
  assert.strictEqual(chess.getState(conversation.id).annotations.arrows.length, 1);

  await execute('play_move', { uci: 'e2e4' });
  assert.strictEqual(chess.getState(conversation.id).history[0].san, 'e4');
  assert.deepStrictEqual(chess.getState(conversation.id).annotations, { highlights: [], arrows: [] });

  const beforeInvalid = chess.getState(conversation.id).fen;
  const invalidLine = await execute('play_line', { moves: ['e7e5', 'e1e8'] });
  assert.strictEqual(invalidLine.toolCall.status, 'failed');
  assert.strictEqual(chess.getState(conversation.id).fen, beforeInvalid);

  const line = await execute('play_line', { moves: ['e7e5', 'g1f3', 'b8c6'] });
  assert.strictEqual(line.toolCall.status, 'complete');
  assert.strictEqual(line.toolCall.progressCurrent, 3);
  assert.deepStrictEqual(chess.getState(conversation.id).history.map((move) => move.uci), [
    'e2e4', 'e7e5', 'g1f3', 'b8c6'
  ]);

  const unknown = await execute('move_physical_robot', {});
  assert.strictEqual(unknown.toolCall.status, 'failed');
  assert.match(unknown.response.error.message, /Unknown mentor tool/);
  assert.ok(events.some((entry) => entry.event === 'mentor-tool-progress'));
  assert.ok(boardUpdates.length >= 5);

  const cancelConversation = store.createConversation();
  const cancelPair = store.createMessagePair(cancelConversation.id, {
    requestId: 'cancel-line',
    text: 'Cancel a line.'
  });
  const controller = new AbortController();
  const cancellingService = new MentorToolService({
    store,
    chessService: chess,
    delay: (milliseconds, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('Cancelled during pacing.');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })
  });
  const pending = cancellingService.execute({
    conversationId: cancelConversation.id,
    requestId: 'cancel-line',
    assistantMessageId: cancelPair.assistantMessage.id,
    ordinal: 1,
    call: { id: 'cancel-provider', name: 'play_line', args: { moves: ['e2e4', 'e7e5', 'g1f3'] } },
    signal: controller.signal
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.deepStrictEqual(chess.getState(cancelConversation.id).history.map((move) => move.uci), ['e2e4']);
  assert.strictEqual(store.listToolCalls(cancelConversation.id)[0].status, 'cancelled');
  store.close();
}

async function providerRoundTripRegression() {
  const sent = [];
  let round = 0;
  const chat = {
    async sendMessageStream({ message }) {
      sent.push(message);
      const chunks = round++ === 0
        ? [{ text: 'Before. ' }, { functionCalls: [{ id: 'call-1', name: 'play_move', args: { uci: 'e2e4' } }] }]
        : [{ text: 'After.' }];
      return (async function* streamChunks() {
        for (const chunk of chunks) yield chunk;
      }());
    }
  };
  let createConfig = null;
  const provider = new GeminiMentorTextProvider({
    ai: { chats: { create: (config) => { createConfig = config; return chat; } } }
  });
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  const output = [];
  try {
    for await (const delta of provider.stream({
      messages: [
        { role: 'user', content: 'Earlier' },
        { role: 'model', content: 'Earlier reply' },
        { role: 'user', content: 'Move now' }
      ],
      chessContext: 'FEN: test',
      toolDeclarations: [{ name: 'play_move' }],
      executeTool: async (call) => ({ response: { output: { uci: call.args.uci } } })
    })) output.push(delta);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
  assert.deepStrictEqual(output, ['Before. ', 'After.']);
  assert.strictEqual(createConfig.history.length, 2);
  assert.strictEqual(createConfig.config.tools[0].functionDeclarations[0].name, 'play_move');
  assert.strictEqual(sent[0], 'Move now');
  assert.strictEqual(sent[1][0].functionResponse.id, 'call-1');
  assert.deepStrictEqual(sent[1][0].functionResponse.response, { output: { uci: 'e2e4' } });
}

async function providerToolLimitFinalReplyRegression() {
  let round = 0;
  let executions = 0;
  const chat = {
    async sendMessageStream() {
      const currentRound = round++;
      const chunks = currentRound < MAX_TOOL_ROUNDS
        ? [{ functionCalls: [{ id: `round-${currentRound}`, name: 'get_board_state', args: {} }] }]
        : [{ text: 'Final explanation.' }];
      return (async function* streamChunks() {
        for (const chunk of chunks) yield chunk;
      }());
    }
  };
  const provider = new GeminiMentorTextProvider({
    ai: { chats: { create: () => chat } }
  });
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  const output = [];
  try {
    for await (const delta of provider.stream({
      messages: [{ role: 'user', content: 'Use every tool round.' }],
      toolDeclarations: [{ name: 'get_board_state' }],
      executeTool: async () => {
        executions += 1;
        return { response: { output: { ok: true } } };
      }
    })) output.push(delta);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
  assert.strictEqual(executions, MAX_TOOL_ROUNDS);
  assert.strictEqual(round, MAX_TOOL_ROUNDS + 1);
  assert.deepStrictEqual(output, ['Final explanation.']);
}

async function serviceToolLoopRegressions() {
  const store = new MentorStore({ dbPath: ':memory:' });
  const chess = new MentorChessService({ store });
  const conversation = store.createConversation();
  let executions = 0;
  const loggedErrors = [];
  const toolService = new MentorToolService({ store, chessService: chess, delay: async () => {} });
  const provider = {
    async *stream({ executeTool }) {
      yield 'Showing it. ';
      executions += 1;
      await executeTool({ id: 'service-move', name: 'play_move', args: { uci: 'e2e4' } });
      yield 'Done.';
    }
  };
  const service = new MentorService({
    store,
    provider,
    toolService,
    logger: { error: (...args) => loggedErrors.push(args) }
  });
  service.submitMessage(conversation.id, { requestId: 'service-loop', text: 'Show e4.' });
  const completed = await waitForTerminal(store, conversation.id, 'service-loop');
  assert.strictEqual(completed.status, 'complete');
  assert.strictEqual(completed.content, 'Showing it. Done.');
  assert.strictEqual(chess.getState(conversation.id).history[0].uci, 'e2e4');
  assert.strictEqual(store.listToolCalls(conversation.id).length, 1);

  const duplicate = service.submitMessage(conversation.id, { requestId: 'service-loop', text: 'Duplicate.' });
  assert.strictEqual(duplicate.duplicate, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(executions, 1);

  const limited = store.createConversation();
  service.provider = {
    async *stream({ executeTool }) {
      for (let index = 0; index < 13; index += 1) {
        await executeTool({ id: `limit-${index}`, name: 'get_board_state', args: {} });
      }
      yield 'Impossible';
    }
  };
  service.submitMessage(limited.id, { requestId: 'limit', text: 'Too many tools.' });
  const failed = await waitForTerminal(store, limited.id, 'limit');
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(store.listToolCalls(limited.id).length, 12);
  assert.strictEqual(chess.getState(limited.id).revision, 0);
  assert.strictEqual(loggedErrors.length, 1);
  assert.match(loggedErrors[0].join(' '), /MENTOR_RESPONSE_FAILED/);
  assert.match(loggedErrors[0].join(' '), /12-tool-call limit/);
  store.close();
}

async function main() {
  await storeAndRestartRegressions();
  await executorRegressions();
  await providerRoundTripRegression();
  await providerToolLimitFinalReplyRegression();
  await serviceToolLoopRegressions();
  console.log('Mentor board-control tool regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
