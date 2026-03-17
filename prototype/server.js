require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const {
  generatePropagation,
  generatePropagationSync,
} = require("./propagation/heuristic");

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const FACTCHECK_API_KEY = process.env.FACTCHECK_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function safeJson(value) {
  try { return JSON.parse(value); }
  catch { return null; }
}

function extractJsonBlock(text) {
  if (!text) return null;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  return text.slice(first, last + 1);
}

function calculateViralityScore(text) {
  const triggers = [
    "breaking","urgent","share","forward","immediately","alert",
    "emergency","before it is deleted","government hiding",
    "they dont want you to know",
  ];
  const lower = text.toLowerCase();
  let score = 10;
  triggers.forEach((w) => { if (lower.includes(w)) score += 15; });
  return Math.min(score, 100);
}

async function analyzeWithGroq(claim) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");
  const prompt = `
Return ONLY valid JSON.
{
  "label": "Likely false | Needs verification | Likely true",
  "score": number (0-100, where 100 = certainly fake),
  "summary": "1-2 sentence explanation",
  "risk_signals": [],
  "suspicious_phrases": [],
  "recommendation": "one sentence advice"
}
Claim: ${claim}`;

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 220,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || "Groq request failed");

  const text = data?.choices?.[0]?.message?.content || "";
  let parsed = safeJson(text);
  if (!parsed) {
    const block = extractJsonBlock(text);
    if (block) parsed = safeJson(block);
  }
  return parsed || {
    label: "Needs verification",
    score: 55,
    summary: "Could not parse model response.",
    risk_signals: ["AI output formatting issue"],
    suspicious_phrases: [],
    recommendation: "Check trusted sources.",
  };
}

async function fetchFactChecks(query) {
  if (!FACTCHECK_API_KEY) return [];
  const params = new URLSearchParams({
    query, languageCode: "en", pageSize: "5", key: FACTCHECK_API_KEY,
  });
  const resp = await fetch(
    `https://factchecktools.googleapis.com/v1alpha1/claims:search?${params}`
  );
  const data = await resp.json();
  if (!resp.ok) return [];
  return (data?.claims || []).map((c) => ({
    text: c.text,
    claimant: c.claimant,
    claimReview: (c.claimReview || []).map((r) => ({
      publisherName: r.publisher?.name || "",
      title: r.title || "",
      url: r.url || "",
      textualRating: r.textualRating || "",
      reviewDate: r.reviewDate || "",
    })),
  }));
}

function flattenReviews(claims) {
  const reviews = [];
  (claims || []).forEach((c) => {
    (c.claimReview || []).forEach((r) => {
      reviews.push({
        claim: c.text,
        publisher: r.publisherName || r.publisher?.name,
        rating: r.textualRating,
        title: r.title,
        url: r.url,
      });
    });
  });
  return reviews;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // ── POST /api/groq ─────────────────────────────────────────────
  if (req.method === "POST" && parsedUrl.pathname === "/api/groq") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const data = safeJson(body) || {};
      const claim = (data.claim || "").trim();
      if (!claim)
        return send(res, 400, JSON.stringify({ error: "Claim required" }));
      try {
        const result = await analyzeWithGroq(claim);
        result.virality_score = calculateViralityScore(claim);
        return send(res, 200, JSON.stringify(result));
      } catch (err) {
        return send(res, 500, JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── POST /api/factcheck ────────────────────────────────────────
  if (req.method === "POST" && parsedUrl.pathname === "/api/factcheck") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const data = safeJson(body) || {};
      const claim = (data.claim || "").trim();
      if (!claim)
        return send(res, 400, JSON.stringify({ error: "Claim required" }));
      try {
        const claims = await fetchFactChecks(claim);
        return send(res, 200, JSON.stringify({ claims }));
      } catch (err) {
        return send(res, 500, JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── POST /api/propagation  ─────────────────────────────────────
  // ONLY CHANGE: added groqApiKey to options so heuristic can use
  // Groq to extract smart search keywords before calling Tavily
  if (req.method === "POST" && parsedUrl.pathname === "/api/propagation") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const data = safeJson(body) || {};
      const text = (data.text || "").trim();
      const fakeProbability = Number(data.fakeProbability) || 50;
      const factCheckReviews = data.factCheckReviews || [];

      if (!text)
        return send(res, 400, JSON.stringify({ error: "text is required" }));

      try {
        const result = await generatePropagation(text, fakeProbability, {
          tavilyApiKey:     TAVILY_API_KEY,
          groqApiKey:       GROQ_API_KEY,    // ← only addition
          factCheckReviews: factCheckReviews,
        });
        return send(res, 200, JSON.stringify(result));
      } catch (err) {
        console.error("Propagation real-data error:", err.message);
        const fallback = generatePropagationSync(text, fakeProbability);
        fallback.dataSource = "API error — using estimated model";
        return send(res, 200, JSON.stringify(fallback));
      }
    });
    return;
  }

  // ── POST /api/groq-rewrite  (Feature 3) ───────────────────────
  if (req.method === "POST" && parsedUrl.pathname === "/api/groq-rewrite") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const data = safeJson(body) || {};
      const claim = (data.claim || "").trim();
      if (!claim)
        return send(res, 400, JSON.stringify({ error: "claim required" }));
      try {
        const prompt = `You are a responsible journalism editor.
Rewrite this misleading claim as a responsible, accurate, calm news statement.
Rules:
- Remove sensational language (CAPS, exclamation marks, emotional manipulation)
- Add hedging words (alleged, reportedly, claims, unverified)
- Keep it 2-3 sentences max
- Do NOT confirm the claim as true
Return ONLY valid JSON:
{"responsible_version":"rewritten text","removed_elements":["element1","element2"],"verification_needed":"what to check"}
Claim: ${claim}`;

        const resp = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${GROQ_API_KEY}`,
            },
            body: JSON.stringify({
              model: "llama-3.1-8b-instant",
              messages: [{ role: "user", content: prompt }],
              temperature: 0.3,
              max_tokens: 300,
            }),
          }
        );
        const d = await resp.json();
        const text = d?.choices?.[0]?.message?.content || "";
        let parsed = safeJson(text);
        if (!parsed) {
          const b = extractJsonBlock(text);
          if (b) parsed = safeJson(b);
        }
        return send(res, 200, JSON.stringify(
          parsed || {
            responsible_version: "Could not generate rewrite.",
            removed_elements: [],
            verification_needed: "Manual review required",
          }
        ));
      } catch (err) {
        return send(res, 500, JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── static files ───────────────────────────────────────────────
  const filePath =
    parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const fullPath = path.join(__dirname, filePath);
  fs.readFile(fullPath, (err, data) => {
    if (err) return send(res, 404, "Not Found", "text/plain");
    const ext = path.extname(fullPath);
    const type = MIME[ext] || "application/octet-stream";
    send(res, 200, data, type);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});