import { installInput } from './input.js';

const WIDTH = 240;
const HEIGHT = 160;
const REG = 0x04000000;
const KEYINPUT = 0x04000130;
const KEY_MASK = 0x03ff;
const FLASH_BASE = 0x0e000000;
const FLASH_SIZE = 128 * 1024;
const FLASH_SECTOR_SIZE = 4096;
const REG_OFFSET_WIN0H = 0x40;
const REG_OFFSET_WIN0V = 0x44;
const REG_OFFSET_WININ = 0x48;
const REG_OFFSET_WINOUT = 0x4a;
const REG_OFFSET_DMA0 = 0xb0;
const DMA_DEST_FIXED = 0x0040;
const DMA_DEST_RELOAD = 0x0060;
const DMA_REPEAT = 0x0200;
const DMA_START_HBLANK = 0x2000;
const DMA_ENABLE = 0x8000;
const SAVE_SECTORS_PER_SLOT = 14;
const SAVE_SECTOR_SIGNATURE = 0x08012025;
const SAVE_SECTOR_DATA_SIZES = [
  0x0f24,
  0x0f80, 0x0f80, 0x0f80, 0x0ee8,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];
const VANILLA_SAVE_SECTOR_DATA_SIZES = [
  0x0f24,
  0x0f80, 0x0f80, 0x0f80, 0x0ee8,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];
const SAVE_BLOCK2_SIZE = 0x0f24;
const SAVE_BLOCK1_SIZE = 0x3d68;
const SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET = 0x0f20;
const SAVE_BLOCK2_TRAINER_ID_OFFSET = 0x00a;
const SAVE_BLOCK1_COINS_OFFSET = 0x0294;
const SAVE_BAG_POCKETS = [
  [0x310, 42, 999],
  [0x3b8, 30, 999],
  [0x430, 13, 999],
  [0x464, 58, 999],
  [0x54c, 43, 999],
];
const SAVE_STORAGE_KEY = 'pokefirered.wasm.flash.v1';
const SAVE_FLUSH_INTERVAL_MS = 1000;
const searchParams = new URLSearchParams(location.search);
const speedParam = searchParams.get('speed');
const automate = searchParams.get('automate') === '1';
export const handheld = matchMedia('(pointer: coarse) and (hover: none)');
export const usesLocalFile = document.body.dataset.runtime === 'local-file';
const MIN_SPEED = 0.1;
const MAX_SPEED = 1000;
const FAST_FRAME_BUDGET_MS = 16;
const GBA_FPS = 16777216 / 280896; // ~59.7275005696 Hz
const GBA_FRAME_MS = 1000 / GBA_FPS; // ~16.7427062988 ms

const buttons = {
  a: 1 << 0,
  b: 1 << 1,
  select: 1 << 2,
  start: 1 << 3,
  right: 1 << 4,
  left: 1 << 5,
  up: 1 << 6,
  down: 1 << 7,
  r: 1 << 8,
  l: 1 << 9,
};

const canvas = document.querySelector('#screen');
const statusEl = document.querySelector('#status');
const speedSelect = document.querySelector('#speed-select');
const speedValue = document.querySelector('#speed-value');
const fullscreenButton = document.querySelector('#fullscreen');
const shell = document.querySelector('.shell');
const downloadSaveButton = document.querySelector('#download-save');
const uploadSaveInput = document.querySelector('#upload-save');
const chooseSaveButton = document.querySelector('#choose-save');
const saveFeedback = document.querySelector('#save-feedback');
const settings = document.querySelector('#settings');
const screenState = document.querySelector('#screen-state');
const retry = document.querySelector('#retry');
const chooseModule = document.querySelector('#choose-module');
const moduleInput = document.querySelector('#module-file');
const ctx = canvas.getContext('2d');
let gameReady = false;
let image;
const pressed = new Set();
const pendingPresses = new Map();

let instance;
let memory;
let u8;
let u16;
let u32;
let statusText = 'loading wasm…';
let lastFpsUpdate = performance.now();
let lastTick = performance.now();
let renderedFrames = 0;
let emulatedFrames = 0;
let gameFrameAccumulator = 0;
let speed = 1;
let currentFrame = 0;
let lastSavedFlashHash = 0;
let lastSaveFlushTime = performance.now();
let wasmModulePromise;
let localModuleFile;
let bootId = 0;
let started = false;
let nextFrame;
let automationReady;
let resolveAutomationReady;
if (automate) {
  automationReady = new Promise((resolve) => { resolveAutomationReady = resolve; });
}

