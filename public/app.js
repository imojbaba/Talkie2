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
    muteBtn: $('#muteBtn'),
    leaveBtn: $('#leaveBtn'),
    banner: $('#banner'),
    roster: $('#roster'),
    stage: $('#stage'),
    ptt: $('#ptt'),
    pttLabel: $('#pttLabel'),
    status: $('#status'),
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
    micTried: false,
    retry: 0,
    lastMsgAt: 0,
    lastDenied: null,
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

  function banner(text) {
    els.banner.textContent = text || '';
    els.banner.hidden = !text;
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
      state.remoteGain = state.ctx.createGain();
      state.remoteGain.connect(state.ctx.destination);
      await state.ctx.audioWorklet.addModule('/worklet.js');
    }
    if (state.ctx.state !== 'running') {
      try { await state.ctx.resume(); } catch {}
    }
  }

  async function ensureMic() {
    if (state.stream || state.micTried) return;
    state.micTried = true;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      const src = state.ctx.createMediaStreamSource(state.stream);
      state.worklet = new AudioWorkletNode(state.ctx, 'ptt-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      state.worklet.port.onmessage = (e) => onFrame(new Int16Array(e.data));
      // A silent sink keeps the worklet pulled by the render graph.
      const sink = state.ctx.createGain();
      sink.gain.value = 0;
      src.connect(state.worklet);
      state.worklet.connect(sink);
      sink.connect(state.ctx.destination);
      state.micOk = true;
    } catch (err) {
      state.micOk = false;
      banner('🎙️ Mic blocked — you can listen but not talk. Allow the microphone and reload.');
    }
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
      toast('Mic is blocked — listen-only');
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
        break;
      }
      case 'roster': {
        state.members = msg.members || [];
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
      case 'pong':
        break;
    }
  }

  // Keepalive + dead-connection watchdog.
  setInterval(() => {
    if (state.ws && state.ws.readyState === 1) {
      wsSend({ t: 'ping' });
      if (Date.now() - state.lastMsgAt > 45000) {
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
    els.ptt.disabled = !state.joined || !state.micOk;
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
    } else if (state.members.length < 2) {
      status = 'Channel clear — waiting for your friend';
    } else {
      status = 'Channel clear — hold to talk';
    }
    els.status.textContent = status;
    els.status.dataset.mode =
      state.talk === 'live' ? 'live' : someoneElse ? 'incoming' : 'idle';
    els.pttLabel.textContent =
      state.talk === 'live' ? 'ON AIR' : someoneElse ? 'BUSY' : 'HOLD TO TALK';
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
      if (!navigator.mediaDevices || !window.isSecureContext) {
        banner('⚠️ Mic needs HTTPS (or localhost). You can listen only.');
        state.micOk = false;
        state.micTried = true;
        if (!state.ctx) await ensureContext().catch(() => {});
      } else {
        await ensureContext();
        await ensureMic();
      }
      connect();
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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.ctx && state.ctx.state !== 'running') {
        state.ctx.resume().catch(() => {});
      }
      keepAwake();
    }
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
    els.muteBtn.addEventListener('click', () => {
      state.muted = !state.muted;
      els.muteBtn.textContent = state.muted ? '🔇' : '🔊';
      els.muteBtn.setAttribute('aria-pressed', String(state.muted));
      toast(state.muted ? 'Speaker muted' : 'Speaker on');
    });
    bindPtt();

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  boot();
})();
