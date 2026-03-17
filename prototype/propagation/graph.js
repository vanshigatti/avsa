// propagation/graph.js — Credible Chronicles themed, organic map layout

window.PropagationMap = (function () {
  const TYPE_COLORS = {
    origin: "#e84c7f",
    twitter: "#7c6cdb",
    whatsapp: "#2f8f6b",
    facebook: "#a855b5",
    telegram: "#d97c4a",
    youtube: "#e84c7f",
    news: "#5ba8a0",
  };

  const TIME_LABELS = ["0h", "+1h", "+3h", "+8h", "+24h", "+48h", "+72h"];
  const TIMELINE_STEPS = [
    { t: 0, label: "Origin posted" },
    { t: 1, label: "Initial burst" },
    { t: 2, label: "Cross-platform" },
    { t: 3, label: "Amplification" },
    { t: 4, label: "Fact-checkers" },
    { t: 5, label: "Reshare wave" },
  ];

  let _data = null,
    _time = 5,
    _playing = false,
    _interval = null;

  function _injectStyles() {
    if (document.getElementById("pm-css")) return;
    const s = document.createElement("style");
    s.id = "pm-css";
    s.textContent = `
      #pm-wrap{font-family:"Space Grotesk",sans-serif;padding:.8rem 0;color:#f6e8f0}
      #pm-topbar{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
      #pm-heading{font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#ff8fb3;flex:1}
      .pm-badge{padding:3px 12px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
      .pm-fake{background:rgba(232,76,127,.2);color:#ff8fb3;border:1px solid rgba(232,76,127,.4)}
      .pm-real{background:rgba(47,143,107,.2);color:#6ee7b7;border:1px solid rgba(47,143,107,.4)}
      .pm-uncertain{background:rgba(247,160,126,.2);color:#f7a07e;border:1px solid rgba(247,160,126,.4)}
      #pm-prob{font-size:11px;color:#caa9b8}
      #pm-graph{
        border:1px solid rgba(255,143,179,.18);border-radius:14px;overflow:hidden;position:relative;
        background:radial-gradient(ellipse at 20% 50%,rgba(232,76,127,.08),transparent 55%),
                   radial-gradient(ellipse at 80% 30%,rgba(124,108,219,.08),transparent 50%),#1a0814;
      }
      #pm-svg{display:block;width:100%}
      #pm-tip{
        position:absolute;background:#2a0f20;border:1px solid rgba(255,143,179,.25);border-radius:10px;
        padding:9px 13px;font-size:11px;pointer-events:none;opacity:0;transition:opacity .15s;
        max-width:200px;z-index:10;color:#caa9b8;line-height:1.65;box-shadow:0 6px 24px rgba(0,0,0,.5)
      }
      #pm-tip.show{opacity:1}
      #pm-tip strong{display:block;font-size:12px;margin-bottom:3px;color:#f6e8f0}
      #pm-playbar{display:flex;align-items:center;gap:8px;margin-top:8px}
      #pm-playbtn{
        width:28px;height:28px;border-radius:999px;border:1px solid rgba(232,76,127,.35);
        background:rgba(232,76,127,.15);cursor:pointer;font-size:11px;color:#ff8fb3;
        display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s
      }
      #pm-playbtn:hover{background:rgba(232,76,127,.3)}
      #pm-slider{flex:1;accent-color:#e84c7f}
      #pm-tlabel{font-size:11px;color:#caa9b8;min-width:40px;text-align:right}
      #pm-tl{margin-top:8px;display:flex;flex-wrap:wrap;gap:5px}
      .pm-step{
        padding:2px 9px;border-radius:999px;border:1px solid rgba(255,143,179,.15);
        background:rgba(255,255,255,.03);font-size:10px;display:flex;align-items:center;
        gap:4px;color:#caa9b8;transition:all .2s
      }
      .pm-step.on{border-color:rgba(232,76,127,.5);background:rgba(232,76,127,.15);color:#ff8fb3}
      .pm-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
      #pm-leg{margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;font-size:10px;color:#caa9b8}
      .pm-li{display:flex;align-items:center;gap:4px}
      .pm-ld{width:7px;height:7px;border-radius:50%;flex-shrink:0}
      .pm-node{cursor:pointer}
      .pm-node:hover .pm-ring{opacity:.5!important}
    `;
    document.head.appendChild(s);
  }

  function init(selector) {
    const el = document.querySelector(selector);
    if (!el) return console.error("PropagationMap: not found →", selector);
    _injectStyles();
    el.innerHTML = `
      <div id="pm-wrap">
        <div id="pm-topbar">
          <span id="pm-heading">📡 Propagation Map — Where did this spread?</span>
          <span id="pm-badge" class="pm-badge pm-uncertain">Analyzing…</span>
          <span id="pm-prob"></span>
        </div>
        <div id="pm-graph">
         <svg id="pm-svg" viewBox="0 0 720 270"></svg>
          <div id="pm-tip"></div>
        </div>
        <div id="pm-playbar">
          <button id="pm-playbtn" onclick="PropagationMap.togglePlay()">▶</button>
          <input type="range" id="pm-slider" min="0" max="5" value="5" step="1" oninput="PropagationMap.setTime(+this.value)">
          <span id="pm-tlabel">+72h</span>
        </div>
        <div id="pm-tl"></div>
        <div id="pm-leg">
          <span class="pm-li"><span class="pm-ld" style="background:#e84c7f"></span>Origin</span>
          <span class="pm-li"><span class="pm-ld" style="background:#7c6cdb"></span>Twitter/X</span>
          <span class="pm-li"><span class="pm-ld" style="background:#2f8f6b"></span>WhatsApp</span>
          <span class="pm-li"><span class="pm-ld" style="background:#d97c4a"></span>Telegram</span>
          <span class="pm-li"><span class="pm-ld" style="background:#5ba8a0"></span>Fact-check / News</span>
        </div>
      </div>`;
  }

  function _render(data, time) {
    if (!window.d3) return;
    const svg = d3.select("#pm-svg");
    const tip = document.getElementById("pm-tip");
    const graph = document.getElementById("pm-graph");
    svg.selectAll("*").remove();

    // Defs — arrowheads + glow filter
    const defs = svg.append("defs");

    // Soft glow filter for nodes
    const filter = defs
      .append("filter")
      .attr("id", "glow")
      .attr("x", "-40%")
      .attr("y", "-40%")
      .attr("width", "180%")
      .attr("height", "180%");
    filter
      .append("feGaussianBlur")
      .attr("stdDeviation", "3")
      .attr("result", "blur");
    const merge = filter.append("feMerge");
    merge.append("feMergeNode").attr("in", "blur");
    merge.append("feMergeNode").attr("in", "SourceGraphic");

    Object.entries(TYPE_COLORS).forEach(([type, color]) => {
      defs
        .append("marker")
        .attr("id", "pma-" + type)
        .attr("viewBox", "0 0 10 10")
        .attr("refX", 8)
        .attr("refY", 5)
        .attr("markerWidth", 4)
        .attr("markerHeight", 4)
        .attr("orient", "auto-start-reverse")
        .append("path")
        .attr("d", "M2 1L8 5L2 9")
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", 1.8)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round");
    });

    const nodeMap = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
    const visNodes = data.nodes.filter((n) => n.time <= time);
    const visIds = new Set(visNodes.map((n) => n.id));
    const visLinks = data.links.filter(
      (l) => visIds.has(l.source) && visIds.has(l.target),
    );

    // Draw links — smooth organic curves
    visLinks.forEach((lk) => {
      const src = nodeMap[lk.source],
        tgt = nodeMap[lk.target];
      if (!src || !tgt) return;
      const color = TYPE_COLORS[src.type] || "#e84c7f";
      const dx = tgt.x - src.x,
        dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ux = dx / dist,
        uy = dy / dist;
      const x1 = src.x + ux * src.r,
        y1 = src.y + uy * src.r;
      const x2 = tgt.x - ux * (tgt.r + 4),
        y2 = tgt.y - uy * (tgt.r + 4);

      // Organic curve — bend perpendicular to the line
      const perpX = -(dy / dist) * 22,
        perpY = (dx / dist) * 22;
      const cx = (x1 + x2) / 2 + perpX,
        cy = (y1 + y2) / 2 + perpY;

      svg
        .append("path")
        .attr("fill", "none")
        .attr("d", `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`)
        .attr("stroke", color)
        .attr("stroke-width", lk.w)
        .attr("stroke-opacity", 0.55)
        .attr("marker-end", `url(#pma-${src.type})`);

      // Time label — only on longer links
      if (dist > 100) {
        svg
          .append("text")
          .attr("x", cx)
          .attr("y", cy - 4)
          .attr("text-anchor", "middle")
          .attr("font-size", "8")
          .attr("font-family", '"Space Grotesk",sans-serif')
          .attr("fill", "rgba(202,169,184,.4)")
          .text(lk.t);
      }
    });

    // Draw nodes
    visNodes.forEach((node) => {
      const color = TYPE_COLORS[node.type] || "#e84c7f";
      const g = svg
        .append("g")
        .attr("class", "pm-node")
        .attr("transform", `translate(${node.x},${node.y})`)
        .attr("opacity", 0)
        .style("cursor", node.url ? "pointer" : "default");

      // Outer glow ring
      g.append("circle")
        .attr("class", "pm-ring")
        .attr("r", node.r + 3)
        .attr("fill", color)
        .attr("fill-opacity", 0.08)
        .attr("stroke", color)
        .attr("stroke-width", 0.5)
        .attr("stroke-opacity", 0.3)
        .attr("filter", "url(#glow)");

      // Main circle
      g.append("circle")
        .attr("r", node.r)
        .attr("fill", color)
        .attr("fill-opacity", 0.18)
        .attr("stroke", color)
        .attr("stroke-width", 1.8);

      // Inner filled circle
      g.append("circle")
        .attr("r", node.r * 0.35)
        .attr("fill", color)
        .attr("fill-opacity", 0.9);

      // Animated pulse for origin
      if (node.type === "origin") {
        g.append("circle")
          .attr("r", node.r + 7)
          .attr("fill", "none")
          .attr("stroke", color)
          .attr("stroke-width", 0.7)
          .attr("stroke-opacity", 0.2)
          .attr("stroke-dasharray", "3 4");
      }

      // Real article star badge
      if (node.isReal) {
        g.append("circle")
          .attr("cx", node.r - 1)
          .attr("cy", -node.r + 1)
          .attr("r", 5)
          .attr("fill", "#1a0814")
          .attr("stroke", "#6ee7b7")
          .attr("stroke-width", 1);
        g.append("text")
          .attr("x", node.r - 1)
          .attr("y", -node.r + 5)
          .attr("text-anchor", "middle")
          .attr("font-size", "7")
          .attr("fill", "#6ee7b7")
          .text("★");
      }

      // Node label — below node
      const lines = node.label.split("\n");
      lines.forEach((ln, i) => {
        g.append("text")
          .attr("x", 0)
          .attr("y", node.r + 12 + i * 11)
          .attr("text-anchor", "middle")
          .attr("font-size", "10")
          .attr("font-weight", "600")
          .attr("font-family", '"Space Grotesk",sans-serif')
          .attr("fill", "#f6e8f0")
          .text(ln);
      });

      // Shares/date — smaller muted
      g.append("text")
        .attr("x", 0)
        .attr("y", node.r + 12 + lines.length * 11)
        .attr("text-anchor", "middle")
        .attr("font-size", "8")
        .attr("font-family", '"Space Grotesk",sans-serif')
        .attr("fill", "rgba(202,169,184,.7)")
        .text(node.shares);

      g.transition().duration(500).ease(d3.easeCubicOut).attr("opacity", 1);

      // Tooltip
      g.on("mouseover", () => {
        const hint = node.url
          ? `<br><span style="color:#ff8fb3;font-size:10px">🔗 Click to open</span>`
          : "";
        tip.innerHTML = `<strong>${node.label.replace("\n", " ")}</strong>${(node.detail || node.shares).replace(/\n/g, "<br>")}${hint}`;
        tip.classList.add("show");
      })
        .on("mousemove", (ev) => {
          const r = graph.getBoundingClientRect();
          tip.style.left =
            Math.min(ev.clientX - r.left + 12, r.width - 210) + "px";
          tip.style.top = Math.max(0, ev.clientY - r.top - 10) + "px";
        })
        .on("mouseleave", () => tip.classList.remove("show"))
        .on("click", () => {
          if (node.url) window.open(node.url, "_blank", "noopener,noreferrer");
        });
    });

    // Timeline
    const tlEl = document.getElementById("pm-tl");
    if (tlEl)
      tlEl.innerHTML = TIMELINE_STEPS.map(
        (s) =>
          `<div class="pm-step${time >= s.t ? " on" : ""}"><div class="pm-dot"></div>${s.label}</div>`,
      ).join("");
    const tlbl = document.getElementById("pm-tlabel");
    if (tlbl) tlbl.textContent = TIME_LABELS[time];
  }

  function setVerdict(verdict, prob) {
    const badge = document.getElementById("pm-badge");
    const probEl = document.getElementById("pm-prob");
    if (!badge) return;
    badge.className = "pm-badge pm-" + verdict;
    badge.textContent =
      verdict === "fake"
        ? "Likely Fake"
        : verdict === "real"
          ? "Likely Real"
          : "Uncertain";
    if (probEl) probEl.textContent = prob + "% confidence";
  }

  function setTime(t) {
    _time = t;
    if (_data) _render(_data, t);
  }

  function togglePlay() {
    _playing = !_playing;
    const btn = document.getElementById("pm-playbtn");
    if (btn) btn.textContent = _playing ? "⏸" : "▶";
    if (_playing) {
      if (_time >= 5) _time = 0;
      _interval = setInterval(() => {
        _time++;
        const sl = document.getElementById("pm-slider");
        if (sl) sl.value = _time;
        if (_data) _render(_data, _time);
        if (_time >= 5) {
          clearInterval(_interval);
          _playing = false;
          if (btn) btn.textContent = "▶";
        }
      }, 650);
    } else clearInterval(_interval);
  }

  function animateIn(data) {
    _data = data;
    _time = 0;
    const sl = document.getElementById("pm-slider");
    if (sl) sl.value = 0;
    _render(data, 0);
    let t = 0;
    const iv = setInterval(() => {
      t++;
      if (sl) sl.value = t;
      _render(data, t);
      if (t >= 5) clearInterval(iv);
    }, 520);
  }

  return { init, setVerdict, setTime, togglePlay, animateIn };
})();
