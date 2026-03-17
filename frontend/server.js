require("dotenv").config();

const http = require("http");
const fs   = require("fs");
const path = require("path");
const url  = require("url");

const PORT             = process.env.PORT             || 3000;
const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const FACTCHECK_API_KEY= process.env.FACTCHECK_API_KEY;
const NEWSAPI_KEY      = process.env.NEWSAPI_KEY;
const TAVILY_API_KEY   = process.env.TAVILY_API_KEY;

const MIME = {
  ".html": "text/html",
  ".css" : "text/css",
  ".js"  : "application/javascript",
  ".json": "application/json"
};

/* ════════════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════════ */

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function safeJson(v) {
  try { return JSON.parse(v); } catch { return null; }
}

function extractJsonBlock(text) {
  if (!text) return null;
  const first = text.indexOf("{");
  const last  = text.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  return text.slice(first, last + 1);
}

function readBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => resolve(body));
  });
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }

/* ════════════════════════════════════════════════════════════════
   TAVILY  — real-time web search (the ground truth layer)
════════════════════════════════════════════════════════════════ */

async function tavilySearch(query, { maxResults = 7, includeDomains = [] } = {}) {
  if (!TAVILY_API_KEY) return { answer: "", results: [] };

  const body = {
    api_key            : TAVILY_API_KEY,
    query,
    search_depth       : "advanced",
    include_answer     : true,
    max_results        : maxResults,
    include_raw_content: false,
  };
  if (includeDomains.length) body.include_domains = includeDomains;

  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(body),
    });
    if (!resp.ok) return { answer: "", results: [] };
    const data = await resp.json();

    return {
      answer : data.answer || "",
      results: (data.results || []).map(r => {
        let source = r.url;
        try { source = new URL(r.url).hostname.replace("www.", ""); } catch {}
        return {
          title      : r.title        || "",
          url        : r.url          || "",
          content    : (r.content || "").slice(0, 400),
          source,
          publishedAt: r.published_date || null,
          relevance  : r.score          || 0,
        };
      }),
    };
  } catch {
    return { answer: "", results: [] };
  }
}

/* ════════════════════════════════════════════════════════════════
   GROQ  — LLM reasoning
   Uses llama-3.3-70b-versatile for analysis (smarter, more accurate)
   Uses llama-3.1-8b-instant for quick tasks (explanations, propagation)
════════════════════════════════════════════════════════════════ */

async function groqChat(messages, { maxTokens = 500, model = "llama-3.3-70b-versatile" } = {}) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");

  const msgs = typeof messages === "string"
    ? [{ role: "user", content: messages }]
    : messages;

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method : "POST",
    headers: {
      "Content-Type" : "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model, messages: msgs, temperature: 0.1, max_tokens: maxTokens }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || "Groq failed");
  return data?.choices?.[0]?.message?.content || "";
}

/* ════════════════════════════════════════════════════════════════
   VIRALITY heuristic
════════════════════════════════════════════════════════════════ */

function calculateViralityScore(text) {
  const triggers = ["breaking","urgent","share","forward","immediately",
    "alert","emergency","before it is deleted","government hiding","they dont want you to know"];
  let score = 10;
  const lower = text.toLowerCase();
  triggers.forEach(w => { if (lower.includes(w)) score += 15; });
  return Math.min(score, 100);
}

/* ════════════════════════════════════════════════════════════════
   STEP 1 — Gather real-time evidence via Tavily
   Two parallel searches:
   A) General  — what is the current reality about this claim?
   B) Credibility — are there fact-checks or debunks?
════════════════════════════════════════════════════════════════ */

async function gatherEvidence(claim) {
  const [general, credibility] = await Promise.all([
    tavilySearch(claim, { maxResults: 8 }),
    tavilySearch(`"${claim}" fact check OR debunked OR verified OR confirmed`, {
      maxResults    : 6,
      includeDomains: [
        "snopes.com","factcheck.org","politifact.com","reuters.com",
        "apnews.com","bbc.com","bbc.co.uk","theguardian.com",
        "fullfact.org","boomlive.in","altnews.in","vishvasnews.com",
        "indiatoday.in","theprint.in","ndtv.com","hindustantimes.com",
        "who.int","cdc.gov","pib.gov.in",
      ],
    }),
  ]);

  const allResults = [...general.results, ...credibility.results]
    .filter((v, i, a) => a.findIndex(x => x.url === v.url) === i);

  return {
    generalAnswer    : general.answer,
    credibilityAnswer: credibility.answer,
    allResults,
    generalResults   : general.results,
    credibilityResults: credibility.results,
  };
}

