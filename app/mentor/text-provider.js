const DEFAULT_SYSTEM_INSTRUCTION = [
  'You are a patient, practical chess mentor.',
  'Teach through clear questions, short explanations, and concrete examples.',
  'Adapt to the learner and remember the conversation context you receive.',
  'You may proactively use the supplied board tools whenever a visual example would improve the lesson.',
  'Never claim a board action succeeded until its tool result confirms success.',
  'The tools validate legality, not chess quality, so do not claim Stockfish-level accuracy.',
  'Use plain text and concise paragraphs. Avoid markdown tables.'
].join(' ');

const MAX_TOOL_ROUNDS = 8;

function extractChunkText(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts || [];
  if (parts.length) return parts.map((part) => part.text || '').join('');
  return typeof chunk?.text === 'string' ? chunk.text : '';
}

function extractFunctionCalls(chunk) {
  if (Array.isArray(chunk?.functionCalls)) return chunk.functionCalls;
  const parts = chunk?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.functionCall).filter(Boolean);
}

function toHistory(messages) {
  return messages.map((message) => ({
    role: message.role === 'model' ? 'model' : 'user',
    parts: [{ text: message.content }]
  }));
}

class GeminiMentorTextProvider {
  constructor({ ai, model = 'gemini-3.5-flash', systemInstruction = DEFAULT_SYSTEM_INSTRUCTION }) {
    this.ai = ai;
    this.model = model;
    this.systemInstruction = systemInstruction;
  }

  async *stream({ messages, chessContext, signal, toolDeclarations = [], executeTool }) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }

    const latest = messages.at(-1);
    if (!latest || latest.role === 'model') throw new Error('A user message is required to start a mentor turn.');
    const chat = this.ai.chats.create({
      model: this.model,
      history: toHistory(messages.slice(0, -1)),
      config: {
        systemInstruction: chessContext
          ? `${this.systemInstruction}\n\n${chessContext}`
          : this.systemInstruction,
        responseModalities: ['TEXT'],
        tools: toolDeclarations.length ? [{ functionDeclarations: toolDeclarations }] : undefined
      }
    });

    let message = latest.content;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (signal?.aborted) return;
      const response = await chat.sendMessageStream({ message });
      const calls = [];
      const callKeys = new Set();
      for await (const chunk of response) {
        if (signal?.aborted) return;
        const text = extractChunkText(chunk);
        if (text) yield text;
        for (const call of extractFunctionCalls(chunk)) {
          const key = call.id || `${call.name}:${JSON.stringify(call.args || {})}`;
          if (!callKeys.has(key)) {
            callKeys.add(key);
            calls.push(call);
          }
        }
      }

      if (!calls.length) return;
      if (typeof executeTool !== 'function') throw new Error('Mentor tool execution is unavailable.');
      const responses = [];
      for (const call of calls) {
        if (signal?.aborted) return;
        const result = await executeTool(call);
        responses.push({
          functionResponse: {
            id: call.id,
            name: call.name,
            response: result.response
          }
        });
      }
      message = responses;
    }
    throw new Error(`Mentor exceeded the ${MAX_TOOL_ROUNDS}-round tool limit.`);
  }
}

class DeterministicMentorTextProvider {
  constructor({ chunks } = {}) {
    this.chunks = chunks || ['Let us examine ', 'the position together.'];
  }

  async *stream({ messages = [], signal, executeTool }) {
    const prompt = messages.at(-1)?.content || '';
    if (prompt === 'Run the browser tool demo.' && executeTool) {
      yield 'I will demonstrate the position. ';
      await executeTool({
        id: 'browser-line',
        name: 'play_line',
        args: { moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'] }
      });
      await executeTool({
        id: 'browser-annotations',
        name: 'annotate_board',
        args: {
          highlights: [{ square: 'f7', role: 'danger' }],
          arrows: [{ from: 'f3', to: 'e5', role: 'idea' }]
        }
      });
      yield 'The line and teaching marks are now on the board.';
      return;
    }
    if (prompt === 'Run the cancellable browser demo.' && executeTool) {
      yield 'Starting the longer line. ';
      await executeTool({
        id: 'browser-cancel-line',
        name: 'play_line',
        args: { moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'] }
      });
      yield 'The line finished.';
      return;
    }
    for (const chunk of this.chunks) {
      if (signal?.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (signal?.aborted) return;
      yield chunk;
    }
  }
}

module.exports = {
  DEFAULT_SYSTEM_INSTRUCTION,
  DeterministicMentorTextProvider,
  GeminiMentorTextProvider,
  MAX_TOOL_ROUNDS,
  extractFunctionCalls,
  extractChunkText
};
