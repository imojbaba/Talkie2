/*
 * End-to-end smoke test: boots the real server, opens two Chromium pages with
 * a fake mic (test tone), joins both to the same channel, holds PTT on one
 * and asserts the other actually receives and schedules audio.
 *
 * Run: node test/e2e.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

process.env.PUSH_DRYRUN = '1'; // never attempt real push sends from tests

const require = createRequire(import.meta.url);
const { server, wss } = require('../server.js');
const { chromium } = require('playwright-core');

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].filter(Boolean);

function findChromium() {
  for (const p of CANDIDATES) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return p;
      if (st.isDirectory()) {
        for (const sub of ['chrome-linux/chrome', 'chrome']) {
          const full = `${p}/${sub}`;
          if (fs.existsSync(full)) return full;
        }
      }
    } catch {}
  }
  throw new Error('No Chromium found; set CHROMIUM_PATH');
}

const fails = [];
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) fails.push(name);
}

await new Promise((res) => server.listen(0, '127.0.0.1', res));
const url = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: [
    '--no-sandbox',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function openPage(name) {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.fill('#name', name);
  await page.fill('#code', 'e2e-test');
  await page.click('#joinBtn');
  await page.waitForFunction(() => window.__talkie && window.__talkie.joined, null, {
    timeout: 15000,
  });
  return page;
}

try {
  const alice = await openPage('Alice');
  const bob = await openPage('Bob');

  await alice.waitForFunction(() => window.__talkie.members.length === 2, null, {
    timeout: 10000,
  });
  await bob.waitForFunction(() => window.__talkie.members.length === 2, null, {
    timeout: 10000,
  });
  check('both pages joined, roster shows 2 members', true);

  await alice.waitForFunction(() => window.__talkie.micOk, null, { timeout: 10000 });
  check('fake mic acquired on Alice', true);

  // Alice holds space to talk
  await alice.keyboard.down('Space');
  await alice.waitForFunction(() => window.__talkie.talk === 'live', null, {
    timeout: 8000,
  });
  check('Alice got the floor (talk=live)', true);

  await bob.waitForFunction(
    () => window.__talkie.speaker && window.__talkie.speaker.name === 'Alice',
    null,
    { timeout: 8000 }
  );
  check('Bob sees "Alice is talking"', true);

  // Bob tries to talk while Alice holds the floor -> denied
  await bob.keyboard.down('Space');
  await bob.waitForFunction(
    () => window.__talkie.lastDenied && window.__talkie.lastDenied.name === 'Alice',
    null,
    { timeout: 8000 }
  );
  await bob.keyboard.up('Space');
  check('Bob denied while channel busy', true);

  // Audio actually flowing
  await bob.waitForFunction(() => window.__talkie.stats.framesRx > 20, null, {
    timeout: 8000,
  });
  const stats = await bob.evaluate(() => ({
    rx: window.__talkie.stats.framesRx,
    energy: window.__talkie.stats.rxEnergy,
  }));
  check('Bob received audio frames', stats.rx > 20, `${stats.rx} frames`);
  check('received audio is non-silent', stats.energy > 1, `energy=${stats.energy.toFixed(1)}`);

  const txCount = await alice.evaluate(() => window.__talkie.stats.framesTx);
  check('Alice transmitted frames', txCount > 20, `${txCount} frames`);

  // Release
  await alice.keyboard.up('Space');
  await alice.waitForFunction(() => window.__talkie.talk === 'idle', null, { timeout: 5000 });
  await bob.waitForFunction(() => window.__talkie.speaker === null, null, { timeout: 5000 });
  check('floor released cleanly on both sides', true);

  // Now Bob can talk
  await bob.keyboard.down('Space');
  await bob.waitForFunction(() => window.__talkie.talk === 'live', null, { timeout: 8000 });
  await alice.waitForFunction(
    () => window.__talkie.speaker && window.__talkie.speaker.name === 'Bob',
    null,
    { timeout: 8000 }
  );
  await alice.waitForFunction(() => window.__talkie.stats.framesRx > 10, null, {
    timeout: 8000,
  });
  await bob.keyboard.up('Space');
  check('roles swap: Bob talks, Alice receives', true);

  // Alice holds 🎤 to record the channel roast; Bob must receive the clip.
  await alice.locator('#recBtn').dispatchEvent('pointerdown');
  await alice.waitForTimeout(1300);
  await alice.locator('#recBtn').dispatchEvent('pointerup');
  await alice.waitForFunction(
    () => window.__talkie.myClip && window.__talkie.myClip.length > 5000,
    null,
    { timeout: 8000 }
  );
  await bob.waitForFunction(
    () => window.__talkie.clips && window.__talkie.clips.size > 0,
    null,
    { timeout: 8000 }
  );
  check('recorded roast distributed to the channel', true);

  // A phone call takes the mic: the OS mutes the track -> Talkie holds.
  await alice.evaluate(() =>
    window.__talkie.stream.getAudioTracks()[0].dispatchEvent(new Event('mute'))
  );
  await alice.waitForFunction(() => window.__talkie.held === true, null, { timeout: 5000 });
  await alice.keyboard.down('Space');
  await alice.waitForTimeout(400);
  const heldTalk = await alice.evaluate(() => window.__talkie.talk);
  await alice.keyboard.up('Space');
  check('call hold blocks talking and playback', heldTalk === 'idle');
  await alice.evaluate(() =>
    window.__talkie.stream.getAudioTracks()[0].dispatchEvent(new Event('unmute'))
  );
  await alice.waitForFunction(() => window.__talkie.held === false, null, { timeout: 5000 });
  await alice.keyboard.down('Space');
  await alice.waitForFunction(() => window.__talkie.talk === 'live', null, { timeout: 8000 });
  await alice.keyboard.up('Space');
  await alice.waitForFunction(() => window.__talkie.talk === 'idle', null, { timeout: 5000 });
  check('auto-resume after the call ends', true);

  // Auto-reconnect: kill Bob's socket server-side, client must rejoin alone —
  // as the SAME member (stable uid identity), showing 🌙 away in the interim.
  const bobId = await bob.evaluate(() => window.__talkie.myId);
  for (const c of wss.clients) if (c.id === bobId) c.terminate();
  await alice.waitForFunction(
    () => window.__talkie.members.some((m) => m.away),
    null,
    { timeout: 10000 }
  );
  await alice.waitForFunction(
    () =>
      window.__talkie.members.length === 2 &&
      window.__talkie.members.every((m) => !m.away),
    null,
    { timeout: 12000 }
  );
  const bobId2 = await bob.evaluate(() => window.__talkie.myId);
  check(
    'auto-reconnect: away while gone, same identity on return',
    bobId2 === bobId,
    `${bobId} -> ${bobId2}`
  );
  await bob.waitForFunction(
    () => window.__talkie.joined && window.__talkie.members.length === 2,
    null,
    { timeout: 10000 }
  );
  check('auto-reconnect + rejoin after dropped socket', true);

  // 🌙 Backgrounding the app shows as away to the others, and clears again.
  await bob.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await alice.waitForFunction(
    () => window.__talkie.members.some((m) => m.p === 'bg'),
    null,
    { timeout: 8000 }
  );
  check('backgrounded rider shows 🌙 to the channel', true);
  await bob.waitForTimeout(1200); // outlive the server's 1 s away rate limit
  await bob.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await alice.waitForFunction(
    () => window.__talkie.members.every((m) => m.p !== 'bg'),
    null,
    { timeout: 8000 }
  );
  check('foregrounding clears the 🌙', true);

  // 📸 Photo share: sender + timestamp meta on every phone, owner can delete.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  await alice.setInputFiles('#photoInput', {
    name: 'trip.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await bob.waitForFunction(() => window.__talkie.photos.size === 1, null, { timeout: 10000 });
  await alice.waitForFunction(() => window.__talkie.photos.size === 1, null, { timeout: 10000 });
  const pmeta = await bob.evaluate(() => [...window.__talkie.photoMeta.values()][0]);
  check(
    'photo lands with sender + timestamp meta',
    !!pmeta && pmeta.name === 'Alice' && pmeta.at > 0,
    JSON.stringify(pmeta || null)
  );
  await alice.click('.photoStrip .ph');
  await alice.waitForFunction(
    () => !document.querySelector('#photoDel').hidden,
    null,
    { timeout: 5000 }
  );
  await alice.click('#photoDel'); // arms ("Sure?")
  await alice.click('#photoDel'); // confirms
  await bob.waitForFunction(() => window.__talkie.photos.size === 0, null, { timeout: 8000 });
  await alice.waitForFunction(() => window.__talkie.photos.size === 0, null, { timeout: 8000 });
  check('owner delete removes the photo for everyone', true);

  // Mic denied on first ask -> user stays in listen-only, then the PTT
  // button itself re-requests the mic and recovers.
  const ctxC = await browser.newContext();
  await ctxC.addInitScript(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let first = true;
    navigator.mediaDevices.getUserMedia = (c) => {
      if (first) {
        first = false;
        return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      }
      return orig(c);
    };
  });
  const carol = await ctxC.newPage();
  carol.on('pageerror', (e) => console.log('[Carol pageerror]', e.message));
  await carol.goto(url, { waitUntil: 'load' });
  await carol.fill('#name', 'Carol');
  await carol.fill('#code', 'e2e-mic');
  await carol.click('#joinBtn');
  await carol.waitForFunction(
    () => window.__talkie.joined && window.__talkie.micErr === 'NotAllowedError' && !window.__talkie.micOk,
    null,
    { timeout: 10000 }
  );
  check('mic denial leaves user joined in listen-only', true);
  const label = await carol.evaluate(() => document.querySelector('#pttLabel').textContent);
  check('PTT button invites enabling the mic', /ENABLE MIC/.test(label), label.replace('\n', ' '));
  await carol.locator('#ptt').dispatchEvent('pointerdown');
  await carol.locator('#ptt').dispatchEvent('pointerup');
  await carol.waitForFunction(() => window.__talkie.micOk, null, { timeout: 10000 });
  check('tapping PTT re-requests and enables the mic', true);
  await carol.keyboard.down('Space');
  await carol.waitForFunction(() => window.__talkie.talk === 'live', null, { timeout: 8000 });
  await carol.keyboard.up('Space');
  check('recovered mic can transmit', true);
  await ctxC.close();

  // Speed alerts: emulated GPS movement above the limit must broadcast the roast.
  const ctxD = await browser.newContext({
    permissions: ['geolocation'],
    geolocation: { latitude: 12.9716, longitude: 77.5946, accuracy: 10 },
  });
  const dave = await ctxD.newPage();
  dave.on('pageerror', (e) => console.log('[Dave pageerror]', e.message));
  await dave.goto(url, { waitUntil: 'load' });
  await dave.fill('#name', 'Dave');
  await dave.fill('#code', 'e2e-speed');
  await dave.click('#joinBtn');
  await dave.waitForFunction(() => window.__talkie.joined, null, { timeout: 15000 });
  // Set the channel-wide limit to 30 via the 🚦 dropdown (server round-trip).
  await dave.selectOption('#limitBtn', '30');
  await dave.waitForFunction(() => window.__talkie.limitKmh === 30, null, { timeout: 5000 });
  const limitVal = await dave.evaluate(() => document.querySelector('#limitBtn').value);
  check('channel-wide limit set to 30 via 🚦 dropdown', limitVal === '30', limitVal);
  await dave.waitForFunction(() => window.__talkie.lastFix != null, null, { timeout: 10000 });
  // "Drive": step the position ~44 m every 1.2 s (~130 km/h) until the roast fires.
  let lat = 12.9716;
  for (let i = 0; i < 8; i++) {
    await dave.waitForTimeout(1200);
    lat += 0.0004;
    await ctxD.setGeolocation({ latitude: lat, longitude: 77.5946, accuracy: 10 });
    if (await dave.evaluate(() => !!window.__talkie.lastGaali)) break;
  }
  await dave.waitForFunction(
    () => window.__talkie.lastGaali && window.__talkie.lastGaali.name === 'Dave',
    null,
    { timeout: 5000 }
  );
  const g = await dave.evaluate(() => window.__talkie.lastGaali);
  check('GPS overspeed detected and roast broadcast', g.kmh > 40, `${g.kmh} km/h`);
  await ctxD.close();

  // WebSocket-blocked phone: constructor throws -> auto compatibility mode.
  const ctxE = await browser.newContext();
  await ctxE.addInitScript(() => {
    window.WebSocket = class {
      constructor() {
        throw new Error('blocked by network');
      }
    };
  });
  const eve = await ctxE.newPage();
  eve.on('pageerror', (e) => console.log('[Eve pageerror]', e.message));
  await eve.goto(url, { waitUntil: 'load' });
  await eve.fill('#name', 'Eve');
  await eve.fill('#code', 'e2e-poll');
  await eve.click('#joinBtn');
  await eve.waitForFunction(() => window.__talkie.joined, null, { timeout: 15000 });
  const mode = await eve.evaluate(() => window.__talkie.transport);
  check('WebSocket-blocked page joins via compatibility mode', mode === 'poll', mode);
  const ctxF = await browser.newContext();
  const frank = await ctxF.newPage();
  frank.on('pageerror', (e) => console.log('[Frank pageerror]', e.message));
  await frank.goto(url, { waitUntil: 'load' });
  await frank.fill('#name', 'Frank');
  await frank.fill('#code', 'e2e-poll');
  await frank.click('#joinBtn');
  await frank.waitForFunction(
    () => window.__talkie.joined && window.__talkie.members.length === 2,
    null,
    { timeout: 15000 }
  );
  await frank.waitForFunction(() => window.__talkie.micOk, null, { timeout: 10000 });
  await frank.keyboard.down('Space');
  await eve.waitForFunction(() => window.__talkie.stats.framesRx > 10, null, {
    timeout: 12000,
  });
  await frank.keyboard.up('Space');
  check('ws -> compatibility-mode audio flows', true);
  await eve.waitForFunction(() => window.__talkie.micOk, null, { timeout: 10000 });
  // Long-poll delivers Frank's release a beat later; press only once Eve sees the channel clear
  // (mirrors the speaker===null guard in the ws roles-swap above).
  await eve.waitForFunction(() => window.__talkie.speaker === null, null, { timeout: 10000 });
  await eve.keyboard.down('Space');
  await eve.waitForFunction(() => window.__talkie.talk === 'live', null, { timeout: 10000 });
  await frank.waitForFunction(() => window.__talkie.stats.framesRx > 10, null, {
    timeout: 12000,
  });
  await eve.keyboard.up('Space');
  check('compatibility-mode -> ws audio flows', true);
  await ctxE.close();
  await ctxF.close();

  // PWA bits reachable
  for (const p of ['/manifest.webmanifest', '/sw.js', '/worklet.js', '/icons/icon-192.png', '/healthz', '/pushkey']) {
    const res = await alice.evaluate(async (u) => (await fetch(u)).status, p);
    check(`GET ${p} -> 200`, res === 200);
  }
} catch (err) {
  check('e2e flow completed', false, err.message);
} finally {
  await browser.close();
  server.close();
}

if (fails.length) {
  console.error(`\n${fails.length} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll e2e checks passed.');
process.exit(0);
