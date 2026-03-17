// app.js — Credible Chronicles (Anuradha version)
// Only includes what index.html actually uses

const FACTCHECK_API_KEY = "AIzaSyCqrnh_HSH31lCd6LKYHSYVBPAw1_ZjwbA";

const SENSATIONAL_TERMS = [
  "share","forward","urgent","breaking","shocking","secret","banned",
  "alert","warning","evacuate","miracle","cure","guarantee",
  "free","cash","giveaway","click","register","verify"
];

// ── Heuristics ─────────────────────────────────────────────────────

function detectPatterns(text) {
  const lower = text.toLowerCase();
  const p = [];
  if (SENSATIONAL_TERMS.some(t => lower.includes(t)))            p.push("Sensational wording");
  if (/[A-Z]{6,}/.test(text))                                    p.push("Excessive capital letters");
  if (/\b(all|every|always|never|guaranteed)\b/i.test(text))     p.push("Absolute claim");
  if (/https?:\/\//i.test(text))                                  p.push("External links present");
  if (!/\b(source|report|official|study)\b/i.test(text))         p.push("No clear source cited");
  return p;
}

function scoreFromHeuristics(patterns, length) {
  let score = 35;
  score += patterns.length * 10;
  if (length < 50)  score += 5;
  if (length > 200) score -= 5;
  return Math.max(5, Math.min(90, score));
}

function calibrateScore(score) {
  return Math.round(Math.pow(score / 100, 1.15) * 100);
}

// ── Renderers ──────────────────────────────────────────────────────

function renderDial(score, label) {
  const dial  = document.querySelector("#dial");
  const value = document.querySelector("#dial-value");
  const lbl   = document.querySelector("#dial-label");
  if (!dial) return;

  const color = score >= 70 ? "#e84c7f"
              : score >= 40 ? "#f7a07e"
              : "#2f8f6b";

  const deg = Math.round((score / 100) * 360);
  dial.style.background = `conic-gradient(${color} 0deg ${deg}deg, #3a1028 ${deg}deg 360deg)`;

  if (value) { value.textContent = `${score}%`; value.style.color = color; }
  if (lbl)   lbl.textContent = label;
}

function renderVirality(score) {
  const bar   = document.querySelector("#virality-score");
  const label = document.querySelector("#virality-label");
  if (!bar) return;
  const safe = Math.max(0, Math.min(100, score || 0));
  bar.style.width = safe + "%";
  if (label) {
    const level = safe > 70 ? "High viral potential"
                : safe > 40 ? "Moderate spread potential"
                : "Low";
    label.textContent = `${safe}% • ${level}`;
  }
}

function renderViralitySignals(text) {
  const list = document.querySelector("#virality-signals");
  if (!list) return;
  list.innerHTML = "";
  ["breaking","urgent","share","forward","alert","emergency"].forEach(t => {
    if (text.toLowerCase().includes(t)) {
      const li = document.createElement("li");
      li.textContent = `Trigger word detected: "${t}"`;
      list.appendChild(li);
    }
  });
  if (!list.children.length) {
    const li = document.createElement("li");
    li.textContent = "No strong virality triggers detected.";
    list.appendChild(li);
  }
}

function renderPatterns(patterns) {
  const list = document.querySelector("#pattern-list");
  if (!list) return;
  list.innerHTML = "";
  if (!patterns.length) {
    const li = document.createElement("li");
    li.textContent = "No strong misinformation signals detected.";
    list.appendChild(li);
    return;
  }
  patterns.forEach(p => {
    const li = document.createElement("li");
    li.textContent = p;
    list.appendChild(li);
  });
}

function renderGroqInsights(data) {
  const summary = document.querySelector("#groq-summary");
  const rec     = document.querySelector("#groq-recommendation");
  const risks   = document.querySelector("#groq-risks");
  const phrases = document.querySelector("#groq-phrases");

  if (summary) summary.textContent = data.summary        || "";
  if (rec)     rec.textContent     = data.recommendation || "";

  if (risks) {
    risks.innerHTML = "";
    (data.risk_signals || []).forEach(r => {
      const li = document.createElement("li");
      li.textContent = r;
      risks.appendChild(li);
    });
  }

  if (phrases) {
    phrases.innerHTML = "";
    (data.suspicious_phrases || []).forEach(p => {
      const li = document.createElement("li");
      li.textContent = p;
      phrases.appendChild(li);
    });
  }
}

function ratingClass(r) {
  const t = (r || "").toLowerCase();
  if (/false|fake|hoax|incorrect|inaccurate|misrepresent|pants.on.fire|pants.fire|four.pinocchio|three.pinocchio|two.pinocchio|fabricated|scam|debunked|mislead|distorted|unsupported|lacks.context|missing.context|no.evidence|baseless|unfounded|wrong|disputed/.test(t)) return "false";
  if (/mixture|mixed|partially|half|mostly false|some truth|partly|unverified|needs.context|unproven|inconclusive|flawed/.test(t)) return "mixed";
  if (/true|correct|accurate|verified|confirmed|mostly true|largely true|supported/.test(t)) return "true";
  return "false";
}

function computeConsensus(claims) {
  const counts  = { true: 0, false: 0, mixed: 0 };
  const reviews = [];
  claims.forEach(c => {
    (c.claimReview || []).forEach(r => {
      counts[ratingClass(r.textualRating)]++;
      reviews.push({
        claim:     c.text                          || "",
        publisher: r.publisher?.name || r.publisherName || "",
        rating:    r.textualRating                 || "",
        title:     r.title                         || "",
        url:       r.url                           || ""
      });
    });
  });
  const total = counts.true + counts.false + counts.mixed;
  let consensus = "Unknown", color = "#6b7280";
  if (total > 0) {
    if      (counts.false >= counts.true  && counts.false >= counts.mixed) { consensus = "False"; color = "#e84c7f"; }
    else if (counts.true  >= counts.false && counts.true  >= counts.mixed) { consensus = "True";  color = "#2f8f6b"; }
    else                                                                    { consensus = "Mixed"; color = "#f7a07e"; }
  }
  return { consensus, counts, total, color, reviews };
}

function renderConsensus(consensusData) {
  const { consensus, counts, total, color } = consensusData;
  const label = document.querySelector("#consensus-label");
  if (label) {
    label.textContent  = total > 0
      ? `Consensus: ${consensus} — ${total} fact-check${total > 1 ? "s" : ""}`
      : "Consensus: No fact-checks found";
    label.style.color      = color;
    label.style.fontWeight = total > 0 ? "600" : "400";
  }
  if (total > 0) {
    const t = document.querySelector("#consensus-true");
    const f = document.querySelector("#consensus-false");
    const m = document.querySelector("#consensus-mixed");
    if (t) t.style.width = (counts.true  / total * 100) + "%";
    if (f) f.style.width = (counts.false / total * 100) + "%";
    if (m) m.style.width = (counts.mixed / total * 100) + "%";
  }
}

function renderEvidence(reviews) {
  const list = document.querySelector("#evidence-list");
  if (!list) return;
  list.innerHTML = "";
  if (!reviews || reviews.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No fact-check matches found.";
    li.style.color = "#caa9b8";
    list.appendChild(li);
    return;
  }
  reviews.slice(0, 6).forEach(r => {
    const li = document.createElement("li");
    const rc = ratingClass(r.rating) === "false" ? "#e84c7f"
             : ratingClass(r.rating) === "true"  ? "#2f8f6b"
             : "#f7a07e";
    li.innerHTML = `
      <div style="margin-bottom:3px">
        <strong style="font-size:13px;color:#f6e8f0">${r.title || "Fact Check"}</strong>
      </div>
      <div style="font-size:12px;color:#caa9b8;margin-bottom:3px">
        ${r.publisher || "Unknown"} •
        <span style="color:${rc};font-weight:600">${r.rating || "Checked"}</span>
      </div>
      ${r.claim ? `<div style="font-size:12px;color:#e8d5e0;font-style:italic;margin-bottom:3px">"${r.claim.slice(0,120)}${r.claim.length>120?"…":""}"</div>` : ""}
      ${r.url   ? `<a href="${r.url}" target="_blank" rel="noopener noreferrer" style="font-size:11px;color:#ff8fb3">View fact-check →</a>` : ""}
    `;
    list.appendChild(li);
  });
}

// ── API calls ──────────────────────────────────────────────────────

async function fetchGroq(claim) {
  const res = await fetch("/api/groq", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ claim })
  });
  return res.json();
}