function refreshViews() {
  u8 = new Uint8Array(memory.buffer);
  u16 = new Uint16Array(memory.buffer);
  u32 = new Uint32Array(memory.buffer);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function flashBytes() {
  return u8.subarray(FLASH_BASE, FLASH_BASE + FLASH_SIZE);
}

function hashBytes(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function loadFlashSave(sourceBytes) {
  const flash = flashBytes();
  flash.fill(0xFF);

  if (sourceBytes?.length === FLASH_SIZE) {
    flash.set(normalizeSaveForCurrentBuild(sourceBytes) ?? sourceBytes);
  } else {
    try {
      const stored = localStorage.getItem(SAVE_STORAGE_KEY);
      if (stored) {
        const saved = base64ToBytes(stored);
        if (saved.length === FLASH_SIZE) {
          const normalized = normalizeSaveForCurrentBuild(saved);
          flash.set(normalized ?? saved);
          if (normalized && normalized !== saved) localStorage.setItem(SAVE_STORAGE_KEY, bytesToBase64(normalized));
        }
      }
    } catch {
      // Storage may be disabled; the game can still run with volatile flash.
    }
  }

  lastSavedFlashHash = hashBytes(flash);
}

function saveFlashIfChanged(force = false) {
  if (!u8) return;
  const now = performance.now();
  if (!force && now - lastSaveFlushTime < SAVE_FLUSH_INTERVAL_MS) return;
  lastSaveFlushTime = now;

  const flash = flashBytes();
  const hash = hashBytes(flash);
  if (!force && hash === lastSavedFlashHash) return;

  try {
    localStorage.setItem(SAVE_STORAGE_KEY, bytesToBase64(flash));
    lastSavedFlashHash = hash;
  } catch {
    // Keep running even if the browser refuses persistent storage.
  }
}

function downloadSave() {
  if (!u8) return;
  saveFlashIfChanged(true);
  const blob = new Blob([new Uint8Array(flashBytes())], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pokefirered.sav';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readSaveU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readSaveU32(bytes, offset) {
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function writeSaveU16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function saveSectorChecksum(bytes, offset, size) {
  let sum = 0;
  let i = 0;
  for (; i + 3 < size; i += 4) sum = (sum + readSaveU32(bytes, offset + i)) >>> 0;
  for (; i < size; i++) sum = (sum + (bytes[offset + i] << ((i & 3) * 8))) >>> 0;
  return ((sum >>> 16) + (sum & 0xffff)) & 0xffff;
}

function hasValidFireRedSaveSlot(bytes, slot, sectorDataSizes) {
  let validSectorFlags = 0;
  const firstSector = slot * SAVE_SECTORS_PER_SLOT;

  for (let i = 0; i < SAVE_SECTORS_PER_SLOT; i++) {
    const sectorOffset = (firstSector + i) * FLASH_SECTOR_SIZE;
    const id = readSaveU16(bytes, sectorOffset + 0x0ff4);
    const checksum = readSaveU16(bytes, sectorOffset + 0x0ff6);
    const signature = readSaveU32(bytes, sectorOffset + 0x0ff8);
    const dataSize = sectorDataSizes[id];

    if (signature === SAVE_SECTOR_SIGNATURE
      && dataSize !== undefined
      && checksum === saveSectorChecksum(bytes, sectorOffset, dataSize)) {
      validSectorFlags |= 1 << id;
    }
  }

  return validSectorFlags === (1 << SAVE_SECTORS_PER_SLOT) - 1;
}

function isValidFireRedSave(bytes, sectorDataSizes) {
  return hasValidFireRedSaveSlot(bytes, 0, sectorDataSizes)
    || hasValidFireRedSaveSlot(bytes, 1, sectorDataSizes);
}

function isValidCurrentBuildSave(bytes) {
  return isValidFireRedSave(bytes, SAVE_SECTOR_DATA_SIZES)
    || isValidFireRedSave(bytes, VANILLA_SAVE_SECTOR_DATA_SIZES);
}

function copyRange(dst, dstOffset, src, srcOffset, size) {
  dst.set(src.subarray(srcOffset, srcOffset + size), dstOffset);
}

function copyLegacyArray(dst, dstOffset, dstElementSize, src, srcOffset, srcElementSize, count) {
  for (let i = 0; i < count; i++) {
    copyRange(dst, dstOffset + i * dstElementSize, src, srcOffset + i * srcElementSize, srcElementSize);
  }
}

function readSlotSaveBlocks(bytes, slot, sectorDataSizes, saveBlock2Size, saveBlock1Size) {
  const saveBlock2 = new Uint8Array(saveBlock2Size);
  const saveBlock1 = new Uint8Array(saveBlock1Size);
  const firstSector = slot * SAVE_SECTORS_PER_SLOT;

  for (let i = 0; i < SAVE_SECTORS_PER_SLOT; i++) {
    const sectorOffset = (firstSector + i) * FLASH_SECTOR_SIZE;
    const id = readSaveU16(bytes, sectorOffset + 0x0ff4);
    const size = sectorDataSizes[id];
    if (size === undefined) continue;

    if (id === 0) {
      copyRange(saveBlock2, 0, bytes, sectorOffset, Math.min(size, saveBlock2.length));
    } else if (id >= 1 && id <= 4) {
      copyRange(saveBlock1, (id - 1) * 0x0f80, bytes, sectorOffset, Math.min(size, saveBlock1.length - (id - 1) * 0x0f80));
    }
  }

  return { saveBlock1, saveBlock2 };
}

function saveKeyScore(saveBlock1, key) {
  let score = (readSaveU32(saveBlock1, 0x0290) ^ key) <= 999999 ? 20 : -20;

  for (const [offset, count, maxQuantity] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const itemOffset = offset + i * 4;
      const itemId = readSaveU16(saveBlock1, itemOffset);
      const quantity = (readSaveU16(saveBlock1, itemOffset + 2) ^ key) & 0xffff;
      if (itemId === 0) score += quantity === 0 ? 1 : -1;
      else if (itemId < 377 && quantity > 0 && quantity <= maxQuantity) score += 3;
      else score -= 3;
    }
  }

  return score;
}

function isLikelyLegacyWasmSaveBlock(blocks) {
  const legacyKey = readSaveU32(blocks.saveBlock2, 0x0a8);
  const currentKey = readSaveU32(blocks.saveBlock2, SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET);
  if (legacyKey === currentKey) return false;
  return saveKeyScore(blocks.saveBlock1, legacyKey) > saveKeyScore(blocks.saveBlock1, currentKey) + 20;
}

function isPlausibleBagQuantity(itemId, quantity, maxQuantity) {
  if (itemId === 0) return quantity === 0;
  return itemId < 377 && quantity > 0 && quantity <= maxQuantity;
}

function bagQuantityKeyScore(saveBlock1, key) {
  let score = 0;
  const keyLow = key & 0xffff;

  for (const [offset, count, maxQuantity] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const itemOffset = offset + i * 4;
      const itemId = readSaveU16(saveBlock1, itemOffset);
      const quantity = (readSaveU16(saveBlock1, itemOffset + 2) ^ keyLow) & 0xffff;
      if (isPlausibleBagQuantity(itemId, quantity, maxQuantity)) score += itemId === 0 ? 2 : 5;
      else score += itemId === 0 ? -2 : -5;
    }
  }

  return score;
}

function staleBagQuantityKey(saveBlock1, currentKey) {
  const currentKeyLow = currentKey & 0xffff;
  const candidates = new Set();

  for (const [offset, count] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const itemOffset = offset + i * 4;
      if (readSaveU16(saveBlock1, itemOffset) === 0) {
        const rawQuantity = readSaveU16(saveBlock1, itemOffset + 2);
        if (rawQuantity !== currentKeyLow) candidates.add(rawQuantity);
      }
    }
  }

  const currentScore = bagQuantityKeyScore(saveBlock1, currentKeyLow);
  let bestKey = currentKeyLow;
  let bestScore = currentScore;
  for (const candidate of candidates) {
    const score = bagQuantityKeyScore(saveBlock1, candidate);
    if (score > bestScore) {
      bestKey = candidate;
      bestScore = score;
    }
  }

  return bestKey !== currentKeyLow && bestScore > currentScore + 100 && bestScore > 100 ? bestKey : null;
}

function reencryptSaveBlock1Hword(saveBlock1, offset, oldKey, newKey) {
  const value = (readSaveU16(saveBlock1, offset) ^ oldKey) & 0xffff;
  writeSaveU16(saveBlock1, offset, value ^ newKey);
}

function repairStaleBagEncryption(blocks) {
  const currentKey = readSaveU32(blocks.saveBlock2, SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET);
  const currentKeyLow = currentKey & 0xffff;
  const oldKey = staleBagQuantityKey(blocks.saveBlock1, currentKey);
  if (oldKey === null) return null;

  const saveBlock1 = new Uint8Array(blocks.saveBlock1);
  let didRepair = false;
  for (const [offset, count, maxQuantity] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const quantityOffset = offset + i * 4 + 2;
      const itemId = readSaveU16(saveBlock1, quantityOffset - 2);
      const rawQuantity = readSaveU16(saveBlock1, quantityOffset);
      const currentQuantity = (rawQuantity ^ currentKeyLow) & 0xffff;
      const oldQuantity = (rawQuantity ^ oldKey) & 0xffff;
      if (isPlausibleBagQuantity(itemId, currentQuantity, maxQuantity)
          || !isPlausibleBagQuantity(itemId, oldQuantity, maxQuantity)) {
        continue;
      }

      reencryptSaveBlock1Hword(saveBlock1, quantityOffset, oldKey, currentKeyLow);
      didRepair = true;
    }
  }

  const rawCoins = readSaveU16(saveBlock1, SAVE_BLOCK1_COINS_OFFSET);
  const currentCoins = (rawCoins ^ currentKeyLow) & 0xffff;
  const oldCoins = (rawCoins ^ oldKey) & 0xffff;
  if (oldCoins <= 9999 && (currentCoins > 9999 || rawCoins === oldKey)) {
    writeSaveU16(saveBlock1, SAVE_BLOCK1_COINS_OFFSET, oldCoins ^ currentKeyLow);
    didRepair = true;
  }

  return didRepair ? { saveBlock1, saveBlock2: blocks.saveBlock2 } : null;
}

