#!/usr/bin/env node
'use strict';

/*
 * Talkie server — static file host + WebSocket audio relay with walkie-talkie
 * floor control (one speaker per channel at a time).
 *
 * Protocol (client <-> server), JSON text frames for control:
 *   -> {t:'join', room, name, uid?}   (uid: private, stable per phone)
 *   <- {t:'joined', id, room, ver, back}
 *   <- {t:'roster', members:[{id,name,status,p|away,for}], speaker, photoMeta, ...}
 *   -> {t:'leave'}                  (explicit exit; a dropped socket goes "away")
 *   -> {t:'away', on}               (app backgrounded, still connected)
 *   -> {t:'photo-del', id}          (owner removes a shared photo)
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
const SERVER_VER = 12;
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE) || 16;
const SPEAKER_TIMEOUT_MS = Number(process.env.SPEAKER_TIMEOUT_MS) || 5000;
// Trip memory: a channel survives everyone dropping (chai stop, dead zone),
// and riders who vanish without tapping Leave linger as "away" for a while
// instead of disappearing — their status comes back with them.
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 6 * 60 * 60 * 1000;
const GHOST_TTL_MS = Number(process.env.GHOST_TTL_MS) || 15 * 60 * 1000;
const PHOTO_TTL_MS = Number(process.env.PHOTO_TTL_MS) || 24 * 60 * 60 * 1000;
const STATUS_TTL_MS = Number(process.env.STATUS_TTL_MS) || 90 * 60 * 1000;
const PHOTO_KEEP = Number(process.env.PHOTO_KEEP) || 8;
const SWEEP_MS = Number(process.env.SWEEP_MS) || 1000;
// Content ids start from the wall clock so a restarted server can never hand
// out an id a phone already cached for a different photo or clip.
const SEQ_BASE =
  process.env.SEQ_BASE != null ? Number(process.env.SEQ_BASE) : Date.now() % 0x40000000;

// ------------------------------------------------------------------ web push
// A locked phone can't play the channel's audio (platform rule), but it can
// buzz: we push "X is talking / pinged / shared a photo" notifications to
// members whose app is backgrounded, away, or closed. Set VAPID_* env vars
// on the host to rotate the identity keys without a code change.
const VAPID_PUBLIC =
  process.env.VAPID_PUBLIC ||
  'BK65JrInBFcQRYA3LDnJCIF1WoF48NtI0dPQY43RlN7FS4difAatGIPSpbfVgofmJrWdHBa5CDO4bsxJwi_Nldk';
const VAPID_PRIVATE =
  process.env.VAPID_PRIVATE || '4MEzPUuCPOw5Z8otqxFK_trjkMOTNz-GggJB5B_1Tf0';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://github.com/imojbaba/talkie2';
const PUSH_DRYRUN = process.env.PUSH_DRYRUN === '1';
let webpush = null;
if (!PUSH_DRYRUN) {
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  } catch {
    webpush = null; // push quietly disabled; everything else still works
  }
}
const pushLog = []; // dry-run capture, asserted by the protocol tests

function queuePush(room, id, sub, payload) {
  if (!webpush) {
    if (PUSH_DRYRUN) pushLog.push({ room: room.code, id, payload });
    return;
  }
  webpush
    .sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: 'high' })
    .catch((err) => {
      const sc = err && err.statusCode;
      if (sc === 404 || sc === 410) room.pushSubs.delete(id); // endpoint is dead
    });
}

// Notify every subscribed member who is NOT looking at the app right now
// (backgrounded, away, or offline) — at most once per kind per window.
function pushRoom(room, kind, minMs, title, body, exceptId) {
  const now = Date.now();
  for (const [id, sub] of room.pushSubs) {
    if (id === exceptId) continue;
    let live = null;
    for (const c of room.clients) {
      if (c.id === id) {
        live = c;
        break;
      }
    }
    if (live && !live.bg) continue; // foreground: they already see/hear it
    const k = id + ':' + kind;
    if (now - (room.pushAt.get(k) || 0) < minMs) continue;
    room.pushAt.set(k, now);
    queuePush(room, id, sub, { title, body, tag: 'talkie-' + kind, room: room.code });
  }
}
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

function photoMetas(room) {
  return room.photos.map((p) => ({ id: p.id, by: p.by.id, name: p.by.name, at: p.at }));
}

function rosterOf(room) {
  const now = Date.now();
  return {
    t: 'roster',
    members: [...room.clients]
      .map((c) => ({ id: c.id, name: c.name, status: c.status || '', p: c.bg ? 'bg' : 'on' }))
      .concat(
        [...room.ghosts.values()].map((g) => ({
          id: g.id,
          name: g.name,
          status: g.status || '',
          away: true,
          for: Math.max(0, Math.round((now - g.leftAt) / 1000)),
        }))
      ),
    speaker: room.speaker
      ? { id: room.speaker.id, name: room.speaker.name, tx: room.tx }
      : null,
    limit: room.limitKmh,
    clips: room.clips.map((c) => c.id),
    mapOn: room.mapOn,
    poll: room.poll
      ? { q: room.poll.q, a: room.poll.a, b: room.poll.b, by: room.poll.by, counts: pollCounts(room) }
      : null,
    photos: room.photos.map((p) => p.id), // kept for older clients; new ones read photoMeta
    photoMeta: photoMetas(room),
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

function leaveRoom(ws, opts = {}) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.clients.delete(ws);
  if (room.speaker === ws) releaseFloor(room, 'left');
  if (opts.ghost) {
    // Connection dropped without an explicit Leave: keep the rider as "away"
    // (status intact) so a screen-lock or dead zone doesn't erase them.
    room.ghosts.set(ws.id, {
      id: ws.id,
      name: ws.name,
      status: ws.status || '',
      statusAt: ws.statusAt || 0,
      leftAt: Date.now(),
    });
  } else {
    room.ghosts.delete(ws.id);
  }
  if (room.clients.size === 0) {
    // The trip survives everyone dropping; the sweeper reclaims it after
    // ROOM_TTL_MS so photos/limit/clips are still there after a long stop.
    room.emptyAt = Date.now();
  } else if (!opts.silent) {
    if (!opts.ghost) broadcast(room, { t: 'peer-leave', id: ws.id, name: ws.name }, null);
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
      leaveRoom(ws); // switching channels is an explicit exit from the old one
      // A private per-phone uid maps to a stable public id: the same person
      // reconnecting is the same member (status, votes, photo ownership all
      // survive). Only the hash is visible to the room, so it can't be spoofed.
      if (typeof msg.uid === 'string' && /^[a-f0-9]{8,64}$/.test(msg.uid)) {
        ws.id = crypto
          .createHash('sha256')
          .update('talkie1:' + msg.uid)
          .digest('hex')
          .slice(0, 6);
      }
      let room = rooms.get(code);
      if (!room) {
        room = {
          code,
          clients: new Set(),
          ghosts: new Map(),
          emptyAt: 0,
          speaker: null,
          tx: 0,
          lastAudio: 0,
          limitKmh: 60,
          roastSeq: 0,
          clips: [],
          clipSeq: SEQ_BASE,
          mapOn: false,
          poll: null,
          photos: [],
          photoSeq: SEQ_BASE,
          pushSubs: new Map(),
          pushAt: new Map(),
        };
        rooms.set(code, room);
      }
      // Same person joining again (refresh, network flap): silently replace
      // the lingering session instead of showing a ghost twin in the roster.
      let back = false;
      for (const c of [...room.clients]) {
        if (c !== ws && c.id === ws.id) {
          // Tell the losing session to stand down, or two open tabs would
          // steal the identity back and forth forever.
          send(c, {
            t: 'error',
            code: 'replaced',
            message: 'You joined from another tab or device — this one stepped aside.',
          });
          leaveRoom(c, { silent: true });
          try { c.terminate(); } catch {}
          back = true;
        }
      }
      if (room.clients.size >= MAX_ROOM_SIZE) {
        return send(ws, {
          t: 'error',
          code: 'room-full',
          message: `Channel “${code}” is full (${MAX_ROOM_SIZE} max).`,
        });
      }
      ws.name = normalizeName(msg.name, 'Guest-' + ws.id.slice(0, 2));
      const ghost = room.ghosts.get(ws.id);
      if (ghost) {
        room.ghosts.delete(ws.id);
        if (ghost.status && !ws.status) {
          ws.status = ghost.status;
          ws.statusAt = ghost.statusAt;
        }
        back = true;
      }
      room.emptyAt = 0;
      ws.room = room;
      room.clients.add(ws);
      send(ws, { t: 'joined', id: ws.id, room: code, ver: SERVER_VER, back });
      if (!back) broadcast(room, { t: 'peer-join', id: ws.id, name: ws.name }, ws);
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
      pushRoom(room, 'talk', 180000, `🎙 ${ws.name} is talking on #${room.code}`, 'Open Talkie to listen', ws.id);
      break;
    }
    case 'ptt-end': {
      const room = ws.room;
      if (room && room.speaker === ws) releaseFloor(room, 'ended');
      break;
    }
    case 'leave': {
      // Explicit exit (the Leave button): a real goodbye, not an "away" ghost.
      ws.explicitLeave = true;
      if (ws.room) ws.room.pushSubs.delete(ws.id); // left the trip: stop buzzing them
      leaveRoom(ws);
      break;
    }
    case 'push-sub': {
      // Register this member's phone for background notifications.
      const room = ws.room;
      if (!room) return;
      const now = Date.now();
      if (now - (ws.lastPushSubAt || 0) < 5000) return;
      ws.lastPushSubAt = now;
      const sub = msg.sub;
      if (
        !sub ||
        typeof sub.endpoint !== 'string' ||
        !/^https:\/\//.test(sub.endpoint) ||
        sub.endpoint.length > 1024 ||
        !sub.keys ||
        typeof sub.keys.p256dh !== 'string' ||
        typeof sub.keys.auth !== 'string' ||
        sub.keys.p256dh.length > 256 ||
        sub.keys.auth.length > 128
      ) {
        return;
      }
      room.pushSubs.set(ws.id, {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      });
      break;
    }
    case 'away': {
      // Screen off / app backgrounded but still connected: 🌙 in the roster.
      const room = ws.room;
      if (!room) return;
      const now = Date.now();
      if (now - (ws.lastAwayAt || 0) < 1000) return;
      ws.lastAwayAt = now;
      const bg = !!msg.on;
      if (bg === !!ws.bg) return;
      ws.bg = bg;
      broadcast(room, rosterOf(room), null);
      break;
    }
    case 'photo-del': {
      // Only the person who shared a photo can remove it from the channel.
      const room = ws.room;
      if (!room) return;
      const id = Number(msg.id);
      const i = room.photos.findIndex((p) => p.id === id);
      if (i < 0 || room.photos[i].by.id !== ws.id) return;
      room.photos.splice(i, 1);
      broadcast(
        room,
        {
          t: 'photo',
          ids: room.photos.map((p) => p.id),
          metas: photoMetas(room),
          del: { id, by: { id: ws.id, name: ws.name } },
        },
        null
      );
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
      pushRoom(room, 'ping', 30000, `🔔 ${ws.name} pinged #${room.code}`, 'Everyone, check in!', ws.id);
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
      pushRoom(
        room,
        'poll',
        60000,
        `🗳️ ${ws.name} asks on #${room.code}`,
        `${room.poll.q} — ${room.poll.a} / ${room.poll.b}`,
        ws.id
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
      ws.statusAt = now; // statuses fade out on their own after STATUS_TTL_MS
      broadcast(room, { t: 'status', id: ws.id, name: ws.name, text }, null);
      broadcast(room, rosterOf(room), null);
      if (text) pushRoom(room, 'status', 60000, `#${room.code}`, `💬 ${ws.name}: ${text}`, ws.id);
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
      pushRoom(
        room,
        'roast',
        120000,
        `🚨 ${ws.name}: ${kmh} km/h on #${room.code}`,
        'bhencho bhencho — dheere chala!',
        ws.id
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
    room.photos.push({ id, buf, by: { id: ws.id, name: ws.name }, at: now });
    if (room.photos.length > PHOTO_KEEP) room.photos.shift();
    for (const c of room.clients) {
      if (c !== ws && c.readyState === c.OPEN && c.bufferedAmount < 3_000_000) {
        c.send(buf, { binary: true });
      }
    }
    broadcast(
      room,
      {
        t: 'photo',
        by: { id: ws.id, name: ws.name },
        ids: room.photos.map((p) => p.id),
        metas: photoMetas(room),
      },
      null
    );
    pushRoom(room, 'photo', 60000, `📸 ${ws.name} shared a photo on #${room.code}`, 'Tap to see it', ws.id);
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
  if (pathname === '/pushkey') {
    // Public VAPID key the client subscribes with; must match our sender key.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ key: VAPID_PUBLIC }));
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
  ws.on('close', () => leaveRoom(ws, { ghost: !ws.explicitLeave }));
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
      // Overflow drops the oldest *binary* frames only — control JSON
      // (joined/roster) must survive, or the join backfill can eat the join.
      let i = 0;
      while (this.outboxBytes > 6_000_000 && i < this.outbox.length) {
        if (this.outbox[i].bin) {
          this.outboxBytes -= this.outbox[i].d.length;
          this.outbox.splice(i, 1);
        } else {
          i++;
        }
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
      // An idle-reaped poll session is a dropped phone, not a goodbye.
      leaveRoom(c, { ghost: !c.explicitLeave });
      pollSessions.delete(token);
    }
  }
}, 15000);
pollSweeper.unref();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.speaker && now - room.lastAudio > SPEAKER_TIMEOUT_MS) {
      releaseFloor(room, 'timeout');
    }
    if (room.poll && now - room.poll.at > 180000) endPoll(room);
    let rosterDirty = false;
    for (const [id, g] of room.ghosts) {
      if (now - g.leftAt > GHOST_TTL_MS) {
        room.ghosts.delete(id); // away long enough: quietly drop off the roster
        rosterDirty = true;
      }
    }
    for (const c of room.clients) {
      if (c.status && now - (c.statusAt || 0) > STATUS_TTL_MS) {
        c.status = ''; // "chai break" three hours later is just noise
        rosterDirty = true;
      }
    }
    const nPhotos = room.photos.length;
    room.photos = room.photos.filter((p) => now - p.at <= PHOTO_TTL_MS);
    if (room.photos.length !== nPhotos && room.clients.size) {
      broadcast(
        room,
        { t: 'photo', ids: room.photos.map((p) => p.id), metas: photoMetas(room) },
        null
      );
    }
    if (rosterDirty && room.clients.size) broadcast(room, rosterOf(room), null);
    if (!room.clients.size && room.emptyAt && now - room.emptyAt > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}, SWEEP_MS);

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

module.exports = { server, wss, rooms, normalizeCode, pushLog };
