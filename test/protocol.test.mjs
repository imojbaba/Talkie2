import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Long enough that deliberate test silences (expectNone windows) don't trip
// it now that the sweeper runs every 150 ms; short enough to test quickly.
process.env.SPEAKER_TIMEOUT_MS = '1200';
// Tiny trip-memory windows so presence/grace tests run in milliseconds.
process.env.GHOST_TTL_MS = '600';
process.env.ROOM_TTL_MS = '2000';
process.env.SWEEP_MS = '150';
process.env.SEQ_BASE = '0'; // deterministic photo/clip ids for assertions
process.env.PUSH_DRYRUN = '1'; // capture pushes in pushLog instead of sending

const require = createRequire(import.meta.url);
const { server, wss, pushLog } = require('../server.js');
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
  assert.ok(joinedA.ver >= 7); // server advertises its protocol version
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

test('disconnecting speaker releases the floor and goes "away", then expires', async () => {
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
  // A dropped rider is "away", not gone — status column intact, no leave toast.
  const roster = await b.next(
    (m) => m.t === 'roster' && m.members.some((x) => x.name === 'Alice' && x.away)
  );
  assert.equal(roster.members.filter((x) => !x.away).length, 1);
  await b.expectNone((m) => m.t === 'peer-leave');
  // ...and quietly drops off after GHOST_TTL_MS.
  await b.next((m) => m.t === 'roster' && m.members.length === 1, 3000);
  b.close();
});

test('same uid rejoining is the same member: id, status, no ghost twin', async () => {
  const uid = 'aabbccdd00112233';
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'uid-room', name: 'Alice', uid });
  const j1 = await a.next((m) => m.t === 'joined');
  assert.equal(j1.back, false);
  b.j({ t: 'join', room: 'uid-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');
  a.j({ t: 'status', text: '☕ chai' });
  await b.next((m) => m.t === 'status' && m.text === '☕ chai');
  // drain the roster that came with the status so it can't satisfy the
  // post-rejoin predicate below
  await b.next((m) => m.t === 'roster' && m.members.some((x) => x.status === '☕ chai'));

  a.terminate(); // phone died mid-trip
  await b.next((m) => m.t === 'roster' && m.members.some((x) => x.away));

  const a2 = await client();
  a2.j({ t: 'join', room: 'uid-room', name: 'Alice', uid });
  const j2 = await a2.next((m) => m.t === 'joined');
  assert.equal(j2.id, j1.id); // same person, same public id
  assert.equal(j2.back, true);
  // the rejoin roster: both live, and Alice's status survived the drop
  const roster = await b.next(
    (m) =>
      m.t === 'roster' &&
      m.members.length === 2 &&
      m.members.every((x) => !x.away) &&
      m.members.some((x) => x.name === 'Alice' && x.status === '☕ chai')
  );
  assert.equal(roster.members.find((x) => x.name === 'Alice').status, '☕ chai');
  await b.expectNone((m) => m.t === 'peer-join'); // no fake "joined" toast
  a2.close();
  b.close();
});

test('second session with the same uid replaces the first silently', async () => {
  const uid = 'ffee00112233aabb';
  const a1 = await client();
  const b = await client();
  a1.j({ t: 'join', room: 'takeover-room', name: 'Ana', uid });
  await a1.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'takeover-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');
  await b.next((m) => m.t === 'roster' && m.members.length === 2);

  const a2 = await client();
  const closed = new Promise((res) => a1.on('close', res));
  a2.j({ t: 'join', room: 'takeover-room', name: 'Ana', uid });
  const j2 = await a2.next((m) => m.t === 'joined');
  assert.equal(j2.back, true);
  // the losing session is told to stand down (so it won't reconnect-fight)…
  const replaced = await a1.next((m) => m.t === 'error' && m.code === 'replaced');
  assert.ok(replaced.message);
  await closed; // …and then terminated server-side
  const roster = await b.next(
    (m) => m.t === 'roster' && m.members.filter((x) => x.name === 'Ana').length === 1
  );
  assert.equal(roster.members.length, 2); // never two Anas
  a2.close();
  b.close();
});

test('explicit leave says goodbye immediately — no away ghost', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'bye-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'bye-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');
  await b.next((m) => m.t === 'roster' && m.members.length === 2);

  a.j({ t: 'leave' });
  const pl = await b.next((m) => m.t === 'peer-leave');
  assert.equal(pl.name, 'Alice');
  const roster = await b.next((m) => m.t === 'roster' && m.members.length === 1);
  assert.equal(roster.members[0].name, 'Bob');
  a.close();
  b.close();
});