/* ════════════════════════════════════════════════════════════════
   STEP 2 — Groq grounded analysis
   Groq reads ALL Tavily evidence and reasons about it.
   Uses the 70b model for best accuracy.
════════════════════════════════════════════════════════════════ */

async function analyzeWithGroq(claim, evidence) {
  const evidenceLines = [];

  if (evidence.generalAnswer)     evidenceLines.push(`WEB ANSWER: ${evidence.generalAnswer}`);
  if (evidence.credibilityAnswer) evidenceLines.push(`CREDIBILITY SEARCH: ${evidence.credibilityAnswer}`);

  evidence.generalResults.slice(0, 5).forEach(r =>
    evidenceLines.push(`SOURCE [${r.source}]: ${r.title} — ${r.content}`)
  );
  evidence.credibilityResults.slice(0, 4).forEach(r =>
    evidenceLines.push(`FACT-CHECK SOURCE [${r.source}]: ${r.title} — ${r.content}`)
  );

  const evidenceBlock = evidenceLines.join("\n\n").slice(0, 3500);
  const hasEvidence   = evidenceLines.length > 0;

  const systemPrompt = `You are an expert fact-checker and misinformation analyst with access to real-time web evidence.
Your ONLY job is to determine whether a claim is true or false based on the evidence provided.
You MUST prioritise real-time evidence over your training knowledge — especially for recent events like sports results, elections, and news.
If real-time evidence confirms the claim is true or happened, set fake_probability very LOW (0-15).
If real-time evidence debunks the claim, set fake_probability HIGH (75-100).
Never flag verified real news as misinformation. Never flag confirmed sports results as fake.`;

  const userPrompt = `CLAIM: "${claim}"

${hasEvidence
  ? `REAL-TIME WEB EVIDENCE (gathered right now — this takes priority over your training data):\n\n${evidenceBlock}`
  : "WARNING: No real-time evidence found. Use your best knowledge but acknowledge uncertainty."
}

Analyze the claim using the evidence above and return ONLY a valid JSON object. No markdown, no backticks.

{
  "label": "Confirmed True | Likely True | Needs Verification | Likely False | Confirmed False",
  "fake_probability": <integer 0-100>,
  "summary": "2-3 sentences citing specific evidence from the sources",
  "risk_signals": ["only list if claim has actual misinformation patterns"],
  "suspicious_phrases": ["manipulative phrases in the claim if any"],
  "recommendation": "one sentence for the user",
  "evidence_based": ${hasEvidence},
  "sources_found": ${evidence.allResults.length}
}

fake_probability SCALE (follow strictly based on evidence):
0–10   → CONFIRMED TRUE — multiple credible real-time sources confirm it
11–25  → LIKELY TRUE — credible sources support it
26–45  → UNCERTAIN — mixed or insufficient evidence
46–65  → LIKELY FALSE — sources contradict it
66–85  → PROBABLY FAKE — credible sources debunk it
86–100 → CONFIRMED FAKE — multiple fact-checkers debunk it

CRITICAL:
- Sports results, election results, official announcements confirmed by real sources = fake_probability 0–10
- Known conspiracy theories with zero credible backing = fake_probability 80+
- Do NOT penalise claims just because they sound surprising — look at the evidence
- The label MUST match the fake_probability number`;

  const raw = await groqChat(
    [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
    { maxTokens: 650, model: "llama-3.3-70b-versatile" }
  );

  let parsed = safeJson(raw) || safeJson(extractJsonBlock(raw));

  if (!parsed) {
    const fallbackRaw = await groqChat(
      `Is this claim true or false? "${claim}". Return ONLY JSON: {"label":"Needs Verification","fake_probability":50,"summary":"Analysis incomplete.","risk_signals":[],"suspicious_phrases":[],"recommendation":"Check trusted sources.","evidence_based":false,"sources_found":0}`,
      { maxTokens: 300, model: "llama-3.1-8b-instant" }
    ).catch(() => "{}");
    parsed = safeJson(fallbackRaw) || safeJson(extractJsonBlock(fallbackRaw)) || {
      label: "Needs Verification", fake_probability: 50,
      summary: "Analysis incomplete.", risk_signals: [],
      suspicious_phrases: [], recommendation: "Check trusted sources.",
      evidence_based: false, sources_found: 0,
    };
  }

  parsed.fake_probability = clamp(parsed.fake_probability ?? 50, 0, 100);
  parsed.tavily_sources   = evidence.allResults.slice(0, 8);

  return parsed;
}

/* ════════════════════════════════════════════════════════════════
   STEP 3 — Fused probability score
   Groq (already Tavily-grounded) = dominant signal
   Hard overrides prevent clearly wrong results
════════════════════════════════════════════════════════════════ */

function heuristicScore(claim) {
  let s = 15;
  if (/share|forward|before.{0,10}delet/i.test(claim))               s += 25;
  if (/they don.{0,5}t want|government.{0,20}(hid|ly)/i.test(claim)) s += 22;
  if (/[A-Z]{8,}/.test(claim))                                        s += 12;
  if (/secret(ly)?|hidden|cover.?up|conspir/i.test(claim))            s += 18;
  if (/miracle|100%\s*cure|guaranteed cure/i.test(claim))             s += 15;
  if (/urgent|breaking|alert/i.test(claim))                           s +=  8;
  if (/according to|study shows|research|published in/i.test(claim))  s -= 12;
  if (/reuters|bbc|apnews|ndtv|who\.int/i.test(claim))               s -= 10;
  return clamp(s, 5, 90);
}

function ratingClass(r) {
  const t = (r || "").toLowerCase();
  if (/false|fake|hoax|pants|incorrect|debunked|no evidence/.test(t)) return "false";
  if (/misleading|mixed|partly|half.true|unproven/.test(t))           return "mixed";
  if (/true|correct|accurate|verified|confirmed/.test(t))             return "true";
  return "other";
}

async function buildScoreData(claim, groqFakeProbability, factChecks, tavilySources) {
  // Component A: Groq (70b, Tavily-grounded) — most reliable
  const groqC = clamp(typeof groqFakeProbability === "number" ? groqFakeProbability : 50, 0, 100);

  // Component B: Google Fact-Check DB
  const counts = { true: 0, false: 0, mixed: 0, other: 0 };
  (factChecks || []).forEach(c =>
    (c.claimReview || []).forEach(r => counts[ratingClass(r.textualRating)]++)
  );
  const fcTotal = counts.true + counts.false + counts.mixed + counts.other;
  let fcC = null;
  if (fcTotal > 0) {
    fcC = clamp(
      (counts.false * 95 + counts.mixed * 55 + counts.other * 50 + counts.true * 5) / fcTotal,
      0, 100
    );
  }

  // Component C: Tavily source quality signal
  let tavilyC = null;
  if (tavilySources && tavilySources.length > 0) {
    const debunkSources = tavilySources.filter(s =>
      /snopes|factcheck\.org|politifact|fullfact|boomlive|altnews|vishvas/i.test(s.source || "")
    );
    const credibleNews = tavilySources.filter(s =>
      /reuters|apnews|bbc|guardian|ndtv|hindustantimes|indianexpress|thehindu|pib\.gov|espn|cricinfo|icc/i.test(s.source || "")
    );

    if (credibleNews.length >= 2 && debunkSources.length === 0) {
      // Multiple credible news sources, no debunks = very likely true
      tavilyC = clamp(8 + (2 / credibleNews.length) * 8, 5, 20);
    } else if (debunkSources.length >= 2) {
      // Multiple debunk sources = very likely false
      tavilyC = clamp(72 + debunkSources.length * 4, 72, 95);
    } else {
      // Reduce uncertainty proportional to source count
      tavilyC = clamp(50 - tavilySources.length * 4, 15, 50);
    }
  }

  // Component D: Heuristic (lowest weight)
  const heurC = heuristicScore(claim);

  // Weighted fusion
  // Groq (Tavily-grounded): 65%  Tavily signal: 20%  FC DB: 10%  Heuristic: 5%
  let weightedSum = groqC * 65;
  let totalWeight = 65;

  if (tavilyC !== null) { weightedSum += tavilyC * 20; totalWeight += 20; }
  else                  { weightedSum += groqC   * 20; totalWeight += 20; }

  if (fcC !== null) { weightedSum += fcC   * 10; totalWeight += 10; }
  else              { weightedSum += groqC * 10; totalWeight += 10; }

  weightedSum += heurC * 5; totalWeight += 5;

  let fused = weightedSum / totalWeight;

  // Hard overrides — prevent clearly wrong results
  // If Groq + Tavily both say it's true → cap final score at 20
  if (groqC <= 15 && tavilyC !== null && tavilyC <= 20) {
    fused = Math.min(fused, 18);
  }
  // If Groq + fact-checkers both confirm false → floor at 75
  if (groqC >= 80 && fcC !== null && fcC >= 75) {
    fused = Math.max(fused, 75);
  }

  fused = clamp(fused, 1, 99);

  console.log("SCORE COMPONENTS — groq:", groqC, "| tavily:", tavilyC, "| fc:", fcC, "| heuristic:", heurC, "| FINAL:", fused);

  const fcLine     = fcC !== null ? `Fact-check databases: ${fcC}% fake (${fcTotal} reviews).` : "No fact-check records found.";
  const tavilyLine = tavilyC !== null ? `Web sources found: ${(tavilySources || []).length} (signal: ${tavilyC}%).` : "";

  const explanation = await groqChat(
    `Score: ${fused}% fake probability for: "${claim}". Evidence: AI=${groqC}%, ${fcLine} ${tavilyLine}. Write 2 plain-English sentences explaining this score. Start with "This claim has a ${fused}% chance of being false". Be specific. No JSON.`,
    { maxTokens: 160, model: "llama-3.1-8b-instant" }
  ).catch(() => `This claim has a ${fused}% chance of being false based on real-time evidence and AI analysis.`);

  return {
    fused_score: fused,
    components : { groq: groqC, heuristic: heurC, factcheck: fcC, tavily: tavilyC },
    fc_reviews : fcTotal,
    explanation: explanation.trim(),
  };
}

/* ════════════════════════════════════════════════════════════════
   FACT-CHECK API  (Google)
════════════════════════════════════════════════════════════════ */

async function fetchFactChecks(query) {
  if (!FACTCHECK_API_KEY) return [];
  const params = new URLSearchParams({ query, languageCode: "en", pageSize: "5", key: FACTCHECK_API_KEY });
  const resp   = await fetch(`https://factchecktools.googleapis.com/v1alpha1/claims:search?${params}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data?.claims || []).map(c => ({
    text       : c.text,
    claimant   : c.claimant,
    claimReview: (c.claimReview || []).map(r => ({
      publisherName: r.publisher?.name || "",
      title        : r.title           || "",
      url          : r.url             || "",
      textualRating: r.textualRating   || "",
      reviewDate   : r.reviewDate      || "",
    })),
  }));
}

/* ════════════════════════════════════════════════════════════════
   NEWS API
════════════════════════════════════════════════════════════════ */

async function searchNews(query) {
  if (!NEWSAPI_KEY) return [];
  const params = new URLSearchParams({ q: query, language: "en", sortBy: "relevancy", pageSize: "6", apiKey: NEWSAPI_KEY });
  const resp   = await fetch(`https://newsapi.org/v2/everything?${params}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data?.articles || []).map(a => ({
    title      : a.title,
    source     : a.source?.name,
    url        : a.url,
    publishedAt: a.publishedAt,
    description: a.description,
  }));
}

