// The Jarvis voice for phones: the same Microsoft neural voice and settings as the desktop app.
// This is an unofficial free service, so the app falls back to the phone's own voice if it stops working.
const VOICE = () => process.env.JARVIS_VOICE || "en-GB-RyanNeural";
const RATE = "-4%";
const PITCH = "-2Hz";
const TIMEOUT_MS = 12_000;

export const MAX_SPEECH_CHARS = 1500;

export const escapeForSpeech = (text) => text
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

/** Returns MP3 bytes, or throws if the voice service fails or takes too long. */
export async function synthesize(text) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const tts = new MsEdgeTTS();
  try {
    const work = (async () => {
      await tts.setMetadata(VOICE(), OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(escapeForSpeech(text), { rate: RATE, pitch: PITCH });
      const chunks = [];
      await new Promise((resolve, reject) => {
        audioStream.on("data", (chunk) => chunks.push(chunk));
        audioStream.on("end", resolve);
        audioStream.on("close", resolve);
        audioStream.on("error", reject);
      });
      return Buffer.concat(chunks);
    })();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Voice service timed out")), TIMEOUT_MS));
    const audio = await Promise.race([work, timeout]);
    if (!audio.length) throw new Error("Voice service returned no audio");
    return audio;
  } finally {
    try { tts.close(); } catch {}
  }
}

/**
 * Voices several sentences over one connection. Connecting is most of the time a sentence takes (about a second,
 * against a third of a second once connected), so this starts connecting straight away, while the reply is still
 * being written. Each say() resolves to MP3 bytes, or null if the voice failed, so the phone can fetch it instead.
 */
export function voiceSession() {
  let queue = (async () => {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOICE(), OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    return tts;
  })();
  const connected = queue;
  connected.catch(() => {});
  let broken = false;
  return {
    say(text) {
      const result = queue.then(async () => {
        if (broken) return null;
        const tts = await connected;
        const { audioStream } = tts.toStream(escapeForSpeech(text), { rate: RATE, pitch: PITCH });
        const chunks = [];
        const done = new Promise((resolve, reject) => {
          audioStream.on("data", (chunk) => chunks.push(chunk));
          audioStream.on("end", resolve);
          audioStream.on("close", resolve);
          audioStream.on("error", reject);
        });
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Voice service timed out")), TIMEOUT_MS));
        await Promise.race([done, timeout]);
        return chunks.length ? Buffer.concat(chunks) : null;
      }).catch((e) => {
        broken = true; // one failure means the connection can't be trusted for the rest
        console.warn("voice failed:", e.message);
        return null;
      });
      queue = result;
      return result;
    },
    async close() {
      await queue.catch(() => {});
      try { (await connected).close(); } catch {}
    },
  };
}
