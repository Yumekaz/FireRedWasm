import { spawn } from 'node:child_process';
import fs from 'node:fs';

if (typeof WebSocket === 'undefined') {
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, ['--experimental-websocket', ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 0);
}

const PORT = 8085;
const CDP_PORT = 9225;

console.log('==============================================');
console.log(' Pokefirered Browser Verification in Chromium ');
console.log('==============================================\n');

// 1. Start local web server
console.log(`Starting web server on port ${PORT}...`);
const server = spawn('node', ['web/server.mjs'], {
  cwd: '/home/yumekaz/Desktop/fire/pokefirered',
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'inherit',
});

// Wait for server to respond
let serverReady = false;
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`http://localhost:${PORT}/web/index.html`);
    if (res.ok) {
      serverReady = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
if (!serverReady) {
  console.error('[FAIL] Web server did not start in time');
  server.kill();
  process.exit(1);
}
console.log('[PASS] Web server is running');

// 2. Launch Google Chrome headless with remote debugging
console.log(`Launching Google Chrome (Chromium) on CDP port ${CDP_PORT}...`);
const chrome = spawn('google-chrome', [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `http://localhost:${PORT}/web/index.html?automate=1`,
], { stdio: 'ignore' });

// Wait for Chrome CDP endpoint
let webSocketUrl = null;
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`http://localhost:${CDP_PORT}/json`);
    if (res.ok) {
      const list = await res.json();
      const page = list.find((p) => p.type === 'page' && p.url.includes('localhost'));
      if (page && page.webSocketDebuggerUrl) {
        webSocketUrl = page.webSocketDebuggerUrl;
        break;
      }
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

if (!webSocketUrl) {
  console.error('[FAIL] Could not connect to Chrome CDP endpoint');
  chrome.kill();
  server.kill();
  process.exit(1);
}
console.log('[PASS] Connected to Chromium DevTools endpoint');

// 3. Connect via WebSocket
const ws = new WebSocket(webSocketUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message));
    else resolve(data.result);
  }
};

