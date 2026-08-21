#!/usr/bin/env node
'use strict';

/*
 * Talkie server — static file host + WebSocket audio relay with walkie-talkie
 * floor control (one speaker per channel at a time).
 *
 * Protocol (client <-> server), JSON text frames for control:
 *   -> {t:'join', room, name}
 *   <- {t:'joined', id, room}
 *   <- {t:'roster', members:[{id,name}], speaker:{id,name,tx}|null}
 *   <- {t:'peer-join'|'peer-leave', id, name}
 *   -> {t:'ptt-start', tx}         (request the floor)
 *   <- {t:'granted', tx}           (to requester)
 *   <- {t:'denied', tx, by:{id,name}}
 *   <- {t:'ptt-start', id, name, tx}  (to everyone else)
 *   -> {t:'ptt-end', tx}
 *   <- {t:'ptt-end', id, tx, reason}
 *   -> {t:'ping'}  <- {t:'pong'}
 * Binary frames: [u32 LE txId][int16 LE PCM @16kHz mono], relayed verbatim
 * from the current floor holder to everyone else in the room.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SERVER_VER = 10;
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE) || 16;
const SPEAKER_TIMEOUT_MS = Number(process.env.SPEAKER_TIMEOUT_MS) || 5000;
const MAX_BINARY_BYTES = 8 * 1024;
const MAX_TEXT_BYTES = 2 * 1024;
// Raw 16 kHz / 16-bit mono is ~32 KB/s; the burst allowance lets a client
// flush the frames it buffered while waiting for the floor grant.
const AUDIO_BYTES_PER_SEC = 96 * 1024;
const AUDIO_BURST_BYTES = 256 * 1024;
// Recorded roast clip: up to ~5 s of 16 kHz 16-bit PCM plus its 4-byte header.
const CLIP_MAX_BYTES = 320 * 1024;
// Shared photos: client-compressed JPEGs, marker header 0xFFFFFFFE.
const PHOTO_MARK = 0xfffffffe;
const PHOTO_MAX_BYTES = 400 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** @type {Map<string, {code:string, clients:Set<any>, speaker:any, tx:number, lastAudio:number}>} */
const rooms = new Map();

function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (code.length < 2 || code.length > 24) return null;
  return code;
}

function normalizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
  return name || fallback;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function pollCounts(room) {
  const counts = [0, 0];
  for (const v of Object.values(room.poll ? room.poll.votes : {})) counts[v]++;
  return counts;
}

function rosterOf(room) {
  return {
    t: 'roster',
    members: [...room.clients].map((c) => ({ id: c.id, name: c.name, status: c.status || '' })),
    speaker: room.speaker
      ? { id: room.speaker.id, name: room.speaker.name, tx: room.tx }
      : null,
    limit: room.limitKmh,
    clips: room.clips.map((c) => c.id),
    mapOn: room.mapOn,
    poll: room.poll
      ? { q: room.poll.q, a: room.poll.a, b: room.poll.b, by: room.poll.by, counts: pollCounts(room) }
      : null,
    photos: room.photos.map((p) => p.id),
  };
}

function broadcast(room, obj, except) {
  const msg = JSON.stringify(obj);
  for (const c of room.clients) {
    if (c !== except && c.readyState === c.OPEN) c.send(msg);
  }
}

function releaseFloor(room, reason) {
  if (!room.speaker) return;
  const ended = { t: 'ptt-end', id: room.speaker.id, tx: room.tx, reason };
  room.speaker = null;
  room.tx = 0;
  broadcast(room, ended, null);
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.clients.delete(ws);
  if (room.speaker === ws) releaseFloor(room, 'left');
  if (room.clients.size === 0) {
    rooms.delete(room.code);
  } else {
    broadcast(room, { t: 'peer-leave', id: ws.id, name: ws.name }, null);
    broadcast(room, rosterOf(room), null);
  }
}

