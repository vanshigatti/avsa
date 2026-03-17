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
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
  });
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
- Breaking news headlines can be real even if they sound alarming

Analyze this claim carefully and return ONLY valid JSON:
{
  "label": "Likely true | Needs verification | Likely false",
  "score": <number 0-100 where 0=definitely real, 100=definitely fake>,
  "summary": "1-2 sentence explanation of your reasoning",
  "risk_signals": ["only list signals that genuinely indicate misinformation"],
  "suspicious_phrases": ["only flag phrases that are actually manipulative, not just news language"],
  "recommendation": "one sentence of practical advice for the reader"
}

Claim: "${claim}"`;


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

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // ── CORS preflight ─────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // ── POST /api/extract-image ────────────────────────────────────
  // Receives { imageBase64, mimeType }
  // Returns { text, translatedText, detectedLanguage }
  if (req.method === "POST" && parsedUrl.pathname === "/api/extract-image") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const data     = safeJson(body) || {};
      const b64      = (data.imageBase64 || "").trim();
      const mimeType = data.mimeType || "image/jpeg";
      if (!b64) return send(res, 400, JSON.stringify({ error: "imageBase64 required" }));
      try {
        // ── Step 1: OCR — extract text in original language ──
        const ocrResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({
            model: "meta-llama/llama-4-scout-17b-16e-instruct",
            messages: [{
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:${mimeType};base64,${b64}` }
                },
                {
                  type: "text",
                  text: `You are an expert OCR system that supports all languages including Marathi, Hindi, Bengali, Tamil, Telugu, Gujarati, Punjabi, Kannada, Malayalam, Urdu, Arabic, Chinese, Japanese, Korean, and all other scripts.

Your task:
1. Identify the language(s) present in this image
2. Extract ALL visible text EXACTLY as written — preserve the original script, spelling, punctuation, line breaks
3. Include everything: headlines, body text, captions, watermarks, dates, source names, hashtags, usernames
4. Do NOT translate, paraphrase, or summarize — copy the text verbatim

Return ONLY a JSON object:
{
  "language": "detected language name in English (e.g. Marathi, Hindi, English)",
  "script": "script name (e.g. Devanagari, Latin, Arabic)",
  "extracted_text": "all extracted text here exactly as it appears"
}`
                }
              ]
            }],
            temperature: 0.0,
            max_tokens: 1200,
          }),
        });

        const ocrData = await ocrResp.json();
        if (!ocrResp.ok) throw new Error(ocrData?.error?.message || "OCR failed");

        const ocrRaw     = ocrData?.choices?.[0]?.message?.content || "";
        let ocrParsed    = safeJson(ocrRaw);
        if (!ocrParsed) {
          const block = extractJsonBlock(ocrRaw);
          if (block) ocrParsed = safeJson(block);
        }

        const extractedText    = ocrParsed?.extracted_text || ocrRaw.trim();
        const detectedLanguage = ocrParsed?.language || "Unknown";
        const detectedScript   = ocrParsed?.script   || "Unknown";

        if (!extractedText) {
          return send(res, 200, JSON.stringify({
            text: "", translatedText: "", detectedLanguage, detectedScript,
          }));
        }

        // ── Step 2: Translate to English if not already English ──
        let translatedText = extractedText;
        const isEnglish = /^english$/i.test(detectedLanguage) || /^latin$/i.test(detectedScript);

        if (!isEnglish) {
          try {
            const transResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
              body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [
                  {
                    role: "system",
                    content: `You are a professional translator. Translate the following ${detectedLanguage} text to English accurately. Preserve the meaning, tone, and any claims made. Return ONLY the translated text — no commentary, no explanations.`
                  },
                  {
                    role: "user",
                    content: extractedText
                  }
                ],
                temperature: 0.1,
                max_tokens: 1000,
              }),
            });
            const transData = await transResp.json();
            translatedText  = transData?.choices?.[0]?.message?.content?.trim() || extractedText;
          } catch (transErr) {
            console.log("Translation failed, using original:", transErr.message);
            translatedText = extractedText;
          }
        }

        return send(res, 200, JSON.stringify({
          text:             translatedText,   // used for analysis (English)
          originalText:     extractedText,    // shown to user (original language)
          translatedText,
          detectedLanguage,
          detectedScript,
        }));

      } catch (err) {
        console.error("Image extract error:", err.message);
        return send(res, 500, JSON.stringify({ error: err.message }));
      }
    });
    return;
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

  // ── POST /api/propagation ──────────────────────────────────────
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
          groqApiKey:       GROQ_API_KEY,
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

  // ── POST /api/groq-rewrite ─────────────────────────────────────
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

  // ── POST /api/groq-autopsy ────────────────────────────────────────
  if (req.method === "POST" && parsedUrl.pathname === "/api/groq-autopsy") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const data  = safeJson(body) || {};
      const claim = (data.claim || "").trim();
      if (!claim) return send(res, 400, JSON.stringify({ error: "claim required" }));
      try {
        const prompt = `You are a forensic misinformation analyst. Be accurate — do NOT label real news as fake.

VERDICT RULES:
- "true"      → verified/credible news from a real event (govt action, official statement, real crisis)
- "fake"      → fabricated claim, hoax, dangerous misinformation with no basis
- "uncertain" → ambiguous, satire, unverified rumour

Analyze this claim and return ONLY valid JSON — no markdown:
{
  "verdict": "true|fake|uncertain",
  "verdict_statement": "one concise sentence summarizing the verdict",
  "annotations": [
    { "phrase": "exact phrase from claim", "type": "fabricated|fear_trigger|misleading|conspiracy_framing|emotional_bait|neutral", "reason": "brief reason" }
  ],
  "techniques": ["technique name if any — leave empty array if none detected"],
  "forensic_summary": "2-3 sentence forensic breakdown",
  "who_benefits": "who benefits from spreading this, or 'No clear beneficiary for credible news'"
}

Claim: "${claim.slice(0, 400)}"`;

        const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2, max_tokens: 600,
          }),
        });
        const d    = await resp.json();
        const text = d?.choices?.[0]?.message?.content || "";
        let parsed = safeJson(text);
        if (!parsed) { const b = extractJsonBlock(text); if (b) parsed = safeJson(b); }
        return send(res, 200, JSON.stringify(parsed || {
          verdict: "uncertain", verdict_statement: "Could not complete autopsy.",
          annotations: [], techniques: [], forensic_summary: "", who_benefits: "Unknown",
        }));
      } catch (err) {
        return send(res, 500, JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── POST /api/groq-truth ──────────────────────────────────────────
  if (req.method === "POST" && parsedUrl.pathname === "/api/groq-truth") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const data  = safeJson(body) || {};
      const claim = (data.claim || "").trim();
      if (!claim) return send(res, 400, JSON.stringify({ error: "claim required" }));
      try {
        const prompt = `You are a fact-checking journalist.
Given this claim, provide the verified truth and return ONLY valid JSON — no markdown.
{
  "corrected_claim": "the accurate version of this claim in 1-2 sentences",
  "explanation": "why the original claim is wrong or misleading",
  "key_facts": ["fact1", "fact2", "fact3"],
  "verified_news": [{ "title": "headline", "url": "" }],
  "fact_check_links": [{ "title": "fact-check title", "url": "" }]
}
Claim: "${claim.slice(0, 400)}"`;

        const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2, max_tokens: 500,
          }),
        });
        const d    = await resp.json();
        const text = d?.choices?.[0]?.message?.content || "";
        let parsed = safeJson(text);
        if (!parsed) { const b = extractJsonBlock(text); if (b) parsed = safeJson(b); }
        return send(res, 200, JSON.stringify(parsed || {
          corrected_claim: "Could not generate truth analysis.",
          explanation: "", key_facts: [], verified_news: [], fact_check_links: [],
        }));
      } catch (err) {
        return send(res, 500, JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Static file serving ────────────────────────────────────────
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