/* ════════════════════════════════════════════════════════════════
   PROPAGATION TRACKER
════════════════════════════════════════════════════════════════ */

async function buildPropagationData(claim) {
  const [articles, tavilyData] = await Promise.all([
    searchNews(claim).catch(() => []),
    tavilySearch(claim, { maxResults: 6 }).catch(() => ({ results: [], answer: "" })),
  ]);

  const sourceMap = {};
  articles.forEach(a => {
    const src = a.source || "Unknown";
    if (!sourceMap[src]) sourceMap[src] = { count: 0, articles: [] };
    sourceMap[src].count++;
    sourceMap[src].articles.push(a);
  });
  const topSources = Object.entries(sourceMap).sort((a, b) => b[1].count - a[1].count).slice(0, 6);

  const dates = articles
    .map(a => a.publishedAt ? new Date(a.publishedAt) : null)
    .filter(Boolean)
    .sort((a, b) => a - b);
  const earliestDate = dates.length
    ? dates[0].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  const sourceNames = topSources.map(([k]) => k).join(", ") || "no news sources found";
  const raw = await groqChat(
    `Claim: "${claim}". News outlets: ${sourceNames}. ${earliestDate ? `Earliest: ${earliestDate}.` : ""}
Return ONLY valid JSON: {"origin":"platform","spread_path":["p1","p2","p3"],"regions":[{"name":"Region","risk":"high|medium|low","reason":"reason"}],"peak_platform":"platform","spread_speed":"fast|moderate|slow","total_estimated_reach":number}`,
    { maxTokens: 400, model: "llama-3.1-8b-instant" }
  ).catch(() => "{}");
  const groqData = safeJson(raw) || safeJson(extractJsonBlock(raw)) || {};

  return {
    newsArticles : articles.slice(0, 8),
    topSources   : topSources.map(([name, d]) => ({ name, count: d.count })),
    earliestDate,
    origin       : groqData.origin        || "Unknown",
    spread_path  : groqData.spread_path   || [],
    regions      : groqData.regions       || [],
    peak_platform: groqData.peak_platform || "Unknown",
    spread_speed : groqData.spread_speed  || "moderate",
    total_estimated_reach: groqData.total_estimated_reach || 0,
  };
}

