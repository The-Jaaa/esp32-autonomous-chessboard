const { MentorStore } = require('./store');
const { MentorService } = require('./service');
const { createMentorRouter } = require('./router');
const { MentorChessService } = require('./chess-service');
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
  model = 'gemini-3.5-flash'
}) {
  const store = new MentorStore(dbPath ? { dbPath } : {});
  const textProvider = provider || (process.env.MENTOR_FAKE_TEXT === '1'
    ? new DeterministicMentorTextProvider()
    : new GeminiMentorTextProvider({ ai, model }));
  const chessService = new MentorChessService({ store });
  const service = new MentorService({
    store,
    provider: textProvider,
    contextProvider: (conversationId) => chessService.promptContext(conversationId),
    emit: (conversationId, event, payload) => {
      io.to(roomName(conversationId)).emit(event, payload);
    }
  });

  const emitBoardUpdate = (conversationId, result) => {
    io.to(roomName(conversationId)).emit('mentor-board-updated', {
      conversationId,
      actionId: result.actionId,
      duplicate: result.duplicate,
      state: result.state
    });
  };

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

  return { store, service, chessService, provider: textProvider };
}

module.exports = {
  createMentorFeature,
  roomName
};