test('away flag shows riders as backgrounded in the roster', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'moon-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'moon-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  a.j({ t: 'away', on: true });
  await b.next(
    (m) => m.t === 'roster' && m.members.some((x) => x.name === 'Alice' && x.p === 'bg')
  );
  await new Promise((r) => setTimeout(r, 1100)); // outlive the 1 s rate limit
  a.j({ t: 'away', on: false });
  await b.next(
    (m) => m.t === 'roster' && m.members.some((x) => x.name === 'Alice' && x.p === 'on')
  );
  a.close();
  b.close();
});

test('an emptied room keeps its limit and photos within the grace window', async () => {
  const MARK = 0xfffffffe;
  const a = await client();
  a.j({ t: 'join', room: 'grace-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  a.j({ t: 'limit', kmh: 80 });
  await a.next((m) => m.t === 'limit' && m.kmh === 80);
  const photo = Buffer.alloc(4 + 500);
  photo.writeUInt32LE(MARK, 0);
  photo.fill(0x42, 4);
  a.send(photo);
  await a.next((m) => m.t === 'photo');
  a.terminate(); // everyone gone — chai stop

  await new Promise((r) => setTimeout(r, 400)); // well inside ROOM_TTL_MS
  const c = await client();
  c.j({ t: 'join', room: 'grace-room', name: 'Cara' });
  await c.next((m) => m.t === 'joined');
  const roster = await c.next((m) => m.t === 'roster');
  assert.equal(roster.limit, 80); // the trip remembered
  assert.deepEqual(roster.photos, [1]);
  assert.equal(roster.photoMeta[0].name, 'Alice');
  const bin = await c.next((m) => m.binary && m.data.readUInt32LE(0) === MARK);
  assert.equal(bin.data.readUInt32LE(4), 1);
  c.close();
});

test('push: away/offline subscribed members get buzzed; foreground and left do not', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'push-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'push-room', name: 'Bob' });
  const jb = await b.next((m) => m.t === 'joined');
  b.j({
    t: 'push-sub',
    sub: { endpoint: 'https://push.example/bob', keys: { p256dh: 'k', auth: 'a' } },
  });
  await new Promise((r) => setTimeout(r, 60));

  // Bob is looking at the app: a ping must NOT buzz him.
  a.j({ t: 'ping-all' });
  await b.next((m) => m.t === 'ping-all');
  assert.equal(pushLog.filter((p) => p.id === jb.id).length, 0);

  // Bob backgrounds the app: a status buzzes him.
  b.j({ t: 'away', on: true });
  await a.next((m) => m.t === 'roster' && m.members.some((x) => x.p === 'bg'));
  a.j({ t: 'status', text: 'chalo chalte hai' });
  await b.next((m) => m.t === 'status');
  const buzzed = pushLog.filter((p) => p.id === jb.id);
  assert.equal(buzzed.length, 1);
  assert.ok(buzzed[0].payload.body.includes('chalo'));
  assert.equal(buzzed[0].payload.room, 'push-room');

  // Bob's phone drops entirely (away ghost): someone talking buzzes him too.
  b.terminate();
  await a.next((m) => m.t === 'roster' && m.members.some((x) => x.away));
  a.j({ t: 'ptt-start', tx: 12 });
  await a.next((m) => m.t === 'granted');
  a.j({ t: 'ptt-end', tx: 12 });
  assert.ok(pushLog.some((p) => p.id === jb.id && p.payload.title.includes('talking')));

  // Explicit leave unsubscribes: no buzz after a goodbye.
  const c = await client();
  c.j({ t: 'join', room: 'push-room', name: 'Cara' });
  const jc = await c.next((m) => m.t === 'joined');
  c.j({
    t: 'push-sub',
    sub: { endpoint: 'https://push.example/cara', keys: { p256dh: 'k', auth: 'a' } },
  });
  await new Promise((r) => setTimeout(r, 60));
  c.j({ t: 'leave' });
  await a.next((m) => m.t === 'peer-leave' && m.name === 'Cara');
  const photo = Buffer.alloc(4 + 100);
  photo.writeUInt32LE(0xfffffffe, 0);
  a.send(photo);
  await a.next((m) => m.t === 'photo');
  assert.equal(pushLog.filter((p) => p.id === jc.id).length, 0);

  a.close();
  c.close();
});

test('push-test buzzes yourself, rate-limited, needs a subscription', async () => {
  const a = await client();
  a.j({ t: 'join', room: 'selftest-room', name: 'Solo' });
  const j = await a.next((m) => m.t === 'joined');

  a.j({ t: 'push-test' }); // no subscription yet -> friendly error
  const err = await a.next((m) => m.t === 'error' && m.code === 'no-push');
  assert.ok(err.message.includes('🔔'));

  a.j({
    t: 'push-sub',
    sub: { endpoint: 'https://push.example/solo', keys: { p256dh: 'k', auth: 'a' } },
  });
  await new Promise((r) => setTimeout(r, 60));
  a.j({ t: 'push-test' });
  await new Promise((r) => setTimeout(r, 60));
  const mine = pushLog.filter((p) => p.id === j.id && p.payload.tag === 'talkie-test');
  assert.equal(mine.length, 1);
  assert.ok(mine[0].payload.title.includes('working'));

  a.j({ t: 'push-test' }); // inside the 15 s window -> dropped
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(pushLog.filter((p) => p.id === j.id && p.payload.tag === 'talkie-test').length, 1);
  a.close();
});

test('photo owner can delete it; others cannot', async () => {
  const MARK = 0xfffffffe;
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'del-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'del-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  const photo = Buffer.alloc(4 + 500);
  photo.writeUInt32LE(MARK, 0);
  photo.fill(0x42, 4);
  a.send(photo);
  const info = await b.next((m) => m.t === 'photo');
  assert.equal(info.metas[0].name, 'Alice');
  const id = info.ids[0];

  b.j({ t: 'photo-del', id }); // not the owner -> ignored
  await a.expectNone((m) => m.t === 'photo' && m.del);
  a.j({ t: 'photo-del', id });
  const del = await b.next((m) => m.t === 'photo' && m.del);
  assert.equal(del.del.id, id);
  assert.deepEqual(del.ids, []);
  a.close();
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
  assert.equal(gotB.v, 0); // first roast uses variant 0
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

  // the roast-rotation counter advances only on relayed alerts
  b.j({ t: 'overspeed', kmh: 92 });
  const g2 = await a.next((m) => m.t === 'overspeed');
  assert.equal(g2.kmh, 92);
  assert.equal(g2.v, 1);
  await b.next((m) => m.t === 'overspeed');

  a.close();
  b.close();
});

test('channel-wide limit syncs to everyone and gates overspeed', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'limit-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  const r0 = await a.next((m) => m.t === 'roster');
  assert.equal(r0.limit, 60); // room default
  b.j({ t: 'join', room: 'limit-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  a.j({ t: 'limit', kmh: 80 });
  const la = await a.next((m) => m.t === 'limit');
  assert.equal(la.kmh, 80);
  assert.equal(la.by.name, 'Alice');
  const lb = await b.next((m) => m.t === 'limit');
  assert.equal(lb.kmh, 80);

  // at/below the channel limit -> server drops it
  b.j({ t: 'overspeed', kmh: 70 });
  await a.expectNone((m) => m.t === 'overspeed');
  // above -> relayed
  b.j({ t: 'overspeed', kmh: 95 });
  const os = await a.next((m) => m.t === 'overspeed');
  assert.equal(os.kmh, 95);
  await b.next((m) => m.t === 'overspeed'); // consume B's own copy

  // limit off -> nothing relays, no matter how fast
  b.j({ t: 'limit', kmh: 0 });
  await a.next((m) => m.t === 'limit' && m.kmh === 0);
  a.j({ t: 'overspeed', kmh: 150 });
  await b.expectNone((m) => m.t === 'overspeed');

  a.close();
  b.close();
});

test('roast clip: upload, broadcast, late-joiner delivery', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'clip-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'clip-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  const clip = Buffer.alloc(4 + 3200); // txId 0 header + 0.1 s of PCM
  clip.writeUInt32LE(0, 0);
  for (let i = 0; i < 1600; i++) clip.writeInt16LE(((i % 32) - 16) * 500, 4 + i * 2);
  a.send(clip);

  const binB = await b.next((m) => m.binary && m.data.readUInt32LE(0) === 0);
  assert.equal(binB.data.length, clip.length + 4); // server prepends a clip id
  assert.equal(binB.data.readUInt32LE(4), 1);
  const info = await a.next((m) => m.t === 'clip');
  assert.equal(info.by.name, 'Alice');
  assert.deepEqual(info.ids, [1]);
  await b.next((m) => m.t === 'clip');

  const c = await client();
  c.j({ t: 'join', room: 'clip-room', name: 'Cara' });
  await c.next((m) => m.t === 'joined');
  const roster = await c.next((m) => m.t === 'roster');
  assert.deepEqual(roster.clips, [1]);
  const binC = await c.next((m) => m.binary && m.data.readUInt32LE(0) === 0);
  assert.equal(binC.data.length, clip.length + 4);

  // a second recording joins the rotation instead of replacing the first
  b.send(clip);
  const bin2 = await a.next((m) => m.binary && m.data.readUInt32LE(0) === 0);
  assert.equal(bin2.data.readUInt32LE(4), 2);
  const info2 = await b.next((m) => m.t === 'clip');
  assert.deepEqual(info2.ids, [1, 2]);

  a.close();
  b.close();
  c.close();
});

test('live speed relays to peers, rate-limited, no echo', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'livespeed', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'livespeed', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  a.j({ t: 'speed', kmh: 42 });
  const sp = await b.next((m) => m.t === 'speed');
  assert.equal(sp.kmh, 42);
  await a.expectNone((m) => m.t === 'speed'); // no echo to sender

  a.j({ t: 'speed', kmh: 55 }); // inside the 2 s window -> dropped
  b.j({ t: 'speed', kmh: 999 }); // junk -> dropped
  await b.expectNone((m) => m.t === 'speed' && m.kmh === 55);
  await a.expectNone((m) => m.t === 'speed');

  a.close();
  b.close();
});