function writeCurrentSaveSlot(out, source, slot, currentBlocks) {
  const firstSector = slot * SAVE_SECTORS_PER_SLOT;

  for (let i = 0; i < SAVE_SECTORS_PER_SLOT; i++) {
    const sectorOffset = (firstSector + i) * FLASH_SECTOR_SIZE;
    const id = readSaveU16(source, sectorOffset + 0x0ff4);
    const size = SAVE_SECTOR_DATA_SIZES[id];
    if (size === undefined) continue;

    out.fill(0, sectorOffset, sectorOffset + 0x0ff4);
    if (id === 0) {
      copyRange(out, sectorOffset, currentBlocks.saveBlock2, 0, size);
    } else if (id >= 1 && id <= 4) {
      copyRange(out, sectorOffset, currentBlocks.saveBlock1, (id - 1) * 0x0f80, size);
    } else {
      copyRange(out, sectorOffset, source, sectorOffset, size);
    }
    writeSaveU16(out, sectorOffset + 0x0ff6, saveSectorChecksum(out, sectorOffset, size));
  }
}

function repairStaleBagEncryptionSave(bytes) {
  const out = new Uint8Array(bytes);
  let didRepair = false;

  for (let slot = 0; slot < 2; slot++) {
    let sectorDataSizes = null;
    if (hasValidFireRedSaveSlot(bytes, slot, SAVE_SECTOR_DATA_SIZES)) sectorDataSizes = SAVE_SECTOR_DATA_SIZES;
    else if (hasValidFireRedSaveSlot(bytes, slot, VANILLA_SAVE_SECTOR_DATA_SIZES)) sectorDataSizes = VANILLA_SAVE_SECTOR_DATA_SIZES;
    if (!sectorDataSizes) continue;

    const blocks = readSlotSaveBlocks(bytes, slot, sectorDataSizes, SAVE_BLOCK2_SIZE, SAVE_BLOCK1_SIZE);
    const repaired = repairStaleBagEncryption(blocks);
    if (!repaired) continue;

    writeCurrentSaveSlot(out, bytes, slot, repaired);
    didRepair = true;
  }

  return didRepair ? out : null;
}