/* ════════════════════════════════════════════════════════════════
   TRUTH ENGINE
════════════════════════════════════════════════════════════════ */

async function buildTruthData(claim) {
  const [tavilyGeneral, tavilyFc, newsArticles, factChecks] = await Promise.all([
    tavilySearch(`verified facts: ${claim}`, { maxResults: 5 }).catch(() => ({ results: [], answer: "" })),
    tavilySearch(`fact check ${claim}`, {
      maxResults    : 5,
      includeDomains: ["snopes.com","factcheck.org","politifact.com","reuters.com","apnews.com","bbc.com","fullfact.org","boomlive.in"],
    }).catch(() => ({ results: [], answer: "" })),
    searchNews(claim).catch(() => []),
    fetchFactChecks(claim).catch(() => []),
  ]);

  const evidence = [
    tavilyGeneral.answer ? `Web answer: ${tavilyGeneral.answer}` : "",
    ...tavilyGeneral.results.slice(0, 3).map(r => `${r.source}: ${r.content || r.title}`),
    ...tavilyFc.results.slice(0, 3).map(r => `Fact-check (${r.source}): ${r.content || r.title}`),
  ].filter(Boolean).join("\n").slice(0, 2000);

  const raw = await groqChat(
    `Claim: "${claim}"\n\n${evidence ? `REAL-TIME EVIDENCE:\n${evidence}` : "No evidence."}\n\nReturn ONLY valid JSON: {"corrected_claim":"accurate version based on evidence","explanation":"plain language 2-3 sentences","key_facts":["fact1","fact2","fact3"],"trusted_sources_to_check":["source1"]}`,
    { maxTokens: 600, model: "llama-3.3-70b-versatile" }
  ).catch(() => "{}");

  const groqTruth = safeJson(raw) || safeJson(extractJsonBlock(raw)) || {};

  const fcArticles = [];
  factChecks.forEach(c => {
    (c.claimReview || []).forEach(r => {
      if (r.url) fcArticles.push({ title: r.title || c.text, source: r.publisherName, url: r.url, rating: r.textualRating });
    });
  });

  const tavilySources = [...tavilyFc.results, ...tavilyGeneral.results]
    .filter((v, i, a) => a.findIndex(x => x.url === v.url) === i)
    .slice(0, 5)
    .map(r => ({ title: r.title, source: r.source, url: r.url, publishedAt: r.publishedAt }));

  return {
    corrected_claim : groqTruth.corrected_claim || "",
    explanation     : groqTruth.explanation     || "",
    key_facts       : groqTruth.key_facts       || [],
    news_articles   : tavilySources.length ? tavilySources : newsArticles.slice(0, 5),
    fact_check_links: fcArticles.slice(0, 5),
    tavily_answer   : tavilyGeneral.answer || tavilyFc.answer || "",
  };
}