function onControl(ws, msg) {
  switch (msg.t) {
    case 'join': {
      const code = normalizeCode(msg.room);
      if (!code) {
        return send(ws, {
          t: 'error',
          code: 'bad-code',
          message: 'Channel word must be 2–24 letters, numbers or dashes.',
        });
      }
      leaveRoom(ws);
      let room = rooms.get(code);
      if (!room) {
        room = {
          code,
          clients: new Set(),
          speaker: null,
          tx: 0,
          lastAudio: 0,
          limitKmh: 60,
          roastSeq: 0,
          clips: [],
          clipSeq: 0,
          mapOn: false,
          poll: null,
          photos: [],
          photoSeq: 0,
        };
        rooms.set(code, room);
      }
      if (room.clients.size >= MAX_ROOM_SIZE) {
        return send(ws, {
          t: 'error',
          code: 'room-full',
          message: `Channel “${code}” is full (${MAX_ROOM_SIZE} max).`,
        });
      }
      ws.name = normalizeName(msg.name, 'Guest-' + ws.id.slice(0, 2));
      ws.room = room;
      room.clients.add(ws);
      send(ws, { t: 'joined', id: ws.id, room: code, ver: SERVER_VER });
      broadcast(room, { t: 'peer-join', id: ws.id, name: ws.name }, ws);
      broadcast(room, rosterOf(room), null);
      for (const c of room.clips) {
        if (ws.readyState === ws.OPEN) ws.send(c.buf, { binary: true });
      }
      for (const ph of room.photos) {
        if (ws.readyState === ws.OPEN) ws.send(ph.buf, { binary: true });
      }
      break;
    }
    case 'ptt-start': {
      const room = ws.room;
      if (!room) return;
      const tx = (msg.tx >>> 0) || 1;
      if (room.speaker && room.speaker !== ws) {
        return send(ws, {
          t: 'denied',
          tx,
          by: { id: room.speaker.id, name: room.speaker.name },
        });
      }
      room.speaker = ws;
      room.tx = tx;
      room.lastAudio = Date.now();
      send(ws, { t: 'granted', tx });
      broadcast(room, { t: 'ptt-start', id: ws.id, name: ws.name, tx }, ws);
      break;
    }
    case 'ptt-end': {
      const room = ws.room;
      if (room && room.speaker === ws) releaseFloor(room, 'ended');
      break;
    }
    case 'limit': {
      // Channel-wide speed limit: anyone's change applies to everyone.
      const room = ws.room;
      if (!room) return;
      const kmh = Math.round(Number(msg.kmh));
      if (!(kmh === 0 || (kmh >= 20 && kmh <= 200))) return;
      const now = Date.now();
      if (now - (ws.lastLimitAt || 0) < 1000) return;
      ws.lastLimitAt = now;
      room.limitKmh = kmh;
      broadcast(room, { t: 'limit', kmh, by: { id: ws.id, name: ws.name } }, null);
      break;
    }
    case 'ping-all': {
      // Attention buzz for the whole channel.
      const room = ws.room;
      if (!room) return;
      const now = Date.now();
      if (now - (ws.lastPingAll || 0) < 5000) return;
      ws.lastPingAll = now;
      broadcast(room, { t: 'ping-all', by: { id: ws.id, name: ws.name } }, null);
      break;
    }
    case 'poll': {
      const room = ws.room;
      if (!room) return;
      const clean = (v, n, d) =>
        String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) || d;
      const q = clean(msg.q, 40, '');
      if (!q) return;
      const now = Date.now();
      if (now - (ws.lastPollAt || 0) < 10000) return;
      ws.lastPollAt = now;
      room.poll = {
        q,
        a: clean(msg.a, 16, 'Yes'),
        b: clean(msg.b, 16, 'No'),
        by: { id: ws.id, name: ws.name },
        votes: {},
        at: now,
      };
      broadcast(
        room,
        { t: 'poll', q: room.poll.q, a: room.poll.a, b: room.poll.b, by: room.poll.by },
        null
      );
      break;
    }
    case 'vote': {
      const room = ws.room;
      if (!room || !room.poll) return;
      const v = msg.v === 1 ? 1 : msg.v === 0 ? 0 : null;
      if (v == null) return;
      room.poll.votes[ws.id] = v;
      broadcast(
        room,
        { t: 'votes', counts: pollCounts(room), total: room.clients.size },
        null
      );
      break;
    }
    case 'poll-end': {
      const room = ws.room;
      if (!room || !room.poll) return;
      if (room.poll.by.id !== ws.id) return;
      endPoll(room);
      break;
    }
    case 'mapmode': {
      // Channel-wide location sharing toggle; announced to everyone.
      const room = ws.room;
      if (!room) return;
      const now = Date.now();
      if (now - (ws.lastMapAt || 0) < 2000) return;
      ws.lastMapAt = now;
      room.mapOn = !!msg.on;
      broadcast(room, { t: 'mapmode', on: room.mapOn, by: { id: ws.id, name: ws.name } }, null);
      break;
    }
    case 'loc': {
      // Rider position for distance display; only while the channel opted in.
      const room = ws.room;
      if (!room || !room.mapOn) return;
      const lat = Number(msg.lat);
      const lon = Number(msg.lon);
      if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return;
      const now = Date.now();
      if (now - (ws.lastLocAt || 0) < 4000) return;
      ws.lastLocAt = now;
      broadcast(
        room,
        { t: 'loc', id: ws.id, lat: +lat.toFixed(4), lon: +lon.toFixed(4) },
        ws
      );
      break;
    }
    case 'status': {
      // Short rider status ("chai break"), shown in everyone's roster.
      const room = ws.room;
      if (!room) return;
      const text = String(msg.text == null ? '' : msg.text)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 48);
      const now = Date.now();
      if (now - (ws.lastStatusAt || 0) < 2000) return;
      ws.lastStatusAt = now;
      ws.status = text;
      broadcast(room, { t: 'status', id: ws.id, name: ws.name, text }, null);
      broadcast(room, rosterOf(room), null);
      break;
    }
    case 'speed': {
      // Live speed sharing for the roster: a number only, never coordinates.
      const room = ws.room;
      if (!room) return;
      const kmh = Math.round(Number(msg.kmh));
      if (!(kmh >= 0 && kmh < 300)) return;
      const now = Date.now();
      if (now - (ws.lastSpeedAt || 0) < 2000) return;
      ws.lastSpeedAt = now;
      broadcast(room, { t: 'speed', id: ws.id, kmh }, ws);
      break;
    }
    case 'overspeed': {
      // Speed-limit roast: client sends only a number, never coordinates.
      const room = ws.room;
      if (!room) return;
      const kmh = Math.round(Number(msg.kmh));
      if (!(kmh > 0 && kmh < 300)) return;
      if (!room.limitKmh || kmh <= room.limitKmh) return; // channel limit is authoritative
      const now = Date.now();
      if (now - (ws.lastOverspeed || 0) < 10000) return;
      ws.lastOverspeed = now;
      // v picks the roast line; a shared counter keeps all phones in sync.
      broadcast(
        room,
        { t: 'overspeed', id: ws.id, name: ws.name, kmh, v: room.roastSeq++ },
        null
      );
      break;
    }
    case 'ping':
      send(ws, { t: 'pong' });
      break;
    default:
      break;
  }
}