function normalizeSaveForCurrentBuild(bytes) {
  if (isValidCurrentBuildSave(bytes)) return bytes;

  const repaired = repairStaleBagEncryptionSave(bytes);
  if (repaired && isValidCurrentBuildSave(repaired)) return repaired;

  return null;
}

async function readWasmBytes() {
  if (usesLocalFile) return localModuleFile.arrayBuffer();
  const res = await fetch('/build/wasm/pokefirered.wasm', { cache: 'no-store' });
  if (!res.ok) throw new Error(`The local game module returned HTTP ${res.status}.`);
  return res.arrayBuffer();
}

async function wasmModule() {
  wasmModulePromise ??= readWasmBytes()
    .then(async (bytes) => ({ bytes, module: await WebAssembly.compile(bytes) }))
    .catch((error) => {
      wasmModulePromise = undefined;
      throw error;
    });
  return wasmModulePromise;
}

async function restartWithSave(bytes) {
  await boot(bytes);
}

async function uploadSave(file) {
  if (!file || !u8) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== FLASH_SIZE)
    throw new Error(`Choose a 128 KiB .sav file. This file contains ${bytes.length} bytes.`);
  const normalized = normalizeSaveForCurrentBuild(bytes);
  if (!normalized)
    throw new Error('This file does not contain a valid FireRed save slot.');

  lastSavedFlashHash = hashBytes(normalized);
  localStorage.setItem(SAVE_STORAGE_KEY, bytesToBase64(normalized));
  await restartWithSave(normalized);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readPreference(key, fallback) {
  try { return localStorage.getItem(`pokefirered.frontend.${key}`) ?? fallback; }
  catch { return fallback; }
}

function writePreference(key, value) {
  try { localStorage.setItem(`pokefirered.frontend.${key}`, value); }
  catch { /* The setting still applies to this tab. */ }
}

function setSpeed(value) {
  speed = value === Infinity ? Infinity : clamp(value, MIN_SPEED, MAX_SPEED);
  const choice = speed === Infinity ? 'unlimited' : String(speed);
  const label = speed === Infinity ? 'Unlimited' : `${Number(speed.toFixed(2))}×`;
  speedValue.textContent = label;
  speedSelect.querySelector('[data-custom]')?.remove();
  if (![...speedSelect.options].some(option => option.value === choice)) {
    const option = new Option(label, choice);
    option.dataset.custom = '';
    speedSelect.add(option);
  }
  speedSelect.value = choice;
}

function resetFpsCounters() {
  lastFpsUpdate = performance.now();
  renderedFrames = 0;
  emulatedFrames = 0;
  gameFrameAccumulator = 0;
}