async function fetchFactChecksRaw(claim) {
  const res = await fetch(
    `https://factchecktools.googleapis.com/v1alpha1/claims:search` +
    `?query=${encodeURIComponent(claim)}&key=${FACTCHECK_API_KEY}`
  );
  return res.json();
}

// ── Propagation map ────────────────────────────────────────────────

async function showPropagation(newsText, fakeProbability, verdict, factCheckReviews) {
  const section = document.getElementById("propagation-section");
  const status  = document.querySelector("#status");
  if (!section) return;

  section.style.display = "block";
  PropagationMap.setVerdict(verdict, fakeProbability);

  // Show immediately with quick estimated data
  const quickRes = await fetch("/api/propagation", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ text: newsText, fakeProbability, factCheckReviews: [] })
  });
  PropagationMap.animateIn(await quickRes.json());
  section.scrollIntoView({ behavior: "smooth", block: "start" });

  // Then refresh with real Tavily + fact-check data
  status.textContent = "Fetching real article data…";
  try {
    const realRes = await fetch("/api/propagation", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text: newsText, fakeProbability, factCheckReviews: factCheckReviews || [] })
    });
    const realData = await realRes.json();
    if (realData.realCount > 0) {
      PropagationMap.animateIn(realData);
      status.textContent = `✓ ${realData.dataSource}`;
    } else {
      status.textContent = realData.dataSource;
    }
  } catch {
    status.textContent = "Propagation map: estimated spread model";
  }
}

