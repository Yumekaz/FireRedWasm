import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
let root = resolve(__dirname, '..');
if (existsSync(resolve(process.cwd(), 'pokefirered/web/index.html'))) {
  root = resolve(process.cwd(), 'pokefirered');
} else if (existsSync(resolve(process.cwd(), 'web/index.html'))) {
  root = resolve(process.cwd());
}

const requestedPort = Number(process.env.PORT || 8000);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.wasm', 'application/wasm'],
]);

function fileFor(url) {
  const pathname = new URL(url, `http://localhost:${requestedPort}`).pathname;
  const relative = pathname === '/' ? 'web/index.html' : pathname.slice(1);
  const file = resolve(root, normalize(relative));
  return file.startsWith(root) ? file : null;
}

createServer((req, res) => {
  const file = fileFor(req.url);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': types.get(extname(file)) || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(requestedPort, function () {
  const { port } = this.address();
  console.log(`pokefirered wasm server: http://localhost:${port}`);
});
