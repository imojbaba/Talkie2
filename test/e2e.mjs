/*
 * End-to-end smoke test: boots the real server, opens two Chromium pages with
 * a fake mic (test tone), joins both to the same channel, holds PTT on one
 * and asserts the other actually receives and schedules audio.
 *
 * Run: node test/e2e.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { server } = require('../server.js');
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

  const aliceMic = await alice.evaluate(() => window.__talkie.micOk);
  check('fake mic acquired on Alice', aliceMic);

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

  // PWA bits reachable
  for (const p of ['/manifest.webmanifest', '/sw.js', '/worklet.js', '/icons/icon-192.png', '/healthz']) {
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
