// app.js — Credible Chronicles (fully integrated)

const FACTCHECK_API_KEY = "";

const SENSATIONAL_TERMS = [
  "share","forward","urgent","breaking","shocking","secret",
  "banned","alert","warning","evacuate","miracle","cure",
  "guarantee","free","cash","giveaway","click","register","verify",
];

// ── Tab switcher ─────────────────────────────────────────────────────

function switchTab(tab) {
  const textPanel  = document.getElementById("panel-text");
  const imagePanel = document.getElementById("panel-image");
  const tabText    = document.getElementById("tab-text");
  const tabImage   = document.getElementById("tab-image");
  if (tab === "text") {
    textPanel.classList.remove("hidden");
    imagePanel.classList.add("hidden");
    tabText.classList.add("active");
    tabImage.classList.remove("active");
  } else {
    textPanel.classList.add("hidden");
    imagePanel.classList.remove("hidden");
    tabText.classList.remove("active");
    tabImage.classList.add("active");
  }
}

// ── Image upload helpers ──────────────────────────────────────────────

let _uploadedImageBase64 = null;

function clearImage() {
  _uploadedImageBase64 = null;
  document.getElementById("image-preview-wrap").classList.add("hidden");
  document.getElementById("drop-zone").classList.remove("hidden");
  document.getElementById("image-input").value = "";
  document.getElementById("extracted-claim-wrap").classList.add("hidden");
}

function handleImageFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    _uploadedImageBase64 = e.target.result.split(",")[1];
    document.getElementById("image-preview").src = e.target.result;
    document.getElementById("image-preview-wrap").classList.remove("hidden");
    document.getElementById("drop-zone").classList.add("hidden");
    const tag = document.getElementById("img-source-tag");
    if (tag) tag.textContent = file.name;
  };
  reader.readAsDataURL(file);
}

// ── Heuristics ────────────────────────────────────────────────────────

