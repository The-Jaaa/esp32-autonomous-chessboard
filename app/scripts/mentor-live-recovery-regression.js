const assert = require('assert');
const { MentorStore, STANDARD_FEN } = require('../mentor/store');
const {
  DeterministicMentorLiveConnector,
  MentorLiveService
} = require('../mentor/live-service');

function waitFor(predicate, message, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(message));
      setTimeout(poll, 5);
    };
    poll();
  });
}

class FakeSocket {
  constructor(conversationId) {
    this.id = 'recovery-socket';
    this.rooms = new Set([`mentor:${conversationId}`]);
    this.events = [];
  }

  emit(event, payload) {
    this.events.push({ event, payload });
  }
}

function state(conversationId) {
  return {
    conversationId,
    source: 'physical',
    sourceKey: 'physical:server:2',
    fen: STANDARD_FEN,
    pgn: '',
    turnName: 'White',
    revision: 12,
    orientation: 'white',
    history: [],
    legalMoves: [],
    annotations: { highlights: [], arrows: [] },
    gameStatus: { resultText: 'Game in progress', isGameOver: false },
    physical: { serverInstanceId: 'server', sessionGeneration: 2, stateRevision: 12 }
  };
}

async function main() {
  const store = new MentorStore({ dbPath: ':memory:' });
  const conversation = store.createConversation();
  const socket = new FakeSocket(conversation.id);
  const connector = new DeterministicMentorLiveConnector({ delayMs: 1 });
  let resumes = 0;
  const activityService = {
    get: () => ({ id: 'physical-activity', status: 'active', config: { boardSource: 'physical' } }),
    resumeStrandedPhysicalMentorTurn: () => { resumes += 1; }
  };
  const speakerEvents = [];
  const service = new MentorLiveService({
    store,
    chessService: { getState: () => state(conversation.id) },
    textService: { hasActiveConversation: () => false },
    toolService: { declarations: () => [] },
    activityService,
    speakerService: {
      bindSession: () => ({ outputMode: 'board', resolvedOutput: 'board', deviceId: 'main-board', boardVolume: 37 }),
      routeAudio: () => ({ destination: 'board' }),
      endSpeech: () => {},
      clearOutput: (...args) => speakerEvents.push(['clear', ...args]),
      releaseSession: (...args) => speakerEvents.push(['release', ...args])
    },
    stateProvider: () => state(conversation.id),
    connector,
    recoveryDelayMs: 5,
    recoveryResetMs: 10,
    logger: { log() {}, warn() {}, error() {} }
  });

  const started = await service.start(socket, {
    conversationId: conversation.id,
    outputMode: 'board',
    deviceId: 'main-board',
    boardVolume: 37
  });
  const originalSessionId = started.sessionId;
  connector.sessions[0].fail('Synthetic provider failure');
  await waitFor(() => connector.sessions.length === 2 && service.isConversationActive(conversation.id), 'Live did not reconnect.');
  const statuses = socket.events.filter((event) => event.event === 'mentor-live-status').map((event) => event.payload.status);
  assert(statuses.includes('recovering'));
  assert(statuses.includes('recovered'));
  assert.strictEqual(service.byConversation.get(conversation.id).sessionId, originalSessionId);
  assert.strictEqual(service.byConversation.get(conversation.id).speaker.boardVolume, 37);
  assert(resumes >= 2, 'physical activity should resume after recovery');
  assert(speakerEvents.some((event) => event[0] === 'clear' && event.at(-1) === 'provider_error'));
  await waitFor(
    () => service.byConversation.get(conversation.id)?.recoveryAttempts === 0,
    'A stable recovered session did not reset its recovery allowance.'
  );

  const beforeContextReconnect = connector.sessions.length;
  service.requestContextReconnect(conversation.id, 'physical_handoff');
  const queuedIntroduction = service.requestPhysicalTurn(conversation.id, {
    requestId: 'opening-after-handoff',
    displayText: 'Italian Game lesson started.',
    prompt: 'Introduce the Italian Game now.',
    fallbackAssistantText: 'The Italian Game is ready.'
  });
  assert.strictEqual(queuedIntroduction.queued, true);
  assert.strictEqual(queuedIntroduction.reconnecting, true);
  await waitFor(() => connector.sessions.length === beforeContextReconnect + 1, 'Context reconnect did not complete.');
  await waitFor(
    () => store.getRequestMessages(conversation.id, 'opening-after-handoff')
      .some((message) => message.role === 'model' && message.status === 'complete'),
    'Opening introduction was not delivered after reconnect.'
  );

  connector.sessions.at(-1).fail('Second provider failure');
  await waitFor(
    () => connector.sessions.length === beforeContextReconnect + 2 && service.isConversationActive(conversation.id),
    'A later independent provider failure did not recover.'
  );

  connector.sessions.at(-1).fail('Immediate repeated provider failure');
  await waitFor(() => !service.isConversationActive(conversation.id), 'An immediate repeated failure should require manual restart.');
  assert(socket.events.some((event) => event.event === 'mentor-live-error'
    && event.payload.code === 'mentor_live_provider_error'));

  const restarted = await service.start(socket, {
    conversationId: conversation.id,
    outputMode: 'board',
    deviceId: 'main-board',
    boardVolume: 37
  });
  assert.strictEqual(restarted.duplicate, false, 'manual restart must be available after failed recovery');
  const sessionsBeforeStop = connector.sessions.length;
  await service.stop(socket, { conversationId: conversation.id, sessionId: restarted.sessionId }, 'client_stop');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(connector.sessions.length, sessionsBeforeStop, 'intentional Stop must not reconnect');

  store.close();
  console.log('Mentor Live recovery regressions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
