// Runs inside the emulator's WebView through its debugging port and reports what the native plugin does.
const pages = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = pages.find((p) => p.type === "page");
if (!page) throw new Error("No WebView page found");
console.log("page url:", page.url);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0;
const waiting = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
};
const evaluate = (expression) => new Promise((resolve) => {
  const id = ++nextId;
  waiting.set(id, (m) => resolve(m.result?.result?.value ?? JSON.stringify(m.result ?? m)));
  socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
});
const native = (method, args = {}) => evaluate(
  `Promise.race([
     Capacitor.nativePromise("JarvisNative", ${JSON.stringify(method)}, ${JSON.stringify(args)}).then((r) => JSON.stringify(r)),
     new Promise((r) => setTimeout(() => r("no answer after 20s"), 20000)),
   ]).catch((e) => "ERROR " + e.message)`,
);

console.log("native platform:", await evaluate("String(window.Capacitor && Capacitor.isNativePlatform())"));
console.log("app script has native support:", await evaluate(`fetch("/app.js").then((r) => r.text()).then((t) => String(t.includes("JarvisNative")))`));
console.log("web speech in this WebView:", await evaluate(`String(!!(window.webkitSpeechRecognition || window.SpeechRecognition)) + " / " + String(!!window.speechSynthesis)`));
console.log("getContacts:", await native("getContacts"));
const voices = await native("getVoices");
console.log("getVoices:", String(voices).slice(0, 300));
console.log("speak:", await native("speak", { text: "All systems are online.", rate: 0.95, pitch: 0.85 }));
console.log("listen:", await native("listen", { lang: "en-IN" }));
console.log("call:", await native("call", { number: "+15551234567" }));

// The call test on the emulator's fake line: nobody answers, so it starts by itself after 25 seconds.
await new Promise((r) => setTimeout(r, 6000));
console.log("call test:", await evaluate(
  `Promise.race([
     Capacitor.nativePromise("JarvisNative", "startCallTest", { number: "+15551234567", message: "This is a test." })
       .then((r) => { const wavLength = (r.wav || "").length; delete r.wav; return JSON.stringify({ ...r, wavLength }); }),
     new Promise((r) => setTimeout(() => r("no answer after 90s"), 90000)),
   ]).catch((e) => "ERROR " + e.message)`,
));
socket.close();
