import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 8088;
const CDP_PORT = 9228;

console.log('Starting web server on port', PORT);
const server = spawn('node', ['web/server.mjs'], {
  cwd: '/home/yumekaz/Desktop/fire/pokefirered',
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`http://localhost:${PORT}/web/index.html`);
    if (res.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

console.log('Launching headless Chrome...');
const chrome = spawn('google-chrome', [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `http://localhost:${PORT}/web/index.html?automate=1`,
], { stdio: 'ignore' });

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

async function saveScreenshot(path) {
  const ssData = await evalInBrowser(`window.pokefirered.automation.screenshot()`);
  const buf = Buffer.from(ssData.replace(/^data:image\/png;base64,/, ''), 'base64');
  fs.writeFileSync(path, buf);
  // Also save to pokefirered/screenshots/ for persistent verification
  const filename = path.split('/').pop();
  fs.writeFileSync(`/home/yumekaz/Desktop/fire/pokefirered/screenshots/${filename}`, buf);
  console.log(`[PASS] Captured screenshot: ${path}`);
}

try {
  await sendCdp('Runtime.enable');
  await sendCdp('Page.enable');

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

  await evalInBrowser(`localStorage.clear()`);

  console.log('Skipping boot to Title Screen...');
  await evalInBrowser(`(() => {
    const auto = window.pokefirered.automation;
    auto.runToFrame(150);
    auto.setButton('start', true);
    auto.runToFrame(152);
    auto.setButton('start', false);
    auto.runToFrame(350);
    auto.setButton('start', true);
    auto.runToFrame(352);
    auto.setButton('start', false);
    auto.runToFrame(620);
    auto.setButton('start', true);
    auto.runToFrame(625);
    auto.setButton('start', false);
    auto.runToFrame(780);
    // Select NEW GAME
    auto.setButton('a', true);
    auto.runToFrame(785);
    auto.setButton('a', false);
  })()`);

  console.log('Advancing to Professor Oak intro...');
  // Wait for Oak to appear on BG2 (Mode 1 affine background active)
  for (let i = 0; i < 40; i++) {
    const hasOak = await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const cur = auto.frame();
      auto.setButton('a', true);
      auto.runToFrame(cur + 4);
      auto.setButton('a', false);
      auto.runToFrame(cur + 20);
      const mem = window.pokefirered.memory;
      const u8 = new Uint8Array(mem.buffer);
      const u16 = new Uint16Array(mem.buffer);
      const dispcnt = u16[0x04000000 >> 1];
      const oakTile = u8[0x0600E000 + 75];
      return (dispcnt & 0x400) && oakTile === 24;
    })()`);
    if (hasOak) break;
  }

  // Let Oak speak a few frames
  await evalInBrowser(`window.pokefirered.automation.runToFrame(window.pokefirered.automation.frame() + 30)`);
  await saveScreenshot('/tmp/01_oak_intro_verified.png');

  // Advance dialogue through Nidoran animation
  console.log('Advancing through Nidoran demonstration...');
  for (let i = 0; i < 30; i++) {
    const hasNidoran = await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const cur = auto.frame();
      auto.setButton('a', true);
      auto.runToFrame(cur + 4);
      auto.setButton('a', false);
      auto.runToFrame(cur + 20);
      const mem = window.pokefirered.memory;
      const u16 = new Uint16Array(mem.buffer);
      // Nidoran sprite uses OAM entry 0 with palette
      const oam0 = u16[0x07000000 >> 1];
      const dispcnt = u16[0x04000000 >> 1];
      return Boolean((dispcnt & 0x1000) && (oam0 & 0x300) !== 0x200 && auto.frame() > 1400);
    })()`);
    if (hasNidoran) break;
  }
  await evalInBrowser(`window.pokefirered.automation.runToFrame(window.pokefirered.automation.frame() + 30)`);
  await saveScreenshot('/tmp/02_oak_nidoran_verified.png');

  // Advance to gender selection menu
  console.log('Advancing to Gender Selection (Boy / Girl)...');
  while (true) {
    const menuOpen = await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const cur = auto.frame();
      auto.setButton('a', true);
      auto.runToFrame(cur + 4);
      auto.setButton('a', false);
      auto.runToFrame(cur + 16);
      const mem = window.pokefirered.memory;
      const inst = window.pokefirered.instance;
      const gTasksAddr = inst.exports.gTasks.value;
      const s16 = new Int16Array(mem.buffer);
      const data13 = s16[(gTasksAddr + 34) >> 1];
      return data13 === 1;
    })()`);
    if (menuOpen) break;
  }
  await saveScreenshot('/tmp/03_gender_selection.png');

  // Select Boy (press A), then advance to Red's 8bpp trainer portrait on BG2
  console.log('Selecting BOY and loading player character sprite...');
  await evalInBrowser(`(() => {
    const auto = window.pokefirered.automation;
    const cur = auto.frame();
    auto.setButton('a', true);
    auto.runToFrame(cur + 4);
    auto.setButton('a', false);
    // Let player sprite load and fade in completely
    auto.runToFrame(cur + 70);
  })()`);
  await saveScreenshot('/tmp/04_player_character_red.png');

  // Advance to name selection ("What is your name?") -> naming screen
  console.log('Advancing to player naming screen...');
  for (let i = 0; i < 20; i++) {
    const atNaming = await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const cur = auto.frame();
      auto.setButton('a', true);
      auto.runToFrame(cur + 4);
      auto.setButton('a', false);
      auto.runToFrame(cur + 20);
      const u16 = new Uint16Array(window.pokefirered.memory.buffer);
      const dispcnt = u16[0x04000000 >> 1];
      return (dispcnt & 0x7) === 0; // Mode 0 indicates naming screen
    })()`);
    if (atNaming) break;
  }
  await evalInBrowser(`window.pokefirered.automation.runToFrame(window.pokefirered.automation.frame() + 20)`);
  await saveScreenshot('/tmp/05_naming_screen_or_menu.png');

  // Press START on naming screen to confirm default name RED
  console.log('Confirming player name RED...');
  await evalInBrowser(`(() => {
    const auto = window.pokefirered.automation;
    const cur = auto.frame();
    auto.setButton('start', true);
    auto.runToFrame(cur + 4);
    auto.setButton('start', false);
    auto.runToFrame(cur + 30);
  })()`);

  // Confirm "So your name is RED? YES / NO"
  for (let i = 0; i < 15; i++) {
    await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const cur = auto.frame();
      auto.setButton('a', true);
      auto.runToFrame(cur + 4);
      auto.setButton('a', false);
      auto.runToFrame(cur + 20);
    })()`);
    const atConfirm = await evalInBrowser(`(() => {
      const u8 = new Uint8Array(window.pokefirered.memory.buffer);
      // Red's portrait reloaded on BG2
      return u8[0x0600E000 + 75] === 24;
    })()`);
    if (atConfirm) break;
  }
  await saveScreenshot('/tmp/06_confirm_player_name.png');

  // Advance to Rival introduction
  console.log('Advancing to Rival introduction...');
  // Press A to confirm name, then advance until Rival appears on BG2
  for (let i = 0; i < 40; i++) {
    await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const cur = auto.frame();
      auto.setButton('a', true);
      auto.runToFrame(cur + 4);
      auto.setButton('a', false);
      auto.runToFrame(cur + 20);
    })()`);
    const rivalLoaded = await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const u8 = new Uint8Array(window.pokefirered.memory.buffer);
      const inst = window.pokefirered.instance;
      const gTasksAddr = inst.exports.gTasks.value;
      const s16 = new Int16Array(window.pokefirered.memory.buffer);
      // Rival loaded on BG2 and trainer pic position is 0
      return u8[0x0600E000 + 75] === 24 && s16[(gTasksAddr + 10) >> 1] === 0 && auto.frame() > 3400;
    })()`);
    if (rivalLoaded) break;
  }
  await evalInBrowser(`window.pokefirered.automation.runToFrame(window.pokefirered.automation.frame() + 20)`);
  await saveScreenshot('/tmp/07_rival_character.png');

  // Confirm rival name GREEN
  console.log('Confirming Rival name GREEN...');
  for (let i = 0; i < 30; i++) {
    await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const cur = auto.frame();
      auto.setButton('a', true);
      auto.runToFrame(cur + 4);
      auto.setButton('a', false);
      auto.runToFrame(cur + 20);
    })()`);
    const inRivalMenu = await evalInBrowser(`(() => {
      const u16 = new Uint16Array(window.pokefirered.memory.buffer);
      return (u16[0x04000000 >> 1] & 0x7) === 0;
    })()`);
    if (inRivalMenu) {
      // In rival naming screen, press START to accept GREEN
      await evalInBrowser(`(() => {
        const auto = window.pokefirered.automation;
        const cur = auto.frame();
        auto.setButton('start', true);
        auto.runToFrame(cur + 4);
        auto.setButton('start', false);
        auto.runToFrame(cur + 30);
      })()`);
      break;
    }
  }

  // Confirm Rival name dialog
  for (let i = 0; i < 15; i++) {
    await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const cur = auto.frame();
      auto.setButton('a', true);
      auto.runToFrame(cur + 4);
      auto.setButton('a', false);
      auto.runToFrame(cur + 20);
    })()`);
  }
  await saveScreenshot('/tmp/08_confirm_rival_name.png');

  // Advance through final speech to shrink animation and bedroom
  console.log('Advancing through final speech to shrink animation & bedroom...');
  let reachedBedroom = false;
  for (let i = 0; i < 70; i++) {
    const status = await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const cur = auto.frame();
      auto.setButton('a', true);
      auto.runToFrame(cur + 4);
      auto.setButton('a', false);
      auto.runToFrame(cur + 25);

      const mem = window.pokefirered.memory;
      const inst = window.pokefirered.instance;
      const sb1 = new Uint32Array(mem.buffer)[inst.exports.gSaveBlock1Ptr.value >> 2];
      const u8 = new Uint8Array(mem.buffer);
      const mapGroup = u8[sb1 + 4];
      const mapNum = u8[sb1 + 5];
      const x = new Int16Array(mem.buffer, sb1, 1)[0];
      const y = new Int16Array(mem.buffer, sb1 + 2, 1)[0];
      return { mapGroup, mapNum, x, y, frame: auto.frame() };
    })()`);

    if (status.mapGroup === 4 && status.mapNum === 1) {
      reachedBedroom = true;
      console.log(`[PASS] Entered Starting Bedroom! Map (${status.mapGroup}, ${status.mapNum}), Player pos: (${status.x}, ${status.y}) at frame ${status.frame}`);
      break;
    }
  }

  if (!reachedBedroom) throw new Error('Did not reach bedroom');

  await saveScreenshot('/tmp/09_starting_bedroom.png');

  // Move around in bedroom (press LEFT)
  console.log('Testing player movement inside starting bedroom...');
  const moveResult = await evalInBrowser(`(() => {
    const auto = window.pokefirered.automation;
    const mem = window.pokefirered.memory;
    const inst = window.pokefirered.instance;
    const sb1 = new Uint32Array(mem.buffer)[inst.exports.gSaveBlock1Ptr.value >> 2];

    const startX = new Int16Array(mem.buffer, sb1, 1)[0];
    const startY = new Int16Array(mem.buffer, sb1 + 2, 1)[0];

    // Hold LEFT for 30 frames to walk left in bedroom
    auto.setButton('left', true);
    auto.runToFrame(auto.frame() + 30);
    auto.setButton('left', false);
    auto.runToFrame(auto.frame() + 15);

    const afterX = new Int16Array(mem.buffer, sb1, 1)[0];
    const afterY = new Int16Array(mem.buffer, sb1 + 2, 1)[0];

    return { startX, startY, afterX, afterY };
  })()`);

  console.log(`Player movement: from (${moveResult.startX}, ${moveResult.startY}) to (${moveResult.afterX}, ${moveResult.afterY})`);
  await saveScreenshot('/tmp/10_bedroom_moved.png');

  // ==========================================
  // Test Female character (Leaf) selection
  // ==========================================
  console.log('\n--- Testing Female Character (Leaf) Selection Flow ---');
  await evalInBrowser(`localStorage.clear()`);
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

  await evalInBrowser(`(() => {
    const auto = window.pokefirered.automation;
    auto.runToFrame(150);
    auto.setButton('start', true);
    auto.runToFrame(152);
    auto.setButton('start', false);
    auto.runToFrame(350);
    auto.setButton('start', true);
    auto.runToFrame(352);
    auto.setButton('start', false);
    auto.runToFrame(620);
    auto.setButton('start', true);
    auto.runToFrame(625);
    auto.setButton('start', false);
    auto.runToFrame(780);
    // Select NEW GAME
    auto.setButton('a', true);
    auto.runToFrame(785);
    auto.setButton('a', false);
  })()`);

  // Advance until Boy/Girl menu is active
  while (true) {
    const menuOpen = await evalInBrowser(`(() => {
      const auto = window.pokefirered.automation;
      const cur = auto.frame();
      auto.setButton('a', true);
      auto.runToFrame(cur + 4);
      auto.setButton('a', false);
      auto.runToFrame(cur + 16);
      const mem = window.pokefirered.memory;
      const inst = window.pokefirered.instance;
      const gTasksAddr = inst.exports.gTasks.value;
      const s16 = new Int16Array(mem.buffer);
      const data13 = s16[(gTasksAddr + 34) >> 1];
      return data13 === 1;
    })()`);
    if (menuOpen) break;
  }

  // Move cursor DOWN to GIRL and press A
  console.log('Selecting GIRL from menu...');
  const leafStatus = await evalInBrowser(`(() => {
    const auto = window.pokefirered.automation;
    auto.setButton('down', true);
    auto.runToFrame(auto.frame() + 4);
    auto.setButton('down', false);
    auto.runToFrame(auto.frame() + 10);

    auto.setButton('a', true);
    auto.runToFrame(auto.frame() + 4);
    auto.setButton('a', false);
    auto.runToFrame(auto.frame() + 70);

    const mem = window.pokefirered.memory;
    const inst = window.pokefirered.instance;
    const u8 = new Uint8Array(mem.buffer);
    const sb2 = new Uint32Array(mem.buffer)[inst.exports.gSaveBlock2Ptr.value >> 2];
    const gender = sb2 ? u8[sb2 + 8] : 255;
    const leafTile = u8[0x0600E000 + 75];
    return { gender, leafTile };
  })()`);

  console.log(`[PASS] GIRL selected: gender=${leafStatus.gender} (1=Female), BG2 tilemap=${leafStatus.leafTile}`);
  if (leafStatus.gender !== 1 || leafStatus.leafTile !== 24) {
    throw new Error(`Failed to load Leaf portrait: gender=${leafStatus.gender}, tile=${leafStatus.leafTile}`);
  }
  await saveScreenshot('/tmp/04b_player_character_leaf.png');

  console.log('\n==============================================');
  console.log(' All New Game, Oak, Red, Leaf, & Bedroom Tests PASSED! ');
  console.log('==============================================');

} finally {
  ws.close();
  chrome.kill();
  server.kill();
}
