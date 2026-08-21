'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const els = {
    join: $('#join'),
    channel: $('#channel'),
    name: $('#name'),
    code: $('#code'),
    dice: $('#dice'),
    joinBtn: $('#joinBtn'),
    joinErr: $('#joinErr'),
    chWord: $('#chWord'),
    connDot: $('#connDot'),
    shareBtn: $('#shareBtn'),
    limitBtn: $('#limitBtn'),
    muteBtn: $('#muteBtn'),
    leaveBtn: $('#leaveBtn'),
    banner: $('#banner'),
    roster: $('#roster'),
    stage: $('#stage'),
    ptt: $('#ptt'),
    pttLabel: $('#pttLabel'),
    status: $('#status'),
    speedLine: $('#speedLine'),
    meter: $('#meter'),
    toast: $('#toast'),
  };

  const WORDS = [
    'alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india',
    'juliet','kilo','lima','mike','november','oscar','papa','quebec','romeo',
    'sierra','tango','uniform','victor','whiskey','yankee','zulu','mango',
    'falcon','tiger','comet','ember','ridge','lagoon','pixel','nova','orbit',
    'cobra','panda','maple','onyx','quartz','raven','sable','topaz','umber',
    'viper','walnut','yonder','zephyr','anchor','beacon','cinder','drift',
    'eagle','flint','glacier','harbor','island','jaguar','kestrel','lantern',
    'meteor','nectar','osprey','prairie','quiver','rocket','summit','thunder',
    'utopia','vortex','willow','xenon','yeti','zenith','badger','canyon',
    'dune','ester','fjord','grotto','hazel','iris','juniper','koala','lotus',
    'mesa','nimbus','otter','pepper','quill','reef','sparrow','tundra',
    'ultra','velvet','wander','yarrow','zigzag','apollo','boulder','cricket',
    'domino','everest','fable','gizmo','hammock','igloo','jubilee','kayak',
    'lemur','mammoth','noodle','octave','pretzel','quasar','rhubarb','saturn',
    'tornado','ukulele','volcano','waffle','xylophone','yodel','zeppelin',
  ];

  const FRAME_MS = 20;
  const JITTER_S = 0.12;
  const PENDING_CAP = 50; // ~1 s of buffered speech while waiting for a grant

  const state = {
    ws: null,
    ctx: null,
    worklet: null,
    stream: null,
    remoteGain: null,
    joined: false,
    joining: false,
    closing: false,
    code: '',
    name: '',
    myId: null,
    members: [],
    speaker: null, // {id, name, tx} | null
    talk: 'idle', // idle | pending | live
    tx: 0,
    finishTx: 0, // released before the grant arrived; flush + end when granted
    pending: [],
    rxTx: 0,
    playhead: 0,
    muted: false,
    micOk: false,
    micBusy: false,
    micErr: null,
    srcNode: null,
    retry: 0,
    lastMsgAt: 0,
    lastDenied: null,
    geoOk: false,
    geoWatch: null,
    geoDenied: false,
    limitKmh: 60,
    lastFix: null,
    speedKmh: null,
    lastAlertAt: 0,
    lastGaali: null,
    wake: null,
    stats: { framesTx: 0, framesRx: 0, rxEnergy: 0 },
  };
  window.__talkie = state; // debug + e2e hook

  // ------------------------------------------------------------ small utils
  const storage = {
    get(k) {
      try { return localStorage.getItem(k) || ''; } catch { return ''; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch {}
    },
  };

  function normalizeCode(raw) {
    return (raw || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function randomWord() {
    return WORDS[(Math.random() * WORDS.length) | 0];
  }

  let toastTimer = 0;
  function toast(text) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
  }

  function banner(text, btnLabel, onBtn) {
    els.banner.textContent = '';
    els.banner.hidden = !text;
    if (!text) return;
    const span = document.createElement('span');
    span.textContent = text;
    els.banner.append(span);
    if (btnLabel) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bannerBtn';
      b.textContent = btnLabel;
      b.addEventListener('click', onBtn);
      els.banner.append(b);
    }
  }

  // In-app browsers (WhatsApp/Instagram/FB/Telegram web views) often block the mic.
  const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Telegram|Line\/|; wv\)/i.test(
    navigator.userAgent
  );

  async function copyPageLink() {
    const url = location.origin + '/' + (state.code || '');
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied — paste it in your browser');
    } catch {
      toast(url);
    }
  }

  function vibrate(ms) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch {}
  }

  function rms(pcm) {
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 4) {
      const v = pcm[i] / 32768;
      sum += v * v;
    }
    return Math.sqrt(sum / (pcm.length / 4));
  }

  function setMeter(level) {
    els.meter.style.width = Math.min(100, Math.round(level * 320)) + '%';
  }

  // ------------------------------------------------------------------ audio
  async function ensureContext() {
    if (!state.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.ctx = new AC();
      // Makeup gain + limiter so incoming voice is properly loud on phones.
      state.remoteGain = state.ctx.createGain();
      state.remoteGain.gain.value = 1.8;
      const limiter = state.ctx.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 10;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      state.remoteGain.connect(limiter);
      limiter.connect(state.ctx.destination);
      await state.ctx.audioWorklet.addModule('/worklet.js');
    }
    if (state.ctx.state !== 'running') {
      try { await state.ctx.resume(); } catch {}
    }
  }

  async function attemptMic() {
    if (state.micOk || state.micBusy) return state.micOk;
    state.micBusy = true;
    render();
    try {
      await ensureContext();
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('no mediaDevices'), { name: 'NotSupportedError' });
      }
      if (state.stream) {
        for (const t of state.stream.getTracks()) t.stop();
        state.stream = null;
      }
      // No echoCancellation: PTT is half-duplex (you never talk and play at
      // once), and the AEC constraint makes phones route playback to the
      // quiet earpiece instead of the loudspeaker.
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      state.srcNode = state.ctx.createMediaStreamSource(state.stream);
      state.worklet = new AudioWorkletNode(state.ctx, 'ptt-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      state.worklet.port.onmessage = (e) => onFrame(new Int16Array(e.data));
      // A silent sink keeps the worklet pulled by the render graph.
      const sink = state.ctx.createGain();
      sink.gain.value = 0;
      state.srcNode.connect(state.worklet);
      state.worklet.connect(sink);
      sink.connect(state.ctx.destination);
      state.micOk = true;
      state.micErr = null;
      banner('');
      if (state.joined) toast('Mic ready — hold to talk');
      return true;
    } catch (err) {
      state.micOk = false;
      state.micErr = (err && err.name) || 'Error';
      await showMicHelp();
      return false;
    } finally {
      state.micBusy = false;
      render();
    }
  }

  async function showMicHelp() {
    if (!window.isSecureContext) {
      banner('⚠️ The mic needs an https:// address — open the secure link.');
      return;
    }
    let perm = '';
    try {
      perm = (await navigator.permissions.query({ name: 'microphone' })).state;
    } catch {}
    const unsupported = state.micErr === 'NotSupportedError' || state.micErr === 'TypeError';
    if (unsupported || (IN_APP && perm !== 'granted')) {
      banner(
        IN_APP
          ? '🎙 This chat app’s built-in browser blocks the mic. Open this page in Chrome or Safari (tap ⋮ or the share icon → “Open in browser”).'
          : '🎙 This browser can’t use the mic — open the link in Chrome or Safari.',
        'Copy link',
        copyPageLink
      );
      return;
    }
    if (perm === 'denied') {
      banner(
        '🎙 Mic is blocked for this site. Android: tap the 🔒/⚙ icon by the address bar → Permissions → Microphone → Allow, then reload. iPhone: tap “aA” in the address bar → Website Settings → Microphone → Allow.'
      );
      return;
    }
    banner('🎙 Tap the big button to turn on your microphone.');
  }

  function gate(on) {
    if (state.worklet) state.worklet.port.postMessage({ active: on });
  }

  function tone(freq, dur, t0, { type = 'sine', vol = 0.08, dest = null } = {}) {
    const ctx = state.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(dest || ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  function chirp() {
    const t = state.ctx.currentTime;
    tone(880, 0.07, t);
    tone(1318, 0.07, t + 0.075);
  }

  function buzz() {
    const t = state.ctx.currentTime;
    tone(196, 0.16, t, { type: 'square', vol: 0.05 });
  }

  function rogerBeep() {
    if (state.muted || !state.ctx) return;
    const t = Math.max(state.playhead, state.ctx.currentTime) + 0.03;
    tone(988, 0.06, t, { dest: state.remoteGain, vol: 0.06 });
    tone(1319, 0.09, t + 0.07, { dest: state.remoteGain, vol: 0.06 });
  }

  // ------------------------------------------------- speed watch ("dheere chala")
  const LIMIT_STEPS = [40, 60, 80, 100, 120, 0]; // 0 = off

  function speakGaali(name) {
    try {
      // Letters/digits only, so TTS never narrates emojis or symbols.
      const spoken = (name || '').replace(/[^\p{L}\p{N} ]/gu, '').trim() || 'bhai';
      const u = new SpeechSynthesisUtterance();
      const hi = speechSynthesis.getVoices().find((v) => /^hi\b|^hi-/i.test(v.lang));
      if (hi) {
        u.voice = hi;
        u.lang = hi.lang;
        u.text = `भेंचो भेंचो ${spoken}! धीरे चला!`;
      } else {
        u.lang = 'hi-IN';
        u.text = `bhencho bhencho ${spoken}! dheere chala!`;
      }
      u.rate = 1.05;
      u.volume = 1;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {}
  }

  function gaali(name, kmh) {
    state.lastGaali = { name, kmh, at: Date.now() };
    toast(`🚨 ${name}: ${kmh} km/h — bhencho bhencho dheere chala!`);
    if (state.muted) return;
    if (state.ctx) {
      const t = state.ctx.currentTime;
      tone(392, 0.12, t, { type: 'square', vol: 0.09 });
      tone(392, 0.12, t + 0.16, { type: 'square', vol: 0.09 });
    }
    vibrate([90, 60, 90]);
    setTimeout(() => speakGaali(name), 350);
  }

  function distM(a, b) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function onFix(pos) {
    state.geoOk = true;
    const c = pos.coords;
    let kmh = null;
    if (typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0) {
      kmh = c.speed * 3.6;
    } else if (state.lastFix && c.accuracy != null && c.accuracy < 60) {
      // Some browsers give no speed; derive it from successive fixes.
      const dt = (pos.timestamp - state.lastFix.t) / 1000;
      if (dt >= 1 && dt <= 15) {
        kmh = (distM(state.lastFix, { lat: c.latitude, lon: c.longitude }) / dt) * 3.6;
      }
    }
    state.lastFix = { lat: c.latitude, lon: c.longitude, t: pos.timestamp };
    if (kmh == null || kmh > 250) return renderSpeed(null);
    renderSpeed(kmh);
    if (
      state.joined &&
      state.limitKmh &&
      kmh > state.limitKmh &&
      Date.now() - state.lastAlertAt > 15000
    ) {
      state.lastAlertAt = Date.now();
      wsSend({ t: 'overspeed', kmh: Math.round(kmh) });
    }
  }

  function startGeo() {
    if (!('geolocation' in navigator) || state.geoWatch != null) return;
    state.geoWatch = navigator.geolocation.watchPosition(
      onFix,
      (err) => {
        // Transient unavailable/timeout errors happen mid-ride; keep watching.
        if (err && err.code === 1) {
          state.geoDenied = true;
          stopGeo();
          toast('Location off — speed alerts disabled');
        }
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }

  function stopGeo() {
    if (state.geoWatch != null) {
      try { navigator.geolocation.clearWatch(state.geoWatch); } catch {}
    }
    state.geoWatch = null;
    state.geoOk = false;
    state.lastFix = null;
    renderSpeed(null);
  }

  function renderSpeed(kmh) {
    state.speedKmh = kmh;
    els.speedLine.textContent =
      kmh != null && kmh > 3 ? `📍 ${Math.round(kmh)} km/h` : '';
  }

  function renderLimit() {
    els.limitBtn.textContent = state.limitKmh ? `🚦${state.limitKmh}` : '🚦off';
  }

  function cycleLimit() {
    if (!state.joined || !state.ws || state.ws.readyState !== 1) return;
    const i = LIMIT_STEPS.indexOf(state.limitKmh);
    const next = LIMIT_STEPS[(i + 1) % LIMIT_STEPS.length];
    state.geoDenied = false; // a manual tap is a fresh chance to allow location
    if (next && state.geoWatch == null) startGeo();
    // The server owns the limit; everyone (incl. us) updates on its broadcast.
    wsSend({ t: 'limit', kmh: next });
  }

  // ------------------------------------------------------------ transmit path
  function packFrame(tx, pcm) {
    const buf = new ArrayBuffer(4 + pcm.byteLength);
    new DataView(buf).setUint32(0, tx, true);
    new Int16Array(buf, 4).set(pcm);
    return buf;
  }

  function wsSend(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  function onFrame(pcm) {
    if (state.talk === 'pending') {
      state.pending.push(pcm);
      if (state.pending.length > PENDING_CAP) state.pending.shift();
    } else if (state.talk === 'live' && state.ws && state.ws.readyState === 1) {
      state.ws.send(packFrame(state.tx, pcm));
      state.stats.framesTx++;
    } else {
      return;
    }
    setMeter(rms(pcm));
  }

  async function startTalk() {
    if (!state.joined || state.talk !== 'idle') return;
    if (!state.micOk) {
      attemptMic();
      return;
    }
    if (state.speaker && state.speaker.id !== state.myId) {
      state.lastDenied = { id: state.speaker.id, name: state.speaker.name };
      busyFeedback(state.speaker.name);
      return;
    }
    await ensureContext();
    state.talk = 'pending';
    state.tx = ((Math.random() * 0xffffffff) >>> 0) || 1;
    state.finishTx = 0;
    state.pending = [];
    gate(true);
    wsSend({ t: 'ptt-start', tx: state.tx });
    render();
  }

  function stopTalk() {
    if (state.talk === 'idle') return;
    gate(false);
    setMeter(0);
    if (state.talk === 'pending') {
      // Grant hasn't arrived yet; remember so a quick tap still transmits.
      state.finishTx = state.tx;
    } else {
      wsSend({ t: 'ptt-end', tx: state.tx });
      if (state.speaker && state.speaker.id === state.myId) state.speaker = null;
    }
    state.talk = 'idle';
    state.tx = 0;
    render();
  }

  function busyFeedback(name) {
    buzz();
    vibrate(60);
    els.ptt.classList.add('shake');
    setTimeout(() => els.ptt.classList.remove('shake'), 350);
    toast(`Channel busy — ${name || 'someone'} is talking`);
  }

  // ------------------------------------------------------------- receive path
  function handleAudio(buf) {
    if (buf.byteLength < 6) return;
    const dv = new DataView(buf);
    const tx = dv.getUint32(0, true);
    if (!state.speaker || tx !== state.rxTx) return;
    state.stats.framesRx++;
    if (!state.ctx) return;
    const n = (buf.byteLength - 4) >> 1;
    const audio = state.ctx.createBuffer(1, n, 16000);
    const chd = audio.getChannelData(0);
    const pcm = new Int16Array(buf, 4, n);
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = pcm[i] / 32768;
      chd[i] = v;
      energy += Math.abs(v);
    }
    state.stats.rxEnergy += energy;
    if (state.muted) return;
    const now = state.ctx.currentTime;
    if (!state.playhead || state.playhead < now + 0.02) {
      state.playhead = now + JITTER_S;
    }
    const src = state.ctx.createBufferSource();
    src.buffer = audio;
    src.connect(state.remoteGain);
    src.start(state.playhead);
    state.playhead += audio.duration;
    setMeter(energy / n * 2.5);
  }

  // -------------------------------------------------------------- ws control
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  function connect() {
    state.joining = true;
    setConn('connecting');
    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      state.lastMsgAt = Date.now();
      ws.send(JSON.stringify({ t: 'join', room: state.code, name: state.name }));
    };

    ws.onmessage = (ev) => {
      state.lastMsgAt = Date.now();
      if (ev.data instanceof ArrayBuffer) return handleAudio(ev.data);
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleControl(msg);
    };

    ws.onclose = () => {
      if (ws !== state.ws) return;
      state.ws = null;
      gate(false);
      if (state.talk !== 'idle') {
        state.talk = 'idle';
        state.tx = 0;
        setMeter(0);
      }
      state.speaker = null;
      state.playhead = 0;
      if (state.closing) {
        state.closing = false;
        state.joined = false;
        state.joining = false;
        showJoin();
        return;
      }
      if (state.joined || state.joining) {
        setConn('down');
        render();
        const delay = Math.min(1000 * 2 ** state.retry, 10000) + Math.random() * 400;
        state.retry++;
        setTimeout(() => {
          if ((state.joined || state.joining) && !state.ws) connect();
        }, delay);
      }
    };

    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  function handleControl(msg) {
    switch (msg.t) {
      case 'joined': {
        state.myId = msg.id;
        state.code = msg.room;
        state.joined = true;
        state.joining = false;
        state.retry = 0;
        setConn('up');
        showChannel();
        keepAwake();
        if (state.limitKmh) startGeo();
        break;
      }
      case 'roster': {
        state.members = msg.members || [];
        if (typeof msg.limit === 'number' && msg.limit !== state.limitKmh) {
          state.limitKmh = msg.limit;
          renderLimit();
        }
        const sp = msg.speaker;
        if (sp && sp.id !== state.myId) {
          if (!state.speaker || state.speaker.id !== sp.id || state.rxTx !== sp.tx) {
            state.speaker = sp;
            state.rxTx = sp.tx;
            state.playhead = 0;
          }
        } else if (!sp && state.speaker && state.speaker.id !== state.myId) {
          state.speaker = null;
          state.rxTx = 0;
        }
        render();
        break;
      }
      case 'peer-join':
        if (msg.id !== state.myId) toast(`${msg.name} joined`);
        break;
      case 'peer-leave':
        toast(`${msg.name} left`);
        break;
      case 'granted': {
        if (state.finishTx && msg.tx === state.finishTx) {
          // Released before the grant arrived — flush the buffer, then end.
          for (const f of state.pending) {
            if (state.ws && state.ws.readyState === 1) {
              state.ws.send(packFrame(state.finishTx, f));
              state.stats.framesTx++;
            }
          }
          state.pending = [];
          wsSend({ t: 'ptt-end', tx: state.finishTx });
          state.finishTx = 0;
          break;
        }
        if (state.talk !== 'pending' || msg.tx !== state.tx) break;
        state.talk = 'live';
        state.speaker = { id: state.myId, name: state.name, tx: state.tx };
        for (const f of state.pending) {
          state.ws.send(packFrame(state.tx, f));
          state.stats.framesTx++;
        }
        state.pending = [];
        chirp();
        vibrate(30);
        render();
        break;
      }
      case 'denied': {
        state.lastDenied = msg.by || null;
        if (state.talk !== 'idle') {
          gate(false);
          state.talk = 'idle';
          state.tx = 0;
          state.pending = [];
          setMeter(0);
        }
        state.finishTx = 0;
        busyFeedback(msg.by && msg.by.name);
        render();
        break;
      }
      case 'ptt-start': {
        state.speaker = { id: msg.id, name: msg.name, tx: msg.tx };
        state.rxTx = msg.tx;
        state.playhead = 0;
        render();
        break;
      }
      case 'ptt-end': {
        if (!state.speaker || msg.id !== state.speaker.id) break;
        const remote = msg.id !== state.myId;
        state.speaker = null;
        state.rxTx = 0;
        if (remote) rogerBeep();
        else if (state.talk !== 'idle') {
          // Server force-released us (timeout) — stop transmitting.
          gate(false);
          state.talk = 'idle';
          state.tx = 0;
        }
        state.playhead = 0;
        setMeter(0);
        render();
        break;
      }
      case 'error': {
        state.joining = false;
        if (!state.joined) {
          state.closing = true;
          try { state.ws && state.ws.close(); } catch {}
          showJoin();
          els.joinErr.textContent = msg.message || 'Could not join.';
          els.joinErr.hidden = false;
        } else {
          toast(msg.message || 'Error');
        }
        break;
      }
      case 'overspeed':
        gaali(msg.name, msg.kmh);
        break;
      case 'limit': {
        state.limitKmh = msg.kmh;
        renderLimit();
        const who = (msg.by && msg.by.name) || 'Channel';
        toast(`🚦 ${who} set the limit: ${msg.kmh ? msg.kmh + ' km/h' : 'off'}`);
        if (msg.kmh && state.geoWatch == null && !state.geoDenied) startGeo();
        break;
      }
      case 'pong':
        break;
    }
  }

  // Keepalive + dead-connection watchdog.
  setInterval(() => {
    if (state.ws && state.ws.readyState === 1) {
      wsSend({ t: 'ping' });
      if (Date.now() - state.lastMsgAt > 35000) {
        try { state.ws.close(); } catch {}
      }
    }
  }, 15000);

  // ---------------------------------------------------------------------- UI
  function setConn(s) {
    els.connDot.dataset.state = s;
    els.connDot.title =
      s === 'up' ? 'Connected' : s === 'down' ? 'Reconnecting…' : 'Connecting…';
  }

  function showJoin() {
    els.channel.hidden = true;
    els.join.hidden = false;
    document.body.dataset.screen = 'join';
    try { history.replaceState(null, '', '/'); } catch {}
  }

  function showChannel() {
    els.join.hidden = true;
    els.channel.hidden = false;
    els.joinErr.hidden = true;
    document.body.dataset.screen = 'channel';
    els.chWord.textContent = state.code;
    try { history.replaceState(null, '', '/' + state.code); } catch {}
    render();
  }

  function initial(name) {
    return (name || '?').trim().charAt(0).toUpperCase() || '?';
  }

  function render() {
    // roster
    els.roster.textContent = '';
    for (const m of state.members) {
      const li = document.createElement('li');
      const speaking = state.speaker && state.speaker.id === m.id;
      li.className = 'member' + (speaking ? ' speaking' : '');
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = initial(m.name);
      const nm = document.createElement('span');
      nm.className = 'mname';
      nm.textContent = m.name + (m.id === state.myId ? ' (you)' : '');
      li.append(av, nm);
      if (speaking) {
        const dot = document.createElement('span');
        dot.className = 'talkdot';
        li.append(dot);
      }
      els.roster.append(li);
    }

    // ptt button + status
    const someoneElse = state.speaker && state.speaker.id !== state.myId;
    els.ptt.classList.toggle('live', state.talk === 'live');
    els.ptt.classList.toggle('pending', state.talk === 'pending');
    els.ptt.classList.toggle('busy', !!someoneElse);
    els.ptt.disabled = !state.joined;
    els.ptt.classList.toggle('nomic', state.joined && !state.micOk && !state.micBusy);
    els.stage.classList.toggle('incoming', !!someoneElse);

    let status;
    if (!state.ws && (state.joined || state.joining)) {
      status = '📡 Reconnecting…';
    } else if (state.talk === 'live') {
      status = '🔴 ON AIR — release to stop';
    } else if (state.talk === 'pending') {
      status = 'Requesting channel…';
    } else if (someoneElse) {
      status = `🎧 ${state.speaker.name} is talking…`;
    } else if (!state.micOk) {
      status = state.micBusy ? 'Turning the mic on…' : '🎙 Tap the button to enable your mic';
    } else if (state.members.length < 2) {
      status = 'Channel clear — waiting for your friend';
    } else {
      status = 'Channel clear — hold to talk';
    }
    els.status.textContent = status;
    els.status.dataset.mode =
      state.talk === 'live' ? 'live' : someoneElse ? 'incoming' : 'idle';
    els.pttLabel.textContent =
      state.talk === 'live'
        ? 'ON AIR'
        : someoneElse
          ? 'BUSY'
          : !state.micOk
            ? state.micBusy
              ? 'MIC…'
              : 'TAP TO\nENABLE MIC'
            : 'HOLD TO TALK';
  }

  // ------------------------------------------------------------------ inputs
  function bindPtt() {
    const el = els.ptt;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch {}
      startTalk();
    });
    const up = (e) => {
      e.preventDefault();
      stopTalk();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', () => stopTalk());
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (!state.joined) return;
      e.preventDefault();
      startTalk();
    });
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (!state.joined) return;
      e.preventDefault();
      stopTalk();
    });
    window.addEventListener('blur', () => stopTalk());
  }

  async function doJoin() {
    const code = normalizeCode(els.code.value);
    if (!code || code.length < 2) {
      els.joinErr.textContent = 'Pick a channel word (letters/numbers, 2+ chars).';
      els.joinErr.hidden = false;
      return;
    }
    els.joinErr.hidden = true;
    state.name = (els.name.value || '').trim().slice(0, 20) || 'Guest';
    state.code = code;
    storage.set('talkie.name', state.name);
    storage.set('talkie.code', code);
    els.joinBtn.disabled = true;
    els.joinBtn.textContent = 'Joining…';
    try {
      // Speaking later (speed alerts) needs one speak() inside a user gesture.
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      } catch {}
      await ensureContext().catch(() => {});
      connect();
      attemptMic(); // prompt in parallel; joining shouldn't wait on the mic
    } finally {
      els.joinBtn.disabled = false;
      els.joinBtn.textContent = 'Join channel';
    }
  }

  function leave() {
    state.closing = true;
    state.joined = false;
    state.joining = false;
    stopTalk();
    if (state.ws) {
      try { state.ws.close(1000); } catch {}
    } else {
      state.closing = false;
      showJoin();
    }
    if (state.wake) {
      try { state.wake.release(); } catch {}
      state.wake = null;
    }
    if (state.stream) {
      for (const t of state.stream.getTracks()) t.stop();
      state.stream = null;
    }
    try { state.srcNode && state.srcNode.disconnect(); } catch {}
    try { state.worklet && state.worklet.disconnect(); } catch {}
    state.srcNode = null;
    state.worklet = null;
    state.micOk = false;
    state.micErr = null;
    banner('');
    stopGeo();
  }

  async function share() {
    const url = location.origin + '/' + state.code;
    const data = {
      title: 'Talkie',
      text: `Join my walkie-talkie channel “${state.code}”`,
      url,
    };
    if (navigator.share) {
      try { await navigator.share(data); return; } catch {}
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied');
    } catch {
      toast(url);
    }
  }

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && state.joined) {
        state.wake = await navigator.wakeLock.request('screen');
      }
    } catch {}
  }

  // Phones freeze the page (and drop the socket) in the background; the
  // moment we're visible again, revive audio and probe/rebuild the connection.
  function wakeReconnect() {
    if (!state.joined && !state.joining) return;
    if (!state.ws) {
      state.retry = 0;
      connect();
    } else if (state.ws.readyState === 1) {
      const at = Date.now();
      wsSend({ t: 'ping' });
      setTimeout(() => {
        if (state.ws && state.ws.readyState === 1 && state.lastMsgAt < at) {
          try { state.ws.close(); } catch {}
        }
      }, 4000);
    }
    // readyState 0/2: connecting or closing — the close handler takes over.
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.ctx && state.ctx.state !== 'running') {
        state.ctx.resume().catch(() => {});
      }
      keepAwake();
      wakeReconnect();
    }
  });
  window.addEventListener('online', wakeReconnect);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) wakeReconnect();
  });

  // ------------------------------------------------------------------- boot
  function boot() {
    els.name.value = storage.get('talkie.name');
    const seg = decodeURIComponent(location.pathname.replace(/^\/+/, '').split('/')[0] || '');
    const q = new URLSearchParams(location.search).get('c') || '';
    const fromUrl = normalizeCode(seg || q);
    els.code.value = fromUrl || storage.get('talkie.code') || '';
    if (!els.code.value) els.code.placeholder = randomWord();
    if (fromUrl && els.name.value) els.joinBtn.focus();
    else if (fromUrl) els.name.focus();

    els.dice.addEventListener('click', () => {
      els.code.value = randomWord();
    });
    els.joinBtn.addEventListener('click', doJoin);
    els.code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doJoin();
    });
    els.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (els.code.value ? doJoin() : els.code.focus());
    });
    els.leaveBtn.addEventListener('click', leave);
    els.shareBtn.addEventListener('click', share);
    renderLimit(); // channel-wide limit arrives from the server after joining
    els.limitBtn.addEventListener('click', cycleLimit);
    try { speechSynthesis.getVoices(); } catch {} // warm the voice list
    els.muteBtn.addEventListener('click', () => {
      state.muted = !state.muted;
      els.muteBtn.textContent = state.muted ? '🔇' : '🔊';
      els.muteBtn.setAttribute('aria-pressed', String(state.muted));
      toast(state.muted ? 'Speaker muted' : 'Speaker on');
    });
    bindPtt();

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => reg.update().catch(() => {}))
        .catch(() => {});
      // When a new version replaces the old one, refresh once — but never
      // mid-session, and not on the first install (that's not an update).
      let reloaded = false;
      const wasControlled = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!wasControlled || reloaded || state.joined || state.joining) return;
        reloaded = true;
        location.reload();
      });
    }
  }

  boot();
})();