function endPoll(room) {
  if (!room.poll) return;
  const p = room.poll;
  room.poll = null;
  broadcast(
    room,
    { t: 'poll-end', q: p.q, a: p.a, b: p.b, counts: (() => {
        const counts = [0, 0];
        for (const v of Object.values(p.votes)) counts[v]++;
        return counts;
      })() },
    null
  );
}

function onAudio(ws, data) {
  const room = ws.room;
  if (!room) return;
  // Binary messages with txId 0 are roast-clip uploads, not live audio; live
  // transmission ids are always non-zero.
  if (data.length >= 8 && data.readUInt32LE(0) === PHOTO_MARK) {
    if (data.length > PHOTO_MAX_BYTES + 8) return;
    const now = Date.now();
    if (now - (ws.lastPhotoAt || 0) < 10000) return;
    ws.lastPhotoAt = now;
    const id = ++room.photoSeq;
    const buf = Buffer.alloc(data.length + 4);
    buf.writeUInt32LE(PHOTO_MARK, 0);
    buf.writeUInt32LE(id, 4);
    data.copy(buf, 8, 4); // jpeg payload after [mark][photoId]
    room.photos.push({ id, buf });
    if (room.photos.length > 3) room.photos.shift();
    for (const c of room.clients) {
      if (c !== ws && c.readyState === c.OPEN && c.bufferedAmount < 3_000_000) {
        c.send(buf, { binary: true });
      }
    }
    broadcast(
      room,
      { t: 'photo', by: { id: ws.id, name: ws.name }, ids: room.photos.map((p) => p.id) },
      null
    );
    return;
  }
  if (data.length >= 8 && data.readUInt32LE(0) === 0) {
    if (data.length > CLIP_MAX_BYTES) return;
    const now = Date.now();
    if (now - (ws.lastClipAt || 0) < 10000) return;
    ws.lastClipAt = now;
    const id = ++room.clipSeq;
    const buf = Buffer.alloc(data.length + 4);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(id, 4);
    data.copy(buf, 8, 4); // pcm payload after the [0][clipId] header
    room.clips.push({ id, buf });
    if (room.clips.length > 4) room.clips.shift(); // newest four rotate
    for (const c of room.clients) {
      if (c !== ws && c.readyState === c.OPEN && c.bufferedAmount < 2_000_000) {
        c.send(buf, { binary: true });
      }
    }
    broadcast(
      room,
      { t: 'clip', by: { id: ws.id, name: ws.name }, ids: room.clips.map((c) => c.id) },
      null
    );
    return;
  }
  if (room.speaker !== ws) return;
  if (data.length > MAX_BINARY_BYTES) return;
  const now = Date.now();
  ws.tokens = Math.min(
    AUDIO_BURST_BYTES,
    ws.tokens + ((now - ws.lastRefill) / 1000) * AUDIO_BYTES_PER_SEC
  );
  ws.lastRefill = now;
  if (ws.tokens < data.length) return;
  ws.tokens -= data.length;
  room.lastAudio = now;
  for (const c of room.clients) {
    // Skip clients whose socket is backed up instead of buffering unboundedly.
    if (c !== ws && c.readyState === c.OPEN && c.bufferedAmount < 1_000_000) {
      c.send(data, { binary: true });
    }
  }
}

