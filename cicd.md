# Simple CI/CD Deployment Plan

## Architecture

```
GitHub push to main
    │
    ▼ GitHub Action: curl webhook
pd.iamcivic.info/deploy?token=SECRET  (via Cloudflare Tunnel)
    │
    ▼ Container "radar" on port 9041
    └─ git pull + self-restart
```

**One container (`radar`), one tunnel entry (`pd.iamcivic.info`), one webhook endpoint.**

---

## Files to Have in Repo (branch `ravi`)

### 1. `Dockerfile` (root)

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache git openssh-client
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev || true

COPY . .

ENV PORT=9041
EXPOSE 9041

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -q http://127.0.0.1:9041/api/generate || exit 1

CMD ["sh", "-c", "node server.mjs"]
```

### 2. `server.mjs` (root) — unified server with `/deploy` endpoint

```javascript
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT || 9041);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const REPO_DIR = __dirname;
const execp = promisify(exec);

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8',
};

function assetsBinding() {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let p = decodeURIComponent(url.pathname);
      if (p === '/' || p === '') p = '/index.html';
      const safe = normalize(p).replace(/^([./\\])+/, '/');
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

async function runDeploy() {
  console.log('[deploy] git pull');
  const pull = await execp('git pull --ff-only', { cwd: REPO_DIR });
  console.log(pull.stdout);
  return pull.stdout.trim();
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // ---- /deploy endpoint ----
    if (path === '/deploy') {
      const token = (url.searchParams.get('token') || req.headers['x-webhook-token'] || '');
      if (!WEBHOOK_SECRET) { res.writeHead(500, {'content-type':'application/json'}); return res.end('{"error":"no secret"}'); }
      if (token !== WEBHOOK_SECRET) { res.writeHead(401, {'content-type':'application/json'}); return res.end('{"error":"unauthorized"}'); }

      res.writeHead(200, {'content-type':'application/json'});
      res.end('{"status":"deploying"}');
      runDeploy()
        .then(out => console.log('[deploy] done:', out))
        .catch(e => console.error('[deploy] FAIL:', e));
      return;
    }

    if (path === '/health') {
      res.writeHead(200, {'content-type':'application/json'});
      return res.end('{"status":"ok"}');
    }

    // ---- everything else: pass to the worker ----
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
      init.body = req; init.duplex = 'half';
    }
    const request = new Request(fullUrl, init);
    const env = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ASSETS: assetsBinding(),
    };
    const mod = await import('./worker.js');
    const response = await mod.default.fetch(request, env);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'content-encoding') return;
      res.setHeader(k, v);
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error('handler error:', err);
    res.statusCode = 500;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({error:'internal', detail:String(err.message||err)}));
  }
}

const server = createServer(handle);
server.listen(PORT, '0.0.0.0', () => console.log(`[radar] on :${PORT}`));
for (const s of ['SIGINT','SIGTERM']) process.on(s, () => server.close(() => process.exit(0)));
```

### 3. `package.json` (edit existing — add `type:module` and `start`)

```json
{
  "name": "current-content-radar",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.mjs",
    "deploy": "wrangler deploy"
  }
}
```

### 4. `.dockerignore`

```
.git
.github
node_modules
.env
.env.*
*.md
.vscode
```

### 5. `.github/workflows/deploy.yml`

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger webhook
        env:
          URL: ${{ secrets.DEPLOY_URL }}
        run: |
          curl -fsS -X POST "${URL}"
```

---

## One-Time Setup (on your Linux Mint server)

```bash
cd /opt/radar
git clone https://github.com/15121987/radar.git .

docker build -t radar .

docker run -d --name radar --restart unless-stopped \
  -p 9041:9041 \
  -e WEBHOOK_SECRET='YOUR_LONG_RANDOM_STRING' \
  -e GEMINI_API_KEY='FRIENDS_GEMINI_KEY' \
  radar
```

## Cloudflare Tunnel

Add hostname: **`pd.iamcivic.info`** → **`http://localhost:9041`**

## GitHub Repository Settings

**Settings → Secrets → Actions → New repository secret:**

| Name | Value |
|------|-------|
| `DEPLOY_URL` | `https://pd.iamcivic.info/deploy?token=YOUR_LONG_RANDOM_STRING` |

---

## How It Works After Setup

1. Friend pushes/merges to `main`
2. GitHub Action runs → `curl https://pd.iamcivic.info/deploy?token=SECRET`
3. Cloudflare Tunnel → your container `/deploy`
4. Container validates token → `git pull --ff-only` → logs "deploy done"
5. App is updated, live at `pd.iamcivic.info`

---

## Trade-offs

- Container must have internet to `git pull` (egress via Cloudflare is fine)
- Code lives inside container; `Dockerfile`/`server.mjs` changes require rebuild
- Repo is public → anonymous `git pull` works. If private later, add SSH key mount.