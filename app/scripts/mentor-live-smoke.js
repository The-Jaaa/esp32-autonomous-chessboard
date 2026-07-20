require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { TOOL_DECLARATIONS } = require('../mentor/tool-service');

const SMOKE_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function toolResult(call) {
  if (call.name === 'get_board_state') {
    return {
      output: {
        fen: SMOKE_FEN,
        pgn: '',
        turn: 'White',
        revision: 0,
        orientation: 'white',
        gameStatus: { resultText: 'Game in progress', isGameOver: false },
        recentMoves: [],
        legalMoves: ['e2e4', 'g1f3'],
        annotations: { highlights: [], arrows: [] }
      }
    };
  }
  if (call.name === 'annotate_board') {
    return {
      output: {
        annotations: {
          highlights: [{ square: 'f7', role: 'danger' }],
          arrows: []
        },
        board: { fen: SMOKE_FEN, revision: 0, orientation: 'white' }
      }
    };
  }
  return { error: { message: `Unexpected smoke-test tool: ${call.name}` } };
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.log('Mentor Live real smoke skipped: GEMINI_API_KEY is not configured.');
    return;
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let session;
  let audioChunks = 0;
  let transcript = '';
  const toolCalls = [];
  let settled = false;
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for Gemini Live tool output.')), 60000);
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      handler(value);
    };
    ai.live.connect({
      model: 'gemini-3.1-flash-live-preview',
      config: {
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [{
          functionDeclarations: TOOL_DECLARATIONS.filter((declaration) =>
            ['get_board_state', 'annotate_board'].includes(declaration.name))
        }],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } }
        },
        systemInstruction: {
          parts: [{
            text: [
              'You are running a connection smoke test.',
              'Use get_board_state first, then call annotate_board to highlight f7 with the danger role and no arrows.',
              'After both tool responses, briefly say that the Live chess tools are working.'
            ].join(' ')
          }]
        }
      },
      callbacks: {
        onmessage: (message) => {
          const calls = message.toolCall?.functionCalls || [];
          if (calls.length) {
            toolCalls.push(...calls.map((call) => ({ id: call.id, name: call.name })));
            session.sendToolResponse({
              functionResponses: calls.map((call) => ({
                id: call.id,
                name: call.name,
                response: toolResult(call)
              }))
            });
          }
          transcript += message.serverContent?.outputTranscription?.text || '';
          audioChunks += (message.serverContent?.modelTurn?.parts || [])
            .filter((part) => part.inlineData?.data).length;
          if (message.serverContent?.turnComplete
            && toolCalls.some((call) => call.name === 'get_board_state')
            && toolCalls.some((call) => call.name === 'annotate_board')) finish(resolve);
        },
        onerror: (error) => finish(reject, error.error || error),
        onclose: () => {
          if (!settled) finish(reject, new Error('Gemini Live closed before completing the smoke turn.'));
        }
      }
    }).then((connected) => {
      session = connected;
      session.sendRealtimeInput({
        text: 'Run the requested board-state and safe annotation smoke test, then explain the result aloud.'
      });
    }).catch((error) => finish(reject, error));
  });

  try {
    await completion;
    if (!audioChunks) throw new Error('Gemini Live returned no audio chunks.');
    if (!transcript.trim()) throw new Error('Gemini Live returned no output transcription.');
    if (!toolCalls.every((call) => call.id)) throw new Error('Gemini Live returned a function call without an ID.');
    if (!toolCalls.some((call) => call.name === 'get_board_state')) {
      throw new Error('Gemini Live did not call get_board_state.');
    }
    if (!toolCalls.some((call) => call.name === 'annotate_board')) {
      throw new Error('Gemini Live did not call annotate_board.');
    }
    console.log(`Mentor Live real tool smoke passed (${toolCalls.length} calls, ${audioChunks} audio chunks).`);
  } finally {
    try { session?.sendRealtimeInput({ audioStreamEnd: true }); } catch {}
    try { session?.close(); } catch {}
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
