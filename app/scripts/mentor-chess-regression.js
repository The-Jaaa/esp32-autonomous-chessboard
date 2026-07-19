const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const { MentorStore, STANDARD_FEN } = require('../mentor/store');
const { MentorChessService } = require('../mentor/chess-service');
const { createMentorFeature } = require('../mentor');

function temporaryDatabase(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `mentor-chess-${name}-`));
  return { directory, file: path.join(directory, 'mentor.sqlite') };
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function expectError(operation, statusCode, code) {
  let thrown = null;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'Expected operation to throw.');
  assert.strictEqual(thrown.statusCode, statusCode);
  if (code) assert.strictEqual(thrown.code, code);
  return thrown;
}

function waitForEvent(emitter, event, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, timeoutMs);
    const listener = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve(payload);
    };
    emitter.on(event, listener);
  });
}

function chessStateRegressions() {
  const store = new MentorStore({ dbPath: ':memory:' });
  const chess = new MentorChessService({ store });
  const first = store.createConversation({ title: 'First board' });
  const second = store.createConversation({ title: 'Second board' });

  assert.strictEqual(chess.getState(first.id).fen, STANDARD_FEN);
  assert.strictEqual(chess.getState(first.id).revision, 0);
  assert.strictEqual(chess.getState(first.id).legalMoves.length, 20);

  const move = chess.move(first.id, {
    uci: 'e2e4',
    expectedRevision: 0,
    actionId: 'move-e4'
  });
  assert.strictEqual(move.state.history[0].san, 'e4');
  assert.strictEqual(move.state.turn, 'b');
  assert.strictEqual(move.state.revision, 1);
  assert.strictEqual(chess.getState(second.id).fen, STANDARD_FEN);

  const duplicate = chess.move(first.id, {
    uci: 'e2e4',
    expectedRevision: 0,
    actionId: 'move-e4'
  });
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(duplicate.state.revision, 1);

  expectError(() => chess.move(first.id, {
    uci: 'a1a8',
    expectedRevision: 1,
    actionId: 'illegal'
  }), 400);
  assert.strictEqual(chess.getState(first.id).revision, 1);

  const stale = expectError(() => chess.move(first.id, {
    uci: 'e7e5',
    expectedRevision: 0,
    actionId: 'stale'
  }), 409, 'stale_revision');
  assert.strictEqual(stale.state.revision, 1);

  const flipped = chess.setOrientation(first.id, {
    orientation: 'black',
    expectedRevision: 1,
    actionId: 'flip'
  });
  assert.strictEqual(flipped.state.orientation, 'black');
  assert.strictEqual(flipped.state.revision, 2);

  const checkFen = '4k3/8/8/8/8/8/4R3/4K3 b - - 0 1';
  const checked = chess.setPosition(first.id, {
    fen: checkFen,
    expectedRevision: 2,
    actionId: 'load-check'
  });
  assert.strictEqual(checked.state.gameStatus.status, 'check');
  assert.strictEqual(checked.state.history.length, 0);

  const mateFen = '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1';
  const mated = chess.setPosition(first.id, {
    fen: mateFen,
    expectedRevision: 3,
    actionId: 'load-mate'
  });
  assert.strictEqual(mated.state.gameStatus.status, 'checkmate');
  assert.strictEqual(mated.state.gameStatus.winner, 'white');

  const stalemateFen = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
  const stalemate = chess.setPosition(first.id, {
    fen: stalemateFen,
    expectedRevision: 4,
    actionId: 'load-stalemate'
  });
  assert.strictEqual(stalemate.state.gameStatus.status, 'stalemate');

  const drawFen = '7k/8/8/8/8/8/8/K7 w - - 0 1';
  const draw = chess.setPosition(first.id, {
    fen: drawFen,
    expectedRevision: 5,
    actionId: 'load-draw'
  });
  assert.strictEqual(draw.state.gameStatus.status, 'draw');
  assert.strictEqual(draw.state.gameStatus.drawReason, 'insufficient_material');

  const reset = chess.reset(first.id, {
    expectedRevision: 6,
    actionId: 'reset'
  });
  assert.strictEqual(reset.state.fen, STANDARD_FEN);
  assert.strictEqual(reset.state.orientation, 'black');
  assert.strictEqual(reset.state.events.length, 7);
  assert.strictEqual(reset.state.cacheConsistent, true);
  assert.match(chess.promptContext(first.id), /FEN: rnbqkbnr/);
  assert.strictEqual(store.deleteConversation(second.id), true);
  assert.strictEqual(store.getChessSession(second.id), null);
  assert.deepStrictEqual(store.listBoardEvents(second.id), []);
  store.close();
}

