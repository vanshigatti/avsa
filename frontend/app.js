/* ─── config ──────────────────────────────────────────────────── */

const FACTCHECK_API_KEY = ""; // kept for direct client calls if needed

const SENSATIONAL_TERMS = [
  "share","forward","urgent","breaking","shocking","secret","banned",
  "alert","warning","evacuate","miracle","cure","guarantee",
  "free","cash","giveaway","click","register","verify"
];

/* ─── heuristics ──────────────────────────────────────────────── */

function detectPatterns(text) {
  const lower    = text.toLowerCase();
  const patterns = [];
  if (SENSATIONAL_TERMS.some(t => lower.includes(t)))        patterns.push("Sensational wording");
  if (/[A-Z]{6,}/.test(text))                                patterns.push("Excessive capital letters");
  if (/\b(all|every|always|never|guaranteed)\b/i.test(text)) patterns.push("Absolute claim");
  if (/https?:\/\//i.test(text))                             patterns.push("External links present");
  if (!/\b(source|report|official|study)\b/i.test(text))    patterns.push("No clear source cited");
  return patterns;
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

/* ─── render helpers (existing) ───────────────────────────────── */

function renderDial(score, label) {
  const dial  = document.querySelector("#dial");
  const value = document.querySelector("#dial-value");
  const tag   = document.querySelector("#dial-label");
  dial.style.setProperty("--dial", `${score}`);
  value.textContent = `${score}%`;
  tag.textContent   = label;
}

function renderVirality(score) {
  const bar   = document.querySelector("#virality-score");
  const label = document.querySelector("#virality-label");
  if (!bar) return;
  const s = Math.max(0, Math.min(100, score || 0));
  bar.style.width = s + "%";
  if (label) {
    let level = "Low";
    if (s > 70)      level = "High viral potential";
    else if (s > 40) level = "Moderate spread potential";
    label.textContent = `${s}% • ${level}`;
  }
}

function renderViralitySignals(text) {
  const list = document.querySelector("#virality-signals");
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
  document.querySelector("#groq-summary").textContent        = data.summary        || "";
  document.querySelector("#groq-recommendation").textContent = data.recommendation || "";

  const risks = document.querySelector("#groq-risks");
  risks.innerHTML = "";
  (data.risk_signals || []).forEach(r => {
    const li = document.createElement("li");
    li.textContent = r;
    risks.appendChild(li);
  });

  const phrases = document.querySelector("#groq-phrases");
  phrases.innerHTML = "";
  (data.suspicious_phrases || []).forEach(p => {
    const li = document.createElement("li");
    li.textContent = p;
    phrases.appendChild(li);
  });

  // Show Tavily evidence badge if grounded
  const summaryEl = document.querySelector("#groq-summary");
  if (data.evidence_based && summaryEl) {
    const badge = document.createElement("span");
    badge.className   = "evidence-badge";
    badge.textContent = "⚡ Live web evidence used";
    summaryEl.parentNode.insertBefore(badge, summaryEl);
  }
}

function renderEvidence(reviews) {
  const list = document.querySelector("#evidence-list");
  list.innerHTML = "";
  if (!reviews.length) {
    const li = document.createElement("li");
    li.textContent = "No fact-check matches found.";
    list.appendChild(li);
    return;
  }
  reviews.slice(0, 6).forEach(r => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${r.title || "Fact Check"}</strong><br>
      ${r.publisher || ""} | ${r.rating || ""}<br>${r.claim || ""}`;
    list.appendChild(li);
  });
}

function renderConsensus(consensus) {
  document.querySelector("#consensus-label").textContent = `Consensus: ${consensus.consensus}`;
}

function ratingClass(r) {
  const t = (r || "").toLowerCase();
  if (/false|fake|hoax/.test(t))       return "false";
  if (/misleading|mixed/.test(t))      return "mixed";
  if (/true|correct/.test(t))          return "true";
  return "other";
}

function computeConsensus(claims) {
  const counts  = { true:0, false:0, mixed:0, other:0 };
  const reviews = [];
  claims.forEach(c => {
    (c.claimReview || []).forEach(r => {
      counts[ratingClass(r.textualRating)]++;
      reviews.push({
        claim    : c.text,
        publisher: r.publisher?.name,
        rating   : r.textualRating,
        title    : r.title,
        url      : r.url
      });
    });
  });
  const total = counts.true + counts.false + counts.mixed;
  let consensus = "Unknown";
  if (total > 0) {
    if      (counts.false >= counts.true && counts.false >= counts.mixed) consensus = "False";
    else if (counts.true  >= counts.false && counts.true  >= counts.mixed) consensus = "True";
    else                                                                    consensus = "Mixed";
  }
  return { consensus, reviews };
}

/* ─── NEW: fake probability score ─────────────────────────────── */

function renderFakeScore(data) {
  const scoreEl  = document.querySelector("#fake-score-value");
  const barEl    = document.querySelector("#fake-score-bar");
  const expl     = document.querySelector("#fake-score-explanation");
  const compEl   = document.querySelector("#fake-score-components");

  if (!scoreEl) return;

  const score = data.fused_score || 0;
  scoreEl.textContent = `${score}%`;

  // Colour the score
  scoreEl.className = "fake-score-number";
  if (score >= 70)       scoreEl.classList.add("score-high");
  else if (score >= 40)  scoreEl.classList.add("score-mid");
  else                   scoreEl.classList.add("score-low");

  if (barEl) {
    barEl.style.width = score + "%";
    barEl.className   = "fake-score-fill";
    if (score >= 70)       barEl.classList.add("fill-high");
    else if (score >= 40)  barEl.classList.add("fill-mid");
    else                   barEl.classList.add("fill-low");
  }

  if (expl) expl.textContent = data.explanation || "";

  if (compEl && data.components) {
    const { groq, heuristic, factcheck, tavily } = data.components;
    compEl.innerHTML = `
      <div class="comp-row"><span>AI judgment (web-grounded)</span><span>${groq}%</span></div>
      <div class="comp-row"><span>Fact-check database</span><span>${factcheck !== null && factcheck !== undefined ? factcheck + "%" : "No data"}</span></div>
      <div class="comp-row"><span>Real-time web sources</span><span>${tavily !== null && tavily !== undefined ? tavily + "%" : "No data"}</span></div>
      <div class="comp-row"><span>Pattern signals</span><span>${heuristic}%</span></div>
    `;
  }
}

/* ─── NEW: truth engine ───────────────────────────────────────── */

function renderTruthEngine(data) {
  const corrected = document.querySelector("#truth-corrected");
  const expl      = document.querySelector("#truth-explanation");
  const facts     = document.querySelector("#truth-facts");
  const newsEl    = document.querySelector("#truth-news");
  const fcEl      = document.querySelector("#truth-factchecks");

  if (corrected) corrected.textContent = data.corrected_claim || "Could not determine a verified alternative.";
  if (expl)      expl.textContent      = data.explanation     || "";

  if (facts) {
    facts.innerHTML = "";
    (data.key_facts || []).forEach(f => {
      const li = document.createElement("li");
      li.textContent = f;
      facts.appendChild(li);
    });
  }

  if (newsEl) {
    newsEl.innerHTML = "";
    (data.news_articles || []).forEach(a => {
      const li  = document.createElement("li");
      li.innerHTML = `<a href="${a.url}" target="_blank" rel="noopener">${a.title}</a>
        <span class="source-tag">${a.source || ""}</span>`;
      newsEl.appendChild(li);
    });
    if (!newsEl.children.length) {
      newsEl.innerHTML = "<li>No news articles found.</li>";
    }
  }

  if (fcEl) {
    fcEl.innerHTML = "";
    (data.fact_check_links || []).forEach(a => {
      const li = document.createElement("li");
      li.innerHTML = `<a href="${a.url}" target="_blank" rel="noopener">${a.title}</a>
        <span class="rating-tag rating-${ratingClass(a.rating)}">${a.rating}</span>`;
      fcEl.appendChild(li);
    });
    if (!fcEl.children.length) {
      fcEl.innerHTML = "<li>No fact-check articles found.</li>";
    }
  }
}

/* ─── NEW: propagation tracker ────────────────────────────────── */

function renderPropagation(data) {
  // Spread path
  const pathEl = document.querySelector("#prop-spread-path");
  if (pathEl) {
    pathEl.innerHTML = "";
    const steps = data.spread_path || [];
    steps.forEach((platform, i) => {
      const span = document.createElement("span");
      span.className   = "path-node";
      span.textContent = platform;
      pathEl.appendChild(span);
      if (i < steps.length - 1) {
        const arrow = document.createElement("span");
        arrow.className   = "path-arrow";
        arrow.textContent = "→";
        pathEl.appendChild(arrow);
      }
    });
  }

  // Origin + peak
  const originEl = document.querySelector("#prop-origin");
  const peakEl   = document.querySelector("#prop-peak");
  const speedEl  = document.querySelector("#prop-speed");
  const reachEl  = document.querySelector("#prop-reach");
  if (originEl) originEl.textContent = data.origin        || "Unknown";
  if (peakEl)   peakEl.textContent   = data.peak_platform || "Unknown";
  if (speedEl)  speedEl.textContent  = data.spread_speed  || "Unknown";
  if (reachEl)  reachEl.textContent  = data.total_estimated_reach
    ? data.total_estimated_reach.toLocaleString()
    : "Estimating...";

  // Affected regions
  const regionsEl = document.querySelector("#prop-regions");
  if (regionsEl) {
    regionsEl.innerHTML = "";
    (data.regions || []).forEach(r => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="region-risk region-${r.risk}">${r.risk.toUpperCase()}</span>
        <strong>${r.name}</strong> — ${r.reason}`;
      regionsEl.appendChild(li);
    });
    if (!regionsEl.children.length) {
      regionsEl.innerHTML = "<li>No regional data available.</li>";
    }
  }

  // News articles
  const newsEl = document.querySelector("#prop-news-articles");
  if (newsEl) {
    newsEl.innerHTML = "";
    (data.newsArticles || []).forEach(a => {
      const li = document.createElement("li");
      const date = a.publishedAt
        ? new Date(a.publishedAt).toLocaleDateString("en-US",{month:"short",day:"numeric"})
        : "";
      li.innerHTML = `
        <a href="${a.url}" target="_blank" rel="noopener">${a.title}</a>
        <span class="source-tag">${a.source || ""}</span>
        ${date ? `<span class="muted"> · ${date}</span>` : ""}`;
      newsEl.appendChild(li);
    });
    if (!newsEl.children.length) {
      newsEl.innerHTML = "<li>No news coverage found for this claim.</li>";
    }
  }

  // Top sources
  const sourcesEl = document.querySelector("#prop-top-sources");
  if (sourcesEl) {
    sourcesEl.innerHTML = "";
    (data.topSources || []).forEach(s => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="source-tag">${s.name}</span>
        <span class="muted">${s.count} article${s.count > 1 ? "s" : ""}</span>`;
      sourcesEl.appendChild(li);
    });
    if (!sourcesEl.children.length) {
      sourcesEl.innerHTML = "<li>No sources found.</li>";
    }
  }

  // Network graph via D3
  renderPropagationGraph(data);
}

function renderPropagationGraph(data) {
  const container = document.querySelector("#prop-graph");
  if (!container || typeof d3 === "undefined") return;

  container.innerHTML = "";
  const W = container.clientWidth  || 420;
  const H = 260;

  // Build nodes + links from real + simulated data
  const nodes = [{ id:"Claim", type:"origin", r:18 }];
  const links = [];

  // News outlets as real spread nodes
  (data.topSources || []).slice(0, 4).forEach(s => {
    nodes.push({ id: s.name, type:"news", r: Math.max(8, Math.min(16, 6 + s.count * 3)) });
    links.push({ source:"Claim", target: s.name, value: s.count });
  });

  // Platform spread path
  (data.spread_path || []).slice(0, 3).forEach(p => {
    if (!nodes.find(n => n.id === p)) {
      nodes.push({ id:p, type:"platform", r:12 });
      links.push({ source:"Claim", target:p, value:1 });
    }
  });

  // Regions as leaf nodes
  (data.regions || []).slice(0, 3).forEach(r => {
    nodes.push({ id:r.name, type:"region", r:10, risk:r.risk });
    const parent = nodes.find(n => n.type==="platform") || nodes[0];
    links.push({ source:parent.id, target:r.name, value:1 });
  });

  const colorMap = {
    origin  : "#C44DFF",
    news    : "#2DD4BF",
    platform: "#7B2FFF",
    region  : "#FF9F45"
  };
  const riskColor = { high:"#E84C7F", medium:"#F7A07E", low:"#2D9CDB" };

  const svg = d3.select(container).append("svg")
    .attr("width", "100%").attr("viewBox", `0 0 ${W} ${H}`);

  const sim = d3.forceSimulation(nodes)
    .force("link",   d3.forceLink(links).id(d=>d.id).distance(75).strength(0.6))
    .force("charge", d3.forceManyBody().strength(-160))
    .force("center", d3.forceCenter(W/2, H/2))
    .force("collide", d3.forceCollide(d => d.r + 10));

  const link = svg.append("g").selectAll("line").data(links).join("line")
    .attr("stroke","rgba(255,255,255,0.15)").attr("stroke-width", 1.2);

  const node = svg.append("g").selectAll("g").data(nodes).join("g")
    .call(d3.drag()
      .on("start", (ev,d)=>{ if(!ev.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on("drag",  (ev,d)=>{ d.fx=ev.x; d.fy=ev.y; })
      .on("end",   (ev,d)=>{ if(!ev.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }));

  node.append("circle")
    .attr("r",    d => d.r)
    .attr("fill", d => d.type==="region" ? (riskColor[d.risk]||"#2D9CDB") : colorMap[d.type]||"#888")
    .attr("fill-opacity", 0.85)
    .attr("stroke","rgba(255,255,255,0.3)")
    .attr("stroke-width", 1);

  node.append("text")
    .attr("text-anchor","middle")
    .attr("dy","0.35em")
    .attr("font-size","9px")
    .attr("fill","#fff")
    .attr("pointer-events","none")
    .text(d => d.id.length > 12 ? d.id.slice(0,11)+"…" : d.id);

  sim.on("tick", () => {
    link
      .attr("x1", d=>d.source.x).attr("y1", d=>d.source.y)
      .attr("x2", d=>d.target.x).attr("y2", d=>d.target.y);
    node.attr("transform", d=>`translate(${
      Math.max(d.r, Math.min(W-d.r, d.x))},${
      Math.max(d.r, Math.min(H-d.r, d.y))})`);
  });
}

/* ─── NEW: claim autopsy ──────────────────────────────────────── */

async function fetchAutopsy(claim) {
  const res = await fetch("/api/autopsy", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ claim })
  });
  return res.json();
}

const VERDICT_META = {
  "Fabricated"     : { icon:"🚨", cls:"verdict-fabricated",   label:"Fabricated" },
  "Misleading"     : { icon:"⚠️",  cls:"verdict-misleading",   label:"Misleading" },
  "Manipulative"   : { icon:"🎭", cls:"verdict-manipulative", label:"Manipulative" },
  "Partially True" : { icon:"⚖️",  cls:"verdict-partially",    label:"Partially True" },
  "Unverified"     : { icon:"🔍", cls:"verdict-unverified",   label:"Unverified" }
};

function renderAutopsy(data) {
  const idle    = document.querySelector("#autopsy-idle");
  const running = document.querySelector("#autopsy-running");
  const result  = document.querySelector("#autopsy-result");

  idle?.classList.add("hidden");
  running?.classList.add("hidden");
  result?.classList.remove("hidden");

  // Verdict
  const verdictEl = document.querySelector("#autopsy-verdict");
  const vm = VERDICT_META[data.verdict] || VERDICT_META["Unverified"];
  verdictEl.className = `autopsy-verdict ${vm.cls}`;
  verdictEl.innerHTML = `
    <span class="verdict-icon">${vm.icon}</span>
    <div class="verdict-right">
      <span class="verdict-label">${vm.label}</span>
      <span class="verdict-score">Manipulation score: ${data.overall_manipulation_score}%</span>
    </div>`;

  // Annotated text — build from segments with staggered animation
  const annotated = document.querySelector("#autopsy-annotated");
  annotated.innerHTML = "";

  (data.segments || []).forEach((seg, i) => {
    const span = document.createElement("span");
    span.className = `seg seg-${seg.type || "neutral"}`;
    span.style.animationDelay = `${i * 0.07}s`;
    span.style.animation = "rise .35s ease both";

    const tooltipHtml = seg.type !== "neutral"
      ? `<span class="seg-tooltip"><strong>${seg.label || seg.type}</strong>${seg.explanation || ""}</span>`
      : "";

    span.innerHTML = escHtml(seg.text) + tooltipHtml;
    annotated.appendChild(span);

    // space between segments
    if (i < data.segments.length - 1) {
      annotated.appendChild(document.createTextNode(" "));
    }
  });

  // Manipulation techniques
  const techEl = document.querySelector("#autopsy-techniques");
  techEl.innerHTML = "";
  (data.manipulation_techniques || []).forEach((t, i) => {
    const card = document.createElement("div");
    card.className = `technique-card sev-${t.severity}`;
    card.style.animationDelay = `${i * 0.1}s`;
    card.innerHTML = `
      <div class="technique-sev sev-${t.severity}">${t.severity} severity</div>
      <div class="technique-name">${escHtml(t.name)}</div>
      <div class="technique-desc">${escHtml(t.description)}</div>`;
    techEl.appendChild(card);
  });

  // Summary + who benefits
  document.querySelector("#autopsy-summary").textContent  = data.autopsy_summary || "";
  document.querySelector("#autopsy-benefits").textContent = data.who_benefits    || "";

  // Update status badge
  const statusBadge = document.querySelector("#autopsy-status");
  if (statusBadge) statusBadge.textContent = "Complete";
}

function showAutopsyScanning() {
  document.querySelector("#autopsy-idle")?.classList.add("hidden");
  document.querySelector("#autopsy-running")?.classList.remove("hidden");
  document.querySelector("#autopsy-result")?.classList.add("hidden");
  const statusBadge = document.querySelector("#autopsy-status");
  if (statusBadge) statusBadge.textContent = "Scanning...";
}

function escHtml(str) {
  return (str || "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}



async function fetchGroq(claim) {
  const res = await fetch("/api/groq", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ claim })
  });
  return res.json();
}

async function fetchFactChecks(claim) {
  const url = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(claim)}&key=${FACTCHECK_API_KEY}`;
  const res = await fetch(url);
  return res.json();
}

async function fetchPropagation(claim) {
  const res = await fetch("/api/propagation", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ claim })
  });
  return res.json();
}

