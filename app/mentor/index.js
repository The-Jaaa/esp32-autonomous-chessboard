const { MentorStore } = require('./store');
const { MentorService } = require('./service');
const { createMentorRouter } = require('./router');
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
  const service = new MentorService({
    store,
    provider: textProvider,
    emit: (conversationId, event, payload) => {
      io.to(roomName(conversationId)).emit(event, payload);
    }
  });

  app.use('/api/mentor', createMentorRouter({ store, service }));

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

  return { store, service, provider: textProvider };
}

module.exports = {
  createMentorFeature,
  roomName
};
