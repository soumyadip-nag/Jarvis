// A small client for Microsoft Edge's free read-aloud voices, the same service and messages as the msedge-tts
// package, but over the WebSocket of whichever runtime this is: Node's built-in one, or a Cloudflare Worker's
// (which connects with fetch and an Upgrade header). msedge-tts needs Node's "ws" package, which Workers can't run.
import { hashSecMsGecV2 } from "msedge-tts/dist/SecMsGec.js";

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const URL_BASE = "speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
};
const AUDIO_MARKER = new TextEncoder().encode("Path:audio\r\n");

const randomHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

async function address(scheme) {
  // The service checks a token made from the time, rounded to five minutes, as Edge itself does.
  const seconds = Math.floor(Date.now() / 1000) + 11644473600;
  const ticks = (seconds - (seconds % 300)) * 10000000;
  const gec = await hashSecMsGecV2(`${ticks}${TOKEN}`);
  return `${scheme}://${URL_BASE}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=2-143.0.3650.96&ConnectionId=${randomHex(16)}`;
}

/** Opens a WebSocket with the headers the service wants, in a Worker or in Node. */
async function openSocket() {
  if (typeof WebSocketPair !== "undefined") {
    const res = await fetch(await address("https"), { headers: { ...HEADERS, Upgrade: "websocket" } });
    if (!res.webSocket) throw new Error(`Voice service refused the connection (HTTP ${res.status})`);
    res.webSocket.accept();
    return res.webSocket;
  }
  const socket = new WebSocket(await address("wss"), { headers: HEADERS });
  socket.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Voice service connection failed")), { once: true });
  });
  return socket;
}

function indexOf(bytes, marker) {
  outer: for (let i = 0; i <= bytes.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
    return i;
  }
  return -1;
}

/** The audio in one binary message: Node gives an ArrayBuffer, a Worker gives a Blob. */
async function audioIn(data) {
  const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : await data.arrayBuffer());
  const at = indexOf(bytes, AUDIO_MARKER);
  return at === -1 ? new Uint8Array(0) : bytes.subarray(at + AUDIO_MARKER.length);
}

/**
 * One connection that can voice several pieces of text, one after another.
 * speak(text) resolves to the MP3 bytes as a Uint8Array.
 */
export async function connect({ voice, format = "audio-24khz-48kbitrate-mono-mp3", timeoutMs = 12000 }) {
  const socket = await openSocket();
  const locale = voice.split("-").slice(0, 2).join("-");
  let current = null; // { id, pieces, resolve, reject, timer }

  const finish = (error, audio) => {
    if (!current) return;
    clearTimeout(current.timer);
    const done = current;
    current = null;
    if (error) done.reject(error);
    else done.resolve(audio);
  };

  socket.addEventListener("message", (event) => {
    if (!current) return;
    if (typeof event.data !== "string") {
      current.pieces.push(audioIn(event.data));
      return;
    }
    if (event.data.includes(`X-RequestId:${current.id}`) && event.data.includes("Path:turn.end")) {
      // Reading a Blob takes a moment, so wait for every piece, in order, before putting them together.
      const request = current;
      Promise.all(request.pieces).then((pieces) => {
        if (current !== request) return;
        const total = pieces.reduce((n, p) => n + p.length, 0);
        if (!total) return finish(new Error("Voice service sent no audio"));
        const audio = new Uint8Array(total);
        let at = 0;
        for (const p of pieces) { audio.set(p, at); at += p.length; }
        finish(null, audio);
      }, (error) => finish(error));
    }
  });
  socket.addEventListener("close", () => finish(new Error("Voice service closed the connection")));
  socket.addEventListener("error", () => finish(new Error("Voice service connection failed")));

  socket.send(
    "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
      JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" }, outputFormat: format } } } }),
  );

  return {
    /** `text` must already be escaped for XML. */
    speak(text, { rate = "+0%", pitch = "+0Hz" } = {}) {
      if (current) return Promise.reject(new Error("One piece of speech at a time"));
      return new Promise((resolve, reject) => {
        const id = randomHex(16);
        current = { id, pieces: [], resolve, reject, timer: setTimeout(() => finish(new Error("Voice service timed out")), timeoutMs) };
        socket.send(
          `X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n` +
            `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">` +
            `<voice name="${voice}"><prosody pitch="${pitch}" rate="${rate}" volume="+0%">${text}</prosody></voice></speak>`,
        );
      });
    },
    close() {
      try { socket.close(); } catch {}
    },
  };
}
