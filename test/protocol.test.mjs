import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.SPEAKER_TIMEOUT_MS = '400';

const require = createRequire(import.meta.url);
const { server, wss } = require('../server.js');
const WebSocket = require('ws');

let port;

before(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
});

after(() => {
  for (const c of wss.clients) c.terminate();
  wss.close();
  server.close();
});

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const item = isBinary
      ? { binary: true, data: Buffer.from(data) }
      : JSON.parse(data.toString());
    const w = waiters.findIndex((f) => f.pred(item));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(item);
    else queue.push(item);
  });
  ws.next = (pred, ms = 3000) =>
    new Promise((resolve, reject) => {
      const i = queue.findIndex(pred);
      if (i >= 0) return resolve(queue.splice(i, 1)[0]);
      const timer = setTimeout(
        () => reject(new Error('timeout waiting for message')),
        ms
      );
      waiters.push({
        pred,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
    });
  ws.expectNone = (pred, ms = 300) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (queue.some(pred)) reject(new Error('unexpected message arrived'));
        else resolve();
      };
      setTimeout(check, ms);
    });
  ws.j = (obj) => ws.send(JSON.stringify(obj));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function frame(tx, samples = 320) {
  const buf = Buffer.alloc(4 + samples * 2);
  buf.writeUInt32LE(tx, 0);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(((i % 64) - 32) * 300, 4 + i * 2);
  return buf;
}

test('join, roster, floor control, relay, release', async () => {
  const a = await client();
  const b = await client();

  a.j({ t: 'join', room: 'Test Room!', name: 'Alice' });
  const joinedA = await a.next((m) => m.t === 'joined');
  assert.equal(joinedA.room, 'test-room'); // normalized
  await a.next((m) => m.t === 'roster' && m.members.length === 1);

  b.j({ t: 'join', room: 'test-room', name: 'Bob' });
  const joinedB = await b.next((m) => m.t === 'joined');
  assert.notEqual(joinedA.id, joinedB.id);
  const rosterA = await a.next((m) => m.t === 'roster' && m.members.length === 2);
  assert.deepEqual(
    rosterA.members.map((m) => m.name).sort(),
    ['Alice', 'Bob']
  );
  await b.next((m) => m.t === 'roster' && m.members.length === 2);

  // A takes the floor
  a.j({ t: 'ptt-start', tx: 7 });
  const granted = await a.next((m) => m.t === 'granted');
  assert.equal(granted.tx, 7);
  const started = await b.next((m) => m.t === 'ptt-start');
  assert.equal(started.name, 'Alice');
  assert.equal(started.tx, 7);

  // B is denied while A holds it
  b.j({ t: 'ptt-start', tx: 9 });
  const denied = await b.next((m) => m.t === 'denied');
  assert.equal(denied.by.name, 'Alice');

  // audio relays A -> B only, header intact
  a.send(frame(7));
  const rx = await b.next((m) => m.binary);
  assert.equal(rx.data.readUInt32LE(0), 7);
  assert.equal(rx.data.length, 4 + 320 * 2);
  await a.expectNone((m) => m.binary); // no echo to the sender

  // audio from a non-speaker is dropped
  b.send(frame(9));
  await a.expectNone((m) => m.binary);

  // release
  a.j({ t: 'ptt-end', tx: 7 });
  const endA = await a.next((m) => m.t === 'ptt-end');
  const endB = await b.next((m) => m.t === 'ptt-end');
  assert.equal(endA.reason, 'ended');
  assert.equal(endB.id, joinedA.id);

  a.close();
  b.close();
});

test('floor times out when the speaker goes silent', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'timeout-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'timeout-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  a.j({ t: 'ptt-start', tx: 3 });
  await a.next((m) => m.t === 'granted');
  // no audio for > SPEAKER_TIMEOUT_MS (400) -> sweeper releases
  const end = await b.next((m) => m.t === 'ptt-end', 3000);
  assert.equal(end.reason, 'timeout');
  a.close();
  b.close();
});

test('disconnecting speaker releases the floor and updates the roster', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'drop-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'drop-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');
  await b.next((m) => m.t === 'roster' && m.members.length === 2);

  a.j({ t: 'ptt-start', tx: 5 });
  await b.next((m) => m.t === 'ptt-start');
  a.terminate();

  const end = await b.next((m) => m.t === 'ptt-end');
  assert.equal(end.reason, 'left');
  const roster = await b.next((m) => m.t === 'roster' && m.members.length === 1);
  assert.equal(roster.members[0].name, 'Bob');
  b.close();
});

test('bad channel word and ping/pong', async () => {
  const a = await client();
  a.j({ t: 'join', room: '!!', name: 'X' });
  const err = await a.next((m) => m.t === 'error');
  assert.equal(err.code, 'bad-code');
  a.j({ t: 'ping' });
  await a.next((m) => m.t === 'pong');
  a.close();
});

test('overspeed relays to the whole room, rate-limited, validated', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'speed-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'speed-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  a.j({ t: 'overspeed', kmh: 88.4 });
  const gotB = await b.next((m) => m.t === 'overspeed');
  assert.equal(gotB.name, 'Alice');
  assert.equal(gotB.kmh, 88);
  const gotA = await a.next((m) => m.t === 'overspeed'); // sender hears it too
  assert.equal(gotA.kmh, 88);

  // second alert inside the 10s window is dropped
  a.j({ t: 'overspeed', kmh: 120 });
  await b.expectNone((m) => m.t === 'overspeed');

  // junk values are dropped (no rate-limit excuse: use B, who hasn't alerted)
  b.j({ t: 'overspeed', kmh: 900 });
  b.j({ t: 'overspeed', kmh: -5 });
  b.j({ t: 'overspeed', kmh: 'zoom' });
  await a.expectNone((m) => m.t === 'overspeed');

  a.close();
  b.close();
});