/* ════════════════════════════════════════════════════════════════
   CLAIM AUTOPSY
════════════════════════════════════════════════════════════════ */

async function buildAutopsyData(claim) {
  const prompt = `You are a misinformation forensics expert. Analyze this claim and return ONLY a JSON object. No markdown, no backticks, no extra text.

Claim: ${claim}

Return exactly:
{"verdict":"Fabricated","overall_manipulation_score":75,"autopsy_summary":"One dramatic forensic sentence.","segments":[{"text":"phrase from claim","type":"fear_trigger","label":"Fear Trigger","explanation":"Why this phrase is problematic."}],"manipulation_techniques":[{"name":"Appeal to Fear","severity":"high","description":"Uses fear to prevent rational analysis."}],"who_benefits":"Who benefits from spreading this."}

Rules:
- verdict: Fabricated | Misleading | Manipulative | Partially True | Verified True | Unverified
- segment type: fabricated | fear_trigger | misleading | conspiracy_framing | emotional_bait | neutral | unverifiable
- severity: high | medium | low
- Split the claim into 3-8 meaningful phrases covering ALL the text
- If claim appears to be legitimate confirmed news: use verdict "Verified True" and type "neutral" for segments`;

  const raw    = await groqChat(prompt, { maxTokens: 900, model: "llama-3.1-8b-instant" });
  const parsed = safeJson(raw) || safeJson(extractJsonBlock(raw));

  return parsed || {
    verdict: "Unverified",
    overall_manipulation_score: 50,
    autopsy_summary: "Analysis could not be completed.",
    segments: [{ text: claim, type: "unverifiable", label: "Unverified", explanation: "Could not parse AI response." }],
    manipulation_techniques: [],
    who_benefits: "Unknown",
  };
}

