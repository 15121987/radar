# Current — free deployment (Cloudflare Workers + Wrangler)

A content-radar PWA: paste a link or topic, get trending angles (global news +
Instagram trends + evergreen), and draft Instagram reels, carousels, and LinkedIn posts.

Runs **entirely free**: free Cloudflare hosting + Google Gemini free tier. No charges as
long as Google billing stays disabled.

## Why the dashboard didn't work

Cloudflare's drag-and-drop upload only hosts **static files** — it cannot run the small
piece of backend code this app needs (to keep your API key hidden and do the live search).
That's why adding the key in the dashboard said "a Worker that only has static assets."
The fix is to deploy with **Wrangler**, Cloudflare's command-line tool, which uploads the
code and the site together. It's three commands.

## Files

    wrangler.jsonc   deploy config (points to worker.js + the public/ site folder)
    worker.js        the backend (serves the site + handles /api/generate)
    public/          the site: index.html, manifest.json, sw.js, icons

---

## Deploy (free)

1. **Install Node.js** (one-time) from https://nodejs.org — the LTS version. Confirm it
   works: open a terminal and run `node -v` (any version number = good). Wrangler comes
   with it via `npx`, nothing else to install.

2. **Get a free Gemini key** at https://aistudio.google.com → "Get API key". No credit
   card. **Leave billing OFF** — that's what guarantees no charges, ever.

3. **Open a terminal inside this `current-app` folder** and run these three commands:

       npx wrangler login
       npx wrangler deploy
       npx wrangler secret put GEMINI_API_KEY

   - `login` opens your browser to sign in to a free Cloudflare account and authorize.
   - `deploy` uploads everything and prints your live URL (like
     `https://current-content-radar.YOUR-NAME.workers.dev`).
   - `secret put` then asks you to paste your Gemini key — paste it, press Enter. Done.

4. **Verify:** open `https://YOUR-URL.workers.dev/api/generate` in a browser. You should see
   `{"status":"worker is deployed and running","gemini_key_present":true,...}`.
   Then open the site root and run a search — it should work.

That's it. No bill as long as Google billing stays disabled.

---

## No-terminal route: GitHub → Cloudflare (all in the browser)

**A. Put the files on GitHub**
1. Create a free account at https://github.com if you don't have one.
2. Click the + (top right) → New repository. Give it a name (e.g. `current-content-radar`),
   leave everything else default, Create repository.
3. On the empty repo page, click "uploading an existing file" (or Add file → Upload files).
4. Drag in the **contents** of this `current-app` folder: `worker.js`, `wrangler.jsonc`,
   `package.json`, and the `public` folder. They must sit at the repo root — NOT inside a
   `current-app` subfolder. Then Commit changes.

**B. Connect it to Cloudflare**
5. https://dash.cloudflare.com → Workers & Pages → Create → Workers → "Import a repository"
   (Connect to Git). Authorize Cloudflare's GitHub app when prompted and give it access to
   the repo.
6. Pick your repo. Build settings: leave **Build command empty**, keep the default
   **Deploy command** (`npx wrangler deploy`), and leave **Root directory** as `/`.
   Create / Deploy, and wait for the build to go green.
   - If you see "Missing entry-point to Worker script or to assets directory": the files
     weren't at the repo root. Re-check that `wrangler.jsonc` is at the top of the repo,
     or set Root directory to the folder that contains it.

**C. Add your key**
7. Open the new Worker → Settings → Variables and Secrets → Add → type **Secret**,
   name `GEMINI_API_KEY`, value = your Gemini key. Save. (This is now allowed, because the
   Worker has code.) Then Deployments → Retry deployment so it picks up the key.

**D. Verify**
8. Visit `https://YOUR-WORKER.workers.dev/api/generate` → expect
   `{"gemini_key_present": true, ...}`. Then open the site root and run a search.

**Updating later:** edit a file on GitHub (or upload a new version) and Cloudflare rebuilds
automatically — no terminal ever.

---

## Tweaks & notes

- **Model:** change `MODEL` at the top of `worker.js` (default `gemini-2.5-flash`; for a
  larger free Google-Search allowance try `gemini-3.5-flash`). Models list:
  https://ai.google.dev/gemini-api/docs/models
- **Update later:** after changing files, just run `npx wrangler deploy` again.
- **HTTP 429:** you hit the free quota — wait and retry. It never becomes a charge.
- **Privacy:** on the free tier Google may use prompts to improve its products; don't paste
  confidential client data.
- Web search reflects *reporting about* Instagram trends, not Instagram's internal data —
  verify a trending audio is still hot before you shoot.
