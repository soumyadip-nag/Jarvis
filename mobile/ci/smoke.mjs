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
// "Hey Jarvis": the service starts, fetches its models and listens (nobody speaks to the emulator).
console.log("startWakeWord:", await native("startWakeWord"));
await new Promise((r) => setTimeout(r, 20000));
console.log("wakeWordStatus after 20s:", await native("wakeWordStatus"));
console.log("takeWake:", await native("takeWake"));
console.log("stopWakeWord:", await native("stopWakeWord"));
// Phone controls and notifications (no notification access on the emulator, so replies say so).
console.log("inboxSummary:", await native("inboxSummary"));
console.log("phoneAction volume:", await native("phoneAction", { action: { type: "phone_control", control: "volume", level: 40 } }));
console.log("phoneAction torch:", await native("phoneAction", { action: { type: "phone_control", control: "torch_on" } }));
console.log("phoneAction pause:", await native("phoneAction", { action: { type: "phone_control", control: "pause" } }));
console.log("phoneAction reply:", await native("phoneAction", { action: { type: "reply_message", to: "Rahul", text: "hi" } }));
// Working inside apps: read Jarvis's own screen, open Settings, read that, scroll, and come back.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
console.log("agentStatus:", await native("agentStatus"));
console.log("screen (Jarvis):", await native("screenSnapshot"));
console.log("agentAct open Settings:", await native("agentAct", { step: { action: "open_app", name: "Settings" } }));
await wait(3000);
console.log("screen (Settings):", await native("screenSnapshot"));
console.log("agentAct scroll:", await native("agentAct", { step: { action: "scroll", direction: "down" } }));
console.log("agentAct open a banking app:", await native("agentAct", { step: { action: "open_app", name: "Pay" } }));
console.log("phoneAction task without a sign-in:", await native("phoneAction", { action: { type: "phone_task", goal: "open settings" } }));
console.log("agentAct back to Jarvis:", await native("agentAct", { step: { action: "open_app", name: "Jarvis" } }));
await wait(2000);
console.log("checkUpdate:", await native("checkUpdate"));
console.log("installUpdate:", await native("installUpdate")); // should end at Android's install prompt
socket.close();
