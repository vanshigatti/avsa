require("dotenv").config();

const http      = require("http");
const fs        = require("fs");
const path      = require("path");
const url       = require("url");
const crypto    = require("crypto");
const { generatePropagation, generatePropagationSync } = require("./propagation/heuristic");

const PORT             = process.env.PORT || 3000;
const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const FACTCHECK_API_KEY= process.env.FACTCHECK_API_KEY;
const TAVILY_API_KEY   = process.env.TAVILY_API_KEY;

// ─── Constants ────────────────────────────────────────────────────────────────
const CACHE_TTL_MS      = 60 * 60 * 1000;   // 1 hour
const MAX_CLAIM_LENGTH  = 2000;
const MAX_TRENDING      = 50;
const REQUEST_TIMEOUT   = 15_000;            // 15 s per external fetch
const GROQ_TIMEOUT      = 20_000;            // 20 s for slower autopsy calls

const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
};

// ─── In-memory stores ─────────────────────────────────────────────────────────

// Cache: hash → { data, expiresAt }
const cache = new Map();

// In-flight deduplication: hash → Promise
const inFlight = new Map();

// Trending: array of { claim, score, verdict, timestamp }
const trendingStore = [];

// Simple rate-limit: IP → { count, windowStart }
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000;  // 1 min
const RATE_LIMIT_MAX    = 30;      // requests per window

// ─── Utilities ────────────────────────────────────────────────────────────────

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function extractJsonBlock(text) {
  if (!text) return null;
  const first = text.indexOf("{");
  const last  = text.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  return text.slice(first, last + 1);
}

function hashClaim(claim) {
  return crypto.createHash("sha256").update(claim.trim().toLowerCase()).digest("hex").slice(0, 16);
}

function sanitizeClaim(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, MAX_CLAIM_LENGTH);
}

function calculateViralityScore(text) {
  const triggers = [
    "breaking","urgent","share","forward","immediately","alert",
    "emergency","before it is deleted","government hiding",
    "they dont want you to know",
  ];
  const lower = text.toLowerCase();
  let score = 10;
  triggers.forEach(w => { if (lower.includes(w)) score += 15; });
  return Math.min(score, 100);
}

// Fetch with timeout helper
function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ─── Cache helpers ─────────────────────────────────────────────────────────────

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  // Evict expired entries occasionally
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) { if (now > v.expiresAt) cache.delete(k); }
  }
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Trending tracker ──────────────────────────────────────────────────────────

function addToTrending(claim, score, verdict) {
  const entry = {
    claim: claim.slice(0, 120),
    score,
    verdict,
    timestamp: Date.now(),
  };
  // Deduplicate by claim text (simple check)
  const idx = trendingStore.findIndex(
    t => t.claim.toLowerCase() === entry.claim.toLowerCase()
  );
  if (idx !== -1) {
    trendingStore[idx] = entry; // refresh
  } else {
    trendingStore.unshift(entry);
    if (trendingStore.length > MAX_TRENDING) trendingStore.pop();
  }
}

function getTrendingStats() {
  const total = trendingStore.length;
  if (total === 0) return { claims: [], fakeRatio: 0, realRatio: 0, uncertainRatio: 0, total: 0 };
  const fakeCount      = trendingStore.filter(t => t.verdict === "fake").length;
  const realCount      = trendingStore.filter(t => t.verdict === "real").length;
  const uncertainCount = total - fakeCount - realCount;
  return {
    claims:         trendingStore.slice(0, 20),
    total,
    fakeRatio:      Math.round((fakeCount      / total) * 100),
    realRatio:      Math.round((realCount      / total) * 100),
    uncertainRatio: Math.round((uncertainCount / total) * 100),
    avgFakeScore:   Math.round(trendingStore.reduce((s, t) => s + t.score, 0) / total),
  };
}

// ─── Rate limiting ─────────────────────────────────────────────────────────────

function isRateLimited(ip) {
  const now  = Date.now();
  const info = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - info.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }
  info.count++;
  rateLimitMap.set(ip, info);
  return info.count > RATE_LIMIT_MAX;
}

// ─── Groq API calls ────────────────────────────────────────────────────────────