test('HTTP fallback transport: join and interop with ws clients', async () => {
  const base = `http://127.0.0.1:${port}`;
  const a = await client();
  a.j({ t: 'join', room: 'poll-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');

  const open = await fetch(base + '/poll/open', { method: 'POST' });
  const { token } = await open.json();
  const post = (body, json) =>
    fetch(base + '/poll/send?t=' + token, {
      method: 'POST',
      headers: { 'Content-Type': json ? 'application/json' : 'application/octet-stream' },
      body,
    });
  const events = async () => {
    const r = await fetch(base + '/poll/events?t=' + token);
    const buf = Buffer.from(await r.arrayBuffer());
    const out = [];
    let off = 0;
    while (off + 5 <= buf.length) {
      const bin = buf[off] === 1;
      const len = buf.readUInt32LE(off + 1);
      off += 5;
      const d = buf.subarray(off, off + len);
      off += len;
      out.push(bin ? { binary: true, data: Buffer.from(d) } : JSON.parse(d.toString()));
    }
    return out;
  };

  await post(JSON.stringify({ t: 'join', room: 'poll-room', name: 'Pia' }), true);
  let got = [];
  for (let i = 0; i < 5 && !got.find((m) => m.t === 'joined'); i++) {
    got = got.concat(await events());
  }
  assert.ok(got.find((m) => m.t === 'joined'), 'poll client joined');
  await a.next((m) => m.t === 'roster' && m.members.length === 2);

  // ws -> poll audio
  a.j({ t: 'ptt-start', tx: 44 });
  await a.next((m) => m.t === 'granted');
  a.send(frame(44));
  let gotBin = null;
  for (let i = 0; i < 5 && !gotBin; i++) {
    gotBin = (await events()).find((m) => m.binary && m.data.readUInt32LE(0) === 44);
  }
  assert.ok(gotBin, 'poll client received relayed audio');
  a.j({ t: 'ptt-end', tx: 44 });

  // poll -> ws audio, via the batched [u32 len][payload] upstream format
  await post(JSON.stringify({ t: 'ptt-start', tx: 55 }), true);
  const f = frame(55);
  const batch = Buffer.alloc(4 + f.length);
  batch.writeUInt32LE(f.length, 0);
  f.copy(batch, 4);
  await post(batch, false);
  const rx = await a.next((m) => m.binary && m.data.readUInt32LE(0) === 55, 5000);
  assert.equal(rx.data.length, f.length);

  await fetch(base + '/poll/close?t=' + token, { method: 'POST' });
  const roster = await a.next((m) => m.t === 'roster' && m.members.length === 1);
  assert.equal(roster.members[0].name, 'Alice');
  a.close();
});

test('statuses broadcast, land in the roster, and rate-limit', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'status-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'status-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  a.j({ t: 'status', text: '☕ Chai break' });
  const st = await b.next((m) => m.t === 'status');
  assert.equal(st.name, 'Alice');
  assert.equal(st.text, '☕ Chai break');
  await b.next(
    (m) => m.t === 'roster' && m.members.some((x) => x.status === '☕ Chai break')
  );

  // second change inside the 2 s window is dropped
  a.j({ t: 'status', text: 'spam' });
  await b.expectNone((m) => m.t === 'status' && m.text === 'spam');

  a.close();
  b.close();
});