// ---------------------------------------------------------------- HTTP static
function serveStatic(req, res) {
  let pathname;
  let query;
  try {
    const u = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(u.pathname);
    query = u.searchParams;
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }
  if (pathname.startsWith('/poll/')) return handlePoll(req, res, pathname, query);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok v' + SERVER_VER);
  }
  // Paths without a file extension are channel share links -> serve the app.
  let rel = pathname.replace(/\/+$/, '') || '/';
  if (rel === '/' || !path.posix.extname(rel)) rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const longLived = ext === '.png' || ext === '.svg' || ext === '.ico';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': longLived ? 'public, max-age=86400' : 'no-cache',
      'Content-Length': buf.length,
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

function initClient(c) {
  c.id = crypto.randomBytes(3).toString('hex');
  c.name = 'Guest-' + c.id.slice(0, 2);
  c.room = null;
  c.isAlive = true;
  c.tokens = AUDIO_BURST_BYTES;
  c.lastRefill = Date.now();
}

function handleMessage(c, data, isBinary) {
  if (isBinary) return onAudio(c, data);
  if (data.length > MAX_TEXT_BYTES) return;
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (msg && typeof msg.t === 'string') onControl(c, msg);
}

wss.on('connection', (ws) => {
  initClient(ws);
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('error', () => {});
  ws.on('close', () => leaveRoom(ws));
  ws.on('message', (data, isBinary) => handleMessage(ws, data, isBinary));
});

// ------------------------------------------------ HTTP fallback transport
// Some networks (iOS content filters, strict proxies) block WebSockets while
// plain HTTPS works. These sessions mimic a ws client over POST + long-poll.
const pollSessions = new Map();

