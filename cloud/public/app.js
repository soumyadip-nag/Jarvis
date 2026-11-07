// J.A.R.V.I.S. web app (installable on Android). Talks to the shared cloud brain at /api.
(() => {
  "use strict";
  const DEVICE = "phone";
  // In the Android app, the native side does what a WebView can't: contacts, calls, listening, speaking.
  const Native = window.Capacitor?.isNativePlatform?.()
    ? (method, args = {}) => window.Capacitor.nativePromise("JarvisNative", method, args)
    : null;
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("jarvis." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { localStorage.setItem("jarvis." + k, JSON.stringify(v)); },
    del(k) { localStorage.removeItem("jarvis." + k); },
  };
  const defaultLang = ["en-IN", "en-GB", "en-US", "hi-IN"].includes(navigator.language) ? navigator.language : "en-IN";
  const settings = Object.assign(
    { voice: "jarvis", rate: 0.95, pitch: 0.85, autoSpeak: true, autoOpen: true, confirmCalls: false, lang: defaultLang },
    store.get("settings", {}),
  );
  const saveSettings = () => store.set("settings", settings);

  let token = store.get("token", null);
  let lastTs = 0;
  let busy = false;
  let latestRequest = 0;
  let contacts = store.get("contacts", []);
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

  // ───────── calling: the phone's own contacts, kept only on this phone ─────────
  const telUrl = (tel) => "tel:" + String(tel).replace(/[^\d+]/g, "");
  const contactsFromPicker = (picked) => picked
    .map((c) => ({ name: (c.name || [])[0] || "", tel: (c.tel || [])[0] || "" }))
    .filter((c) => c.name && c.tel);

  async function refreshNativeContacts() {
    try {
      contacts = (await Native("getContacts")).contacts;
    } catch (e) {
      systemMessage(e.message);
    }
    renderContactsInfo();
  }

  /** Calling by voice on the phone: direct in the app unless confirmation is on; the dialler in a browser. */
  function placeCall(contact) {
    const dial = () => openUrl(telUrl(contact.tel));
    if (Native) {
      if (!settings.confirmCalls) Native("call", { number: contact.tel }).catch(dial);
    } else if (settings.autoOpen) {
      dial();
    }
  }

  function renderContactsInfo() {
    if (Native) {
      $("#import-contacts").hidden = true;
      $("#clear-contacts").hidden = true;
      $("#contacts-info").textContent = `${contacts.length} found on this phone, including WhatsApp contacts where Android lists them. They are never uploaded.`;
      return;
    }
    const supported = "contacts" in navigator && "select" in navigator.contacts;
    $("#import-contacts").hidden = !supported;
    $("#clear-contacts").hidden = !contacts.length;
    $("#contacts-info").textContent = !supported
      ? "This browser can't read your contacts. Use Chrome on your Pixel."
      : contacts.length
        ? `${contacts.length} imported. Numbers stay on this phone and are never uploaded. Import again to add more.`
        : "Choose the people Jarvis can call. Numbers stay on this phone and are never uploaded.";
  }

  async function importContacts() {
    try {
      const picked = await navigator.contacts.select(["name", "tel"], { multiple: true });
      const merged = new Map(contacts.map((c) => [c.name, c]));
      for (const c of contactsFromPicker(picked)) merged.set(c.name, c);
      contacts = [...merged.values()];
      store.set("contacts", contacts);
    } catch (e) {
      systemMessage("Couldn't open your contacts: " + e.message);
    }
    renderContactsInfo();
  }

  function callLink(contact) {
    const link = document.createElement("a");
    link.className = "action";
    link.href = telUrl(contact.tel);
    link.textContent = `📞 ${contact.name}`;
    return link;
  }

  function callEl(a) {
    const box = document.createElement("div");
    box.className = "call-options";
    const matches = JarvisContacts.rank(a.name, contacts);
    for (const contact of matches) box.append(callLink(contact));
    if (!matches.length && "contacts" in navigator) {
      const choose = document.createElement("button");
      choose.className = "action";
      choose.textContent = "📇 Choose from contacts";
      choose.onclick = async () => {
        const [contact] = contactsFromPicker(await navigator.contacts.select(["name", "tel"]).catch(() => []));
        if (contact) { box.replaceChildren(callLink(contact)); openUrl(telUrl(contact.tel)); }
      };
      box.append(choose);
    }
    return box;
  }

  /** What Jarvis should say for a call, on this phone, where the match is actually known. */
  function callOutcome(name) {
    const matches = JarvisContacts.rank(name, contacts);
    const best = JarvisContacts.bestMatch(matches);
    if (best) return { contact: best, say: `Calling ${best.name}.` };
    if (matches.length) return { say: `I found more than one match for ${name}, sir. Which one?` };
    return { say: `I can't find ${name} in your imported contacts, sir.` };
  }

  function actionEl(a) {
    if (a.type === "image") return imageEl(a);
    if (a.type === "call_contact" && !a.queued) return callEl(a);
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
    // Dialler, SMS and app links: a real link click also works for Android's handling of tel:.
    const link = document.createElement("a");
    link.href = url;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  }

  // ───────── voice output ─────────
  let voices = [];
  function loadVoices(list) {
    voices = (list || window.speechSynthesis?.getVoices() || []).filter((v) => v.lang.toLowerCase().startsWith("en"));
    const select = $("#voice-select");
    select.innerHTML = "<option value='jarvis'>Jarvis (same voice as the laptop)</option>";
    for (const v of voices) {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = `${v.name} (${v.lang})`;
      select.append(o);
    }
    if (settings.voice !== "jarvis" && !voices.some((v) => v.name === settings.voice)) {
      const gb = voices.filter((v) => /en[-_]GB/i.test(v.lang));
      const pick = gb.find((v) => /male|ryan|thomas|daniel|george/i.test(v.name) && !/female/i.test(v.name)) || gb[0] || voices[0];
      settings.voice = pick?.name || null;
    }
    select.value = settings.voice || "jarvis";
  }

  const sentences = (t) => t.split(/(?<=[.!?])\s+/).filter(Boolean);

  // ───────── the Jarvis voice: generated by the server, with the desktop app's effects rebuilt in Web Audio ─────────
  let audioContext = null;
  let voiceInput = null;
  let voiceSource = null;
  let voiceTurn = 0;

  const spokenParts = (text) => {
    const parts = sentences(text);
    return parts.length > 4 && text.length >= 250 ? [...parts.slice(0, 2), "The rest is on your screen."] : parts;
  };

  function audio() {
    if (audioContext) return audioContext;
    const Context = window.AudioContext || window.webkitAudioContext;
    audioContext = new Context();
    const c = audioContext;
    const filter = (type, frequency, gain = 0) => {
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.gain.value = gain;
      return f;
    };
    const lowCut = filter("highpass", 90);
    const chest = filter("lowshelf", 220, 2);
    const air = filter("highshelf", 6500, 2.5);
    const compressor = c.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.12;
    lowCut.connect(chest).connect(air).connect(compressor);

    const output = c.createGain();
    output.gain.value = 1.12;
    output.connect(c.destination);
    compressor.connect(output);

    // A touch of chorus
    const delay = c.createDelay(0.05);
    delay.delayTime.value = 0.007;
    const wobble = c.createOscillator();
    wobble.frequency.value = 0.35;
    const depth = c.createGain();
    depth.gain.value = 0.0008;
    wobble.connect(depth).connect(delay.delayTime);
    wobble.start();
    const chorusLevel = c.createGain();
    chorusLevel.gain.value = 0.12;
    compressor.connect(delay).connect(chorusLevel).connect(output);

    // A very short room
    const length = Math.floor(c.sampleRate * 0.25);
    const impulse = c.createBuffer(1, length, c.sampleRate);
    const samples = impulse.getChannelData(0);
    for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    const room = c.createConvolver();
    room.buffer = impulse;
    const roomLevel = c.createGain();
    roomLevel.gain.value = 0.07;
    compressor.connect(room).connect(roomLevel).connect(output);

    voiceInput = lowCut;
    return audioContext;
  }

  async function speakJarvis(text) {
    const turn = ++voiceTurn;
    setState("speaking", "Speaking");
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ text: spokenParts(text).join(" ").slice(0, 1500) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Voice HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      if (turn !== voiceTurn) return;
      const c = audio();
      // Browsers only allow sound after a tap; don't wait forever if it stays blocked.
      await Promise.race([c.resume(), new Promise((resolve) => setTimeout(resolve, 1000))]);
      if (c.state !== "running") throw new Error("Audio is blocked until the screen is tapped");
      const decoded = await c.decodeAudioData(bytes);
      if (turn !== voiceTurn) return;
      await new Promise((resolve) => {
        const source = c.createBufferSource();
        source.buffer = decoded;
        source.connect(voiceInput);
        source.onended = resolve;
        voiceSource = source;
        source.start();
      });
    } finally {
      if (turn === voiceTurn && state === "speaking") setState("idle", "Awaiting your command");
    }
  }

  async function speak(text) {
    if (!settings.autoSpeak) return;
    if (settings.voice === "jarvis") {
      const turn = voiceTurn + 1;
      try {
        return await speakJarvis(text);
      } catch (e) {
        console.warn("Falling back to the phone's voice:", e.message);
        if (turn !== voiceTurn) return; // the user moved on while it was failing
      }
    }
    return speakSystem(text);
  }

  function speakNative(text) {
    if (!settings.autoSpeak) return Promise.resolve();
    const parts = spokenParts(text);
    setState("speaking", "Speaking");
    return Native("speak", { text: parts.join(" "), rate: settings.rate, pitch: settings.pitch, voice: settings.voice })
      .catch(() => {})
      .finally(() => { if (state === "speaking") setState("idle", "Awaiting your command"); });
  }

  function speakSystem(text) {
    if (Native) return speakNative(text);
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
    voiceTurn++;
    try { voiceSource?.stop(); } catch {}
    voiceSource = null;
    if (Native) Native("stopSpeaking").catch(() => {});
    else window.speechSynthesis?.cancel();
    if (state === "speaking") setState("idle", "Awaiting your command");
  }

  // ───────── voice input ─────────
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // ───────── experiment: can Jarvis talk on a normal call through the speaker? ─────────
  async function runCallTest() {
    const number = $("#call-test-number").value.trim();
    const out = $("#call-test-result");
    if (!/^[+\d][\d\s()-]{2,}$/.test(number)) { out.textContent = "Enter a phone number first."; return; }
    if (!confirm(`Call ${number} now? Jarvis will speak on speaker and record for up to a minute.`)) return;

    stopSpeaking();
    const button = $("#call-test-start");
    button.disabled = true;
    out.textContent = "Calling. Tap the notification when they answer.";
    const message = "Hello, this is Jarvis, an A I assistant calling on behalf of Ushnish. This is a test call and this call is being recorded. Please say a few words after this message.";
    try {
      const r = await Native("startCallTest", { number, message });
      const peaks = r.loudestPerSecond || [];
      const loudest = peaks.length ? Math.max(...peaks) : 0;
      const verdict = r.recordError ? `The mic failed: ${r.recordError}`
        : r.silencedByAndroid ? "Android silenced the mic during the call."
        : loudest < 200 ? "The mic heard almost nothing."
        : "The mic was working during the call.";
      out.replaceChildren();
      const line = (text) => { const p = document.createElement("p"); p.textContent = text; out.append(p); return p; };
      line(verdict);
      line(`Speaker on: ${r.speakerOn}. Speech played: ${!!r.speechStarted}. Silenced by Android: ${r.silencedByAndroid ?? "unknown"}.`);
      line(`Loudest sound each second (0-32767): ${peaks.join(", ")}`);
      if (r.wav) {
        const player = document.createElement("audio");
        player.controls = true;
        player.style.width = "100%";
        player.src = "data:audio/wav;base64," + r.wav;
        out.append(player);
        const heard = line("Transcribing what the mic heard…");
        api("transcribe", { method: "POST", body: { audio: r.wav } })
          .then((t) => { heard.textContent = `The mic heard: "${t.text.trim() || "(no words)"}"`; })
          .catch((e) => { heard.textContent = `Couldn't transcribe it: ${e.message}`; });
      }
      line("Now ask the person: did they hear Jarvis clearly?");
    } catch (e) {
      out.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  }

  async function listenNative() {
    if (state === "listening") return;
    stopSpeaking();
    setState("listening", "Listening…");
    try {
      const { text } = await Native("listen", { lang: settings.lang });
      if (text) return send(text);
      setState("idle", "Didn't catch that");
    } catch (e) {
      setState("idle", "Awaiting your command");
      systemMessage(e.message);
    }
  }

  function listen() {
    if (busy) return;
    if (Native) return listenNative();
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
      const call = data.actions.find((a) => a.type === "call_contact" && !a.queued);
      if (call && Native) await refreshNativeContacts();
      const outcome = call && callOutcome(call.name);
      if (outcome) {
        data.reply.content = outcome.contact && Native && settings.confirmCalls ? `Tap to call ${outcome.contact.name}.` : outcome.say;
      }
      renderMessage(data.reply, { typewriter: true });
      if (outcome?.contact) placeCall(outcome.contact);
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
      } else if (cmd.type === "call_contact") {
        if (Native) await refreshNativeContacts();
        const outcome = callOutcome(cmd.name);
        renderMessage({ role: "assistant", ts: cmd.ts, content: `From your laptop: ${outcome.say}`, actions: [cmd] });
        navigator.vibrate?.(120);
        if (outcome.contact && settings.autoOpen) openUrl(telUrl(outcome.contact.tel));
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
    store.del("contacts");
    contacts = [];
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
    if (Native) refreshNativeContacts();
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

    renderContactsInfo();
    $("#import-contacts").onclick = importContacts;
    $("#clear-contacts").onclick = () => {
      if (!confirm("Forget the contacts imported on this phone?")) return;
      contacts = [];
      store.del("contacts");
      renderContactsInfo();
    };

    // settings
    loadVoices();
    if (Native) {
      Native("getVoices").then((r) => loadVoices(r.voices)).catch(() => {});
    } else if (window.speechSynthesis) {
      speechSynthesis.onvoiceschanged = () => loadVoices();
    }
    const bindRange = (id, key) => {
      const el = $("#" + id), out = $("#" + id + "-val");
      el.value = settings[key];
      out.textContent = Number(settings[key]).toFixed(2);
      el.oninput = () => { settings[key] = Number(el.value); out.textContent = settings[key].toFixed(2); saveSettings(); };
    };
    bindRange("rate", "rate");
    bindRange("pitch", "pitch");
    const showVoiceSliders = () => {
      for (const id of ["#rate", "#pitch"]) $(id).closest(".setting").hidden = settings.voice === "jarvis";
    };
    showVoiceSliders();
    $("#voice-select").onchange = (e) => { settings.voice = e.target.value; saveSettings(); showVoiceSliders(); };
    // Sound has to be unlocked by a tap before a reply can be spoken.
    document.addEventListener("pointerdown", () => { try { audio().resume(); } catch {} });
    $("#auto-speak").checked = settings.autoSpeak;
    $("#auto-speak").onchange = (e) => { settings.autoSpeak = e.target.checked; saveSettings(); };
    $("#auto-open").checked = settings.autoOpen;
    $("#auto-open").onchange = (e) => { settings.autoOpen = e.target.checked; saveSettings(); };
    $("#confirm-calls-row").hidden = !Native;
    $("#call-test").hidden = !Native;
    $("#call-test-start").onclick = runCallTest;
    $("#confirm-calls").checked = settings.confirmCalls;
    $("#confirm-calls").onchange = (e) => { settings.confirmCalls = e.target.checked; saveSettings(); };
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