test('ping-all broadcasts with rate limit', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'ping-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'ping-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  a.j({ t: 'ping-all' });
  const p = await b.next((m) => m.t === 'ping-all');
  assert.equal(p.by.name, 'Alice');
  await a.next((m) => m.t === 'ping-all'); // sender gets it too
  a.j({ t: 'ping-all' }); // within 5 s -> dropped
  await b.expectNone((m) => m.t === 'ping-all');
  a.close();
  b.close();
});

test('polls: create, vote, live counts, creator-only end', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'poll-room2', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'poll-room2', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  a.j({ t: 'poll', q: 'chai ya khana?', a: 'chai', b: 'khana' });
  const pl = await b.next((m) => m.t === 'poll');
  assert.equal(pl.q, 'chai ya khana?');
  assert.equal(pl.by.name, 'Alice');
  await a.next((m) => m.t === 'poll');

  b.j({ t: 'vote', v: 0 });
  const v1 = await a.next((m) => m.t === 'votes');
  assert.deepEqual(v1.counts, [1, 0]);
  await b.next((m) => m.t === 'votes');
  a.j({ t: 'vote', v: 1 });
  const v2 = await b.next((m) => m.t === 'votes');
  assert.deepEqual(v2.counts, [1, 1]);
  await a.next((m) => m.t === 'votes');

  b.j({ t: 'poll-end' }); // not the creator -> ignored
  await a.expectNone((m) => m.t === 'poll-end');
  a.j({ t: 'poll-end' });
  const end = await b.next((m) => m.t === 'poll-end');
  assert.deepEqual(end.counts, [1, 1]);
  a.close();
  b.close();
});