function detectPatterns(text) {
  const lower = text.toLowerCase();
  const p = [];

  // Only flag truly manipulative sensational terms, not news language
  const MANIPULATIVE_TERMS = [
    "forward करें","must share","share now","before it is deleted",
    "they don't want you to know","government hiding","miracle cure",
    "100% guaranteed","free cash","giveaway","click here","register now",
  ];
  if (MANIPULATIVE_TERMS.some((t) => lower.includes(t)))
    p.push("Manipulative forwarding language");

  if (/[A-Z]{8,}/.test(text)) p.push("Excessive capital letters");
  if (/\b(guaranteed|100%\s*free|free\s*money|click\s*now)\b/i.test(text))
    p.push("Promotional/scam language");
  if (/https?:\/\//i.test(text)) p.push("External links present");

  // Only flag missing source if it looks like a factual claim (not a news headline)
  const looksLikeHeadline = /:\s|govt|government|police|minister|official|deploy|supply|crisis/i.test(text);
  if (!looksLikeHeadline && !/\b(source|report|official|study|according)\b/i.test(text))
    p.push("No clear source cited");

  return p;
}

function scoreFromHeuristics(patterns, length) {
  // Start at a neutral 30 — not already biased toward fake
  let score = 30;
  score += patterns.length * 8;
  if (length < 30) score += 5;
  if (length > 300) score -= 5;
  return Math.max(5, Math.min(75, score));
}

function calibrateScore(score) {
  // Gentle curve — don't push borderline scores to extremes
  return Math.round(Math.pow(score / 100, 1.05) * 100);
}

// ── Renderers ─────────────────────────────────────────────────────────

function renderDial(fakeScore, _rawLabel) {
  const dial  = document.querySelector("#dial");
  const value = document.querySelector("#dial-value");
  const lbl   = document.querySelector("#dial-label");
  if (!dial) return;

  // Credibility = inverse of fake score
  const credibility = 100 - fakeScore;

  // Derive a clean human-readable label from the score — never show raw Groq label
  let label, color;
  if (credibility >= 80) { label = "Highly Credible";     color = "var(--ok)";     }
  else if (credibility >= 60) { label = "Likely Credible";color = "var(--ok)";     }
  else if (credibility >= 45) { label = "Needs Verification"; color = "var(--warn)"; }
  else if (credibility >= 25) { label = "Likely Misleading";  color = "var(--warn)"; }
  else                        { label = "Likely Fake";         color = "var(--danger)"; }

  const deg = Math.round((credibility / 100) * 360);
  dial.style.background = `conic-gradient(${color} 0deg ${deg}deg, #3a1028 ${deg}deg 360deg)`;
  if (value) { value.textContent = `${credibility}%`; value.style.color = color; }
  if (lbl)   { lbl.textContent = label; lbl.style.color = color; }
}

function renderVirality(score) {
  const bar   = document.querySelector("#virality-score");
  const label = document.querySelector("#virality-label");
  if (!bar) return;
  const safe = Math.max(0, Math.min(100, score || 0));
  bar.style.width = safe + "%";
  if (label) {
    const level = safe > 70 ? "High viral potential" : safe > 40 ? "Moderate spread potential" : "Low";
    label.textContent = `${safe}% • ${level}`;
  }
}

function renderViralitySignals(text) {
  const list = document.querySelector("#virality-signals");
  if (!list) return;
  list.innerHTML = "";
  ["breaking","urgent","share","forward","alert","emergency"].forEach((t) => {
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
  patterns.forEach((p) => {
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
  if (summary) summary.textContent = data.summary || "";
  if (rec)     rec.textContent     = data.recommendation || "";
  if (risks) {
    risks.innerHTML = "";
    (data.risk_signals || []).forEach((r) => {
      const li = document.createElement("li"); li.textContent = r; risks.appendChild(li);
    });
  }
  if (phrases) {
    phrases.innerHTML = "";
    (data.suspicious_phrases || []).forEach((p) => {
      const li = document.createElement("li"); li.textContent = p; phrases.appendChild(li);
    });
  }
}

// ── Fake Probability Score ────────────────────────────────────────────

function renderFakeScore(score, explanation, components) {
  const valEl  = document.getElementById("fake-score-value");
  const barEl  = document.getElementById("fake-score-bar");
  const explEl = document.getElementById("fake-score-explanation");
  const compEl = document.getElementById("fake-score-components");

  const color = score >= 70 ? "#e84c7f" : score >= 40 ? "#f7a07e" : "#2f8f6b";

  if (valEl)  { valEl.textContent = `${score}%`; valEl.style.color = color; }
  if (barEl)  { barEl.style.width = score + "%"; barEl.style.background = color; }
  if (explEl) explEl.textContent = explanation || "";

  if (compEl && components && components.length) {
    compEl.innerHTML = components.map((c) => {
      const cColor = c.score >= 70 ? "#e84c7f" : c.score >= 40 ? "#f7a07e" : "#2f8f6b";
      return `
        <div style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#caa9b8;margin-bottom:3px;">
            <span>${c.label}</span><span style="color:${cColor};font-weight:600">${c.score}%</span>
          </div>
          <div style="height:5px;background:rgba(255,255,255,0.08);border-radius:999px;overflow:hidden;">
            <div style="height:100%;width:${c.score}%;background:${cColor};border-radius:999px;transition:width .6s ease;"></div>
          </div>
        </div>`;
    }).join("");
  }
}

// ── Claim Autopsy ─────────────────────────────────────────────────────

// Map annotation type → CSS class + display label
const SEG_META = {
  fabricated:         { cls: "seg-fabricated",         label: "Fabricated",         icon: "🔴" },
  fear_trigger:       { cls: "seg-fear_trigger",        label: "Fear Trigger",        icon: "😨" },
  misleading:         { cls: "seg-misleading",          label: "Misleading",          icon: "🟠" },
  conspiracy_framing: { cls: "seg-conspiracy_framing",  label: "Conspiracy Framing",  icon: "🟣" },
  emotional_bait:     { cls: "seg-emotional_bait",      label: "Emotional Bait",      icon: "🟡" },
  unverifiable:       { cls: "seg-unverifiable",        label: "Unverifiable",        icon: "⚪" },
  neutral:            { cls: "seg-neutral",             label: "Neutral",             icon: "⚫" },
};

// Verdict config — driven by fakeScore passed in, NOT by AI label alone
function getVerdictConfig(verdict, fakeScore) {
  // Override AI verdict if score clearly contradicts it
  if (fakeScore <= 25)  verdict = "true";
  if (fakeScore >= 70)  verdict = "fake";

  if (verdict === "true") return {
    cls: "verdict-unverified", // reuse green-tinted style
    icon: "✅", label: "Likely Credible",
    color: "var(--ok)",
    bgStyle: "background:rgba(45,212,191,0.10);border:1px solid rgba(45,212,191,0.3);",
    statusText: "CREDIBLE", statusStyle: "background:rgba(45,212,191,0.15);color:var(--ok);border:1px solid rgba(45,212,191,0.3);"
  };
  if (verdict === "fake") return {
    cls: "verdict-fabricated",
    icon: "🚨", label: "Likely Misinformation",
    color: "var(--danger)",
    bgStyle: "background:rgba(255,77,109,0.12);border:1px solid rgba(255,77,109,0.3);",
    statusText: "FAKE", statusStyle: "background:rgba(255,77,109,0.15);color:var(--danger);border:1px solid rgba(255,77,109,0.3);"
  };
  return {
    cls: "verdict-unverified",
    icon: "🔍", label: "Needs Verification",
    color: "var(--muted)",
    bgStyle: "background:rgba(155,143,181,0.12);border:1px solid rgba(155,143,181,0.3);",
    statusText: "UNVERIFIED", statusStyle: "background:rgba(196,77,255,0.15);color:var(--accent);border:1px solid rgba(196,77,255,0.3);"
  };
}

function renderAutopsy(data, originalText, fakeScore) {
  document.getElementById("autopsy-idle")?.classList.add("hidden");
  document.getElementById("autopsy-running")?.classList.add("hidden");
  document.getElementById("autopsy-result")?.classList.remove("hidden");

  const verdict = data.verdict || "uncertain";
  const cfg = getVerdictConfig(verdict, fakeScore || 50);

  // Status badge in card title
  const statusEl = document.getElementById("autopsy-status");
  if (statusEl) {
    statusEl.textContent = cfg.statusText;
    statusEl.style.cssText = cfg.statusStyle + "margin-left:auto;font-size:11px;font-weight:700;padding:2px 10px;border-radius:999px;letter-spacing:.04em;";
  }

  // Verdict banner — using proper CSS class + structured HTML
  const verdictEl = document.getElementById("autopsy-verdict");
  if (verdictEl) {
    verdictEl.className = `autopsy-verdict ${cfg.cls}`;
    verdictEl.style.cssText = cfg.bgStyle;
    verdictEl.innerHTML = `
      <span class="verdict-icon">${cfg.icon}</span>
      <div class="verdict-right">
        <span class="verdict-label" style="color:${cfg.color}">${cfg.label}</span>
        <span class="verdict-score">${data.verdict_statement || ""}</span>
      </div>`;
  }

  // Annotated text — use proper .seg spans with .seg-tooltip
  const annotatedEl = document.getElementById("autopsy-annotated");
  if (annotatedEl) {
    let html = originalText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    if (data.annotations && data.annotations.length) {
      // Sort longest phrase first to avoid partial overlaps
      const sorted = [...data.annotations].sort((a, b) => (b.phrase || "").length - (a.phrase || "").length);
      sorted.forEach((ann) => {
        if (!ann.phrase) return;
        const meta    = SEG_META[ann.type] || SEG_META.neutral;
        const escaped = ann.phrase.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        const re      = new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        html = html.replace(re, `<span class="seg ${meta.cls}">${escaped}<span class="seg-tooltip"><strong>${meta.icon} ${meta.label}</strong>${(ann.reason || "").replace(/"/g,"'")}</span></span>`);
      });
    }
    annotatedEl.innerHTML = html;
  }

  // Techniques — use .technique-card with severity
  const techEl = document.getElementById("autopsy-techniques");
  if (techEl) {
    if (data.techniques && data.techniques.length) {
      // Assign severity based on position (first = most severe)
      const sevMap = ["sev-high", "sev-high", "sev-medium", "sev-medium", "sev-low"];
      techEl.innerHTML = data.techniques.map((t, i) => {
        const sev     = sevMap[i] || "sev-low";
        const sevText = sev === "sev-high" ? "HIGH RISK" : sev === "sev-medium" ? "MEDIUM RISK" : "LOW RISK";
        return `
          <div class="technique-card ${sev}">
            <div class="technique-sev ${sev}">${sevText}</div>
            <div class="technique-name">${t}</div>
          </div>`;
      }).join("");
    } else {
      techEl.innerHTML = `
        <div class="technique-card sev-low">
          <div class="technique-sev sev-low">LOW RISK</div>
          <div class="technique-name">No manipulation techniques detected</div>
          <div class="technique-desc">This claim does not appear to use common misinformation techniques.</div>
        </div>`;
    }
  }

  // Forensic summary
  const sumEl = document.getElementById("autopsy-summary");
  if (sumEl) sumEl.textContent = data.forensic_summary || "";

  // Who benefits
  const benEl = document.getElementById("autopsy-benefits");
  if (benEl) benEl.textContent = data.who_benefits || "Unknown";
}

// ── Truth Engine ──────────────────────────────────────────────────────

function renderTruth(data) {
  const correctedEl   = document.getElementById("truth-corrected");
  const explanationEl = document.getElementById("truth-explanation");
  const factsEl       = document.getElementById("truth-facts");
  const newsEl        = document.getElementById("truth-news");
  const factchecksEl  = document.getElementById("truth-factchecks");

  if (correctedEl) {
    correctedEl.textContent = data.corrected_claim || "No verified alternative found.";
    correctedEl.style.color = "#6ee7b7";
  }
  if (explanationEl) explanationEl.textContent = data.explanation || "";

  if (factsEl) {
    factsEl.innerHTML = "";
    (data.key_facts || []).forEach((f) => {
      const li = document.createElement("li");
      li.textContent   = f;
      li.style.cssText = "font-size:13px;color:#e8d5e0;margin-bottom:6px;";
      factsEl.appendChild(li);
    });
  }

  if (newsEl) {
    newsEl.innerHTML = "";
    (data.verified_news || []).forEach((n) => {
      const li = document.createElement("li");
      li.innerHTML = n.url
        ? `<a href="${n.url}" target="_blank" rel="noopener noreferrer" style="color:#ff8fb3;font-size:12px;">${n.title || n.url}</a>`
        : `<span style="font-size:12px;color:#caa9b8">${n.title || n}</span>`;
      newsEl.appendChild(li);
    });
  }

  if (factchecksEl) {
    factchecksEl.innerHTML = "";
    (data.fact_check_links || []).forEach((n) => {
      const li = document.createElement("li");
      li.innerHTML = n.url
        ? `<a href="${n.url}" target="_blank" rel="noopener noreferrer" style="color:#ff8fb3;font-size:12px;">${n.title || n.url}</a>`
        : `<span style="font-size:12px;color:#caa9b8">${n.title || n}</span>`;
      factchecksEl.appendChild(li);
    });
  }
}

// ── Propagation meta ──────────────────────────────────────────────────

function renderPropagationMeta(data) {
  const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.textContent = val; };
  const primaryNode = (data.nodes || []).filter(n => n.id !== "origin" && n.id !== "reshare")
    .sort((a,b) => (b.r||0) - (a.r||0))[0];

  set("prop-origin", data.language ? `${data.language} source` : null);
  set("prop-peak",   primaryNode ? primaryNode.label.replace("\n"," ") : null);
  set("prop-speed",  data.signals > 3 ? "Fast" : data.signals > 1 ? "Moderate" : "Slow");
  set("prop-reach",  data.signals > 3 ? "High" : data.signals > 1 ? "Medium" : "Low");

  const pathEl = document.getElementById("prop-spread-path");
  if (pathEl && data.nodes) {
    const order = ["origin","twitter","whatsapp","telegram","reshare"];
    const pathNodes = order.map(id => data.nodes.find(n => n.id === id)).filter(Boolean);
    pathEl.innerHTML = pathNodes.map((n, i) =>
      `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;">
        <span style="padding:2px 10px;border-radius:999px;background:rgba(255,143,179,0.1);border:1px solid rgba(255,143,179,0.2);color:#f6e8f0;">${n.label.replace("\n"," ")}</span>
        ${i < pathNodes.length-1 ? '<span style="color:#e84c7f">→</span>' : ""}
      </span>`
    ).join("");
  }
}

// ── Consensus / Evidence ──────────────────────────────────────────────

function ratingClass(r) {
  const t = (r || "").toLowerCase();
  if (/false|fake|hoax|incorrect|inaccurate|misrepresent|pants.on.fire|fabricated|scam|debunked|mislead|distorted|unsupported|lacks.context|missing.context|no.evidence|baseless|unfounded|wrong|disputed/.test(t))
    return "false";
  if (/mixture|mixed|partially|half|mostly false|some truth|partly|unverified|needs.context|unproven|inconclusive|flawed/.test(t))
    return "mixed";
  if (/true|correct|accurate|verified|confirmed|mostly true|largely true|supported/.test(t))
    return "true";
  return "false";
}

function computeConsensus(claims) {
  const counts  = { true: 0, false: 0, mixed: 0 };
  const reviews = [];
  claims.forEach((c) => {
    (c.claimReview || []).forEach((r) => {
      counts[ratingClass(r.textualRating)]++;
      reviews.push({
        claim:     c.text || "",
        publisher: r.publisher?.name || r.publisherName || "",
        rating:    r.textualRating || "",
        title:     r.title || "",
        url:       r.url || "",
      });
    });
  });
  const total = counts.true + counts.false + counts.mixed;
  let consensus = "Unknown", color = "#6b7280";
  if (total > 0) {
    if (counts.false >= counts.true && counts.false >= counts.mixed) { consensus = "False"; color = "#e84c7f"; }
    else if (counts.true >= counts.false && counts.true >= counts.mixed) { consensus = "True"; color = "#2f8f6b"; }
    else { consensus = "Mixed"; color = "#f7a07e"; }
  }
  return { consensus, counts, total, color, reviews };
}

function renderConsensus(consensusData) {
  const { consensus, counts, total, color } = consensusData;
  const label = document.querySelector("#consensus-label");
  if (label) {
    label.textContent  = total > 0 ? `Consensus: ${consensus} — ${total} fact-check${total > 1 ? "s" : ""}` : "Consensus: No fact-checks found";
    label.style.color      = color;
    label.style.fontWeight = total > 0 ? "600" : "400";
  }
  if (total > 0) {
    const t = document.querySelector("#consensus-true");
    const f = document.querySelector("#consensus-false");
    const m = document.querySelector("#consensus-mixed");
    if (t) t.style.width = (counts.true  / total) * 100 + "%";
    if (f) f.style.width = (counts.false / total) * 100 + "%";
    if (m) m.style.width = (counts.mixed / total) * 100 + "%";
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
  reviews.slice(0, 6).forEach((r) => {
    const li = document.createElement("li");
    const rc = ratingClass(r.rating) === "false" ? "#e84c7f" : ratingClass(r.rating) === "true" ? "#2f8f6b" : "#f7a07e";
    li.innerHTML = `
      <div style="margin-bottom:3px"><strong style="font-size:13px;color:#f6e8f0">${r.title || "Fact Check"}</strong></div>
      <div style="font-size:12px;color:#caa9b8;margin-bottom:3px">${r.publisher || "Unknown"} • <span style="color:${rc};font-weight:600">${r.rating || "Checked"}</span></div>
      ${r.claim ? `<div style="font-size:12px;color:#e8d5e0;font-style:italic;margin-bottom:3px">"${r.claim.slice(0,120)}${r.claim.length>120?"…":""}"</div>` : ""}
      ${r.url   ? `<a href="${r.url}" target="_blank" rel="noopener noreferrer" style="font-size:11px;color:#ff8fb3">View fact-check →</a>` : ""}
    `;
    list.appendChild(li);
  });
}

// ── API calls ─────────────────────────────────────────────────────────

async function fetchGroq(claim) {
  const res = await fetch("/api/groq", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim }),
  });
  return res.json();
}

async function fetchAutopsy(claim) {
  const res = await fetch("/api/groq-autopsy", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim }),
  });
  return res.json();
}

