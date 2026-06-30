import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const execp = promisify(exec);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT || 9041);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ENV_FILE = join(__dirname, '.env');

// Load .env file if it exists (for runtime secrets)
try {
  const envContent = await readFile(ENV_FILE, 'utf-8');
  for (const line of envContent.split('\n')) {
    const [key, ...val] = line.split('=');
    if (key && val.length && !process.env[key.trim()]) {
      process.env[key.trim()] = val.join('=').replace(/^"|"$/g, '');
    }
  }
} catch {}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function assetsBinding() {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/' || pathname === '') pathname = '/index.html';
      const safe = normalize(pathname).replace(/^([.\/\\])+/, '/');
      const filePath = join(PUBLIC_DIR, safe);
      if (!filePath.startsWith(PUBLIC_DIR)) return new Response('Forbidden', { status: 403 });
      try {
        const s = await stat(filePath);
        if (s.isDirectory()) {
          const buf = await readFile(join(filePath, 'index.html'));
          return new Response(buf, { headers: { 'content-type': MIME['.html'] } });
        }
        const stream = createReadStream(filePath);
        return new Response(stream, {
          headers: { 'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream' }
        });
      } catch {
        if (!extname(safe)) {
          const buf = await readFile(join(PUBLIC_DIR, 'index.html'));
          return new Response(buf, { headers: { 'content-type': MIME['.html'] } });
        }
        return new Response('Not found', { status: 404 });
      }
    }
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
  });
}

async function doDeploy(body) {
  console.log('[deploy] git pull...');
  const pull = await execp('git pull --ff-only', { cwd: __dirname });
  console.log('[deploy] git pull done:', pull.stdout.trim());

  const secrets = body?.secrets || {};
  if (Object.keys(secrets).length > 0) {
    await writeEnvFile(secrets);
  }

  // Exit cleanly - Docker restart policy will bring us back up with new code
  console.log('[deploy] exiting for restart...');
  setTimeout(() => process.exit(0), 100);
  
  return { ok: true, git: pull.stdout.trim() };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // Webhook endpoint - accepts secrets in POST body
    if (url.pathname === '/deploy') {
      const token = url.searchParams.get('token') || req.headers['x-webhook-token'] || '';
      if (!WEBHOOK_SECRET) return json(res, 500, { error: 'WEBHOOK_SECRET not set on server' });
      if (token !== WEBHOOK_SECRET) return json(res, 401, { error: 'unauthorized' });
      
      const bodyText = await readBody(req);
      let body = {};
      try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}
      
      const result = await doDeploy(body);
      return json(res, result.ok ? 200 : 500, { 
        status: result.ok ? 'deployed' : 'error', 
        git: result.git,
        restart: result 
      });
    }
    
    // Health check
    if (url.pathname === '/health') {
      return json(res, 200, { status: 'ok', time: new Date().toISOString() });
    }

    // API and static - forward to worker
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const fullUrl = `${protocol}://${host}${req.url}`;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) headers[k] = v.join(', ');
      else if (v != null) headers[k] = String(v);
    }

    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req;
      init.duplex = 'half';
    }
    const request = new Request(fullUrl, init);

    const env = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ASSETS: assetsBinding(),
    };

    const mod = await import('./worker.js');
    const worker = mod.default;
    const response = await worker.fetch(request, env);

    res.statusCode = response.status;
    response.headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'content-encoding') res.setHeader(k, v);
    });
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error('handler error:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'internal', detail: String(err?.message || err) }));
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[radar] listening on :${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));