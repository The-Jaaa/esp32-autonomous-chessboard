require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.log('Mentor Live real smoke skipped: GEMINI_API_KEY is not configured.');
    return;
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let session;
  let audioChunks = 0;
  let transcript = '';
  let settled = false;
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for Gemini Live output.')), 30000);
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
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } }
        },
        systemInstruction: { parts: [{ text: 'Reply concisely in plain conversational English.' }] }
      },
      callbacks: {
        onmessage: (message) => {
          transcript += message.serverContent?.outputTranscription?.text || '';
          audioChunks += (message.serverContent?.modelTurn?.parts || [])
            .filter((part) => part.inlineData?.data).length;
          if (message.serverContent?.turnComplete) finish(resolve);
        },
        onerror: (error) => finish(reject, error.error || error),
        onclose: () => {
          if (!settled) finish(reject, new Error('Gemini Live closed before completing the smoke turn.'));
        }
      }
    }).then((connected) => {
      session = connected;
      session.sendRealtimeInput({ text: 'Say that the live chess mentor connection is working.' });
    }).catch((error) => finish(reject, error));
  });

  try {
    await completion;
    if (!audioChunks) throw new Error('Gemini Live returned no audio chunks.');
    if (!transcript.trim()) throw new Error('Gemini Live returned no output transcription.');
    console.log(`Mentor Live real smoke passed (${audioChunks} audio chunks).`);
  } finally {
    try { session?.sendRealtimeInput({ audioStreamEnd: true }); } catch {}
    try { session?.close(); } catch {}
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