function initialSpeed() {
  const value = speedParam ?? readPreference('speed', '1');
  if (value === '0' || value === 'unlimited') return Infinity;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function updateFullscreenButton() {
  const active = document.fullscreenElement === shell;
  document.querySelector('#fullscreen-label').textContent = active ? 'Exit fullscreen' : 'Fullscreen';
  fullscreenButton.title = active ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
}

export async function toggleFullscreen({ quiet = false } = {}) {
  try {
    if (document.fullscreenElement === shell) {
      await document.exitFullscreen();
    } else {
      await shell.requestFullscreen();
      if (document.fullscreenElement !== shell) return;
      if (shell.hidden) {
        await document.exitFullscreen();
        return;
      }
      if (handheld.matches) {
        try {
          await screen.orientation?.lock?.('landscape');
        } catch {
          // Keep the player usable when the browser only supports manual rotation.
        }
      }
    }
    if (gameReady && !shell.hidden && !settings.open) canvas.focus({ preventScroll: true });
  } catch (error) {
    if (quiet) return;
    console.warn(error);
    showPlayerFeedback('Fullscreen is unavailable in this browser or window.');
  }
}

function refreshFrameImage() {
  const ptr = instance.exports.WasmDisplayBuffer();
  const size = instance.exports.WasmDisplayBufferSize();
  image = new ImageData(new Uint8ClampedArray(memory.buffer, ptr, size), WIDTH, HEIGHT);
}

function render() {
  instance.exports.WasmRenderFrame();
  ctx.putImageData(image, 0, 0);
}

function copy(src, dst, count, size, fill) {
  for (let i = 0; i < count; i++) {
    const from = fill ? src : src + i * size;
    u8.set(u8.subarray(from, from + size), dst + i * size);
  }
}

function lz77(src, dst) {
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

function readCString(ptr) {
  let out = '';
  while (u8[ptr]) out += String.fromCharCode(u8[ptr++]);
  return out;
}

function readS16(ptr) {
  return u16[ptr >> 1] << 16 >> 16;
}

function readS32(ptr) {
  return (u16[ptr >> 1] | (u16[(ptr + 2) >> 1] << 16)) | 0;
}

function writeS16(ptr, value) {
  u16[ptr >> 1] = value & 0xffff;
}

function writeS32(ptr, value) {
  u16[ptr >> 1] = value & 0xffff;
  u16[(ptr + 2) >> 1] = (value >> 16) & 0xffff;
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

function bgAffineSet(src, dest, count) {
  for (let i = 0; i < count; i++) {
    const s = src + i * 20;
    const d = dest + i * 16;
    const texX = readS32(s);
    const texY = readS32(s + 4);
    const scrX = readS16(s + 8);
    const scrY = readS16(s + 10);
    const { pa, pb, pc, pd } = affineTerms(readS16(s + 12), readS16(s + 14), u16[(s + 16) >> 1]);
    const a = pa | 0;
    const b = pb | 0;
    const c = pc | 0;
    const e = pd | 0;
    writeS16(d, a);
    writeS16(d + 2, b);
    writeS16(d + 4, c);
    writeS16(d + 6, e);
    writeS32(d + 8, (texX - scrX * a - scrY * b) | 0);
    writeS32(d + 12, (texY - scrX * c - scrY * e) | 0);
  }
}

function objAffineSet(src, dest, count, offset) {
  for (let i = 0; i < count; i++) {
    const s = src + i * 6;
    const d = dest + i * offset * 4;
    const { pa, pb, pc, pd } = affineTerms(readS16(s), readS16(s + 2), u16[(s + 4) >> 1]);
    writeS16(d, pa | 0);
    writeS16(d + offset, pb | 0);
    writeS16(d + offset * 2, pc | 0);
    writeS16(d + offset * 3, pd | 0);
  }
}

function copyOamMatrices(src, dest, dummy, oamCount, oamLimit, oamEnd) {
  const dummyWord0 = u32[dummy >> 2];
  const dummyWord1 = u32[(dummy + 4) >> 2];
  for (let entry = oamCount; entry < oamLimit; entry++) {
    const output = (dest + entry * 8) >> 2;
    u32[output] = dummyWord0;
    u32[output + 1] = dummyWord1;
  }
  const wholeMatrices = oamEnd >> 2;
  for (let matrix = 0; matrix < wholeMatrices; matrix++) {
    const source = (src + matrix * 8) >> 1;
    const output = (dest + matrix * 32 + 6) >> 1;
    u16[output] = u16[source];
    u16[output + 4] = u16[source + 1];
    u16[output + 8] = u16[source + 2];
    u16[output + 12] = u16[source + 3];
  }
  for (let entry = wholeMatrices * 4; entry < oamEnd; entry++) {
    u16[(dest + entry * 8 + 6) >> 1] = u16[(src + entry * 2) >> 1];
  }
}

function importsFor(module) {
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
        case 'WasmCopyOamMatrices': return copyOamMatrices(args[0], args[1], args[2], args[3], args[4], args[5]);
        case 'Div': return args[1] ? (args[0] / args[1]) | 0 : 0;
        case 'Sqrt': return Math.sqrt(args[0]) | 0;
        case 'strcmp': return readCString(args[0]).localeCompare(readCString(args[1]));
        default: return 0;
      }
    };
  }
  return { env };
}

function writeKeys() {
  let held = 0;
  for (const key of pressed) held |= buttons[key] || 0;
  for (const key of pendingPresses.keys()) held |= buttons[key] || 0;
  u16[KEYINPUT >> 1] = KEY_MASK ^ held;
}

function stepPendingPresses() {
  for (const [key, frames] of pendingPresses) {
    if (frames <= 1) pendingPresses.delete(key);
    else pendingPresses.set(key, frames - 1);
  }
}

function setPressed(name, isPressed) {
  if (isPressed) {
    pressed.add(name);
    pendingPresses.set(name, 1);
  } else {
    pressed.delete(name);
  }
  document.querySelectorAll(`[data-key='${name}']`).forEach((el) => el.classList.toggle('pressed', isPressed));
  if (u16) writeKeys();
}

function clearInputState() {
  pressed.clear();
  pendingPresses.clear();
  document.querySelectorAll('[data-key]').forEach((el) => el.classList.remove('pressed'));
  if (u16) writeKeys();
}

const input = installInput({
  canvas, dialog: settings, ready: () => gameReady, setPressed,
  clearState: clearInputState, toggleFullscreen,
});

window.addEventListener('blur', input.clear);
window.addEventListener('beforeunload', () => saveFlashIfChanged(true));
window.addEventListener('pagehide', () => {
  input.clear();
  saveFlashIfChanged(true);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    input.clear();
    saveFlashIfChanged(true);
  }
});