function restartReconstructionRegression() {
  const temp = temporaryDatabase('restart');
  let store = new MentorStore({ dbPath: temp.file });
  let chess = new MentorChessService({ store });
  const conversation = store.createConversation();
  chess.move(conversation.id, { uci: 'd2d4', expectedRevision: 0, actionId: 'd4' });
  chess.move(conversation.id, { uci: 'd7d5', expectedRevision: 1, actionId: 'd5' });
  const beforeRestart = chess.getState(conversation.id);
  store.close();

  store = new MentorStore({ dbPath: temp.file });
  chess = new MentorChessService({ store });
  const restored = chess.getState(conversation.id);
  assert.strictEqual(restored.fen, beforeRestart.fen);
  assert.strictEqual(restored.pgn, beforeRestart.pgn);
  assert.deepStrictEqual(restored.history.map((move) => move.uci), ['d2d4', 'd7d5']);
  assert.strictEqual(restored.cacheConsistent, true);
  store.close();
  cleanup(temp.directory);
}

async function restAndSocketRegressions() {
  const temp = temporaryDatabase('http');
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server);
  const feature = createMentorFeature({
    app,
    io,
    ai: {},
    dbPath: temp.file,
    provider: { async *stream() { yield 'Mock'; } }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const create = () => fetch(`${baseUrl}/api/mentor/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  }).then((response) => response.json());
  const first = (await create()).conversation;
  const second = (await create()).conversation;
  assert.strictEqual(first.chess.fen, STANDARD_FEN);

  const firstClient = createClient(baseUrl, { transports: ['websocket'] });
  const secondClient = createClient(baseUrl, { transports: ['websocket'] });
  await Promise.all([waitForEvent(firstClient, 'connect'), waitForEvent(secondClient, 'connect')]);
  await Promise.all([
    new Promise((resolve) => firstClient.emit('mentor-subscribe', { conversationId: first.id }, resolve)),
    new Promise((resolve) => secondClient.emit('mentor-subscribe', { conversationId: second.id }, resolve))
  ]);

  let leaks = 0;
  secondClient.on('mentor-board-updated', () => { leaks += 1; });
  const updatePromise = waitForEvent(firstClient, 'mentor-board-updated');
  const moveResponse = await fetch(`${baseUrl}/api/mentor/conversations/${first.id}/moves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uci: 'g1f3', expectedRevision: 0, actionId: 'socket-knight' })
  });
  assert.strictEqual(moveResponse.status, 200);
  const update = await updatePromise;
  assert.strictEqual(update.actionId, 'socket-knight');
  assert.strictEqual(update.state.history[0].san, 'Nf3');
  assert.strictEqual(leaks, 0);

  const staleResponse = await fetch(`${baseUrl}/api/mentor/conversations/${first.id}/moves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uci: 'g8f6', expectedRevision: 0, actionId: 'stale-http' })
  });
  assert.strictEqual(staleResponse.status, 409);
  assert.strictEqual((await staleResponse.json()).state.revision, 1);

  const firstDetail = await fetch(`${baseUrl}/api/mentor/conversations/${first.id}`).then((response) => response.json());
  const secondDetail = await fetch(`${baseUrl}/api/mentor/conversations/${second.id}`).then((response) => response.json());
  assert.strictEqual(firstDetail.conversation.chess.history.length, 1);
  assert.strictEqual(secondDetail.conversation.chess.history.length, 0);

  firstClient.disconnect();
  secondClient.disconnect();
  await new Promise((resolve) => io.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  feature.store.close();
  cleanup(temp.directory);
}

async function main() {
  chessStateRegressions();
  restartReconstructionRegression();
  await restAndSocketRegressions();
  console.log('Mentor chess workspace regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
