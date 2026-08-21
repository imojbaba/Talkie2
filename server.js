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
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE) || 16;
const SPEAKER_TIMEOUT_MS = Number(process.env.SPEAKER_TIMEOUT_MS) || 5000;
const MAX_BINARY_BYTES = 8 * 1024;
const MAX_TEXT_BYTES = 2 * 1024;
// Raw 16 kHz / 16-bit mono is ~32 KB/s; the burst allowance lets a client
// flush the frames it buffered while waiting for the floor grant.
const AUDIO_BYTES_PER_SEC = 96 * 1024;
const AUDIO_BURST_BYTES = 256 * 1024;

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

function rosterOf(room) {
  return {
    t: 'roster',
    members: [...room.clients].map((c) => ({ id: c.id, name: c.name })),
    speaker: room.speaker
      ? { id: room.speaker.id, name: room.speaker.name, tx: room.tx }
      : null,
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
        room = { code, clients: new Set(), speaker: null, tx: 0, lastAudio: 0 };
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
      send(ws, { t: 'joined', id: ws.id, room: code });
      broadcast(room, { t: 'peer-join', id: ws.id, name: ws.name }, ws);
      broadcast(room, rosterOf(room), null);
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
    case 'overspeed': {
      // Speed-limit roast: client sends only a number, never coordinates.
      const room = ws.room;
      if (!room) return;
      const kmh = Math.round(Number(msg.kmh));
      if (!(kmh > 0 && kmh < 300)) return;
      const now = Date.now();
      if (now - (ws.lastOverspeed || 0) < 10000) return;
      ws.lastOverspeed = now;
      broadcast(room, { t: 'overspeed', id: ws.id, name: ws.name, kmh }, null);
      break;
    }
    case 'ping':
      send(ws, { t: 'pong' });
      break;
    default:
      break;
  }
}

function onAudio(ws, data) {
  const room = ws.room;
  if (!room || room.speaker !== ws) return;
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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
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
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(3).toString('hex');
  ws.name = 'Guest-' + ws.id.slice(0, 2);
  ws.room = null;
  ws.isAlive = true;
  ws.tokens = AUDIO_BURST_BYTES;
  ws.lastRefill = Date.now();

  ws.on('pong', () => (ws.isAlive = true));
  ws.on('error', () => {});
  ws.on('close', () => leaveRoom(ws));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return onAudio(ws, data);
    if (data.length > MAX_TEXT_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg && typeof msg.t === 'string') onControl(ws, msg);
  });
});

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.speaker && now - room.lastAudio > SPEAKER_TIMEOUT_MS) {
      releaseFloor(room, 'timeout');
    }
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
