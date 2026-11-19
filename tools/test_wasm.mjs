// Automated verification of pokefirered.wasm
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const possiblePaths = [
  path.resolve('build/wasm/pokefirered.wasm'),
  path.resolve('pokefirered/build/wasm/pokefirered.wasm'),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build/wasm/pokefirered.wasm'),
];
const wasmPath = possiblePaths.find((p) => fs.existsSync(p));

console.log('====================================');
console.log(' Pokefirered WASM Verification Test ');
console.log('====================================\n');

if (!wasmPath) {
  console.error(`ERROR: pokefirered.wasm not found in search paths: ${possiblePaths.join(', ')}`);
  process.exit(1);
}

const stats = fs.statSync(wasmPath);
console.log(`[PASS] Found pokefirered.wasm (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

const bytes = fs.readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);

const memoryRef = { current: null };
let u8, u16, u32;

function updateViews() {
  if (!memoryRef.current) return;
  u8 = new Uint8Array(memoryRef.current.buffer);
  u16 = new Uint16Array(memoryRef.current.buffer);
  u32 = new Uint32Array(memoryRef.current.buffer);
}

function copy(src, dst, count, size, fill) {
  updateViews();
  for (let i = 0; i < count; i++) {
    const from = fill ? src : src + i * size;
    u8.set(u8.subarray(from, from + size), dst + i * size);
  }
}

function lz77(src, dst) {
  updateViews();
  const size = u8[src + 1] | (u8[src + 2] << 8) | (u8[src + 3] << 16);
  let s = src + 4;
  let d = dst;
  const end = dst + size;
  while (d < end) {
    const flags = u8[s++];
    for (let bit = 7; bit >= 0 && d < end; bit--) {
      if (flags & (1 << bit)) {
        const pair = (u8[s] << 8) | u8[s + 1];
        s += 2;
        let length = (pair >> 12) + 3;
        const disp = (pair & 0xfff) + 1;
        while (length-- && d < end) {
          u8[d] = u8[d - disp];
          d++;
        }
      } else {
        u8[d++] = u8[s++];
      }
    }
  }
}

function rl(src, dst) {
  updateViews();
  const size = u8[src + 1] | (u8[src + 2] << 8) | (u8[src + 3] << 16);
  let s = src + 4;
  let d = dst;
  const end = dst + size;
  while (d < end) {
    const flag = u8[s++];
    if (flag & 0x80) {
      let count = (flag & 0x7f) + 3;
      const value = u8[s++];
      while (count-- && d < end) u8[d++] = value;
    } else {
      let count = (flag & 0x7f) + 1;
      while (count-- && d < end) u8[d++] = u8[s++];
    }
  }
}

function affineTerms(xScale, yScale, rotation) {
  const angle = rotation * Math.PI * 2 / 0x10000;
  const sin = Math.sin(angle) * 256;
  const cos = Math.cos(angle) * 256;
  return {
    pa: cos * xScale / 256,
    pb: -sin * xScale / 256,
    pc: sin * yScale / 256,
    pd: cos * yScale / 256,
  };
}

function objAffineSet(src, dest, count, offset) {
  updateViews();
  for (let i = 0; i < count; i++) {
    const s = src + i * 6;
    const d = dest + i * offset * 4;
    const { pa, pb, pc, pd } = affineTerms(u16[s >> 1], u16[(s + 2) >> 1], u16[(s + 4) >> 1]);
    u16[d >> 1] = pa & 0xffff;
    u16[(d + offset) >> 1] = pb & 0xffff;
    u16[(d + offset * 2) >> 1] = pc & 0xffff;
    u16[(d + offset * 3) >> 1] = pd & 0xffff;
  }
}

function bgAffineSet(src, dest, count) {
  updateViews();
  for (let i = 0; i < count; i++) {
    const s = src + i * 20;
    const d = dest + i * 16;
    const texX = (u16[s >> 1] | (u16[(s + 2) >> 1] << 16)) | 0;
    const texY = (u16[(s + 4) >> 1] | (u16[(s + 6) >> 1] << 16)) | 0;
    const scrX = (u16[(s + 8) >> 1] << 16 >> 16);
    const scrY = (u16[(s + 10) >> 1] << 16 >> 16);
    const { pa, pb, pc, pd } = affineTerms(u16[(s + 12) >> 1], u16[(s + 14) >> 1], u16[(s + 16) >> 1]);
    const a = pa | 0;
    const b = pb | 0;
    const c = pc | 0;
    const e = pd | 0;
    u16[d >> 1] = a & 0xffff;
    u16[(d + 2) >> 1] = b & 0xffff;
    u16[(d + 4) >> 1] = c & 0xffff;
    u16[(d + 6) >> 1] = e & 0xffff;
    const resX = (texX - scrX * a - scrY * b) | 0;
    const resY = (texY - scrX * c - scrY * e) | 0;
    u16[(d + 8) >> 1] = resX & 0xffff;
    u16[(d + 10) >> 1] = (resX >> 16) & 0xffff;
    u16[(d + 12) >> 1] = resY & 0xffff;
    u16[(d + 14) >> 1] = (resY >> 16) & 0xffff;
  }
}

const env = {};
for (const item of WebAssembly.Module.imports(module)) {
  if (item.kind !== 'function') continue;
  env[item.name] = (...args) => {
    switch (item.name) {
      case 'CpuSet': return copy(args[0], args[1], args[2] & 0x1fffff, (args[2] >>> 26) & 1 ? 4 : 2, (args[2] >>> 24) & 1);
      case 'CpuFastSet': return copy(args[0], args[1], args[2] & 0x1fffff, 4, (args[2] >>> 24) & 1);
      case 'LZ77UnCompWram':
      case 'LZ77UnCompVram': return lz77(args[0], args[1]);
      case 'RLUnCompWram':
      case 'RLUnCompVram': return rl(args[0], args[1]);
      case 'BgAffineSet': return bgAffineSet(args[0], args[1], args[2]);
      case 'ObjAffineSet': return objAffineSet(args[0], args[1], args[2], args[3]);
      case 'Div': return args[1] ? (args[0] / args[1]) | 0 : 0;
      case 'Sqrt': return Math.sqrt(args[0]) | 0;
      case 'ArcTan2': return Math.round((Math.atan2(args[1], args[0]) * 0x10000) / (2 * Math.PI)) & 0xffff;
      default: return 0;
    }
  };
}

const instance = new WebAssembly.Instance(module, { env });
memoryRef.current = instance.exports.memory;
updateViews();
console.log('[PASS] Instantiated WebAssembly module successfully');

// Assert expected exports
const expectedExports = [
  'AgbMain', 'WasmRunFrame', 'WasmRenderFrame', 'WasmDisplayBuffer', 'WasmDisplayBufferSize',
  'NewGameInitData', 'TrySavingData', 'LoadGameSave', 'CB2_NewGame', 'CB2_InitBattle',
];
for (const exp of expectedExports) {
  if (typeof instance.exports[exp] !== 'function') {
    console.error(`[FAIL] Expected export function '${exp}' missing!`);
    process.exit(1);
  }
}
console.log(`[PASS] Verified required exports: ${expectedExports.join(', ')}`);

// Setup GBA state
const KEYINPUT = 0x04000130;
u16[KEYINPUT >> 1] = 0x03FF; // all buttons unpressed
u8.subarray(0x0e000000, 0x0e000000 + 128 * 1024).fill(0xFF); // 128KB flash
u16[0x04000020 >> 1] = 0x0100; // BG2PA
u16[0x04000026 >> 1] = 0x0100; // BG2PD
u16[0x04000030 >> 1] = 0x0100; // BG3PA
u16[0x04000036 >> 1] = 0x0100; // BG3PD
console.log('[PASS] Initialized GBA linear hardware address space (I/O, Keypad, 128KB Flash)');

// ==========================================
// TEST 1: AgbMain & Intro Sequence Rendering
// ==========================================
console.log('\n--- Test 1: AgbMain & Intro Sequence Rendering ---');
instance.exports.AgbMain();
console.log('[PASS] AgbMain() completed without exceptions');

console.log('Running 240 frames across intro sequence...');
let frameNonZeroCounts = [];
for (let f = 1; f <= 240; f++) {
  if (f === 150) {
    u16[KEYINPUT >> 1] = 0x03FF ^ (1 << 3); // Press START
  } else if (f === 155) {
    u16[KEYINPUT >> 1] = 0x03FF; // Release START
  }

  instance.exports.WasmRunFrame();

  if (f % 30 === 0) {
    instance.exports.WasmRenderFrame();
    const ptr = instance.exports.WasmDisplayBuffer();
    const size = instance.exports.WasmDisplayBufferSize();
    const fb = u8.subarray(ptr, ptr + size);
    let nz = 0;
    for (let i = 0; i < fb.length; i++) if (fb[i] !== 0) nz++;
    frameNonZeroCounts.push({ frame: f, nonZero: nz, size });
    console.log(`  Frame ${f.toString().padStart(3, ' ')}: active pixels: ${nz} / ${size} bytes`);
  }
}
const lastCheck = frameNonZeroCounts[frameNonZeroCounts.length - 1];
if (lastCheck.nonZero === 0) {
  console.error('[FAIL] Framebuffer remained blank!');
  process.exit(1);
}
console.log(`[PASS] Intro framebuffer actively rendered graphics (${lastCheck.nonZero} non-zero bytes)`);

// ==========================================
// TEST 2: NewGameInitData & Memory Safety
// ==========================================
console.log('\n--- Test 2: NewGameInitData & Memory Safety ---');
const defFlashPtr = instance.exports.DefaultFlash.value;
const defFlashInitial = u32[defFlashPtr >> 2];
if (defFlashInitial === 0) {
  console.error('[FAIL] DefaultFlash was uninitialized or 0 before NewGameInitData');
  process.exit(1);
}
instance.exports.NewGameInitData();
if (u32[defFlashPtr >> 2] === 0) {
  console.error('[FAIL] DefaultFlash was clobbered (zeroed) by NewGameInitData!');
  process.exit(1);
}
console.log('[PASS] DefaultFlash structure memory intact after NewGameInitData()');

// ==========================================
// TEST 3: Flash Save Write & Sector Integrity
// ==========================================
console.log('\n--- Test 3: Flash Save Write & Sector Integrity ---');
const sb1Ptr = u32[instance.exports.gSaveBlock1Ptr.value >> 2];
const moneyOffset = sb1Ptr + 0x290;
instance.exports.SetMoney(moneyOffset, 888888);
const saveResult = instance.exports.TrySavingData(0);
if (saveResult !== 1) {
  console.error(`[FAIL] TrySavingData(0) failed with status ${saveResult}`);
  process.exit(1);
}
console.log(`[PASS] TrySavingData(0) returned SAVE_STATUS_OK (${saveResult})`);

const FLASH_SECTOR_SIZE = 4096;
const SAVE_SECTORS_PER_SLOT = 14;
const SAVE_SECTOR_SIGNATURE = 0x08012025;
const FIRERED_SIZES = [
  0x0f24,
  0x0f80, 0x0f80, 0x0f80, 0x0ee8,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];

function readSaveU16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function readSaveU32(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; }
function saveSectorChecksum(bytes, sectorOffset, size) {
  let sum = 0;
  for (let i = 0; i < size; i += 4) {
    sum = (sum + readSaveU32(bytes, sectorOffset + i)) >>> 0;
  }
  return (((sum >>> 16) + (sum & 0xffff)) & 0xffff);
}

const flashBase = 0x0e000000;
let validSlot = -1;
for (let slot = 0; slot < 2; slot++) {
  let validFlags = 0;
  const first = slot * SAVE_SECTORS_PER_SLOT;
  for (let s = 0; s < SAVE_SECTORS_PER_SLOT; s++) {
    const off = flashBase + (first + s) * FLASH_SECTOR_SIZE;
    const id = readSaveU16(u8, off + 0x0ff4);
    const chk = readSaveU16(u8, off + 0x0ff6);
    const sig = readSaveU32(u8, off + 0x0ff8);
    const size = FIRERED_SIZES[id];
    if (sig === SAVE_SECTOR_SIGNATURE && size && chk === saveSectorChecksum(u8, off, size)) {
      validFlags |= (1 << id);
    }
  }
  if (validFlags === (1 << SAVE_SECTORS_PER_SLOT) - 1) {
    validSlot = slot;
    break;
  }
}
if (validSlot < 0) {
  console.error('[FAIL] No valid FireRed save slot found in Flash memory after saving!');
  process.exit(1);
}
console.log(`[PASS] Verified authentic FireRed 14-sector save slot ${validSlot} with matching checksums & signatures`);

// ==========================================
// TEST 4: Flash Save Reload Roundtrip
// ==========================================
console.log('\n--- Test 4: Flash Save Reload Roundtrip ---');
u32[moneyOffset >> 2] = 0;
if (instance.exports.GetMoney(moneyOffset) !== 0) {
  console.error('[FAIL] Money memory could not be wiped for test');
  process.exit(1);
}
const loadResult = instance.exports.LoadGameSave(0);
if (loadResult !== 1) {
  console.error(`[FAIL] LoadGameSave(0) failed with status ${loadResult}`);
  process.exit(1);
}
const restoredMoney = instance.exports.GetMoney(moneyOffset);
if (restoredMoney !== 888888) {
  console.error(`[FAIL] Reloaded money expected 888888, got ${restoredMoney}`);
  process.exit(1);
}
console.log(`[PASS] LoadGameSave(0) returned SAVE_STATUS_OK and accurately restored state (money: ${restoredMoney})`);

// ==========================================
// TEST 5: Overworld Map Initialization & Movement
// ==========================================
console.log('\n--- Test 5: Overworld Map Initialization & Movement ---');
instance.exports.CB2_NewGame();
// Re-read gSaveBlock1Ptr as SetSaveBlocksPointers dynamically relocates it
const currentSb1Ptr = u32[instance.exports.gSaveBlock1Ptr.value >> 2];
const startX = u16[currentSb1Ptr >> 1];
const startY = u16[(currentSb1Ptr + 2) >> 1];
console.log(`Initial player position: (${startX}, ${startY})`);

// Run frames with DOWN button pressed
u16[KEYINPUT >> 1] = 0x03FF ^ (1 << 7); // Press DOWN
for (let f = 0; f < 60; f++) instance.exports.WasmRunFrame();
u16[KEYINPUT >> 1] = 0x03FF; // Release DOWN
for (let f = 0; f < 30; f++) instance.exports.WasmRunFrame();

const movedX = u16[currentSb1Ptr >> 1];
const movedY = u16[(currentSb1Ptr + 2) >> 1];
console.log(`Player position after moving DOWN: (${movedX}, ${movedY})`);
if (movedY <= startY) {
  console.error(`[FAIL] Player did not advance position in overworld (start ${startY}, now ${movedY})`);
  process.exit(1);
}
instance.exports.WasmRenderFrame();
const owFbPtr = instance.exports.WasmDisplayBuffer();
const owFbSize = instance.exports.WasmDisplayBufferSize();
const owFb = u8.subarray(owFbPtr, owFbPtr + owFbSize);
let owNz = 0;
for (let i = 0; i < owFb.length; i++) if (owFb[i] !== 0) owNz++;
console.log(`[PASS] Overworld rendered ${owNz} active framebuffer bytes`);

// ==========================================
// TEST 6: Battle Engine Initialization & Frame Simulation
// ==========================================
console.log('\n--- Test 6: Battle Engine Initialization & Frame Simulation ---');
// Keep a snapshot of overworld framebuffer to verify genuine battle transition
const owSnapshot = new Uint8Array(owFb);

// Give player Charmander (species 4) and enemy Pidgey (species 16)
instance.exports.CreateMon(instance.exports.gPlayerParty.value, 4, 5, 32, 0, 0, 0, 0);
instance.exports.CreateMon(instance.exports.gEnemyParty.value, 16, 3, 32, 0, 0, 0, 0);
instance.exports.CB2_InitBattle();
for (let f = 0; f < 90; f++) instance.exports.WasmRunFrame();
instance.exports.WasmRenderFrame();
const bFbPtr = instance.exports.WasmDisplayBuffer();
const bFbSize = instance.exports.WasmDisplayBufferSize();
const bFb = u8.subarray(bFbPtr, bFbPtr + bFbSize);
let bNz = 0;
let bDiffs = 0;
for (let i = 0; i < bFb.length; i++) {
  if (bFb[i] !== 0) bNz++;
  if (bFb[i] !== owSnapshot[i]) bDiffs++;
}
if (bDiffs < 10000) {
  console.error(`[FAIL] Battle engine did not update framebuffer (only ${bDiffs} byte diffs from overworld)`);
  process.exit(1);
}
console.log(`[PASS] Battle engine actively rendered ${bNz} active framebuffer bytes (${bDiffs} diffs from overworld)`);

// ==========================================
// TEST 7: Mode 1 BG2 Affine Background & Oak Intro Regression Test
// ==========================================
console.log('\n--- Test 7: Mode 1 Affine Background & Oak Intro Regression Test ---');

// 1. Verify GBA GPU Register Manager boot defaults
// GBA hardware and BIOS specification: BG2PA, BG2PD, BG3PA, BG3PD reset to 0x0100 (1.0 identity scale)
const bg2paBuf = instance.exports.GetGpuReg(0x20); // REG_OFFSET_BG2PA
const bg2pdBuf = instance.exports.GetGpuReg(0x26); // REG_OFFSET_BG2PD
const bg3paBuf = instance.exports.GetGpuReg(0x30); // REG_OFFSET_BG3PA
const bg3pdBuf = instance.exports.GetGpuReg(0x36); // REG_OFFSET_BG3PD
const bg2paIO = u16[0x04000020 >> 1];
const bg2pdIO = u16[0x04000026 >> 1];

if (bg2paBuf !== 0x0100 || bg2pdBuf !== 0x0100 || bg3paBuf !== 0x0100 || bg3pdBuf !== 0x0100) {
  console.error(`[FAIL] Buffered GPU affine registers uninitialized: BG2PA=0x${bg2paBuf.toString(16)}, BG2PD=0x${bg2pdBuf.toString(16)}`);
  process.exit(1);
}
if (bg2paIO !== 0x0100 || bg2pdIO !== 0x0100) {
  console.error(`[FAIL] Hardware I/O affine registers uninitialized: BG2PA=0x${bg2paIO.toString(16)}, BG2PD=0x${bg2pdIO.toString(16)}`);
  process.exit(1);
}
console.log('[PASS] GBA GPU affine register manager & I/O space default to authentic identity scale (0x0100)');

// 2. Configure Mode 1 (affine BG2 enabled), matching Oak's intro configuration:
// DISPCNT: Mode 1 (1) | BG2 Enable (0x0400)
u16[0x04000000 >> 1] = 0x0401;
// BG2CNT: Priority 0, CharBase 0, ScreenBase 28 (0x1C00), Size 256x256 (0x4000)
u16[0x0400000C >> 1] = 0x5C00;

// Set up palette: index 0 = transparent, index 1 = solid white (0x7FFF)
u16[0x05000000 >> 1] = 0x0000;
u16[(0x05000000 + 2) >> 1] = 0x7FFF;

// Set up 8bpp tile 0 at CharBase 0 (0x06000000):
// Top-left pixel (0,0) is 0 (transparent margin), but pixel (1,0) and remainder are 1.
u8.fill(0, 0x06000000, 0x06000040);
u8.fill(1, 0x06000000 + 1, 0x06000040);

// Tilemap at ScreenBase 28 (0x0600E000): affine screen is 1 byte per entry (32x32 tiles)
u8.fill(0, 0x0600E000, 0x0600E400);

// Set authentic identity affine matrix (GBA hardware boot default)
u16[0x04000020 >> 1] = 0x0100; // BG2PA
u16[0x04000022 >> 1] = 0x0000; // BG2PB
u16[0x04000024 >> 1] = 0x0000; // BG2PC
u16[0x04000026 >> 1] = 0x0100; // BG2PD
u32[0x04000028 >> 2] = 0; // BG2X
u32[0x0400002C >> 2] = 0; // BG2Y

instance.exports.WasmRenderFrame();
const aFbPtr = instance.exports.WasmDisplayBuffer();
const aFb = u8.subarray(aFbPtr, aFbPtr + instance.exports.WasmDisplayBufferSize());
let aNzIdentity = 0;
for (let i = 0; i < aFb.length; i += 4) {
  if (aFb[i] !== 0 || aFb[i+1] !== 0 || aFb[i+2] !== 0) aNzIdentity++;
}

if (aNzIdentity === 0) {
  console.error('[FAIL] Mode 1 affine BG2 rendered 0 pixels with 0x0100 identity matrix (Oak invisible bug)!');
  process.exit(1);
}
console.log(`[PASS] Identity matrix (0x0100) rendered ${aNzIdentity} active pixels (Oak visible)`);

// 3. Verify authentic GBA hardware behavior for zero matrix (pa=0, pb=0, pc=0, pd=0):
// On real GBA hardware, zero scaling maps every pixel to texel (refX, refY), which is (0,0) (transparent)
u16[0x04000020 >> 1] = 0;
u16[0x04000026 >> 1] = 0;
instance.exports.WasmRenderFrame();
let aNzZero = 0;
for (let i = 0; i < aFb.length; i += 4) {
  if (aFb[i] !== 0 || aFb[i+1] !== 0 || aFb[i+2] !== 0) aNzZero++;
}
if (aNzZero !== 0) {
  console.error(`[FAIL] Zero affine matrix did not collapse to texel (0,0): rendered ${aNzZero} unexpected pixels`);
  process.exit(1);
}
console.log('[PASS] Zero affine matrix correctly collapses to reference texel without artificial fallback');

// Restore identity scale
u16[0x04000020 >> 1] = 0x0100;
u16[0x04000026 >> 1] = 0x0100;

console.log('\n====================================');
console.log(' All WebAssembly Tests PASSED!      ');
console.log('====================================');