function showGameState(state, heading = '', detail = '') {
  gameReady = state === 'ready';
  if (!gameReady) input.clear();
  screenState.hidden = gameReady;
  screenState.dataset.state = state;
  document.querySelector('#state-title').textContent = heading;
  document.querySelector('#state-detail').textContent = detail;
  statusEl.dataset.state = state;
  const stateLabels = { ready: 'Ready', error: 'Unavailable', file: 'Game file needed', loading: 'Loading' };
  statusEl.textContent = stateLabels[state];
  retry.hidden = usesLocalFile || state !== 'error';
  chooseModule.hidden = !usesLocalFile || (state !== 'file' && state !== 'error');
  chooseSaveButton.disabled = !gameReady;
  downloadSaveButton.disabled = !gameReady;
}

function showGameError(error) {
  console.error(error);
  wasmModulePromise = undefined;
  const detail = usesLocalFile ? 'Choose a compatible pokefirered.wasm from this project’s local build.'
    : error?.message || 'The game could not start.';
  showGameState('error', 'Game build unavailable', detail);
  if (!shell.hidden && (document.activeElement === canvas || document.activeElement === document.body)) {
    (usesLocalFile ? chooseModule : retry).focus({ preventScroll: true });
  }
}

let feedbackTimer;
function showPlayerFeedback(message) {
  const feedback = document.querySelector('#player-feedback');
  feedback.textContent = message;
  feedback.hidden = false;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { feedback.hidden = true; }, 4500);
}

speedSelect.addEventListener('change', () => {
  setSpeed(speedSelect.value === 'unlimited' ? Infinity : Number(speedSelect.value));
  writePreference('speed', speedSelect.value);
  resetFpsCounters();
});
setSpeed(initialSpeed());

for (const [id, key, choices] of [
  ['display-scale', 'scale', ['fit', 'integer']],
  ['touch-mode', 'touch', ['auto', 'on', 'off']],
]) {
  const select = document.getElementById(id);
  const saved = readPreference(key, choices[0]);
  select.value = choices.includes(saved) ? saved : choices[0];
  shell.dataset[key] = select.value;
  select.addEventListener('change', () => {
    input.clear();
    shell.dataset[key] = select.value;
    writePreference(key, select.value);
  });
}

function updateIntegerScale() {
  const space = document.querySelector('#display').getBoundingClientRect();
  const density = window.devicePixelRatio || 1;
  const pixels = Math.floor(Math.min(space.width / WIDTH, space.height / HEIGHT) * density);
  canvas.style.setProperty('--integer-width', pixels > 0 ? `${pixels * WIDTH / density}px` : '100%');
}
new ResizeObserver(updateIntegerScale).observe(document.querySelector('#display'));
window.addEventListener('resize', updateIntegerScale);

fullscreenButton.addEventListener('click', () => toggleFullscreen());
document.addEventListener('fullscreenchange', () => {
  input.clear();
  updateFullscreenButton();
});
updateFullscreenButton();

document.querySelector('#open-settings').addEventListener('click', () => {
  input.clear();
  settings.showModal();
});

const confirmation = document.querySelector('#import-confirmation');
const confirmImport = document.querySelector('#confirm-import');
let selectedSave;
function dismissImport() {
  confirmation.hidden = true;
  selectedSave = undefined;
  uploadSaveInput.value = '';
}
settings.addEventListener('close', () => {
  dismissImport();
  if (gameReady && !shell.hidden) canvas.focus({ preventScroll: true });
});

downloadSaveButton.addEventListener('click', () => {
  if (!gameReady) return;
  downloadSave();
  saveFeedback.textContent = 'Save export started.';
});
chooseSaveButton.addEventListener('click', () => {
  uploadSaveInput.value = '';
  uploadSaveInput.click();
});
uploadSaveInput.addEventListener('change', () => {
  const file = uploadSaveInput.files[0];
  if (!file) return;
  selectedSave = file;
  saveFeedback.textContent = '';
  document.querySelector('#import-question').textContent =
    `Import ${file.name}? This replaces the current save and restarts the game.`;
  confirmation.hidden = false;
  confirmImport.focus();
});
document.querySelector('#cancel-import').addEventListener('click', () => {
  dismissImport();
  chooseSaveButton.focus();
});
confirmImport.addEventListener('click', async () => {
  const file = selectedSave;
  dismissImport();
  if (!file || !gameReady) return;
  chooseSaveButton.disabled = true;
  saveFeedback.textContent = 'Checking save file…';
  try {
    await uploadSave(file);
    saveFeedback.textContent = 'Save imported. The game restarted.';
  } catch (error) {
    if (!gameReady) showGameError(error);
    saveFeedback.textContent = error.message || 'The save could not be imported.';
  }
  chooseSaveButton.disabled = !gameReady;
  if (gameReady && settings.open) chooseSaveButton.focus();
});
retry.addEventListener('click', () => boot().catch(showGameError));
chooseModule.addEventListener('click', () => moduleInput.click());
moduleInput.addEventListener('change', () => {
  const file = moduleInput.files[0];
  moduleInput.value = '';
  if (!file) return;
  localModuleFile = file;
  wasmModulePromise = undefined;
  boot().catch(showGameError);
});

function fpsStatus(displayFps, gameFps) {
  return `${statusText} — Display FPS: ${displayFps}, Game FPS: ${gameFps} (${(gameFps / GBA_FPS).toFixed(1)}x)`;
}