async function fetchTruth(claim) {
  const res = await fetch("/api/truth", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ claim })
  });
  return res.json();
}

async function fetchScore(claim, groqFakeProbability, factChecks, tavilySources) {
  const res = await fetch("/api/score", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ claim, groqFakeProbability, factChecks, tavilySources })
  });
  return res.json();
}

/* ─── screenshot upload ───────────────────────────────────────── */

let currentImageBase64 = null;
let currentMimeType    = null;
let currentTab         = "text";

function switchTab(tab) {
  currentTab = tab;
  document.getElementById("tab-text").classList.toggle("active",  tab === "text");
  document.getElementById("tab-image").classList.toggle("active", tab === "image");
  document.getElementById("panel-text").classList.toggle("hidden",  tab !== "text");
  document.getElementById("panel-image").classList.toggle("hidden", tab !== "image");
}

function clearImage() {
  currentImageBase64 = null;
  currentMimeType    = null;
  document.getElementById("image-preview-wrap").classList.add("hidden");
  document.getElementById("drop-zone").classList.remove("hidden");
  document.getElementById("image-input").value = "";
  document.getElementById("extracted-claim-wrap").classList.add("hidden");
  document.getElementById("extracted-claim-text").textContent = "";
  document.getElementById("img-source-tag").textContent = "";
}

function handleImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  currentMimeType = file.type;

  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    // strip the data:...;base64, prefix
    currentImageBase64 = dataUrl.split(",")[1];

    // show preview
    document.getElementById("image-preview").src = dataUrl;
    document.getElementById("image-preview-wrap").classList.remove("hidden");
    document.getElementById("drop-zone").classList.add("hidden");
  };
  reader.readAsDataURL(file);
}

// File input change
document.getElementById("image-input")?.addEventListener("change", e => {
  handleImageFile(e.target.files[0]);
});

// Drag and drop
const dropZone = document.getElementById("drop-zone");
dropZone?.addEventListener("click", () => document.getElementById("image-input").click());
dropZone?.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone?.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone?.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  handleImageFile(e.dataTransfer.files[0]);
});

// Paste from clipboard (Ctrl+V anywhere on page)
document.addEventListener("paste", e => {
  if (currentTab !== "image") return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      handleImageFile(item.getAsFile());
      break;
    }
  }
});

async function extractImageAndAnalyze() {
  if (!currentImageBase64) {
    setStatus("Please upload a screenshot first.", "warn");
    return;
  }

  setStatus("Extracting text from screenshot…", "running");
  showAutopsyScanning();

  try {
    const res = await fetch("/api/extract-image", {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({
        imageBase64: currentImageBase64,
        mimeType   : currentMimeType
      })
    });
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    // Show extracted claim in UI
    const extractWrap = document.getElementById("extracted-claim-wrap");
    const extractText = document.getElementById("extracted-claim-text");
    const sourceTag   = document.getElementById("img-source-tag");

    extractText.textContent = data.main_claim || data.extracted_text || "";
    sourceTag.textContent   = data.source_type ? `Source: ${data.source_type}` : "";
    extractWrap.classList.remove("hidden");

    // Put extracted claim into the hidden textarea and run full analysis
    const claimEl = document.getElementById("claim");
    claimEl.value = data.main_claim || data.extracted_text || "";

    setStatus("Text extracted. Running full analysis…", "running");

    // Fire the full pipeline
    await runFullAnalysis(claimEl.value);

  } catch(err) {
    console.error("Image extraction error:", err);
    setStatus("Could not extract text from image. Try a clearer screenshot.", "warn");
  }
}



