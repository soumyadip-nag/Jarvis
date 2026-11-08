// The Jarvis voice for phones: the same Microsoft neural voice and settings as the desktop app.
// This is an unofficial free service, so the app falls back to the phone's own voice if it stops working.
import { Buffer } from "node:buffer";
import { connect } from "./edgeVoice.mjs";
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
  const session = await connect({ voice: VOICE(), timeoutMs: TIMEOUT_MS });
  try {
    const audio = await session.speak(escapeForSpeech(text), { rate: RATE, pitch: PITCH });
    if (!audio.length) throw new Error("Voice service returned no audio");
    return Buffer.from(audio);
  } finally {
    session.close();
  }
}

/**
 * Voices several sentences over one connection. Connecting is most of the time a sentence takes (about a second,
 * against a third of a second once connected), so this starts connecting straight away, while the reply is still
 * being written. Each say() resolves to MP3 bytes, or null if the voice failed, so the phone can fetch it instead.
 */
export function voiceSession() {
  const connected = connect({ voice: VOICE(), timeoutMs: TIMEOUT_MS });
  connected.catch(() => {});
  let queue = connected;
  let broken = false;
  return {
    say(text) {
      const result = queue.then(async () => {
        if (broken) return null;
        const audio = await (await connected).speak(escapeForSpeech(text), { rate: RATE, pitch: PITCH });
        return audio.length ? Buffer.from(audio) : null;
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