async function fetchTruth(claim) {
  const res = await fetch("/api/groq-truth", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim }),
  });
  return res.json();
}

async function fetchFactChecksRaw(claim) {
  const res = await fetch(
    `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(claim)}&key=${FACTCHECK_API_KEY}`
  );
  return res.json();
}

// ── Propagation map ───────────────────────────────────────────────────

async function showPropagation(newsText, fakeProbability, verdict, factCheckReviews) {
  const mapEl  = document.getElementById("propagation-map");
  const status = document.querySelector("#status");
  if (!mapEl) return;

  if (!mapEl.dataset.init) {
    PropagationMap.init("#propagation-map");
    mapEl.dataset.init = "1";
  }
  PropagationMap.setVerdict(verdict, fakeProbability);

  try {
    const quickRes  = await fetch("/api/propagation", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: newsText, fakeProbability, factCheckReviews: [] }),
    });
    const quickData = await quickRes.json();
    PropagationMap.animateIn(quickData);
    renderPropagationMeta(quickData);
  } catch (e) { console.error("Quick propagation failed:", e); }

  if (status) status.textContent = "Fetching real article data…";
  try {
    const realRes  = await fetch("/api/propagation", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: newsText, fakeProbability, factCheckReviews: factCheckReviews || [] }),
    });
    const realData = await realRes.json();
    if (realData.realCount > 0) {
      PropagationMap.animateIn(realData);
      renderPropagationMeta(realData);
      if (status) status.textContent = `✓ ${realData.dataSource}`;
    } else {
      if (status) status.textContent = realData.dataSource;
    }
  } catch {
    if (status) status.textContent = "Propagation map: estimated spread model";
  }
}