async function analyzeClaim() {
  if (currentTab === "image" && currentImageBase64) {
    await extractImageAndAnalyze();
    return;
  }
  const text = document.querySelector("#claim").value.trim();
  if (!text) return;
  await runFullAnalysis(text);
}

async function runFullAnalysis(text) {
  if (!text) return;

  setStatus("Running analysis…", "running");

  // Start autopsy scanner immediately
  showAutopsyScanning();

  const patterns    = detectPatterns(text);
  const heuristic   = calibrateScore(scoreFromHeuristics(patterns, text.length));

  renderPatterns(patterns);
  renderViralitySignals(text);
  renderDial(heuristic, "Initial estimate");

  let groqResult    = null;
  let factCheckData = null;

  /* Step 1 — Groq primary analysis */
  try {
    setStatus("Running AI analysis…", "running");
    groqResult = await fetchGroq(text);
    renderVirality(groqResult.virality_score || 0);

    // Use fake_probability directly for dial — no calibration needed
    const fakePct = typeof groqResult.fake_probability === "number"
      ? groqResult.fake_probability
      : typeof groqResult.score === "number" ? groqResult.score : 50;

    // Dial shows CREDIBILITY (inverse of fake probability)
    const credibility = 100 - fakePct;
    renderDial(credibility, groqResult.label || "AI analysis");
    renderGroqInsights(groqResult);
    setStatus("AI analysis done. Checking fact databases…", "running");
  } catch(e) {
    console.error("Groq error:", e);
    setStatus("AI analysis unavailable. Using heuristics…", "warn");
  }

  /* Step 2 — Fact-check (background) */
  const fcPromise = fetchFactChecks(text)
    .then(data => {
      factCheckData = data;
      const consensus = computeConsensus(data.claims || []);
      renderConsensus(consensus);
      renderEvidence(consensus.reviews);
      return data.claims || [];
    })
    .catch(() => []);

  /* Step 3 — Autopsy (parallel, non-blocking) */
  fetchAutopsy(text)
    .then(data => renderAutopsy(data))
    .catch(e => console.error("Autopsy error:", e));

  /* Step 4 — Propagation tracker (parallel, non-blocking) */
  fetchPropagation(text)
    .then(data => {
      renderPropagation(data);
      setStatus("Propagation data loaded.", "running");
    })
    .catch(e => console.error("Propagation error:", e));

  /* Step 5 — Truth engine (parallel, non-blocking) */
  fetchTruth(text)
    .then(data => {
      renderTruthEngine(data);
      setStatus("Truth engine done.", "running");
    })
    .catch(e => console.error("Truth engine error:", e));

  /* Step 6 — Fused probability score (waits for Groq + fact-check) */
  try {
    const fcClaims = await fcPromise;
    const groqFakeProbability = groqResult && typeof groqResult.fake_probability === "number"
      ? groqResult.fake_probability
      : groqResult && typeof groqResult.score === "number"
        ? groqResult.score : 50;
    const tavilySources = groqResult?.tavily_sources || [];
    const scoreData = await fetchScore(text, groqFakeProbability, fcClaims, tavilySources);
    renderFakeScore(scoreData);
    setStatus("Verification complete", "done");
  } catch(e) {
    console.error("Score error:", e);
    setStatus("Analysis complete (partial)", "warn");
  }
}

