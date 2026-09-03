/* Reactome status page — static, reads JSON written by collector/collector.py.
   No build step; uPlot is vendored in vendor/. */
(() => {
  "use strict";

  const REFRESH_MS = 60_000;
  const RANGE_SECONDS = { "24h": 86400, "7d": 7 * 86400, "90d": 90 * 86400 };
  const STALE_WARN_S = 7 * 60;     // collector runs every 5 min
  const STALE_BAD_S = 12 * 60;
  const GROUP_ORDER = ["ContentService", "AnalysisService", "PathwayBrowser", "RESTfulAPI", "Website", "Chatbot", "other"];

  let range = localStorage.getItem("status.range") || "24h";
  const plots = [];             // live uPlot instances (destroyed on re-render)
  const state = { hosts: [], data: {} };

  // ------------------------------------------------------------ helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const SERIES = () => [1, 2, 3, 4, 5, 6, 7, 8].map(i => css(`--s${i}`));
  const nowS = () => Date.now() / 1000;
  const parseTs = (s) => s ? Date.parse(s) / 1000 : null;
  const fmtTime = (ts) => new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const fmtDur = (s) => {
    if (s == null) return "–";
    s = Math.round(s);
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
    return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
  };
  const fmtAgo = (ts) => ts == null ? "–" : `${fmtDur(Math.max(0, nowS() - ts))} ago`;
  const fmtBytes = (b) => b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(0)} GB` : `${(b / 1e6).toFixed(0)} MB`;
  const fmtMs = (v) => v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;

  async function getJSON(path) {
    const r = await fetch(`${path}?t=${Math.floor(Date.now() / 30000)}`, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }

  // ------------------------------------------------------------ data load
  async function loadHost(h) {
    const out = { latest: null, series: null, events: null, error: null };
    const results = await Promise.allSettled([
      getJSON(`${h.prefix}/latest.json`),
      getJSON(`${h.prefix}/series/${range}.json`),
      getJSON(`${h.prefix}/events.json`),
    ]);
    [out.latest, out.series, out.events] = results.map(r => r.status === "fulfilled" ? r.value : null);
    out.error = results.find(r => r.status === "rejected")?.reason?.message || null;
    return out;
  }

  async function refresh() {
    try {
      if (!state.hosts.length) state.hosts = (await getJSON("hosts.json")).hosts;
    } catch (e) {
      $("#hosts").innerHTML = `<p class="empty">Could not load hosts.json (${e.message})</p>`;
      return;
    }
    const loaded = await Promise.all(state.hosts.map(loadHost));
    state.hosts.forEach((h, i) => { state.data[h.name] = loaded[i]; });
    render();
  }

  // ------------------------------------------------------------ render
  function render() {
    plots.splice(0).forEach(p => p.destroy());
    const main = $("#hosts");
    main.innerHTML = "";
    let overall = "good", overallText = "All systems operational";
    for (const h of state.hosts) {
      const d = state.data[h.name];
      const sec = renderHost(h, d);
      main.appendChild(sec);
      if (sec.dataset.status === "bad") { overall = "bad"; overallText = "Problems detected"; }
      else if (sec.dataset.status === "warn" && overall !== "bad") { overall = "warn"; overallText = "Degraded or not reporting"; }
    }
    const pill = $("#overall");
    pill.className = `pill pill-${overall}`;
    pill.textContent = overallText;
    $("#updated").textContent = `Page refreshed ${new Date().toLocaleTimeString()}; refreshes every minute.`;
  }

  function renderHost(h, d) {
    const sec = $("#host-template").content.firstElementChild.cloneNode(true);
    $(".host-title", sec).textContent = h.title || h.name;
    const latest = d.latest;
    let status = "good";

    if (!latest) {
      const b = $(".banner", sec);
      b.hidden = false;
      b.textContent = `No data has been received from ${h.name} yet${d.error ? ` (${d.error})` : ""}.`;
      sec.dataset.status = "warn";
      $(".charts", sec).innerHTML = `<p class="empty">No data</p>`;
      return sec;
    }

    // staleness — the "host is down" signal
    const gen = parseTs(latest.generated_at);
    const age = Math.max(0, nowS() - gen);
    $(".host-meta", sec).textContent = `Last report ${fmtAgo(gen)} · ${fmtTime(gen)}`;
    const banner = $(".banner", sec);
    if (age > STALE_BAD_S) {
      banner.hidden = false;
      banner.textContent = `No report from ${h.name} since ${fmtTime(gen)} (${fmtDur(age)} ago). The server or its collector is probably down; the details below are from the last report received.`;
      status = "bad";
    } else if (age > STALE_WARN_S) {
      banner.hidden = false; banner.classList.add("warn");
      banner.textContent = `The last report from ${h.name} is ${fmtDur(age)} old; a report is expected every ${fmtDur(latest.interval_seconds || 300)}.`;
      status = "warn";
    }

    // services, with uptime over the selected range
    const ul = $(".services", sec);
    const pts = d.series?.points || [];
    state.step = d.series?.step_s || 300;
    state.interval = latest.interval_seconds || 300;
    for (const [name, s] of Object.entries(latest.services || {})) {
      const li = el("li");
      const dot = el("span", `dot ${s.up ? "up" : "down"}`);
      dot.title = `${s.state}${s.sub ? ` (${s.sub})` : ""}`;
      const up = uptime(pts, p => p.svc?.[name]);
      const box = el("div", "svc");
      const row = el("div", "svc-row");
      row.append(el("span", null, name));
      const right = el("span", "since", s.up ? `up ${fmtDur(Math.max(0, nowS() - parseTs(s.since)))}${s.restarts ? ` · ${s.restarts} restarts` : ""} · ` : `${s.state} · `);
      right.append(el("span", "pct", up.pct == null ? "–" : `${up.pct}%`));
      row.append(right);
      box.append(row, strip(up.bins, name));
      li.append(dot, box);
      if (!s.up) status = "bad";
      ul.appendChild(li);
    }

    // probes
    const tb = $(".probes tbody", sec);
    for (const [name, p] of Object.entries(latest.probes || {})) {
      const tr = el("tr");
      const st = el("span", "state");
      st.append(el("span", `dot ${p.ok ? "up" : "down"}`), document.createTextNode(p.ok ? "OK" : "Failing"));
      const detail = p.error ? `failed (${p.error})` : p.status ? `HTTP ${p.status}${p.body ? ` · database v${p.body}` : ""}` : p.kind === "tcp" || p.port ? "port responds" : "";
      const up = uptime(pts, q => q.probe_ok?.[name]);
      tr.append(el("td", null, name), el("td")); tr.lastChild.appendChild(st);
      tr.append(el("td", "num", fmtMs(p.ms)), el("td", "num", up.pct == null ? "–" : `${up.pct}%`), el("td", "muted", detail));
      if (!p.ok) status = "bad";
      tb.appendChild(tr);
    }

    // host info
    const host = latest.host || {}, ap = latest.apache || {}, lg = latest.access_log || {};
    const dl = $(".hostinfo", sec);
    const rows = [
      ["Load (1 / 5 / 15 min)", host.load ? host.load.map(v => v.toFixed(2)).join(" / ") + ` on ${host.cpus} CPUs` : "–"],
      ["Memory used", host.mem_used_pct != null ? `${host.mem_used_pct}% of ${fmtBytes(host.mem_total)}` : "–"],
      ["Disk used (/)", host.disks?.["/"] ? `${host.disks["/"].used_pct}% of ${fmtBytes(host.disks["/"].total)}` : "–"],
      ["Server up since", host.boot_time ? `${fmtTime(parseTs(host.boot_time))} (${fmtDur(host.uptime_s)})` : "–"],
      ["Apache", ap.ok ? `${ap.req_per_sec?.toFixed(1)} req/s · ${ap.busy_workers} busy / ${ap.idle_workers} idle workers · up ${fmtDur(ap.uptime_s)}` : "not reachable"],
      ["Requests, last interval", lg.total ? `${lg.total.hits} (${lg.total.s5xx} server errors, p95 ${fmtMs(lg.total.p95_ms)})` : "–"],
    ];
    for (const [k, v] of rows) { dl.append(el("dt", null, k), el("dd", null, v)); }

    // charts
    renderCharts($(".charts", sec), d.series);

    // events
    const ev = (d.events?.events || []).filter(e => e.kind !== "healthy" || e.healthy_within_s != null);
    const etb = $(".events tbody", sec);
    const byStart = {};
    for (const e of d.events?.events || []) if (e.kind === "healthy") byStart[`${e.service}|${e.started_at}`] = e;
    const shown = (d.events?.events || []).filter(e => e.kind !== "healthy").slice(0, 25);
    for (const e of shown) {
      const tr = el("tr");
      let detail = "";
      if (e.kind === "restart") {
        const rec = byStart[`${e.service}|${e.started_at}`];
        detail = rec ? `healthy within ${fmtDur(rec.healthy_within_s)} (checked every 5 min)` : "not yet seen healthy";
      } else if (e.kind === "down") detail = `state: ${e.state}`;
      tr.append(el("td", "since", fmtTime(parseTs(e.ts))), el("td", null, e.service), el("td", null, e.kind === "restart" ? "Restarted" : "Went down"), el("td", "muted", detail));
      etb.appendChild(tr);
    }
    if (!shown.length) $(".events .none", sec).hidden = false;
    void ev;

    sec.dataset.status = status;
    return sec;
  }

  // ------------------------------------------------------------ uptime
  const STRIP_BINS = 60;
  /** Availability over the selected range. Every expected sample between the first one we have and
   *  now counts; a missing sample (host not reporting) counts as DOWN. Time before the first sample
   *  counts as no data. bins = worst value per time slice for the strip. */
  function uptime(points, pick) {
    const span = RANGE_SECONDS[range], end = Math.floor(nowS()), start = end - span;
    const step = state.step || 300;
    const bins = new Array(STRIP_BINS).fill(null);
    const have = points.filter(p => pick(p) != null && p.t >= start);
    if (!have.length) return { pct: null, bins };
    let sum = 0;
    for (const p of have) {
      const v = pick(p);
      sum += v * (p.n || 1);                              // rolled-up points carry n original samples
      const b = Math.min(STRIP_BINS - 1, Math.max(0, Math.floor((p.t - start) / span * STRIP_BINS)));
      bins[b] = bins[b] == null ? v : Math.min(bins[b], v);
    }
    // expected samples from the first one we have until now (minus one interval of grace for the run in progress)
    const first = have[0].t;
    const expected = Math.max(1, Math.floor((end - first) / (state.interval || 300)));
    const observed = have.reduce((a, p) => a + (p.n || 1), 0);
    const ratio = Math.min(1, sum / Math.max(expected, observed));
    // strip slices after the first sample with no data at all were outages of the whole host
    const firstBin = Math.floor((first - start) / span * STRIP_BINS);
    const lastBin = Math.floor((end - step * 2 - start) / span * STRIP_BINS);
    for (let b = firstBin + 1; b <= lastBin && b < STRIP_BINS; b++) if (bins[b] == null) bins[b] = 0;
    const pct = +(100 * ratio).toFixed(ratio >= 0.9995 ? 1 : 2);
    return { pct, bins };
  }

  function strip(bins, label) {
    const box = el("div", "strip");
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", `${label} availability over the selected range`);
    const step = RANGE_SECONDS[range] / STRIP_BINS, end = Math.floor(nowS());
    bins.forEach((v, i) => {
      const b = el("i");
      if (v != null) b.className = v >= 1 ? "ok" : v <= 0 ? "bad" : "part";
      const t0 = end - RANGE_SECONDS[range] + i * step;
      b.title = `${fmtTime(t0)} – ${fmtTime(t0 + step)}: ${v == null ? "no data" : v >= 1 ? "up" : v <= 0 ? "down or not reporting" : `${Math.round(v * 100)}% up`}`;
      box.appendChild(b);
    });
    return box;
  }

  // ------------------------------------------------------------ charts
  function renderCharts(container, series) {
    if (!series || !series.points?.length) { container.innerHTML = `<p class="empty">No time-series data for this range yet.</p>`; return; }
    const pts = withGaps(series.points, series.step_s || 300);
    const t = pts.map(p => p && p.t);
    const C = SERIES();
    const perMin = (p, g, i) => (p && p.log?.[g] && p.win) ? +(p.log[g][i] / (p.win / 60)).toFixed(2) : null;

    const groups = GROUP_ORDER.filter(g => pts.some(p => p?.log?.[g]));
    chart(container, "Requests per minute by service", "From the Apache access log, all clients", t,
      groups.map((g, i) => ({ label: g, color: C[i % 8], data: pts.map(p => perMin(p, g, 0)) })), { unit: "/min" });

    chart(container, "Responses by HTTP status class", "Requests per minute, all services", t,
      [["2xx", 1], ["3xx", 2], ["4xx", 3], ["5xx", 4]].map(([label, idx], i) => ({ label, color: C[i], data: pts.map(p => perMin(p, "_total", idx)) })), { unit: "/min" });

    chart(container, "Response time, 95th percentile", range === "24h" ? "Apache-measured time to serve, by service" : "Apache-measured; hit-weighted mean of 5-minute p95 values", t,
      groups.map((g, i) => ({ label: g, color: C[i % 8], data: pts.map(p => p?.log?.[g] ? p.log[g][6] : null) })), { unit: "ms", fmt: fmtMs });

    const probes = [...new Set(pts.flatMap(p => p ? Object.keys(p.probe_ms || {}) : []))];
    chart(container, "Health check latency", "Local checks run by the collector", t,
      probes.map((n, i) => ({ label: n, color: C[i % 8], data: pts.map(p => p?.probe_ms?.[n] ?? null) })), { unit: "ms", fmt: fmtMs });

    chart(container, "Apache workers", "Busy vs idle worker processes", t,
      [{ label: "busy", color: C[1], data: pts.map(p => p?.busy ?? null) }, { label: "idle", color: C[0], data: pts.map(p => p?.idle ?? null) }], { unit: "" });

    chart(container, "Load average (1 min)", "", t,
      [{ label: "load", color: C[0], data: pts.map(p => p?.load1 ?? null) }], { unit: "" });

    chart(container, "Memory and disk used", "Percent of total", t,
      [{ label: "memory", color: C[0], data: pts.map(p => p?.mem ?? null) }, { label: "disk /", color: C[2], data: pts.map(p => p?.disk ?? null) }], { unit: "%", max: 100 });
  }

  /** Insert a null row wherever a gap > 2 steps exists so lines break instead of bridging outages. */
  function withGaps(points, step) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      if (i && points[i].t - points[i - 1].t > step * 2) out.push({ t: points[i - 1].t + step });
      out.push(points[i]);
    }
    return out;
  }

  function chart(container, title, sub, t, seriesDefs, opts) {
    const box = el("div", "chart");
    box.append(el("h3", null, title));
    if (sub) box.append(el("p", "sub", sub));
    const plotEl = el("div", "plot");
    box.append(plotEl);
    container.appendChild(box);
    if (!seriesDefs.length || !seriesDefs.some(s => s.data.some(v => v != null))) {
      plotEl.className = "empty"; plotEl.textContent = "No data"; return;
    }
    const legend = el("div", "legend");
    const fmt = opts.fmt || (v => v == null ? "–" : `${+v.toFixed(v >= 100 ? 0 : 1)}${opts.unit || ""}`);
    const tip = el("div", "u-tooltip"); tip.style.display = "none";
    box.style.position = "relative"; box.appendChild(tip);

    const u = new uPlot({
      width: plotEl.clientWidth || 340, height: 200,
      cursor: { points: { size: 8 }, drag: { x: true, y: false } },
      legend: { show: false },
      // x-axis always spans the selected window, however much data exists yet
      scales: { x: { time: true, range: () => [Math.floor(nowS()) - RANGE_SECONDS[range], Math.floor(nowS())] }, y: { range: (u, min, max) => [0, opts.max ?? (max <= 0 ? 1 : max * 1.1)] } },
      axes: [
        { stroke: css("--muted"), grid: { stroke: css("--grid"), width: 1 }, ticks: { stroke: css("--axis"), width: 1 }, font: "11px system-ui" },
        { stroke: css("--muted"), grid: { stroke: css("--grid"), width: 1 }, ticks: { show: false }, size: 56, gap: 6, font: "11px system-ui",
          values: (u, vals) => vals.map(v => opts.fmt ? opts.fmt(v) : opts.unit === "%" ? `${v}%` : `${v}`) },
      ],
      series: [{}, ...seriesDefs.map(s => ({ label: s.label, stroke: s.color, width: 2, spanGaps: false, points: { size: 6, fill: s.color } }))],
      hooks: {
        setCursor: [u => {
          const i = u.cursor.idx;
          if (i == null || u.data[0][i] == null) { tip.style.display = "none"; return; }
          const rows = seriesDefs.map((s, k) => u.series[k + 1].show ? `<div class="row"><span><i style="background:${s.color}"></i>${s.label}</span><b>${fmt(u.data[k + 1][i])}</b></div>` : "").join("");
          tip.innerHTML = `<div class="muted">${fmtTime(u.data[0][i])}</div>${rows}`;
          tip.style.display = "block";
          const left = u.cursor.left, w = box.clientWidth;
          tip.style.top = "36px";
          tip.style.left = `${Math.min(left + 60, w - tip.offsetWidth - 8)}px`;
        }],
      },
    }, [t, ...seriesDefs.map(s => s.data)], plotEl);
    plots.push(u);

    if (seriesDefs.length > 1) {
      // per-chart visibility, remembered in this browser
      const key = `status.series.${title}`;
      let hidden = new Set();
      try { hidden = new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch (_) { /* ignore */ }
      const save = () => { try { localStorage.setItem(key, JSON.stringify([...hidden])); } catch (_) { /* ignore */ } };
      const chips = [];
      const apply = () => {
        seriesDefs.forEach((s, k) => {
          const show = !hidden.has(s.label);
          u.setSeries(k + 1, { show });
          chips[k].classList.toggle("off", !show);
          chips[k].setAttribute("aria-pressed", String(show));
        });
        save();
      };
      seriesDefs.forEach((s, k) => {
        const sp = el("button", "chip", s.label);
        sp.type = "button";
        sp.style.setProperty("--c", s.color);
        sp.title = "Click to show or hide · double-click to show only this series";
        sp.onclick = () => { hidden.has(s.label) ? hidden.delete(s.label) : hidden.add(s.label); apply(); };
        sp.ondblclick = () => { hidden = new Set(seriesDefs.map(x => x.label).filter(l => l !== s.label)); apply(); };
        chips.push(sp);
        legend.appendChild(sp);
      });
      const tools = el("span", "legend-tools");
      const all = el("button", "link", "all"); all.type = "button";
      all.onclick = () => { hidden = new Set(); apply(); };
      const none = el("button", "link", "none"); none.type = "button";
      none.onclick = () => { hidden = new Set(seriesDefs.map(x => x.label)); apply(); };
      tools.append(all, document.createTextNode(" · "), none);
      legend.appendChild(tools);
      box.appendChild(legend);
      apply();
    }
    new ResizeObserver(() => u.setSize({ width: plotEl.clientWidth, height: 200 })).observe(plotEl);
  }

  // ------------------------------------------------------------ wiring
  document.querySelectorAll(".range button").forEach(b => {
    b.classList.toggle("active", b.dataset.range === range);
    b.onclick = () => {
      range = b.dataset.range;
      try { localStorage.setItem("status.range", range); } catch (_) { /* ignore */ }
      document.querySelectorAll(".range button").forEach(x => x.classList.toggle("active", x === b));
      refresh();
    };
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