// ── Main analysis ─────────────────────────────────────────────────────

async function analyzeClaim() {
  const status  = document.querySelector("#status");
  const claimEl = document.querySelector("#claim");

  // Determine active tab
  const imageTabActive = document.getElementById("tab-image")?.classList.contains("active");
  let text = "";

  // ── IMAGE MODE: extract text from screenshot first ──
  if (imageTabActive && _uploadedImageBase64) {
    if (status) status.textContent = "Detecting language and extracting text…";
    document.getElementById("autopsy-idle")?.classList.add("hidden");
    document.getElementById("autopsy-running")?.classList.remove("hidden");
    document.getElementById("autopsy-result")?.classList.add("hidden");

    try {
      const imgEl    = document.getElementById("image-preview");
      const src      = imgEl?.src || "";
      const mimeType = src.startsWith("data:image/png")  ? "image/png"
                     : src.startsWith("data:image/webp") ? "image/webp"
                     : "image/jpeg";

      const res  = await fetch("/api/extract-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: _uploadedImageBase64, mimeType }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // text = English version for analysis
      // originalText = native script for display
      text = (data.text || data.translatedText || data.originalText || "").trim();
      const originalText     = (data.originalText || text).trim();
      const detectedLanguage = data.detectedLanguage || "Unknown";
      const isTranslated     = data.translatedText && data.translatedText !== originalText;

      if (!text) {
        if (status) status.textContent = "No text found in image. Try a clearer screenshot.";
        document.getElementById("autopsy-idle")?.classList.remove("hidden");
        document.getElementById("autopsy-running")?.classList.add("hidden");
        return;
      }

      // Show extracted content under image preview
      const extractWrap = document.getElementById("extracted-claim-wrap");
      const extractText = document.getElementById("extracted-claim-text");
      if (extractWrap) extractWrap.classList.remove("hidden");
      if (extractText) {
        // Language badge + original text + translated text if different
        extractText.innerHTML = `
          <div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:999px;
              background:rgba(196,77,255,0.15);border:1px solid rgba(196,77,255,0.3);color:var(--accent);
              letter-spacing:.04em;">🌐 ${detectedLanguage}</span>
            ${isTranslated ? `<span style="font-size:11px;color:var(--muted);">Translated to English for analysis</span>` : ""}
          </div>
          ${isTranslated ? `
            <div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;">Original (${detectedLanguage})</div>
            <div style="font-size:14px;color:var(--ink);line-height:1.7;margin-bottom:12px;padding:10px 14px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,255,255,0.07);">${originalText}</div>
            <div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;">English Translation</div>
            <div style="font-size:14px;color:var(--ok);line-height:1.7;padding:10px 14px;background:rgba(45,212,191,0.06);border-radius:8px;border:1px solid rgba(45,212,191,0.15);">${text}</div>
          ` : `
            <div style="font-size:14px;color:var(--ink);line-height:1.7;">${originalText}</div>
          `}
        `;
      }

      // Update image source tag with language
      const imgSourceTag = document.getElementById("img-source-tag");
      if (imgSourceTag) imgSourceTag.textContent = detectedLanguage !== "Unknown" ? `📷 ${detectedLanguage}` : "📷 Image";

      if (status) status.textContent = isTranslated
        ? `Extracted & translated from ${detectedLanguage}. Running analysis…`
        : `Text extracted (${detectedLanguage}). Running analysis…`;

    } catch (e) {
      console.error("Image extraction failed:", e);
      if (status) status.textContent = `Image extraction failed: ${e.message}`;
      document.getElementById("autopsy-idle")?.classList.remove("hidden");
      document.getElementById("autopsy-running")?.classList.add("hidden");
      return;
    }

  // ── TEXT MODE ──
  } else {
    text = claimEl ? claimEl.value.trim() : "";
    if (!text) {
      if (status) status.textContent = "Please enter a claim or upload a screenshot first.";
      return;
    }
    document.getElementById("autopsy-idle")?.classList.add("hidden");
    document.getElementById("autopsy-running")?.classList.remove("hidden");
    document.getElementById("autopsy-result")?.classList.add("hidden");
  }

  if (status) status.textContent = "Running analysis…";

  // ── Instant heuristics ──
  const patterns  = detectPatterns(text);
  renderPatterns(patterns);
  renderViralitySignals(text);
  const heuristic = calibrateScore(scoreFromHeuristics(patterns, text.length));
  renderDial(heuristic, "Initial estimate");
  renderFakeScore(heuristic, "Heuristic estimate — AI loading…", [
    { label: "Manipulative language", score: patterns.includes("Manipulative forwarding language") ? 70 : 15 },
    { label: "Source credibility",    score: patterns.includes("No clear source cited") ? 65 : 20 },
    { label: "Scam indicators",       score: patterns.includes("Promotional/scam language") ? 60 : 10 },
  ]);

  let finalScore   = heuristic;
  let finalVerdict = "uncertain";

  // ── Groq main analysis ──
  try {
    if (status) status.textContent = "Running Groq reasoning…";
    const groq = await fetchGroq(text);

    renderVirality(groq.virality_score || 0);
    finalScore = typeof groq.score === "number" ? calibrateScore(groq.score) : heuristic;

    const lowerLabel = (groq.label || "").toLowerCase();
    if (lowerLabel.includes("false") || lowerLabel.includes("fake"))              finalVerdict = "fake";
    else if (lowerLabel.includes("true") || lowerLabel.includes("real") || lowerLabel.includes("credible")) finalVerdict = "real";
    else finalVerdict = "uncertain";

    renderDial(finalScore, groq.label || "AI analysis");
    renderGroqInsights(groq);
    renderFakeScore(finalScore, groq.summary || "", [
      { label: "Manipulative language", score: patterns.includes("Manipulative forwarding language") ? 70 : 15 },
      { label: "Source credibility",    score: patterns.includes("No clear source cited") ? 65 : 20 },
      { label: "AI risk assessment",    score: finalScore },
      { label: "Virality risk",         score: Math.min(groq.virality_score || 0, 100) },
    ]);

    if (status) status.textContent = "Groq complete. Running deep analysis…";
  } catch (e) {
    console.error(e);
    if (status) status.textContent = "Groq unavailable. Using heuristic result.";
  }

  // ── Autopsy (parallel) ──
  fetchAutopsy(text)
    .then((data) => renderAutopsy(data, text, finalScore))
    .catch(() => renderAutopsy({
      verdict: finalVerdict,
      verdict_statement: finalVerdict === "fake" ? "This claim shows strong misinformation signals."
        : finalVerdict === "real" ? "This claim appears to be credible news."
        : "This claim could not be fully verified.",
      annotations: [],
      techniques: finalVerdict === "fake" ? patterns : [],
      forensic_summary: "AI autopsy unavailable — heuristic signals shown.",
      who_benefits: "Unknown",
    }, text, finalScore));

  // ── Truth Engine (parallel) ──
  fetchTruth(text)
    .then((data) => renderTruth(data))
    .catch(() => renderTruth({
      corrected_claim: "Truth engine unavailable. Please verify with trusted sources.",
      explanation: "", key_facts: [], verified_news: [], fact_check_links: [],
    }));

  // ── Fact-check + propagation ──
  fetchFactChecksRaw(text)
    .then((data) => {
      const consensus = computeConsensus(data.claims || []);
      renderConsensus(consensus);
      renderEvidence(consensus.reviews);
      showPropagation(text, finalScore, finalVerdict, consensus.reviews);
      if (status) status.textContent = "Verification complete ✓";
    })
    .catch((err) => {
      console.error("Fact-check error:", err);
      showPropagation(text, finalScore, finalVerdict, []);
      if (status) status.textContent = "Fact-check unavailable";
    });
}

// ── Init ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const imageInput = document.getElementById("image-input");
  if (imageInput) imageInput.addEventListener("change", (e) => handleImageFile(e.target.files[0]));

  const dropZone = document.getElementById("drop-zone");
  if (dropZone) {
    dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
    dropZone.addEventListener("dragleave", ()  => dropZone.classList.remove("drag-over"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault(); dropZone.classList.remove("drag-over");
      handleImageFile(e.dataTransfer.files[0]);
    });
    dropZone.addEventListener("click", () => document.getElementById("image-input").click());
  }

  if (typeof PropagationMap === "undefined") {
    console.error("graph.js not loaded — check script order in index.html");
  }

  const analyzeBtn = document.querySelector("#analyze");
  if (analyzeBtn) analyzeBtn.addEventListener("click", analyzeClaim);
});