function setStatus(msg, state) {
  const el = document.querySelector("#status");
  el.textContent  = msg;
  el.className    = `status status-${state}`;
}

/* ─── popular fakes ───────────────────────────────────────────── */

function switchFakeTab(tab) {
  document.querySelectorAll(".fake-tab").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".fakes-grid").forEach(g => g.classList.add("hidden"));
  document.querySelector(`#fakes-${tab}`).classList.remove("hidden");
  event.target.classList.add("active");
}

function analyzePopular(card) {
  const textEl = card.querySelector(".pill-hover-title") || card.querySelector(".pill-text");
  const text   = textEl ? textEl.textContent.trim() : "";
  if (!text) return;

  switchTab("text");
  document.querySelector("#claim").value = text;
  document.querySelector(".input-card").scrollIntoView({ behavior: "smooth", block: "center" });

  const ta = document.querySelector("#claim");
  ta.style.borderColor = "rgba(196,77,255,0.7)";
  ta.style.boxShadow   = "0 0 0 3px rgba(196,77,255,0.25)";
  setTimeout(() => { ta.style.borderColor = ""; ta.style.boxShadow = ""; }, 1200);
  setTimeout(() => analyzeClaim(), 500);
}

/* ─── boot ───────────────────────────────────────────────────── */

document.querySelector("#analyze").addEventListener("click", analyzeClaim);

// Auto-fill claim sent from fake-news.html via sessionStorage
(function checkPendingClaim() {
  const pending = sessionStorage.getItem("pendingClaim");
  if (pending) {
    sessionStorage.removeItem("pendingClaim");
    const claimEl = document.querySelector("#claim");
    if (claimEl) {
      claimEl.value = pending;
      // Flash + auto-run after short delay
      claimEl.style.borderColor = "rgba(196,77,255,0.7)";
      claimEl.style.boxShadow   = "0 0 0 3px rgba(196,77,255,0.25)";
      setTimeout(() => { claimEl.style.borderColor = ""; claimEl.style.boxShadow = ""; }, 1200);
      setTimeout(() => analyzeClaim(), 600);
    }
  }
})();

// Load D3 dynamically
(function loadD3() {
  const s   = document.createElement("script");
  s.src     = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js";
  s.onload  = () => console.log("D3 loaded");
  document.head.appendChild(s);
})();
