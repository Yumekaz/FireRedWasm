import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const output = new URL('../build/vercel-site/', import.meta.url);
const source = new URL('../web/', import.meta.url);
const assets = ['app.js', 'input.js', 'landing.js', 'landing.css', 'mobile.css', 'style.css'];

const html = await readFile(new URL('index.html', source), 'utf8');
if (!html.includes('<body>')) throw new Error('Could not mark the hosted player.');

await rm(output, { recursive: true, force: true });
const assetOutput = new URL('web/', output);
await mkdir(assetOutput, { recursive: true });
await Promise.all(assets.map(file => copyFile(new URL(file, source), new URL(file, assetOutput))));
await writeFile(new URL('index.html', output), html.replace('<body>', '<body data-runtime="local-file">'));
console.log('Built the static frontend in build/vercel-site.');