// ── Main analysis ──────────────────────────────────────────────────

async function analyzeClaim() {
  const text = document.querySelector("#claim").value.trim();
  if (!text) return;

  const status = document.querySelector("#status");
  status.textContent = "Running analysis…";

  const patterns  = detectPatterns(text);
  renderPatterns(patterns);
  renderViralitySignals(text);

  const heuristic = calibrateScore(scoreFromHeuristics(patterns, text.length));
  renderDial(heuristic, "Initial estimate");

  let finalScore   = heuristic;
  let finalVerdict = "uncertain";

  try {
    status.textContent = "Running Groq reasoning…";
    const groq = await fetchGroq(text);

    renderVirality(groq.virality_score || 0);
    finalScore = typeof groq.score === "number"
      ? calibrateScore(groq.score) : heuristic;

    const lowerLabel = (groq.label || "").toLowerCase();
    if      (lowerLabel.includes("false") || lowerLabel.includes("fake")) finalVerdict = "fake";
    else if (lowerLabel.includes("true")  || lowerLabel.includes("real")) finalVerdict = "real";

    renderDial(finalScore, groq.label || "AI analysis");
    renderGroqInsights(groq);
    status.textContent = "Groq complete. Checking fact-check databases…";

  } catch (e) {
    console.error(e);
    status.textContent = "Groq unavailable. Using heuristic result.";
  }

  // Fact-check + propagation
  fetchFactChecksRaw(text)
    .then(data => {
      const consensus = computeConsensus(data.claims || []);
      renderConsensus(consensus);
      renderEvidence(consensus.reviews);
      showPropagation(text, finalScore, finalVerdict, consensus.reviews);
      status.textContent = "Verification complete ✓";
    })
    .catch(err => {
      console.error("Fact-check error:", err);
      showPropagation(text, finalScore, finalVerdict, []);
      status.textContent = "Fact-check unavailable";
    });
}

// ── Init ───────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  if (typeof PropagationMap === "undefined") {
    console.error("graph.js not loaded — check script order in index.html");
    document.querySelector("#analyze").addEventListener("click", analyzeClaim);
    return;
  }
  PropagationMap.init("#propagation-map");
  document.querySelector("#analyze").addEventListener("click", analyzeClaim);
});