const { MentorStore } = require('./store');
const { MentorService } = require('./service');
const { createMentorRouter } = require('./router');
const { MentorChessService } = require('./chess-service');
const { MentorToolService } = require('./tool-service');
const { MentorEngineService } = require('./engine-service');
const { MentorAnalysisService } = require('./analysis-service');
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
  model = 'gemini-3.5-flash'
}) {
  const store = new MentorStore(dbPath ? { dbPath } : {});
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

  const emitBoardUpdate = (conversationId, result) => {
    io.to(roomName(conversationId)).emit('mentor-board-updated', {
      conversationId,
      actionId: result.actionId,
      duplicate: result.duplicate,
      state: result.state
    });
  };
  const toolService = new MentorToolService({
    store,
    chessService,
    analysisService: mentorAnalysis,
    emit,
    emitBoardUpdate
  });
  const service = new MentorService({
    store,
    provider: textProvider,
    toolService,
    contextProvider: (conversationId) => chessService.promptContext(conversationId),
    emit
  });

  app.use('/api/mentor', createMentorRouter({
    store,
    service,
    chessService,
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
      acknowledge({ success: true, conversationId });
    });

    socket.on('mentor-unsubscribe', ({ conversationId } = {}) => {
      if (conversationId) socket.leave(roomName(conversationId));
    });

    socket.on('mentor-message-cancel', ({ conversationId, requestId } = {}, acknowledge = () => {}) => {
      acknowledge({ success: service.cancel(conversationId, requestId) });
    });
  });

  return {
    store,
    service,
    chessService,
    toolService,
    analysisService: mentorAnalysis,
    engineService: mentorEngine,
    provider: textProvider,
    close() {
      mentorEngine.close?.();
      store.close();
    }
  };
}

module.exports = {
  createMentorFeature,
  roomName
};