async function analyzeWithGroq(claim) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");

  const prompt = `You are an expert fact-checker and misinformation analyst. Your job is to assess whether a claim is fake/misinformation or real/credible news.

IMPORTANT SCORING RULES:
- score = 0-20  → Credible/real news from a legitimate event or government action
- score = 21-45 → Needs verification but not clearly fake
- score = 46-70 → Suspicious, likely misleading or unverified
- score = 71-100 → Almost certainly fake, fabricated, or dangerous misinformation

KEY DISTINCTIONS:
- News headlines about real government actions, police deployments, supply issues, political events → score LOW (0-30)
- WhatsApp forwards claiming free money, miraculous cures, secret government schemes → score HIGH (70-100)
- Sensational language alone does NOT make something fake if it describes a real event

Return ONLY valid JSON:
{
  "label": "Likely true | Needs verification | Likely false",
  "score": <number 0-100>,
  "summary": "1-2 sentence explanation",
  "risk_signals": ["only genuine misinformation signals"],
  "suspicious_phrases": ["only actually manipulative phrases"],
  "recommendation": "one sentence of practical advice",
  "virality_score": <number 0-100>
}

Claim: "${claim}"`;

  const resp = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 260,
      }),
    },
    REQUEST_TIMEOUT
  );

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || "Groq request failed");

  const text   = data?.choices?.[0]?.message?.content || "";
  let parsed   = safeJson(text);
  if (!parsed) { const block = extractJsonBlock(text); if (block) parsed = safeJson(block); }

  const result = parsed || {
    label: "Needs verification", score: 55,
    summary: "Could not parse model response.",
    risk_signals: ["AI output formatting issue"],
    suspicious_phrases: [],
    recommendation: "Check trusted sources.",
  };

  // Always compute virality from text as fallback
  result.virality_score = result.virality_score ?? calculateViralityScore(claim);
  return result;
}

async function autopsyWithGroq(claim) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");

  const prompt = `You are a forensic misinformation analyst. Be accurate — do NOT label real news as fake.

VERDICT RULES:
- "true"      → verified/credible news from a real event
- "fake"      → fabricated claim, hoax, dangerous misinformation
- "uncertain" → ambiguous, unverified rumour

Return ONLY valid JSON:
{
  "verdict": "true|fake|uncertain",
  "verdict_statement": "one concise sentence",
  "annotations": [{ "phrase": "exact phrase", "type": "fabricated|fear_trigger|misleading|conspiracy_framing|emotional_bait|neutral", "reason": "brief reason" }],
  "techniques": ["technique name"],
  "forensic_summary": "2-3 sentence forensic breakdown",
  "who_benefits": "who benefits or 'No clear beneficiary for credible news'"
}

Claim: "${claim.slice(0, 400)}"`;

  const resp = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 600,
      }),
    },
    GROQ_TIMEOUT
  );

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || "Groq autopsy failed");

  const text   = data?.choices?.[0]?.message?.content || "";
  let parsed   = safeJson(text);
  if (!parsed) { const block = extractJsonBlock(text); if (block) parsed = safeJson(block); }
  return parsed || {
    verdict: "uncertain", verdict_statement: "Could not complete autopsy.",
    annotations: [], techniques: [], forensic_summary: "", who_benefits: "Unknown",
  };
}

async function truthWithGroq(claim) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");

  const prompt = `You are a fact-checking journalist.
Given this claim, provide the verified truth. Return ONLY valid JSON:
{
  "corrected_claim": "accurate version in 1-2 sentences",
  "explanation": "why the original claim is wrong or misleading",
  "key_facts": ["fact1", "fact2", "fact3"],
  "verified_news": [{ "title": "headline", "url": "" }],
  "fact_check_links": [{ "title": "title", "url": "" }]
}
Claim: "${claim.slice(0, 400)}"`;

  const resp = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 500,
      }),
    },
    GROQ_TIMEOUT
  );

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || "Groq truth failed");

  const text   = data?.choices?.[0]?.message?.content || "";
  let parsed   = safeJson(text);
  if (!parsed) { const block = extractJsonBlock(text); if (block) parsed = safeJson(block); }
  return parsed || {
    corrected_claim: "Could not generate truth analysis.",
    explanation: "", key_facts: [], verified_news: [], fact_check_links: [],
  };
}

