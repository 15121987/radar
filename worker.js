// Cloudflare Worker entry (deployed with Wrangler — see README).
// Serves the static site (./public) and handles /api/generate using Google
// Gemini's FREE tier. Keep billing DISABLED on the Google project so it can
// never be charged. The GEMINI_API_KEY is set via: wrangler secret put GEMINI_API_KEY

// Free-tier model with Google Search grounding. If you see "model not found",
// the name changed — try "gemini-3.5-flash".
const MODEL = "gemini-2.5-flash";
// Paid fallback, used ONLY when Gemini fails. Cheapest model by default;
// change to "claude-sonnet-4-6" for higher quality at higher cost.
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/generate") {
      if (request.method === "GET") {
        // Health check — open /api/generate in a browser to see this.
        return json({
          status: "worker is deployed and running",
          worker_build: "v7",
          gemini_key_present: !!env.GEMINI_API_KEY,
          anthropic_fallback: !!env.ANTHROPIC_API_KEY,
          model: MODEL,
          next_step: env.GEMINI_API_KEY
            ? "Key found. Anthropic fallback is " + (env.ANTHROPIC_API_KEY ? "ON." : "OFF (add ANTHROPIC_API_KEY to enable).")
            : "GEMINI_API_KEY is NOT set. Add it in your Worker settings, then redeploy."
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
  if (!env.GEMINI_API_KEY && !env.ANTHROPIC_API_KEY) {
    return json({ error: "Server has no API keys set. Add GEMINI_API_KEY (and optionally ANTHROPIC_API_KEY)." }, 500);
  }
  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "Invalid request body." }, 400); }

  const prompt = (payload && payload.prompt) || "";
  const useSearch = !!(payload && payload.search);
  const wantJson = !!(payload && payload.json);
  if (!prompt) return json({ error: "Missing prompt." }, 400);

  let text = "";
  let geminiError = "";

  // 1) FREE path: Gemini first (it already retries transient 503/429 internally,
  //    plus an ungrounded retry here if a grounded call fails).
  if (env.GEMINI_API_KEY) {
    try {
      text = await callGemini(env.GEMINI_API_KEY, prompt, useSearch, wantJson);
      if (!text && useSearch) text = await callGemini(env.GEMINI_API_KEY, prompt, false, wantJson);
    } catch (e1) {
      geminiError = String((e1 && e1.message) || e1);
      if (useSearch) {
        try { text = await callGemini(env.GEMINI_API_KEY, prompt, false, wantJson); } catch (e2) {}
      }
    }
  }

  // 2) LAST RESORT (paid): Anthropic, only if Gemini produced nothing.
  if (!text && env.ANTHROPIC_API_KEY) {
    try {
      text = await callAnthropic(env.ANTHROPIC_API_KEY, prompt, useSearch);
    } catch (e3) {
      return json({ error: "Gemini unavailable" + (geminiError ? " (" + geminiError + ")" : "") + "; Anthropic fallback also failed: " + String((e3 && e3.message) || e3) }, 502);
    }
  }

  if (!text) {
    return json({ error: "Could not generate" + (geminiError ? ": " + geminiError : "") + (env.ANTHROPIC_API_KEY ? "" : " (no Anthropic fallback configured)") }, 502);
  }

  return json({ text });
}

async function callGemini(key, prompt, useSearch, wantJson) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
              MODEL + ":generateContent?key=" + key;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 2048 }
  };
  if (useSearch) body.tools = [{ google_search: {} }];
  if (wantJson) body.generationConfig.responseMimeType = "application/json";

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (r.ok) {
      const d = await r.json();
      const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
      return parts.map((p) => p.text || "").join("");
    }
    const t = await r.text();
    lastErr = new Error("Gemini " + r.status + ": " + t.slice(0, 200));
    // Retry transient overload / rate spikes; fail fast on everything else.
    if (r.status === 503 || r.status === 429) {
      await new Promise((res) => setTimeout(res, 1200 * (attempt + 1)));
      continue;
    }
    throw lastErr;
  }
  throw lastErr || new Error("Gemini unavailable after retries");
}

async function callAnthropic(key, prompt, useSearch) {
  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }]
  };
  if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("Anthropic " + r.status + ": " + t.slice(0, 200));
  }
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}
