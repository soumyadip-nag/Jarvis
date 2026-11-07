// J.A.R.V.I.S. web app (installable on Android). Talks to the shared cloud brain at /api.
(() => {
  "use strict";
  const DEVICE = "phone";
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("jarvis." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { localStorage.setItem("jarvis." + k, JSON.stringify(v)); },
    del(k) { localStorage.removeItem("jarvis." + k); },
  };
  const defaultLang = ["en-IN", "en-GB", "en-US", "hi-IN"].includes(navigator.language) ? navigator.language : "en-IN";
  const settings = Object.assign(
    { voice: null, rate: 0.95, pitch: 0.85, autoSpeak: true, autoOpen: true, lang: defaultLang },
    store.get("settings", {}),
  );
  const saveSettings = () => store.set("settings", settings);

  let token = store.get("token", null);
  let lastTs = 0;
  let busy = false;
  let latestRequest = 0;
  let state = "booting";
  let lastActivity = Date.now();
  let syncTimer = null;
  let recognition = null;
  const seen = new Set();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const STATE_TEXT = {
    booting: "INITIALISING", idle: "STANDING BY", listening: "LISTENING",
    thinking: "PROCESSING", speaking: "RESPONDING", offline: "OFFLINE",
  };
  const STATE_COLOR = {
    booting: "#5a8caa", idle: "#29d0ff", listening: "#40ffc8", thinking: "#ffb02e", speaking: "#50b4ff", offline: "#ff4848",
  };
  const CHIPS = [
    "What's the news today?",
    "Open YouTube",
    "Play some lo-fi music",
    "What do you remember about me?",
    "Open Spotify on my laptop",
    "Tell me a joke",
  ];

  // ───────── API ─────────
  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch("/api/" + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "login") { logout(); throw new Error("Session expired, please sign in again."); }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ───────── state / HUD ─────────
  let reactor;
  function setState(s, status) {
    state = s;
    reactor?.setState(s);
    $("#state-label").textContent = STATE_TEXT[s] || s.toUpperCase();
    $("#state-label").style.color = STATE_COLOR[s] || STATE_COLOR.idle;
    if (status !== undefined) $("#status-label").textContent = status;
    $("#send").disabled = busy;
    $("#mic").classList.toggle("active", s === "listening");
    document.querySelectorAll(".chip").forEach((c) => (c.disabled = busy));
  }

  // ───────── chat rendering ─────────
  const chatEl = () => $("#chat");
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const scrollDown = () => { chatEl().scrollTop = chatEl().scrollHeight; };

  /** Images need the login token, so they are fetched by script rather than with a plain <img src>. */
  function imageEl(a) {
    const link = document.createElement("a");
    link.className = "gen-image";
    link.title = "Tap to save";
    link.download = `jarvis-${a.id}.jpg`;
    const img = document.createElement("img");
    img.alt = a.label || "Generated image";
    link.append(img);
    fetch("/api/images/" + encodeURIComponent(a.id), { headers: { Authorization: "Bearer " + token } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        img.onload = scrollDown;
        img.src = url;
        link.href = url;
      })
      .catch(() => { link.textContent = "Couldn't load this image."; });
    return link;
  }

  function actionEl(a) {
    if (a.type === "image") return imageEl(a);
    if (a.type === "open_url" && !a.queued) {
      const link = document.createElement("a");
      link.className = "action";
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "↗ " + a.label;
      return link;
    }
    const span = document.createElement("span");
    span.className = "action queued";
    span.textContent = a.queued
      ? `⇢ Sent to ${a.device}: ${a.label}`
      : `💻 ${a.label}`;
    return span;
  }

  function renderMessage(m, { typewriter = false } = {}) {
    if (m.id && seen.has(m.id)) return null;
    if (m.id) seen.add(m.id);
    if (m.ts) lastTs = Math.max(lastTs, m.ts);
    $(".empty")?.remove();

    const el = document.createElement("div");
    el.className = "msg " + m.role;
    const meta = document.createElement("div");
    meta.className = "meta";
    const who = m.role === "user" ? `YOU · ${m.device === DEVICE ? "PHONE" : (m.device || "").toUpperCase()}`
      : m.role === "assistant" ? "JARVIS" : "SYSTEM";
    meta.textContent = `${who}   ${time(m.ts || Date.now())}`;
    const body = document.createElement("div");
    body.className = "body";
    el.append(meta, body);
    for (const a of m.actions || []) el.append(actionEl(a));
    chatEl().append(el);

    if (typewriter) {
      let i = 0;
      const step = Math.max(2, Math.floor(m.content.length / 60));
      const tick = () => {
        i += step;
        body.textContent = m.content.slice(0, i);
        scrollDown();
        if (i < m.content.length) requestAnimationFrame(tick);
      };
      tick();
    } else {
      body.textContent = m.content;
    }
    scrollDown();
    return el;
  }

  const systemMessage = (text) => renderMessage({ role: "system", content: text, ts: Date.now() });

  // ───────── actions on this phone ─────────
  function openUrl(url) {
    if (/^https?:/i.test(url)) {
      const w = window.open(url, "_blank", "noopener");
      if (w) return;
    }
    window.location.href = url;
  }

  // ───────── voice output ─────────
  let voices = [];
  function loadVoices() {
    voices = (window.speechSynthesis?.getVoices() || []).filter((v) => v.lang.toLowerCase().startsWith("en"));
    const select = $("#voice-select");
    select.innerHTML = "";
    if (!voices.length) select.innerHTML = "<option value=''>Default voice</option>";
    for (const v of voices) {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = `${v.name} (${v.lang})`;
      select.append(o);
    }
    if (!settings.voice || !voices.some((v) => v.name === settings.voice)) {
      const gb = voices.filter((v) => /en[-_]GB/i.test(v.lang));
      const pick = gb.find((v) => /male|ryan|thomas|daniel|george/i.test(v.name) && !/female/i.test(v.name)) || gb[0] || voices[0];
      settings.voice = pick?.name || null;
    }
    select.value = settings.voice || "";
  }

  const sentences = (t) => t.split(/(?<=[.!?])\s+/).filter(Boolean);

  function speak(text) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!settings.autoSpeak || !synth) return resolve();
      synth.cancel();
      let parts = sentences(text);
      if (parts.length > 4 && text.length >= 250) parts = [...parts.slice(0, 2), "The rest is on your screen."];
      const voice = voices.find((v) => v.name === settings.voice);
      setState("speaking", "Speaking");
      // Some Android TTS engines never fire `onend`; don't get stuck in the speaking state.
      setTimeout(resolve, 3000 + parts.join(" ").length * 90);
      parts.forEach((p, i) => {
        const u = new SpeechSynthesisUtterance(p);
        if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = "en-GB"; }
        u.rate = settings.rate;
        u.pitch = settings.pitch;
        if (i === parts.length - 1) { u.onend = resolve; u.onerror = resolve; }
        synth.speak(u);  // queueing per sentence avoids Chrome's cut-off on long utterances
      });
    }).finally(() => { if (state === "speaking") setState("idle", "Awaiting your command"); });
  }

  function stopSpeaking() {
    window.speechSynthesis?.cancel();
    if (state === "speaking") setState("idle", "Awaiting your command");
  }

  // ───────── voice input ─────────
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listen() {
    if (busy) return;
    if (!SR) return systemMessage("Voice input isn't supported in this browser. Use Chrome on your Pixel.");
    if (recognition) { recognition.stop(); return; }
    stopSpeaking();
    let finalText = "";
    recognition = new SR();
    recognition.lang = settings.lang;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (e) => {
      let interim = "";
      for (const r of e.results) (r.isFinal ? (finalText = r[0].transcript) : (interim += r[0].transcript));
      $("#input").value = finalText || interim;
    };
    recognition.onerror = (e) => {
      if (e.error === "not-allowed") systemMessage("Microphone permission was denied. Allow it in Chrome's site settings.");
    };
    recognition.onend = () => {
      recognition = null;
      const text = (finalText || $("#input").value).trim();
      if (text) send(text);
      else setState("idle", "Didn't catch that");
    };
    setState("listening", "Listening…");
    recognition.start();
  }

  // ───────── sending ─────────
  async function send(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    busy = true;
    const request = ++latestRequest;
    stopSpeaking();
    lastActivity = Date.now();
    $("#input").value = "";
    const local = renderMessage({ role: "user", content: text, device: DEVICE, ts: Date.now() });
    setState("thinking", "Thinking");
    try {
      const data = await api("chat", { method: "POST", body: { text, tz } });
      seen.add(data.user.id);
      lastTs = Math.max(lastTs, data.user.ts);
      busy = false;
      renderMessage(data.reply, { typewriter: true });
      const toOpen = data.actions.filter((a) => a.type === "open_url" && !a.queued);
      if (settings.autoOpen && toOpen.length) openUrl(toOpen[0].url);
      await speak(data.reply.content);
    } catch (e) {
      busy = false;
      local?.classList.add("failed");
      systemMessage(e.message);
    } finally {
      // Speaking can outlast this request: a newer message may already be in flight, so only the
      // latest request may return the app to idle (and `busy` was already cleared above).
      if (request === latestRequest && !busy && state !== "speaking") setState("idle", "Awaiting your command");
    }
  }

  // ───────── sync with the other device ─────────
  function renderDevices(devices) {
    const el = $("#devices");
    el.innerHTML = "";
    for (const [name, info] of Object.entries(devices || {})) {
      const span = document.createElement("span");
      const dot = document.createElement("i");
      dot.className = "dot" + (info.online ? " on" : "");
      span.append(dot, name === DEVICE ? "Phone (this)" : name[0].toUpperCase() + name.slice(1));
      el.append(span);
    }
  }

  async function handleCommand(cmd) {
    try {
      if (cmd.type === "open_url") {
        renderMessage({
          role: "assistant", ts: cmd.ts,
          content: `From your laptop: ${cmd.label}.`,
          actions: [{ type: "open_url", url: cmd.url, label: cmd.label }],
        });
        navigator.vibrate?.(120);
        if (settings.autoOpen) openUrl(cmd.url);
      }
    } finally {
      await api(`commands/${cmd.id}/done`, { method: "POST" }).catch(() => {});
    }
  }

  async function sync() {
    clearTimeout(syncTimer);
    if (token && !document.hidden) {
      const wasBusy = busy;
      try {
        const data = await api("sync?since=" + lastTs);
        if (!busy && !wasBusy) {
          for (const m of data.messages) renderMessage(m);
          for (const c of data.commands) await handleCommand(c);
        }
        renderDevices(data.devices);
        if (state === "offline" || state === "booting") setState("idle", greeting());
      } catch (e) {
        if (token) setState("offline", "Can't reach the server");
      }
    }
    const active = Date.now() - lastActivity < 120_000;
    syncTimer = setTimeout(sync, active ? 3000 : 10000);
  }

  function greeting() {
    const h = new Date().getHours();
    return (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening") + ", sir.";
  }

  // ───────── memory view ─────────
  let memories = [];
  async function loadMemories() {
    try {
      memories = (await api("memories")).memories;
      renderMemories();
    } catch (e) { systemMessage(e.message); }
  }
  function renderMemories() {
    const q = $("#memory-search").value.toLowerCase();
    const list = $("#memory-list");
    list.innerHTML = "";
    const shown = memories.filter((m) => m.text.toLowerCase().includes(q));
    $("#memory-count").textContent = `${memories.length} item${memories.length === 1 ? "" : "s"}`;
    if (!shown.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = memories.length ? "No matches." : "Nothing yet. Talk to Jarvis and it will start learning about you.";
      list.append(li);
    }
    for (const m of shown) {
      const li = document.createElement("li");
      const text = document.createElement("div");
      text.textContent = m.text;
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = `${new Date(m.ts).toLocaleDateString()} · ${m.source}`;
      text.append(when);
      const del = document.createElement("button");
      del.textContent = "✕";
      del.ariaLabel = "Delete memory";
      del.onclick = async () => {
        if (!confirm("Forget this?\n\n" + m.text)) return;
        await api("memories/" + m.id, { method: "DELETE" });
        memories = memories.filter((x) => x.id !== m.id);
        renderMemories();
      };
      li.append(text, del);
      list.append(li);
    }
  }

  // ───────── navigation ─────────
  function showView(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
    for (const v of ["chat", "memory", "settings"]) $("#view-" + v).hidden = v !== name;
    document.body.className = "view-" + name;
    if (name === "memory") loadMemories();
    if (name === "chat") scrollDown();
  }

  // ───────── session ─────────
  function logout() {
    token = null;
    store.del("token");
    clearTimeout(syncTimer);
    $("#app").hidden = true;
    $("#login").hidden = false;
  }

  function start() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    document.body.className = "view-chat";
    $("#device-name").textContent = "Phone";
    if (!reactor) reactor = new Reactor($("#reactor"));
    setState("booting", "Connecting");
    if (!chatEl().children.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Say or type anything. Conversations from your laptop appear here too.";
      chatEl().append(empty);
    }
    sync();
  }

  // ───────── wiring ─────────
  function init() {
    new Reactor($("#login-reactor")).setState("idle");

    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      $("#login-error").textContent = "";
      try {
        const data = await api("login", { method: "POST", body: { passcode: $("#passcode").value, device: DEVICE } });
        token = data.token;
        store.set("token", token);
        $("#passcode").value = "";
        start();
      } catch (err) {
        $("#login-error").textContent = err.message;
      }
    });

    $("#composer").addEventListener("submit", (e) => { e.preventDefault(); send($("#input").value); });
    $("#mic").addEventListener("click", listen);
    $("#reactor").addEventListener("click", () => (state === "speaking" ? stopSpeaking() : listen()));
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

    const chips = $("#chips");
    for (const text of CHIPS) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = text;
      b.onclick = () => send(text);
      chips.append(b);
    }

    $("#memory-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = $("#memory-input").value.trim();
      if (!text) return;
      await api("memories", { method: "POST", body: { text } });
      $("#memory-input").value = "";
      loadMemories();
    });
    $("#memory-search").addEventListener("input", renderMemories);

    // settings
    loadVoices();
    if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;
    const bindRange = (id, key) => {
      const el = $("#" + id), out = $("#" + id + "-val");
      el.value = settings[key];
      out.textContent = Number(settings[key]).toFixed(2);
      el.oninput = () => { settings[key] = Number(el.value); out.textContent = settings[key].toFixed(2); saveSettings(); };
    };
    bindRange("rate", "rate");
    bindRange("pitch", "pitch");
    $("#voice-select").onchange = (e) => { settings.voice = e.target.value; saveSettings(); };
    $("#auto-speak").checked = settings.autoSpeak;
    $("#auto-speak").onchange = (e) => { settings.autoSpeak = e.target.checked; saveSettings(); };
    $("#auto-open").checked = settings.autoOpen;
    $("#auto-open").onchange = (e) => { settings.autoOpen = e.target.checked; saveSettings(); };
    $("#speech-lang").value = settings.lang;
    $("#speech-lang").onchange = (e) => { settings.lang = e.target.value; saveSettings(); };
    $("#test-voice").onclick = () => {
      const was = settings.autoSpeak;
      settings.autoSpeak = true;
      speak(`${greeting()} All systems are online.`).finally(() => (settings.autoSpeak = was));
    };
    $("#clear-chat").onclick = async () => {
      if (!confirm("Clear the conversation on all devices? Jarvis's memory is kept.")) return;
      await api("history", { method: "DELETE" });
      chatEl().innerHTML = "";
    };
    $("#logout").onclick = () => { if (confirm("Sign out of Jarvis on this phone?")) logout(); };

    let installPrompt = null;
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; $("#install").hidden = false; });
    $("#install").onclick = async () => { if (installPrompt) { installPrompt.prompt(); installPrompt = null; $("#install").hidden = true; } };

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { lastActivity = Date.now(); if (token) sync(); }
    });

    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

    if (token) start();
    else $("#login").hidden = false;
  }

  init();
})();