async function boot(saveBytes) {
  bootId++;
  cancelAnimationFrame(nextFrame);
  nextFrame = undefined;
  showGameState('loading', 'Loading game', saveBytes
    ? 'Restarting with the imported save.'
    : usesLocalFile ? 'Opening the selected WebAssembly file.' : 'Connecting to the local WebAssembly build.');
  const { bytes, module } = await wasmModule();
  instance = await WebAssembly.instantiate(module, importsFor(module));
  memory = instance.exports.memory;
  window.pokefirered = {
    instance,
    memory,
    runFrames,
    setPressed,
    buttons,
    getLayout: input.getLayout,
    setLayout: input.setLayout,
    automation: automationApi(),
  };
  refreshViews();
  refreshFrameImage();
  loadFlashSave(saveBytes);
  writeKeys();
  u16[(REG + 0x20) >> 1] = 0x0100;
  u16[(REG + 0x26) >> 1] = 0x0100;
  u16[(REG + 0x30) >> 1] = 0x0100;
  u16[(REG + 0x36) >> 1] = 0x0100;
  instance.exports.AgbMain();
  currentFrame = 0;
  gameFrameAccumulator = 0;
  resetFpsCounters();
  statusText = `running — ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB wasm (~59.73 FPS)`;
  showGameState('ready');
  statusEl.title = fpsStatus(0, 0);
  if (!shell.hidden && !settings.open && (document.activeElement === document.body || document.activeElement === retry))
    canvas.focus({ preventScroll: true });
  if (automate) {
    render();
    resolveAutomationReady();
  } else syncGameView();
}

function updateFps(frameCount) {
  renderedFrames++;
  emulatedFrames += frameCount;

  const now = performance.now();
  const elapsed = now - lastFpsUpdate;
  if (elapsed < 1000) return;

  const fps = Math.round(renderedFrames * 1000 / elapsed);
  const gameFps = Math.round(emulatedFrames * 1000 / elapsed);
  statusEl.title = fpsStatus(fps, gameFps);
  lastFpsUpdate = now;
  renderedFrames = 0;
  emulatedFrames = 0;
}

function runFrames(frameCount, keyMask = 0) {
  for (let i = 0; i < frameCount; i++) {
    if (keyMask) u16[KEYINPUT >> 1] = KEY_MASK ^ keyMask;
    else writeKeys();
    instance.exports.WasmRunFrame();
    currentFrame++;
    stepPendingPresses();
  }
  u16[KEYINPUT >> 1] = KEY_MASK;
  saveFlashIfChanged();
}

function setAutomationButton(name, isPressed) {
  if (!Object.hasOwn(buttons, name)) throw new Error(`unknown button: ${name}`);
  pendingPresses.delete(name);
  if (isPressed) pressed.add(name);
  else pressed.delete(name);
  document.querySelectorAll(`[data-key='${name}']`).forEach((el) => el.classList.toggle('pressed', isPressed));
  writeKeys();
}

function runToFrame(targetFrame) {
  if (!Number.isInteger(targetFrame) || targetFrame < currentFrame) {
    throw new Error(`cannot run from frame ${currentFrame} to ${targetFrame}`);
  }
  runFrames(targetFrame - currentFrame);
  render();
  return currentFrame;
}

function readU32(ptr) {
  return (u16[ptr >> 1] | (u16[(ptr + 2) >> 1] << 16)) >>> 0;
}

function hblankDmaWin0HProbe() {
  const src = 0x0203ff00;
  const dma = REG + REG_OFFSET_DMA0;
  const callDmaStop0 = () => {
    if (typeof instance.exports.WasmDmaStop0 !== 'function') throw new Error('WasmDmaStop0 export unavailable');
    instance.exports.WasmDmaStop0();
  };
  const probeMode = (destMode) => {
    writeS32(dma, src);
    writeS32(dma + 4, REG + REG_OFFSET_WIN0H);
    writeS32(dma + 8, 1 | ((DMA_ENABLE | DMA_START_HBLANK | DMA_REPEAT | destMode) << 16));

    instance.exports.WasmRefreshHblankDmaGpuRegs();
    const activeLine0 = instance.exports.WasmWindowMask(5, 0);
    const activeLine1 = instance.exports.WasmWindowMask(5, 1);
    const activeLine2 = instance.exports.WasmWindowMask(5, 2);
    const activeCached = Boolean(instance.exports.WasmHblankDmaGpuRegActive(REG_OFFSET_WIN0H));

    callDmaStop0();
    const stoppedControl = u16[(dma + 10) >> 1];
    instance.exports.WasmRefreshHblankDmaGpuRegs();
    const stoppedLine0 = instance.exports.WasmWindowMask(5, 0);
    const stoppedLine1 = instance.exports.WasmWindowMask(5, 1);
    const stoppedLine2 = instance.exports.WasmWindowMask(5, 2);

    return {
      activeLine0,
      activeLine1,
      activeLine2,
      activeCached,
      stoppedControl,
      stoppedLine0,
      stoppedLine1,
      stoppedLine2,
      stoppedCached: Boolean(instance.exports.WasmHblankDmaGpuRegActive(REG_OFFSET_WIN0H)),
    };
  };
  const saved = {
    dispcnt: u16[REG >> 1],
    win0h: u16[(REG + REG_OFFSET_WIN0H) >> 1],
    win0v: u16[(REG + REG_OFFSET_WIN0V) >> 1],
    winin: u16[(REG + REG_OFFSET_WININ) >> 1],
    winout: u16[(REG + REG_OFFSET_WINOUT) >> 1],
    src0: u16[src >> 1],
    src1: u16[(src + 2) >> 1],
    dmaSrc: readU32(dma),
    dmaDest: readU32(dma + 4),
    dmaControl: readU32(dma + 8),
  };
  let result;

  try {
    u16[REG >> 1] = 0x2000;
    u16[(REG + REG_OFFSET_WIN0H) >> 1] = (20 << 8) | 30;
    u16[(REG + REG_OFFSET_WIN0V) >> 1] = HEIGHT;
    u16[(REG + REG_OFFSET_WININ) >> 1] = 0x3f;
    u16[(REG + REG_OFFSET_WINOUT) >> 1] = 0;
    u16[src >> 1] = 10;
    u16[(src + 2) >> 1] = (20 << 8) | 30;

    result = {
      fixed: probeMode(DMA_DEST_FIXED),
      reload: probeMode(DMA_DEST_RELOAD),
    };
  } finally {
    u16[REG >> 1] = saved.dispcnt;
    u16[(REG + REG_OFFSET_WIN0H) >> 1] = saved.win0h;
    u16[(REG + REG_OFFSET_WIN0V) >> 1] = saved.win0v;
    u16[(REG + REG_OFFSET_WININ) >> 1] = saved.winin;
    u16[(REG + REG_OFFSET_WINOUT) >> 1] = saved.winout;
    u16[src >> 1] = saved.src0;
    u16[(src + 2) >> 1] = saved.src1;
    writeS32(dma, saved.dmaSrc);
    writeS32(dma + 4, saved.dmaDest);
    writeS32(dma + 8, saved.dmaControl);
    instance.exports.WasmRefreshHblankDmaGpuRegs();
  }

  return result;
}