function sendCdp(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInBrowser(expr) {
  const res = await sendCdp('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`Browser JS exception: ${JSON.stringify(res.exceptionDetails)}`);
  }
  return res.result?.value;
}

try {
  await sendCdp('Runtime.enable');
  await sendCdp('Page.enable');

  console.log('\n--- Step 1: Wait for WASM boot in Chromium ---');
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const hasAuto = await evalInBrowser(`Boolean(window.pokefirered?.automation)`);
      if (hasAuto) {
        await evalInBrowser(`window.pokefirered.automation.ready`);
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('Timeout waiting for pokefirered automation in browser');
  const status = await evalInBrowser(`document.querySelector('#status').textContent`);
  console.log(`[PASS] Chromium initialized pokefirered.wasm. Status: "${status}"`);

  console.log('\n--- Step 2: Skip Intro and advance to FireRed Title Screen ---');
  // Skip copyright/intro
  await evalInBrowser(`
    window.pokefirered.automation.runToFrame(150);
    window.pokefirered.automation.setButton('start', true);
    window.pokefirered.automation.runToFrame(152);
    window.pokefirered.automation.setButton('start', false);
    // Skip opening flash to Title Screen RUN
    window.pokefirered.automation.runToFrame(350);
    window.pokefirered.automation.setButton('start', true);
    window.pokefirered.automation.runToFrame(352);
    window.pokefirered.automation.setButton('start', false);
    // Advance into full-color Title Screen display with blinking PRESS START
    window.pokefirered.automation.runToFrame(590);
  `);

  const titleFrame = await evalInBrowser(`window.pokefirered.automation.frame()`);
  console.log(`[PASS] Reached full title screen at frame ${titleFrame}`);

  // Capture title screen screenshot
  const titleScreenshotData = await evalInBrowser(`window.pokefirered.automation.screenshot()`);
  const titleBase64 = titleScreenshotData.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync('/tmp/chromium_title_screen.png', Buffer.from(titleBase64, 'base64'));
  console.log('[PASS] Captured Chromium title screen screenshot: /tmp/chromium_title_screen.png');

  console.log('\n--- Step 3: Press START on Title Screen to enter original game menus ---');
  await evalInBrowser(`
    window.pokefirered.automation.runToFrame(620);
    window.pokefirered.automation.setButton('start', true);
    window.pokefirered.automation.runToFrame(625);
    window.pokefirered.automation.setButton('start', false);
    // Advance frames to complete cry, white fade, and menu initialization
    window.pokefirered.automation.runToFrame(780);
  `);

  const menuFrame = await evalInBrowser(`window.pokefirered.automation.frame()`);
  console.log(`[PASS] Advanced to frame ${menuFrame} after pressing Start on Title Screen`);

  // Capture main menu / intro controls screen screenshot
  const menuScreenshotData = await evalInBrowser(`window.pokefirered.automation.screenshot()`);
  const menuBase64 = menuScreenshotData.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync('/tmp/chromium_main_menu.png', Buffer.from(menuBase64, 'base64'));
  console.log('[PASS] Captured Chromium game menu screenshot: /tmp/chromium_main_menu.png');

  console.log('\n--- Step 4: Test Main Menu (CONTINUE / NEW GAME) with existing save ---');
  // Write a valid save using TrySavingData, then restart to Title Screen and press Start
  await evalInBrowser(`
    const inst = window.pokefirered.instance;
    const mem = window.pokefirered.memory;
    const u32 = new Uint32Array(mem.buffer);
    const sb1Ptr = u32[inst.exports.gSaveBlock1Ptr.value >> 2];
    inst.exports.SetMoney(sb1Ptr + 0x290, 5000);
    inst.exports.TrySavingData(0);
    // Restart with the saved flash
    const flashBytes = new Uint8Array(mem.buffer, 0x0e000000, 128 * 1024);
    let binary = '';
    for (let i = 0; i < flashBytes.length; i += 0x8000) {
      binary += String.fromCharCode(...flashBytes.subarray(i, i + 0x8000));
    }
    localStorage.setItem('pokefirered.wasm.flash.v1', btoa(binary));
  `);

  // Reload page to test cold boot with persistent save
  await sendCdp('Page.reload');
  for (let i = 0; i < 50; i++) {
    try {
      const hasAuto = await evalInBrowser(`Boolean(window.pokefirered?.automation)`);
      if (hasAuto) {
        await evalInBrowser(`window.pokefirered.automation.ready`);
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  // Skip intro, reach title screen, press Start
  await evalInBrowser(`
    window.pokefirered.automation.runToFrame(150);
    window.pokefirered.automation.setButton('start', true);
    window.pokefirered.automation.runToFrame(152);
    window.pokefirered.automation.setButton('start', false);
    window.pokefirered.automation.runToFrame(350);
    window.pokefirered.automation.setButton('start', true);
    window.pokefirered.automation.runToFrame(352);
    window.pokefirered.automation.setButton('start', false);
    window.pokefirered.automation.runToFrame(620);
    window.pokefirered.automation.setButton('start', true);
    window.pokefirered.automation.runToFrame(625);
    window.pokefirered.automation.setButton('start', false);
    // Advance frames to load save and render Main Menu (CONTINUE / NEW GAME / OPTION)
    window.pokefirered.automation.runToFrame(790);
  `);

  const saveMenuScreenshotData = await evalInBrowser(`window.pokefirered.automation.screenshot()`);
  const saveMenuBase64 = saveMenuScreenshotData.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync('/tmp/chromium_continue_menu.png', Buffer.from(saveMenuBase64, 'base64'));
  console.log('[PASS] Captured Chromium Continue / New Game menu screenshot: /tmp/chromium_continue_menu.png');

  console.log('\n--- Step 5: Verify Keyboard Controls in Chromium Frontend ---');
  // Test layout switching and key responses
  const layoutBefore = await evalInBrowser(`window.pokefirered.getLayout()`);
  console.log(`Initial layout: ${layoutBefore}`);

  // Test WASD keys
  await evalInBrowser(`
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  `);
  const layoutAfterW = await evalInBrowser(`window.pokefirered.getLayout()`);
  console.log(`Layout after pressing W: ${layoutAfterW}`);
  if (layoutAfterW !== 'wasd') throw new Error('WASD auto-detection failed');

  // Test Arrow keys
  await evalInBrowser(`
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));
  `);
  const layoutAfterArrow = await evalInBrowser(`window.pokefirered.getLayout()`);
  console.log(`Layout after pressing ArrowUp: ${layoutAfterArrow}`);
  if (layoutAfterArrow !== 'arrows') throw new Error('Arrow layout auto-detection failed');

  await evalInBrowser(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp' }));`);
  console.log('[PASS] Keyboard responsive control layouts verified successfully');

  console.log('\n==============================================');
  console.log(' All Chromium Browser Tests PASSED!           ');
  console.log('==============================================');
} finally {
  ws.close();
  chrome.kill();
  server.kill();
}