/* ════════════════════════════════════════════════════════════════
   SCREENSHOT — Vision model extracts text
════════════════════════════════════════════════════════════════ */

async function extractTextFromImage(imageBase64, mimeType) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method : "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body   : JSON.stringify({
      model      : "meta-llama/llama-4-scout-17b-16e-instruct",
      temperature: 0.1,
      max_tokens : 500,
      messages   : [{
        role   : "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: "text", text: `Extract all visible text and identify the main claim. Return ONLY valid JSON, no markdown:
{"extracted_text":"all visible text","main_claim":"core claim in one sentence","source_type":"WhatsApp|Twitter|Facebook|News|Unknown","context":"one sentence about content type"}` },
        ],
      }],
    }),
  });

  const result = await resp.json();
  if (!resp.ok) throw new Error(result?.error?.message || "Vision API failed");

  const text   = result?.choices?.[0]?.message?.content || "";
  const parsed = safeJson(text) || safeJson(extractJsonBlock(text));
  return parsed || { extracted_text: text, main_claim: text, source_type: "Unknown", context: "" };
}

/* ════════════════════════════════════════════════════════════════
   HTTP SERVER
════════════════════════════════════════════════════════════════ */

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  /* /api/groq — gather evidence first, then analyze */
  if (req.method === "POST" && parsed.pathname === "/api/groq") {
    const body  = await readBody(req);
    const data  = safeJson(body) || {};
    const claim = (data.claim || "").trim();
    if (!claim) return send(res, 400, JSON.stringify({ error: "Claim required" }));
    try {
      console.log("\n════════════════════════════════════");
      console.log("CLAIM:", claim);

      const evidence = await gatherEvidence(claim);
      console.log("TAVILY general answer:", evidence.generalAnswer || "(none)");
      console.log("TAVILY general results:", evidence.generalResults.length, "sources");
      evidence.generalResults.forEach(r => console.log("  →", r.source, "|", r.title.slice(0,60)));
      console.log("TAVILY credibility results:", evidence.credibilityResults.length, "sources");
      evidence.credibilityResults.forEach(r => console.log("  →", r.source, "|", r.title.slice(0,60)));

      const result = await analyzeWithGroq(claim, evidence);
      console.log("GROQ fake_probability:", result.fake_probability);
      console.log("GROQ label:", result.label);
      console.log("GROQ summary:", result.summary);
      console.log("GROQ evidence_based:", result.evidence_based);
      console.log("════════════════════════════════════\n");

      result.virality_score = calculateViralityScore(claim);
      return send(res, 200, JSON.stringify(result));
    } catch (err) {
      console.error("/api/groq:", err.message);
      return send(res, 500, JSON.stringify({ error: err.message }));
    }
  }

  /* /api/factcheck */
  if (req.method === "POST" && parsed.pathname === "/api/factcheck") {
    const body  = await readBody(req);
    const data  = safeJson(body) || {};
    const claim = (data.claim || "").trim();
    if (!claim) return send(res, 400, JSON.stringify({ error: "Claim required" }));
    try {
      return send(res, 200, JSON.stringify({ claims: await fetchFactChecks(claim) }));
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: err.message }));
    }
  }

  /* /api/propagation */
  if (req.method === "POST" && parsed.pathname === "/api/propagation") {
    const body  = await readBody(req);
    const data  = safeJson(body) || {};
    const claim = (data.claim || "").trim();
    if (!claim) return send(res, 400, JSON.stringify({ error: "Claim required" }));
    try {
      return send(res, 200, JSON.stringify(await buildPropagationData(claim)));
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: err.message }));
    }
  }

  /* /api/truth */
  if (req.method === "POST" && parsed.pathname === "/api/truth") {
    const body  = await readBody(req);
    const data  = safeJson(body) || {};
    const claim = (data.claim || "").trim();
    if (!claim) return send(res, 400, JSON.stringify({ error: "Claim required" }));
    try {
      return send(res, 200, JSON.stringify(await buildTruthData(claim)));
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: err.message }));
    }
  }

  /* /api/score */
  if (req.method === "POST" && parsed.pathname === "/api/score") {
    const body = await readBody(req);
    const data = safeJson(body) || {};
    const { claim, groqFakeProbability, factChecks, tavilySources } = data;
    if (!claim) return send(res, 400, JSON.stringify({ error: "Claim required" }));
    try {
      return send(res, 200, JSON.stringify(
        await buildScoreData(claim, groqFakeProbability, factChecks || [], tavilySources || [])
      ));
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: err.message }));
    }
  }

  /* /api/extract-image */
  if (req.method === "POST" && parsed.pathname === "/api/extract-image") {
    const body = await readBody(req);
    const data = safeJson(body) || {};
    const { imageBase64, mimeType } = data;
    if (!imageBase64) return send(res, 400, JSON.stringify({ error: "Image required" }));
    try {
      return send(res, 200, JSON.stringify(await extractTextFromImage(imageBase64, mimeType || "image/jpeg")));
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: err.message }));
    }
  }

  /* /api/autopsy */
  if (req.method === "POST" && parsed.pathname === "/api/autopsy") {
    const body  = await readBody(req);
    const data  = safeJson(body) || {};
    const claim = (data.claim || "").trim();
    if (!claim) return send(res, 400, JSON.stringify({ error: "Claim required" }));
    try {
      return send(res, 200, JSON.stringify(await buildAutopsyData(claim)));
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: err.message }));
    }
  }

  /* Static files */
  const filePath = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const fullPath = path.join(__dirname, filePath);
  fs.readFile(fullPath, (err, fileData) => {
    if (err) return send(res, 404, "Not Found", "text/plain");
    send(res, 200, fileData, MIME[path.extname(fullPath)] || "application/octet-stream");
  });
});

server.listen(PORT, () => console.log(`TruthLens → http://localhost:${PORT}`));