const DEFAULT_SYSTEM_INSTRUCTION = [
  'You are a patient, practical chess mentor.',
  'Teach through clear questions, short explanations, and concrete examples.',
  'Adapt to the learner and remember the conversation context you receive.',
  'Do not claim to move pieces or change the chessboard.',
  'Use plain text and concise paragraphs. Avoid markdown tables.'
].join(' ');

function extractChunkText(chunk) {
  if (typeof chunk?.text === 'string') return chunk.text;
  const parts = chunk?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || '').join('');
}

class GeminiMentorTextProvider {
  constructor({ ai, model = 'gemini-3.5-flash', systemInstruction = DEFAULT_SYSTEM_INSTRUCTION }) {
    this.ai = ai;
    this.model = model;
    this.systemInstruction = systemInstruction;
  }

  async *stream({ messages, chessContext, signal }) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }

    const contents = messages.map((message) => ({
      role: message.role === 'model' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));
    const response = await this.ai.models.generateContentStream({
      model: this.model,
      contents,
      config: {
        systemInstruction: chessContext
          ? `${this.systemInstruction}\n\n${chessContext}`
          : this.systemInstruction,
        responseModalities: ['TEXT']
      }
    });

    for await (const chunk of response) {
      if (signal?.aborted) return;
      const text = extractChunkText(chunk);
      if (text) yield text;
    }
  }
}

class DeterministicMentorTextProvider {
  constructor({ chunks } = {}) {
    this.chunks = chunks || ['Let us examine ', 'the position together.'];
  }

  async *stream({ signal }) {
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
  extractChunkText
};
