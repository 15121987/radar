// Cloudflare Worker entry (deployed with Wrangler — see README).
// Serves the static site (./public) and handles /api/generate using Google
// Gemini's FREE tier. Keep billing DISABLED on the Google project so it can
// never be charged. The GEMINI_API_KEY is set via: wrangler secret put GEMINI_API_KEY

// Free-tier model with Google Search grounding. If you see "model not found",
// the name changed — try "gemini-3.5-flash".
const MODEL = "gemini-2.5-flash";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/generate") {
      if (request.method === "GET") {
        // Health check — open /api/generate in a browser to see this.
        return json({
          status: "worker is deployed and running",
          gemini_key_present: !!env.GEMINI_API_KEY,
          model: MODEL,
          next_step: env.GEMINI_API_KEY
            ? "Key found. If search still fails, try model gemini-3.5-flash, or wait out a rate limit."
            : "GEMINI_API_KEY is NOT set. Add it in Pages > Settings > Environment variables (Production), then redeploy."
        }, 200);
      }
      if (request.method === "POST") return handleGenerate(request, env);
      return json({ error: "Method not allowed" }, 405);
    }

    // Everything else: serve the static site (index.html, icons, etc.).
    return env.ASSETS.fetch(request);
  }
};

async function handleGenerate(request, env) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: "Server missing GEMINI_API_KEY. Add it in your Pages settings, then redeploy." }, 500);
  }
  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "Invalid request body." }, 400); }

  const prompt = (payload && payload.prompt) || "";
  const useSearch = !!(payload && payload.search);
  if (!prompt) return json({ error: "Missing prompt." }, 400);

  try {
    let text = "";
    try {
      text = await callGemini(env.GEMINI_API_KEY, prompt, useSearch);
    } catch (e) {
      if (useSearch) text = await callGemini(env.GEMINI_API_KEY, prompt, false);
      else throw e;
    }
    if (!text && useSearch) text = await callGemini(env.GEMINI_API_KEY, prompt, false);
    return json({ text });
  } catch (err) {
    return json({ error: "Request failed: " + String(err) }, 502);
  }
}

async function callGemini(key, prompt, useSearch) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
              MODEL + ":generateContent?key=" + key;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 1500 }
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("Gemini " + r.status + ": " + t.slice(0, 200));
  }
  const d = await r.json();
  const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || "").join("");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}