test('location relays only while channel mapmode is on', async () => {
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'map-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'map-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  a.j({ t: 'loc', lat: 12.9716, lon: 77.5946 }); // mapOn is false -> dropped
  await b.expectNone((m) => m.t === 'loc');
  a.j({ t: 'mapmode', on: true });
  const mm = await b.next((m) => m.t === 'mapmode');
  assert.equal(mm.on, true);
  a.j({ t: 'loc', lat: 12.9716, lon: 77.5946 });
  const loc = await b.next((m) => m.t === 'loc');
  assert.equal(loc.lat, 12.9716);
  await a.expectNone((m) => m.t === 'loc'); // no echo to sender
  a.close();
  b.close();
});

test('photos: store, broadcast, late-joiner delivery', async () => {
  const MARK = 0xfffffffe;
  const a = await client();
  const b = await client();
  a.j({ t: 'join', room: 'photo-room', name: 'Alice' });
  await a.next((m) => m.t === 'joined');
  b.j({ t: 'join', room: 'photo-room', name: 'Bob' });
  await b.next((m) => m.t === 'joined');

  const photo = Buffer.alloc(4 + 2000);
  photo.writeUInt32LE(MARK, 0);
  photo.fill(0x5a, 4);
  a.send(photo);
  const rx = await b.next((m) => m.binary && m.data.readUInt32LE(0) === MARK);
  assert.equal(rx.data.readUInt32LE(4), 1); // photo id
  assert.equal(rx.data.length, photo.length + 4);
  const info = await b.next((m) => m.t === 'photo');
  assert.deepEqual(info.ids, [1]);

  const c = await client();
  c.j({ t: 'join', room: 'photo-room', name: 'Cara' });
  await c.next((m) => m.t === 'joined');
  const late = await c.next((m) => m.binary && m.data.readUInt32LE(0) === MARK);
  assert.equal(late.data.readUInt32LE(4), 1);
  const roster = await c.next((m) => m.t === 'roster');
  assert.deepEqual(roster.photos, [1]);
  a.close();
  b.close();
  c.close();
});
