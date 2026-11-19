import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const output = new URL('../build/vercel-site/', import.meta.url);
const source = new URL('../web/', import.meta.url);
const assets = ['app.js', 'audio.js', 'input.js', 'landing.js', 'landing.css', 'mobile.css', 'style.css'];

const html = await readFile(new URL('index.html', source), 'utf8');

await rm(output, { recursive: true, force: true });
const assetOutput = new URL('web/', output);
await mkdir(assetOutput, { recursive: true });
await Promise.all(assets.map(file => copyFile(new URL(file, source), new URL(file, assetOutput))));

// Copy screenshots for landing page preview
const screenshotsDir = new URL('../screenshots/', import.meta.url);
if (existsSync(screenshotsDir)) {
  await cp(screenshotsDir, new URL('screenshots/', output), { recursive: true });
}

// Copy WASM binary to supported paths
const wasmWebSource = new URL('pokefirered.wasm', source);
const wasmBuildSource = new URL('../build/wasm/pokefirered.wasm', import.meta.url);
const wasmFile = existsSync(wasmWebSource) ? wasmWebSource : existsSync(wasmBuildSource) ? wasmBuildSource : null;

if (wasmFile) {
  await copyFile(wasmFile, new URL('pokefirered.wasm', output));
  await copyFile(wasmFile, new URL('pokefirered.wasm', assetOutput));
  await mkdir(new URL('build/wasm/', output), { recursive: true });
  await copyFile(wasmFile, new URL('build/wasm/pokefirered.wasm', output));
  await writeFile(new URL('index.html', output), html);
  console.log('Built standalone playable FireRed game with bundled WASM in build/vercel-site.');
} else {
  await writeFile(new URL('index.html', output), html.replace('<body>', '<body data-runtime="local-file">'));
  console.log('Built static frontend (local-file mode) in build/vercel-site.');
}