async function fetchFactChecks(query) {
  if (!FACTCHECK_API_KEY) return [];
  const params = new URLSearchParams({
    query, languageCode: "en", pageSize: "5", key: FACTCHECK_API_KEY,
  });
  const resp = await fetchWithTimeout(
    `https://factchecktools.googleapis.com/v1alpha1/claims:search?${params}`,
    {}, REQUEST_TIMEOUT
  );
  const data = await resp.json();
  if (!resp.ok) return [];
  return (data?.claims || []).map(c => ({
    text: c.text,
    claimant: c.claimant,
    claimReview: (c.claimReview || []).map(r => ({
      publisherName: r.publisher?.name || "",
      title: r.title || "",
      url: r.url || "",
      textualRating: r.textualRating || "",
      reviewDate: r.reviewDate || "",
    })),
  }));
}

// ─── Cached + deduplicated wrapper ───────────────────────────────────────────

async function cachedCall(cacheKey, fn) {
  // 1. Cache hit?
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, _cached: true };

  // 2. In-flight dedup?
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  // 3. Execute and cache
  const promise = fn().then(result => {
    cacheSet(cacheKey, result);
    inFlight.delete(cacheKey);
    return result;
  }).catch(err => {
    inFlight.delete(cacheKey);
    throw err;
  });

  inFlight.set(cacheKey, promise);
  return promise;
}