function makePollClient(token) {
  const c = {
    token,
    readyState: 1,
    OPEN: 1,
    outbox: [],
    outboxBytes: 0,
    waiter: null,
    lastSeen: Date.now(),
    bufferedAmount: 0,
    send(data) {
      const bin = typeof data !== 'string';
      const d = bin ? Buffer.from(data) : Buffer.from(String(data), 'utf8');
      this.outbox.push({ bin, d });
      this.outboxBytes += d.length;
      while (this.outboxBytes > 2_000_000 && this.outbox.length) {
        this.outboxBytes -= this.outbox.shift().d.length;
      }
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w();
      }
    },
    ping() {},
    terminate() {
      this.readyState = 3;
    },
    close() {
      this.readyState = 3;
    },
  };
  initClient(c);
  return c;
}

function readBody(req, res, limit, cb) {
  const chunks = [];
  let total = 0;
  req.on('data', (ch) => {
    total += ch.length;
    if (total > limit) {
      res.writeHead(413);
      res.end();
      req.destroy();
      return;
    }
    chunks.push(ch);
  });
  req.on('end', () => cb(Buffer.concat(chunks)));
  req.on('error', () => {});
}

function handlePoll(req, res, pathname, query) {
  res.setHeader('Cache-Control', 'no-store');
  if (pathname === '/poll/open' && req.method === 'POST') {
    if (pollSessions.size >= 300) {
      res.writeHead(503);
      return res.end();
    }
    const token = crypto.randomBytes(12).toString('hex');
    pollSessions.set(token, makePollClient(token));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ token }));
  }
  const c = pollSessions.get(query.get('t') || '');
  if (!c || c.readyState !== 1) {
    res.writeHead(410);
    return res.end();
  }
  c.lastSeen = Date.now();
  if (pathname === '/poll/send' && req.method === 'POST') {
    readBody(req, res, PHOTO_MAX_BYTES + 8192, (body) => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('json')) {
        handleMessage(c, body, false);
      } else {
        // batched binary: [u32 len][payload] repeated
        let off = 0;
        while (off + 4 <= body.length) {
          const len = body.readUInt32LE(off);
          off += 4;
          if (len === 0 || len > PHOTO_MAX_BYTES + 8 || off + len > body.length) break;
          onAudio(c, body.subarray(off, off + len));
          off += len;
        }
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (pathname === '/poll/events' && req.method === 'GET') {
    const flush = () => {
      const parts = [];
      let total = 0;
      while (c.outbox.length && total < 512 * 1024) {
        const m = c.outbox.shift();
        c.outboxBytes -= m.d.length;
        const hdr = Buffer.alloc(5);
        hdr[0] = m.bin ? 1 : 0;
        hdr.writeUInt32LE(m.d.length, 1);
        parts.push(hdr, m.d);
        total += m.d.length + 5;
      }
      try {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.concat(parts));
      } catch {}
    };
    if (c.outbox.length) return flush();
    const timer = setTimeout(() => {
      if (c.waiter === wake) c.waiter = null;
      flush();
    }, 25000);
    const wake = () => {
      clearTimeout(timer);
      flush();
    };
    c.waiter = wake;
    req.on('close', () => {
      clearTimeout(timer);
      if (c.waiter === wake) c.waiter = null;
    });
    return;
  }
  if (pathname === '/poll/close' && req.method === 'POST') {
    c.readyState = 3;
    leaveRoom(c);
    pollSessions.delete(c.token);
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(404);
  res.end();
}

const pollSweeper = setInterval(() => {
  const now = Date.now();
  for (const [token, c] of pollSessions) {
    if (c.readyState !== 1 || now - c.lastSeen > 60000) {
      c.readyState = 3;
      leaveRoom(c);
      pollSessions.delete(token);
    }
  }
}, 15000);
pollSweeper.unref();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.speaker && now - room.lastAudio > SPEAKER_TIMEOUT_MS) {
      releaseFloor(room, 'timeout');
    }
    if (room.poll && now - room.poll.at > 180000) endPoll(room);
  }
}, 1000);

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

sweeper.unref();
heartbeat.unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Talkie on http://localhost:${PORT} (ws path /ws)`);
  });
}

module.exports = { server, wss, rooms, normalizeCode };