function automationState() {
  const saveBlock1 = readU32(instance.exports.gSaveBlock1Ptr.value);
  const saveBlock2 = readU32(instance.exports.gSaveBlock2Ptr.value);
  const playerAvatar = instance.exports.gPlayerAvatar.value;
  const objectEventId = u8[playerAvatar + 5];
  const objectEvent = instance.exports.gObjectEvents.value + objectEventId * 0x24;
  return {
    frame: currentFrame,
    trainerId: u16[(saveBlock2 + SAVE_BLOCK2_TRAINER_ID_OFFSET) >> 1],
    x: readS16(saveBlock1),
    y: readS16(saveBlock1 + 2),
    mapGroup: u8[saveBlock1 + 4],
    mapNum: u8[saveBlock1 + 5],
    elevation: u8[objectEvent + 0x0b] & 0x0f,
    objectX: readS16(objectEvent + 0x10),
    objectY: readS16(objectEvent + 0x12),
    objectEventId,
    palletTownOakState: instance.exports.VarGet(0x4050),
    oaksLabState: instance.exports.VarGet(0x4055),
    playersHouse2FState: instance.exports.VarGet(0x4056),
    rivalsHouseState: instance.exports.VarGet(0x4058),
    starterMon: instance.exports.VarGet(0x4031),
  };
}

function automationApi() {
  return {
    ready: automationReady,
    setButton: setAutomationButton,
    runToFrame,
    screenshot: () => canvas.toDataURL('image/png'),
    hblankDmaWin0HProbe,
    state: automationState,
    frame: () => currentFrame,
  };
}

function runFramesForTick(elapsedMs) {
  const start = performance.now();
  const frameBudgetMs = speed === Infinity ? elapsedMs : FAST_FRAME_BUDGET_MS;
  let frameCount;

  if (speed === Infinity) {
    gameFrameAccumulator = 0;
    frameCount = Infinity;
  } else {
    gameFrameAccumulator += speed * elapsedMs / GBA_FRAME_MS;
    frameCount = Math.floor(gameFrameAccumulator);
    gameFrameAccumulator -= frameCount;
    if (frameCount === 0) return 0;
  }

  let frames = 0;
  while (frames < frameCount && performance.now() - start < frameBudgetMs) {
    const batchSize = Math.min(frameCount - frames, 256);
    runFrames(batchSize);
    frames += batchSize;
  }
  return frames;
}

function tick(thisBootId, now) {
  nextFrame = undefined;
  if (thisBootId !== bootId) return;
  try {
    const elapsedMs = Math.min(now - lastTick, 100);
    lastTick = now;
    const frames = runFramesForTick(elapsedMs);
    render();
    updateFps(frames);
    nextFrame = requestAnimationFrame((nextNow) => tick(thisBootId, nextNow));
  } catch (error) {
    showGameError(error);
  }
}

export function syncGameView() {
  if (shell.hidden) {
    input.clear();
    cancelAnimationFrame(nextFrame);
    nextFrame = undefined;
    return;
  }

  if (!started) {
    started = true;
    if (usesLocalFile) {
      showGameState('file', 'Choose your game build', 'Open the pokefirered.wasm file from your local build. It stays on this device.');
      chooseModule.focus({ preventScroll: true });
    } else {
      boot().catch(showGameError);
    }
    return;
  }

  if (!automate && gameReady && nextFrame === undefined) {
    lastTick = performance.now();
    const thisBootId = bootId;
    nextFrame = requestAnimationFrame((now) => tick(thisBootId, now));
  }
}