// ─── Read request body ────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 50_000) { req.destroy(); reject(new Error("Payload too large")); }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname  = parsedUrl.pathname;
  const ip        = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // ── GET /api/health ──────────────────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/health") {
    const checks = {
      status:    "ok",
      timestamp: new Date().toISOString(),
      uptime:    Math.floor(process.uptime()),
      services: {
        groq:       GROQ_API_KEY      ? "configured" : "missing",
        factcheck:  FACTCHECK_API_KEY ? "configured" : "missing",
        tavily:     TAVILY_API_KEY    ? "configured" : "missing",
      },
      cache: {
        entries: cache.size,
        inFlight: inFlight.size,
      },
      trending: {
        totalAnalyzed: trendingStore.length,
      },
    };

    // Quick Groq ping
    if (GROQ_API_KEY) {
      try {
        const pingResp = await fetchWithTimeout(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
            body: JSON.stringify({
              model: "llama-3.1-8b-instant",
              messages: [{ role: "user", content: "Reply with OK" }],
              max_tokens: 5,
            }),
          },
          5000
        );
        checks.services.groqLive = pingResp.ok ? "reachable" : "error";
      } catch {
        checks.services.groqLive = "unreachable";
      }
    }

    return send(res, 200, checks);
  }

  // ── GET /api/trending ────────────────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/trending") {
    return send(res, 200, getTrendingStats());
  }

  // ── GET /api/cache-stats ─────────────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/cache-stats") {
    return send(res, 200, {
      cacheSize:  cache.size,
      inFlight:   inFlight.size,
      trending:   trendingStore.length,
    });
  }

  // Rate limit all POST API routes
  if (req.method === "POST" && pathname.startsWith("/api/")) {
    if (isRateLimited(ip)) {
      return send(res, 429, { error: "Too many requests — please slow down." });
    }
  }

  // ── POST /api/groq ───────────────────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/groq") {
    try {
      const body  = await readBody(req);
      const data  = safeJson(body) || {};
      const claim = sanitizeClaim(data.claim);
      if (!claim) return send(res, 400, { error: "Claim required" });

      const cacheKey = `groq:${hashClaim(claim)}`;
      const result   = await cachedCall(cacheKey, () => analyzeWithGroq(claim));

      // Track in trending
      const verdict = (result.label || "").toLowerCase().includes("false") ? "fake"
        : (result.label || "").toLowerCase().includes("true")  ? "real"
        : "uncertain";
      addToTrending(claim, result.score ?? 50, verdict);

      return send(res, 200, result);
    } catch (err) {
      console.error("[/api/groq]", err.message);
      return send(res, 500, {
        label: "Needs verification", score: 50,
        summary: "Analysis temporarily unavailable. Please try again.",
        risk_signals: [], suspicious_phrases: [],
        recommendation: "Verify with trusted fact-checking sources.",
        virality_score: 0,
        error: err.message,
      });
    }
  }

  // ── POST /api/groq-autopsy ───────────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/groq-autopsy") {
    try {
      const body  = await readBody(req);
      const data  = safeJson(body) || {};
      const claim = sanitizeClaim(data.claim);
      if (!claim) return send(res, 400, { error: "claim required" });

      const cacheKey = `autopsy:${hashClaim(claim)}`;
      const result   = await cachedCall(cacheKey, () => autopsyWithGroq(claim));
      return send(res, 200, result);
    } catch (err) {
      console.error("[/api/groq-autopsy]", err.message);
      return send(res, 500, {
        verdict: "uncertain", verdict_statement: "Autopsy temporarily unavailable.",
        annotations: [], techniques: [], forensic_summary: "", who_benefits: "Unknown",
      });
    }
  }

  // ── POST /api/groq-truth ─────────────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/groq-truth") {
    try {
      const body  = await readBody(req);
      const data  = safeJson(body) || {};
      const claim = sanitizeClaim(data.claim);
      if (!claim) return send(res, 400, { error: "claim required" });

      const cacheKey = `truth:${hashClaim(claim)}`;
      const result   = await cachedCall(cacheKey, () => truthWithGroq(claim));
      return send(res, 200, result);
    } catch (err) {
      console.error("[/api/groq-truth]", err.message);
      return send(res, 500, {
        corrected_claim: "Truth engine temporarily unavailable.",
        explanation: "", key_facts: [], verified_news: [], fact_check_links: [],
      });
    }
  }

  // ── POST /api/factcheck ──────────────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/factcheck") {
    try {
      const body  = await readBody(req);
      const data  = safeJson(body) || {};
      const claim = sanitizeClaim(data.claim);
      if (!claim) return send(res, 400, { error: "Claim required" });

      const cacheKey = `factcheck:${hashClaim(claim)}`;
      const claims   = await cachedCall(cacheKey, () => fetchFactChecks(claim));
      return send(res, 200, { claims });
    } catch (err) {
      console.error("[/api/factcheck]", err.message);
      return send(res, 500, { claims: [] });
    }
  }

  // ── POST /api/propagation ────────────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/propagation") {
    try {
      const body           = await readBody(req);
      const data           = safeJson(body) || {};
      const text           = sanitizeClaim(data.text);
      const fakeProbability= Number(data.fakeProbability) || 50;
      const factCheckReviews = Array.isArray(data.factCheckReviews) ? data.factCheckReviews : [];
      if (!text) return send(res, 400, { error: "text is required" });

      const cacheKey = `prop:${hashClaim(text)}:${Math.round(fakeProbability / 10)}`;
      const result   = await cachedCall(cacheKey, () =>
        generatePropagation(text, fakeProbability, {
          tavilyApiKey:     TAVILY_API_KEY,
          groqApiKey:       GROQ_API_KEY,
          factCheckReviews,
        })
      );
      return send(res, 200, result);
    } catch (err) {
      console.error("[/api/propagation]", err.message);
      try {
        const body  = await readBody(req).catch(() => "{}");
        const data  = safeJson(body) || {};
        const fallback = generatePropagationSync(data.text || "", Number(data.fakeProbability) || 50);
        fallback.dataSource = "API error — estimated model";
        return send(res, 200, fallback);
      } catch {
        return send(res, 500, { error: err.message });
      }
    }
  }

  // ── POST /api/extract-image ──────────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/extract-image") {
    try {
      const body     = await readBody(req);
      const data     = safeJson(body) || {};
      const b64      = (data.imageBase64 || "").trim();
      const mimeType = data.mimeType || "image/jpeg";
      if (!b64) return send(res, 400, { error: "imageBase64 required" });

      // Step 1: OCR
      const ocrResp = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({
            model: "meta-llama/llama-4-scout-17b-16e-instruct",
            messages: [{
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}` } },
                { type: "text", text: `You are an expert OCR system supporting all languages including Marathi, Hindi, Bengali, Tamil, Telugu, Gujarati, Punjabi, Kannada, Malayalam, Urdu, Arabic, Chinese, Japanese, Korean, and all other scripts.

Your task:
1. Identify the language(s) present in this image
2. Extract ALL visible text EXACTLY as written — preserve original script, spelling, punctuation, line breaks
3. Include everything: headlines, body text, captions, watermarks, dates, source names
4. Do NOT translate, paraphrase, or summarize

Return ONLY valid JSON:
{ "language": "detected language", "script": "script name", "extracted_text": "all text here" }` }
              ],
            }],
            temperature: 0.0,
            max_tokens: 1200,
          }),
        },
        GROQ_TIMEOUT
      );

      const ocrData    = await ocrResp.json();
      if (!ocrResp.ok) throw new Error(ocrData?.error?.message || "OCR failed");

      const ocrRaw     = ocrData?.choices?.[0]?.message?.content || "";
      let ocrParsed    = safeJson(ocrRaw);
      if (!ocrParsed)  { const block = extractJsonBlock(ocrRaw); if (block) ocrParsed = safeJson(block); }

      const extractedText    = ocrParsed?.extracted_text || ocrRaw.trim();
      const detectedLanguage = ocrParsed?.language || "Unknown";
      const detectedScript   = ocrParsed?.script   || "Unknown";

      if (!extractedText) {
        return send(res, 200, { text: "", translatedText: "", detectedLanguage, detectedScript });
      }

      // Step 2: Translate if needed
      let translatedText = extractedText;
      const isEnglish    = /^english$/i.test(detectedLanguage) || /^latin$/i.test(detectedScript);

      if (!isEnglish) {
        try {
          const transResp = await fetchWithTimeout(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
              body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [
                  { role: "system", content: `Translate the following ${detectedLanguage} text to English accurately. Preserve meaning, tone, and claims. Return ONLY the translated text.` },
                  { role: "user",   content: extractedText },
                ],
                temperature: 0.1,
                max_tokens: 1000,
              }),
            },
            REQUEST_TIMEOUT
          );
          const transData  = await transResp.json();
          translatedText   = transData?.choices?.[0]?.message?.content?.trim() || extractedText;
        } catch (transErr) {
          console.warn("[translate]", transErr.message);
        }
      }

      return send(res, 200, {
        text:             translatedText,
        originalText:     extractedText,
        translatedText,
        detectedLanguage,
        detectedScript,
      });
    } catch (err) {
      console.error("[/api/extract-image]", err.message);
      return send(res, 500, { error: err.message });
    }
  }

  // ── POST /api/groq-rewrite ───────────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/groq-rewrite") {
    try {
      const body  = await readBody(req);
      const data  = safeJson(body) || {};
      const claim = sanitizeClaim(data.claim);
      if (!claim) return send(res, 400, { error: "claim required" });

      const prompt = `You are a responsible journalism editor. Rewrite this misleading claim as a responsible, accurate, calm news statement.
Rules: Remove sensational language, add hedging words (alleged, reportedly), keep 2-3 sentences, do NOT confirm claim as true.
Return ONLY valid JSON:
{"responsible_version":"rewritten text","removed_elements":["element1"],"verification_needed":"what to check"}
Claim: ${claim}`;

      const resp = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            max_tokens: 300,
          }),
        },
        REQUEST_TIMEOUT
      );
      const d    = await resp.json();
      const text = d?.choices?.[0]?.message?.content || "";
      let parsed = safeJson(text);
      if (!parsed) { const b = extractJsonBlock(text); if (b) parsed = safeJson(b); }
      return send(res, 200, parsed || {
        responsible_version: "Could not generate rewrite.",
        removed_elements: [], verification_needed: "Manual review required",
      });
    } catch (err) {
      console.error("[/api/groq-rewrite]", err.message);
      return send(res, 500, { error: err.message });
    }
  }

  // ── Static file serving ──────────────────────────────────────────────────────
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = path.join(__dirname, filePath);

  // Prevent directory traversal
  if (!fullPath.startsWith(path.join(__dirname))) {
    return send(res, 403, "Forbidden", "text/plain");
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) return send(res, 404, "Not Found", "text/plain");
    const ext  = path.extname(fullPath);
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🔎 Credible Chronicles server running`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n   Services:`);
  console.log(`   Groq       : ${GROQ_API_KEY      ? "✓ configured" : "✗ missing GROQ_API_KEY"}`);
  console.log(`   Fact Check : ${FACTCHECK_API_KEY ? "✓ configured" : "✗ missing FACTCHECK_API_KEY"}`);
  console.log(`   Tavily     : ${TAVILY_API_KEY    ? "✓ configured" : "✗ missing TAVILY_API_KEY"}`);
  console.log(`\n   Endpoints:`);
  console.log(`   GET  /api/health`);
  console.log(`   GET  /api/trending`);
  console.log(`   POST /api/groq`);
  console.log(`   POST /api/groq-autopsy`);
  console.log(`   POST /api/groq-truth`);
  console.log(`   POST /api/propagation`);
  console.log(`   POST /api/extract-image\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n✗ Port ${PORT} is already in use. Try: PORT=3001 node server.js\n`);
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});