const { MentorStore } = require('./store');
const { MentorService } = require('./service');
const { createMentorRouter } = require('./router');
const { MentorChessService } = require('./chess-service');
const { MentorToolService } = require('./tool-service');
const { MentorEngineService } = require('./engine-service');
const { MentorAnalysisService } = require('./analysis-service');
const { MentorActivityService } = require('./activity-service');
const { MentorSpeakerService } = require('./speaker-service');
const { MentorPhysicalObserverService } = require('./physical-observer-service');
const { GameSettingsService } = require('../game-settings-service');
const {
  DEFAULT_LIVE_MODEL,
  DEFAULT_LIVE_VOICE,
  DeterministicMentorLiveConnector,
  GeminiMentorLiveConnector,
  MentorLiveService
} = require('./live-service');
const {
  DeterministicMentorTextProvider,
  GeminiMentorTextProvider
} = require('./text-provider');

function roomName(conversationId) {
  return `mentor:${conversationId}`;
}

function createMentorFeature({
  app,
  io,
  ai,
  dbPath = process.env.MENTOR_DB_PATH,
  provider,
  engineService,
  analysisService,
  liveConnector,
  speakerService = null,
  model = 'gemini-3.5-flash',
  liveModel = DEFAULT_LIVE_MODEL,
  liveVoice = DEFAULT_LIVE_VOICE,
  voiceFirstPhysical = true
}) {
  const store = new MentorStore(dbPath ? { dbPath } : {});
  const gameSettingsService = new GameSettingsService({
    store,
    emit: (event, payload) => io.emit(event, payload)
  });
  const textProvider = provider || (process.env.MENTOR_FAKE_TEXT === '1'
    ? new DeterministicMentorTextProvider()
    : new GeminiMentorTextProvider({ ai, model }));
  const chessService = new MentorChessService({ store });
  const mentorEngine = engineService || new MentorEngineService();
  const mentorAnalysis = analysisService || new MentorAnalysisService({
    chessService,
    engineService: mentorEngine
  });
  const emit = (conversationId, event, payload) => {
    io.to(roomName(conversationId)).emit(event, payload);
  };

  const physicalObserver = new MentorPhysicalObserverService({
    store,
    chessService,
    analysisService: mentorAnalysis,
    emit
  });

  let liveService;
  let activityService;
  const emitBoardUpdate = (conversationId, result) => {
    io.to(roomName(conversationId)).emit('mentor-board-updated', {
      conversationId,
      actionId: result.actionId,
      duplicate: result.duplicate,
      state: result.state
    });
    liveService?.notifyBoardUpdated(conversationId, result.state, {
      actionId: result.actionId
    });
  };
  const toolService = new MentorToolService({
    store,
    chessService,
    analysisService: mentorAnalysis,
    physicalObserver,
    gameSettingsService,
    emit,
    emitBoardUpdate
  });
  activityService = new MentorActivityService({
    store,
    chessService,
    analysisService: mentorAnalysis,
    engineService: mentorEngine,
    emit,
    emitGlobal: (event, payload) => io.emit(event, payload),
    emitBoardUpdate
  });
  toolService.setActivityService(activityService);
  const service = new MentorService({
    store,
    provider: textProvider,
    toolService,
    activityService,
    contextProvider: (conversationId) => physicalObserver.isAttached(conversationId)
      ? physicalObserver.promptContext(conversationId)
      : chessService.promptContext(conversationId),
    emit
  });
  const connector = liveConnector || (process.env.MENTOR_FAKE_LIVE === '1'
    ? new DeterministicMentorLiveConnector()
    : new GeminiMentorLiveConnector({ ai }));
  liveService = new MentorLiveService({
    store,
    chessService,
    textService: service,
    toolService,
    activityService,
    speakerService,
    stateProvider: (conversationId) => physicalObserver.isAttached(conversationId)
      ? physicalObserver.getState(conversationId)
      : chessService.getState(conversationId),
    connector,
    emit,
    model: liveModel,
    voiceName: liveVoice,
    voiceFirstPhysical
  });
  physicalObserver.setDependencies({
    textService: service,
    liveService,
    activityService
  });
  activityService.setRunners({
    isLiveActive: (conversationId) => liveService.isConversationActive(conversationId),
    text: ({ conversationId, requestId, displayText, prompt }) =>
      service.submitActivityTurn(conversationId, { requestId, displayText, prompt }),
    live: ({ conversationId, requestId, displayText, prompt }) =>
      liveService.requestActivityTurn(conversationId, { requestId, displayText, prompt })
  });

  app.use('/api/mentor', createMentorRouter({
    store,
    service,
    chessService,
    activityService,
    liveService,
    speakerService,
    physicalObserver,
    gameSettingsService,
    emitBoardUpdate
  }));

  io.on('connection', (socket) => {
    socket.on('mentor-subscribe', ({ conversationId } = {}, acknowledge = () => {}) => {
      if (!conversationId || !store.getConversation(conversationId)) {
        acknowledge({ success: false, error: 'Conversation not found.' });
        return;
      }
      for (const room of socket.rooms) {
        if (room.startsWith('mentor:')) socket.leave(room);
      }
      socket.join(roomName(conversationId));
      activityService.reconcile(conversationId, { resumeMentorTurn: true });
      acknowledge({ success: true, conversationId });
    });

    socket.on('mentor-unsubscribe', ({ conversationId } = {}) => {
      if (conversationId) socket.leave(roomName(conversationId));
    });

    socket.on('mentor-message-cancel', ({ conversationId, requestId } = {}, acknowledge = () => {}) => {
      acknowledge({ success: service.cancel(conversationId, requestId) });
    });

    liveService.registerSocket(socket);
  });

  return {
    store,
    service,
    chessService,
    activityService,
    toolService,
    analysisService: mentorAnalysis,
    engineService: mentorEngine,
    liveService,
    physicalObserver,
    gameSettingsService,
    liveConnector: connector,
    provider: textProvider,
    async close() {
      await liveService.closeAll();
      await speakerService?.close?.();
      mentorEngine.close?.();
      store.close();
    }
  };
}

module.exports = {
  createMentorFeature,
  MentorSpeakerService,
  roomName
};
