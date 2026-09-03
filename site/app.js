/* Reactome status page — static, reads JSON written by collector/collector.py.
   No build step; uPlot is vendored in vendor/. */
(() => {
  "use strict";

  const REFRESH_MS = 60_000;
  const FETCH_TIMEOUT_MS = 20_000;
  const RANGE_SECONDS = { "24h": 86400, "7d": 7 * 86400, "90d": 90 * 86400 };
  // staleness thresholds relative to the host's reporting interval (5 min by default): warn after
  // one missed report plus slack, "down" after two
  const staleWarn = (interval) => interval + 120;
  const staleBad = (interval) => 2 * interval + 120;
  const STRIP_BINS = 60;
  // fixed colour slot per log group so a colour always means the same service; unknown groups follow
  const GROUP_ORDER = ["ContentService", "AnalysisService", "PathwayBrowser", "RESTfulAPI", "Website", "Chatbot", "other"];

  // storage may be blocked (private mode, locked-down browsers): never let it break the page
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
  };
  let range = RANGE_SECONDS[store.get("status.range")] ? store.get("status.range") : "24h";

  const plots = [];             // live uPlot instances (destroyed on re-render)
  const observers = [];         // ResizeObservers, disconnected on re-render
  const state = { hosts: [], data: {}, hostsError: null, lastSig: null };
  let refreshSeq = 0;           // discards responses that finish after a newer refresh started
  let clockOffsetMs = 0;        // server time minus viewer time, from response Date headers

  // ------------------------------------------------------------ helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const SERIES = () => [1, 2, 3, 4, 5, 6, 7, 8].map(i => css(`--s${i}`));
  const nowS = () => (Date.now() + clockOffsetMs) / 1000;
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const parseTs = (s) => { const v = typeof s === "string" ? Date.parse(s) / 1000 : NaN; return finite(v) ? v : null; };
  const fmtTime = (ts) => finite(ts) ? new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "unknown time";
  const fmtDur = (s) => {
    if (!finite(s)) return "–";
    s = Math.max(0, Math.round(s));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
    return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
  };
  const fmtAgo = (ts) => finite(ts) ? `${fmtDur(nowS() - ts)} ago` : "–";
  const fmtBytes = (b) => !finite(b) ? "–" : b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(0)} GB` : `${(b / 1e6).toFixed(0)} MB`;
  const fmtMs = (v) => !finite(v) ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
  const fmtPct = (ratio) => !finite(ratio) ? "–" : ratio >= 1 ? "100%" : `${(Math.floor(ratio * 10000) / 100).toFixed(2)}%`; // never rounds up to 100

  /** Fetch JSON with a timeout. Resolves {ok, data} | {ok:false, notFound:true} | {ok:false, error}. */
  async function getJSON(path) {
    try {
      const r = await fetch(`${path}?t=${Math.floor(Date.now() / 30000)}`, { cache: "no-cache", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const date = Date.parse(r.headers.get("date") || "");
      if (finite(date)) clockOffsetMs = date - Date.now();      // correct for a wrong viewer clock (±1 s of header rounding)
      if (r.status === 404) return { ok: false, notFound: true, error: "not found" };
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      return { ok: true, data: await r.json() };
    } catch (e) {
      return { ok: false, error: e.name === "TimeoutError" ? "timed out" : (e.message || String(e)) };
    }
  }

  // ------------------------------------------------------------ data load
  async function loadHost(h, previous) {
    const [latest, series, events] = await Promise.all([
      getJSON(`${h.prefix}/latest.json`),
      getJSON(`${h.prefix}/series/${range}.json`),
      getJSON(`${h.prefix}/events.json`),
    ]);
    const out = { latest: null, series: null, events: null, error: null, stale: false, fetchedAt: nowS(), noData: false };
    if (latest.ok) out.latest = latest.data;
    else if (latest.notFound) out.noData = true;
    else {
      // viewer-side failure (network, CDN, timeout): keep what we showed before rather than blaming the host
      out.error = latest.error;
      if (previous?.latest) { out.latest = previous.latest; out.stale = true; out.fetchedAt = previous.fetchedAt; }
    }
    out.series = series.ok ? series.data : (previous?.series && previous.seriesRange === range && !series.notFound ? previous.series : null);
    out.seriesError = series.ok ? null : series.error;
    out.seriesRange = range;
    out.events = events.ok ? events.data : (previous?.events || null);
    return out;
  }

  async function refresh() {
    const seq = ++refreshSeq;
    if (!state.hosts.length) {
      const r = await getJSON("hosts.json");
      if (seq !== refreshSeq) return;
      if (!r.ok || !Array.isArray(r.data?.hosts)) { state.hostsError = r.error || "hosts.json is malformed"; render(); return; }
      state.hosts = r.data.hosts.filter(h => h && typeof h.name === "string" && typeof h.prefix === "string");
      state.hostsError = null;
    }
    const loaded = await Promise.all(state.hosts.map(h => loadHost(h, state.data[h.name])));
    if (seq !== refreshSeq) return;   // a newer refresh (e.g. range change) superseded this one
    state.hosts.forEach((h, i) => { state.data[h.name] = loaded[i]; });
    render();
  }

  // ------------------------------------------------------------ render
  function setPill(kind, text) {
    const pill = $("#overall");
    const cls = `pill pill-${kind}`;
    if (pill.className !== cls) pill.className = cls;
    if (pill.textContent !== text) pill.textContent = text;   // only re-announce to screen readers when it changes
  }

  function render() {
    const main = $("#hosts");
    if (state.hostsError) {
      main.replaceChildren(el("p", "empty", `Could not load the host list (${state.hostsError}).`));
      setPill("unknown", "Status unavailable");
      return;
    }
    // nothing changed since the last render: refresh only the relative times, keep focus/tooltips
    const sig = JSON.stringify([range, document.documentElement.dataset.theme || "", state.hosts.map(h => {
      const d = state.data[h.name] || {};
      return [d.latest?.generated_at, d.series?.generated, d.stale, d.error, d.noData, (d.events?.events || []).length];
    })]);
    if (sig === state.lastSig && main.children.length) {
      state.hosts.forEach(h => { const sec = main.querySelector(`[data-host="${CSS.escape(h.name)}"]`); if (sec) updateMeta(sec, state.data[h.name]); });
      $("#updated").textContent = `Page refreshed ${new Date().toLocaleTimeString()}; refreshes every minute.`;
      return;
    }
    state.lastSig = sig;

    plots.splice(0).forEach(p => p.destroy());
    observers.splice(0).forEach(o => o.disconnect());
    const focusKey = document.activeElement?.dataset?.key || null;
    const sections = [];
    let worst = "unknown";
    const rank = { unknown: 0, good: 1, warn: 2, bad: 3 };
    for (const h of state.hosts) {
      let sec;
      try {
        sec = renderHost(h, state.data[h.name] || {});
      } catch (e) {
        console.error(`render failed for ${h.name}`, e);
        sec = $("#host-template").content.firstElementChild.cloneNode(true);
        $(".host-title", sec).textContent = h.title || h.name;
        const b = $(".banner", sec); b.hidden = false; b.classList.add("warn");
        b.textContent = `The data for ${h.name} could not be displayed (${e.message}). The collector may be publishing an unexpected format.`;
        $(".charts", sec).replaceChildren();
        sec.dataset.status = "bad";   // an undisplayable host must not read as merely degraded
      }
      sec.dataset.host = h.name;
      sections.push(sec);
      if (rank[sec.dataset.status] > rank[worst]) worst = sec.dataset.status;
    }
    main.replaceChildren(...sections);
    const texts = { good: "All systems operational", warn: "Degraded or not reporting", bad: "Problems detected", unknown: "Status unavailable" };
    setPill(worst, texts[worst]);
    $("#updated").textContent = `Page refreshed ${new Date().toLocaleTimeString()}; refreshes every minute.`;
    if (focusKey) main.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  function updateMeta(sec, d) {
    const gen = parseTs(d?.latest?.generated_at);
    const meta = $(".host-meta", sec);
    if (meta && gen != null) meta.textContent = `Last report ${fmtAgo(gen)} · ${fmtTime(gen)}${d.stale ? ` · shown from cache, refresh failed (${d.error})` : ""}`;
  }

  function renderHost(h, d) {
    const sec = $("#host-template").content.firstElementChild.cloneNode(true);
    $(".host-title", sec).textContent = h.title || h.name;
    const latest = d.latest;
    const banner = $(".banner", sec);
    const warn = (text, level = "warn") => { banner.hidden = false; banner.classList.toggle("warn", level === "warn"); banner.append(el("div", null, text)); };
    let status = "good";

    if (!latest || typeof latest !== "object") {
      if (d.noData) warn(`No data has been received from ${h.name} yet.`);
      else warn(`Could not load data for ${h.name} (${d.error || "unknown error"}).`);
      $(".charts", sec).replaceChildren(el("p", "empty", "No data"));
      sec.dataset.status = d.noData ? "warn" : "unknown";
      return sec;
    }

    // staleness — the "host is down" signal. An unparsable timestamp is treated as stale, not as fine.
    const interval = finite(latest.interval_seconds) && latest.interval_seconds >= 60 && latest.interval_seconds <= 3600 ? latest.interval_seconds : 300;
    let gen = parseTs(latest.generated_at);
    if (gen != null && gen > nowS() + 120) gen = null;            // a timestamp from the future is not "fresh"
    const age = gen == null ? Infinity : Math.max(0, nowS() - gen);
    updateMeta(sec, d);
    if (d.stale) { warn(`This page could not refresh (${d.error}); showing the last data received at ${fmtTime(d.fetchedAt)}.`); status = "warn"; }
    if (age > staleBad(interval)) {
      warn(gen == null ? `The last report from ${h.name} has no readable timestamp.`
        : `No report from ${h.name} since ${fmtTime(gen)} (${fmtDur(age)} ago). The server or its collector is probably down; the details below are from the last report received.`, "bad");
      status = "bad";
    } else if (age > staleWarn(interval)) {
      warn(`The last report from ${h.name} is ${fmtDur(age)} old; a report is expected every ${fmtDur(interval)}.`);
      status = "warn";
    }
    const hostFresh = age <= staleWarn(interval);

    // uptime context for this host and range
    const pts = Array.isArray(d.series?.points) ? d.series.points : [];
    const seriesGen = finite(d.series?.generated) ? d.series.generated : null;
    const ctx = {
      span: RANGE_SECONDS[range], step: finite(d.series?.step_s) ? d.series.step_s : 300,
      interval, hostFresh, seriesGen,
    };
    if (hostFresh && seriesGen != null && nowS() - seriesGen > 2 * ctx.step + 900) {
      warn(`The ${range} history file was last updated ${fmtDur(nowS() - seriesGen)} ago although the host is reporting; charts and uptime for this range may lag.`);
      if (status === "good") status = "warn";
    }

    // services
    const ul = $(".services", sec);
    const objects = (o) => Object.entries(o && typeof o === "object" ? o : {}).filter(([, v]) => v && typeof v === "object");
    const services = Object.fromEntries(objects(latest.services));
    const probesObj = Object.fromEntries(objects(latest.probes));
    if (!Object.keys(services).length && !Object.keys(probesObj).length) {
      warn(`The last report from ${h.name} contains no service or health-check results.`);
      status = "warn";
    }
    for (const [name, s] of Object.entries(services)) {
      const li = el("li");
      const dot = el("span", `dot ${s.up ? "up" : "down"}`);
      dot.title = `${s.state || "unknown"}${s.sub ? ` (${s.sub})` : ""}${s.unknown ? " — state could not be read this run" : ""}`;
      const up = uptime(ctx, pts, p => p.svc?.[name], p => p.svc_n?.[name]);
      const box = el("div", "svc");
      const row = el("div", "svc-row");
      row.append(el("span", null, name));
      const since = parseTs(s.since);
      const upFor = since != null ? `up ${fmtDur(nowS() - since)}` : "up";
      const right = el("span", "since", s.up ? `${upFor}${s.restarts ? ` · ${s.restarts} restarts` : ""} · ` : `${s.state || "down"} · `);
      right.append(el("span", "pct", fmtPct(up.ratio)));
      row.append(right);
      box.append(row, strip(ctx, up, name));
      li.append(dot, box);
      if (!s.up && !s.unknown) status = "bad";
      ul.appendChild(li);
    }

    // probes
    const tb = $(".probes tbody", sec);
    for (const [name, p] of Object.entries(probesObj)) {
      const tr = el("tr");
      const st = el("span", "state");
      st.append(el("span", `dot ${p.ok ? "up" : "down"}`), document.createTextNode(p.ok ? "OK" : "Failing"));
      const detail = p.error ? `failed (${p.error})` : p.status ? `HTTP ${p.status}${p.body ? ` · database v${p.body}` : ""}` : p.kind === "tcp" || p.port ? "port responds" : "";
      const up = uptime(ctx, pts, q => q.probe_ok?.[name], q => q.probe_n?.[name]);
      tr.append(el("td", null, name), el("td")); tr.lastChild.appendChild(st);
      tr.append(el("td", "num", fmtMs(p.ms)), el("td", "num", fmtPct(up.ratio)), el("td", "muted", detail));
      if (!p.ok) status = "bad";
      tb.appendChild(tr);
    }

    // host info
    const host = latest.host || {}, ap = latest.apache || {}, lg = latest.access_log || {};
    const dl = $(".hostinfo", sec);
    const load = Array.isArray(host.load) ? host.load.filter(finite) : [];
    const disk = host.disks?.["/"];
    const rows = [
      ["Load (1 / 5 / 15 min)", load.length ? load.map(v => v.toFixed(2)).join(" / ") + (finite(host.cpus) ? ` on ${host.cpus} CPUs` : "") : "–"],
      ["Memory used", finite(host.mem_used_pct) ? `${host.mem_used_pct}% of ${fmtBytes(host.mem_total)}` : "–"],
      ["Disk used (/)", disk && finite(disk.used_pct) ? `${disk.used_pct}% of ${fmtBytes(disk.total)}` : "–"],
      ["Server up since", parseTs(host.boot_time) != null ? `${fmtTime(parseTs(host.boot_time))} (${fmtDur(host.uptime_s)})` : "–"],
      ["Apache", ap.ok ? `${ap.busy_workers ?? "–"} busy / ${ap.idle_workers ?? "–"} idle workers · ${finite(ap.req_per_sec) ? ap.req_per_sec.toFixed(1) : "–"} req/s averaged since Apache started ${fmtDur(ap.uptime_s)} ago` : "not reachable"],
      ["Requests, last interval", lg.total && finite(lg.window_s) && lg.window_s > 0
        ? `${lg.total.hits} in ${fmtDur(lg.window_s)} (≈${Math.round(lg.total.hits / (lg.window_s / 60))}/min) · ${lg.total.s5xx} server errors · p95 ${fmtMs(lg.total.p95_ms)}${lg.unparsed ? ` · ${lg.unparsed} unparsed lines` : ""}`
        : "–"],
    ];
    if (lg.parsed && lg.unparsed > 0.01 * (lg.parsed + lg.unparsed)) {
      warn(`${lg.unparsed} of ${lg.parsed + lg.unparsed} log lines in the last interval could not be parsed; traffic figures are incomplete.`);
      if (status === "good") status = "warn";
    }
    for (const [k, v] of rows) { dl.append(el("dt", null, k), el("dd", null, v)); }

    // charts
    renderCharts($(".charts", sec), d.series, d.seriesError, h.name);

    // events: restarts and outages, each paired with the recovery that followed it
    const all = (Array.isArray(d.events?.events) ? d.events.events : []).filter(e => e && typeof e === "object");   // newest first
    const etb = $(".events tbody", sec);
    const shown = all.filter(e => e && e.kind !== "healthy").slice(0, 25);
    for (const e of shown) {
      const tr = el("tr");
      let detail = "";
      if (e.kind === "restart") {
        const rec = all.find(x => x.kind === "healthy" && x.service === e.service && x.started_at === e.started_at);
        detail = rec && finite(rec.healthy_within_s) ? `healthy within ${fmtDur(rec.healthy_within_s)} (checked every 5 min)` : "not yet seen healthy";
      } else if (e.kind === "down") {
        const rec = all.filter(x => x.kind === "healthy" && x.service === e.service && x.ts > e.ts).pop();
        detail = rec ? `back up by ${fmtTime(parseTs(rec.ts))} (state was ${e.state})` : `still down · state: ${e.state}`;
      }
      tr.append(el("td", "since", fmtTime(parseTs(e.ts))), el("td", null, e.service), el("td", null, e.kind === "restart" ? "Restarted" : "Went down"), el("td", "muted", detail));
      etb.appendChild(tr);
    }
    if (!shown.length) $(".events .none", sec).hidden = false;

    sec.dataset.status = status;
    return sec;
  }

  // ------------------------------------------------------------ uptime
  /** Availability over the selected range.
   *  Each sample covers one collector interval. Every sample expected between the first real sample
   *  (clipped to the range) and the end of coverage counts; a missing sample (host not reporting)
   *  counts as DOWN. Coverage ends at the series' generation time while the host is reporting (the
   *  coarse series lag by up to 30 min) and at "now" when it is not, so silence counts against it.
   *  Rolled-up points carry n samples between t0 and t1 (plus per-key counts svc_n / probe_n) and are
   *  spread over the strip bins by time overlap, so nothing depends on bucket/bin alignment. */
  function uptime(ctx, points, pick, pickN) {
    const now = Math.floor(nowS()), I = ctx.interval;
    const binW = ctx.span / STRIP_BINS;
    const alignedNow = Math.ceil(now / binW) * binW;          // stable bin edges between renders
    const start = alignedNow - ctx.span, rangeStart = now - ctx.span;
    const bins = new Array(STRIP_BINS).fill(null);
    const have = points.filter(p => p && finite(p.t) && finite(pick(p)) && (p.t1 ?? p.t) + I > rangeStart);
    if (!have.length) return { ratio: null, bins };
    const lastSample = have[have.length - 1].t1 ?? have[have.length - 1].t;
    const end = ctx.hostFresh ? Math.min(now, Math.max(ctx.seriesGen ?? lastSample, lastSample)) : now;
    const first = Math.max(rangeStart, have[0].t0 ?? have[0].t);
    const wEnd = end + I;                                      // coverage window [first, wEnd)
    if (wEnd <= first) return { ratio: null, bins };
    const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

    const obs = new Array(STRIP_BINS).fill(0), ups = new Array(STRIP_BINS).fill(0);
    let sum = 0, observed = 0;
    for (let i = 0; i < have.length; i++) {
      const p = have[i], v = pick(p);
      // time-weighted: a raw sample covers until the next sample (at most one interval), so extra
      // off-schedule runs do not count as extra intervals; a rolled bucket never counts more samples
      // than the time it spans
      const s0 = p.t0 ?? p.t;
      const next = have[i + 1];
      const s1 = p.t1 != null ? p.t1 + I : Math.min(p.t + I, next && finite(next.t0 ?? next.t) ? (next.t0 ?? next.t) : p.t + I);
      const span = Math.max(1, s1 - s0);
      const nRaw = finite(pickN?.(p)) ? pickN(p) : (finite(p.n) ? p.n : 1);
      const n = p.t1 != null ? Math.min(nRaw, span / I) : span / I;
      const fw = overlap(s0, s1, first, wEnd) / span;         // fraction of this point inside the window
      sum += v * n * fw; observed += n * fw;
      for (let b = 0; b < STRIP_BINS; b++) {
        const fb = overlap(s0, s1, start + b * binW, start + (b + 1) * binW) / span;
        if (fb > 0) { obs[b] += n * fb; ups[b] += v * n * fb; }
      }
    }
    const expected = Math.max(1, Math.round((wEnd - first) / I));
    const ratio = Math.min(1, sum / Math.max(expected, observed));

    // colour bins by how much of the covered time was down or missing (one sample of slack for jitter)
    for (let b = 0; b < STRIP_BINS; b++) {
      const cov = overlap(start + b * binW, start + (b + 1) * binW, first, wEnd);
      if (cov <= 0) continue;                                   // outside coverage: no data
      const exp = cov / I;
      const missing = Math.max(0, exp - 1 - obs[b]);
      const down = (obs[b] - ups[b]) + missing;
      bins[b] = { down, exp, ratio: Math.min(1, ups[b] / Math.max(exp, obs[b])) };
    }
    return { ratio, bins };
  }

  function strip(ctx, up, label) {
    const box = el("div", "strip");
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", `${label}: ${fmtPct(up.ratio)} available over the selected range`);
    const binW = ctx.span / STRIP_BINS, alignedNow = Math.ceil(Math.floor(nowS()) / binW) * binW, start = alignedNow - ctx.span;
    up.bins.forEach((v, i) => {
      const b = el("i");
      const t0 = start + i * binW;
      let text = "no data";
      if (v) {
        const downMin = Math.round(v.down * ctx.interval / 60);
        if (v.down <= 1) { b.className = "ok"; text = "up"; }
        else if (v.ratio <= 0.05) { b.className = "bad"; text = `down or not reporting (~${fmtDur(downMin * 60)})`; }
        else { b.className = "part"; text = `~${fmtDur(downMin * 60)} down or not reporting`; }
      }
      b.title = `${fmtTime(t0)} – ${fmtTime(t0 + binW)}: ${text}`;
      box.appendChild(b);
    });
    return box;
  }

  // ------------------------------------------------------------ charts
  function renderCharts(container, series, seriesError, hostName) {
    if (!Array.isArray(series?.points) || !series.points.length) {
      container.replaceChildren(el("p", "empty", seriesError && seriesError !== "not found" ? `Could not load the ${range} history (${seriesError}).` : "No time-series data for this range yet."));
      return;
    }
    const pts = withGaps(series.points.filter(p => p && finite(p.t)), finite(series.step_s) ? series.step_s : 300);
    const t = pts.map(p => p.t);
    const C = SERIES();
    const perMin = (p, g, i) => (p && p.log?.[g] && finite(p.win) && p.win > 0 && finite(p.log[g][i])) ? +(p.log[g][i] / (p.win / 60)).toFixed(2) : null;
    const colorFor = (name, order) => { const i = order.indexOf(name); return C[(i >= 0 ? i : order.length + Math.abs(hash(name))) % 8]; };

    // groups come from the data; GROUP_ORDER only fixes their order and colours
    const present = [...new Set(pts.flatMap(p => Object.keys(p.log || {}).filter(k => k !== "_total")))];
    const groups = [...GROUP_ORDER.filter(g => present.includes(g)), ...present.filter(g => !GROUP_ORDER.includes(g)).sort()];
    const gseries = (fn) => groups.map(g => ({ label: g, color: colorFor(g, GROUP_ORDER), data: pts.map(p => fn(p, g)) }));
    const mk = (title, sub, defs, opts) => chart(container, hostName, title, sub, t, defs, opts);

    mk("Requests per minute by service", "From the Apache access log, all clients", gseries((p, g) => perMin(p, g, 0)), { unit: "/min" });
    mk("Responses by HTTP status class", "Requests per minute, all services",
      [["2xx", 1], ["3xx", 2], ["4xx", 3], ["5xx", 4]].map(([label, idx], i) => ({ label, color: C[i], data: pts.map(p => perMin(p, "_total", idx)) })), { unit: "/min" });
    mk("Response time, 95th percentile", range === "24h" ? "Apache-measured time to serve, by service" : "Apache-measured; hit-weighted mean of 5-minute p95 values",
      gseries((p, g) => finite(p.log?.[g]?.[6]) ? p.log[g][6] : null), { unit: "ms", fmt: fmtMs });
    const probes = [...new Set(pts.flatMap(p => Object.keys(p.probe_ms || {})))];
    mk("Health check latency", "Local checks run by the collector",
      probes.map(n => ({ label: n, color: colorFor(n, probes), data: pts.map(p => finite(p.probe_ms?.[n]) ? p.probe_ms[n] : null) })), { unit: "ms", fmt: fmtMs });
    mk("Apache workers", "Busy vs idle worker processes",
      [{ label: "busy", color: C[1], data: pts.map(p => finite(p.busy) ? p.busy : null) }, { label: "idle", color: C[0], data: pts.map(p => finite(p.idle) ? p.idle : null) }], { unit: "" });
    mk("Load average (1 min)", "", [{ label: "load", color: C[0], data: pts.map(p => finite(p.load1) ? p.load1 : null) }], { unit: "" });
    mk("Memory and disk used", "Percent of total",
      [{ label: "memory", color: C[0], data: pts.map(p => finite(p.mem) ? p.mem : null) }, { label: "disk /", color: C[2], data: pts.map(p => finite(p.disk) ? p.disk : null) }], { unit: "%", max: 100 });
  }

  const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };

  /** Insert a null row wherever a gap > 2 steps exists so lines break instead of bridging outages. */
  function withGaps(points, step) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      if (i && points[i].t - points[i - 1].t > step * 1.5) out.push({ t: points[i - 1].t + step });
      out.push(points[i]);
    }
    return out;
  }

  function chart(container, hostName, title, sub, t, seriesDefs, opts) {
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
    const fmt = opts.fmt || (v => !finite(v) ? "–" : `${+v.toFixed(v >= 100 ? 0 : 1)}${opts.unit || ""}`);
    const tip = el("div", "u-tooltip"); tip.style.display = "none";
    box.style.position = "relative"; box.appendChild(tip);

    const u = new uPlot({
      width: plotEl.clientWidth || 340, height: 200,
      cursor: { points: { size: 8 }, drag: { x: false, y: false } },
      legend: { show: false },
      // x-axis always spans the selected window, however much data exists yet
      scales: { x: { time: true, range: () => [Math.floor(nowS()) - RANGE_SECONDS[range], Math.floor(nowS())] }, y: { range: (u, min, max) => [0, opts.max ?? (!finite(max) || max <= 0 ? 1 : max * 1.1)] } },
      axes: [
        { stroke: css("--muted"), grid: { stroke: css("--grid"), width: 1 }, ticks: { stroke: css("--axis"), width: 1 }, font: "11px Roboto, system-ui" },
        { stroke: css("--muted"), grid: { stroke: css("--grid"), width: 1 }, ticks: { show: false }, size: 56, gap: 6, font: "11px Roboto, system-ui",
          values: (u, vals) => vals.map(v => opts.fmt ? opts.fmt(v) : opts.unit === "%" ? `${v}%` : `${v}`) },
      ],
      series: [{}, ...seriesDefs.map(s => ({ label: s.label, stroke: s.color, width: 2, spanGaps: false, points: { size: 6, fill: s.color } }))],
      hooks: {
        setCursor: [u => {
          const i = u.cursor.idx;
          if (i == null || u.data[0][i] == null) { tip.style.display = "none"; return; }
          tip.replaceChildren(el("div", "muted", fmtTime(u.data[0][i])));
          seriesDefs.forEach((s, k) => {
            if (!u.series[k + 1].show) return;
            const row = el("div", "row"), name = el("span"), sw = el("i");
            sw.style.background = s.color;
            name.append(sw, document.createTextNode(s.label));
            row.append(name, el("b", null, fmt(u.data[k + 1][i])));
            tip.appendChild(row);
          });
          tip.style.display = "block";
          tip.style.top = "36px";
          tip.style.left = `${Math.min(u.cursor.left + 60, box.clientWidth - tip.offsetWidth - 8)}px`;
        }],
      },
    }, [t, ...seriesDefs.map(s => s.data)], plotEl);
    plots.push(u);

    if (seriesDefs.length > 1) {
      // per-host, per-chart visibility, remembered in this browser
      const key = `status.series.${hostName}.${title}`;
      let hidden = new Set();
      try { hidden = new Set(JSON.parse(store.get(key) || "[]")); } catch (_) { /* ignore */ }
      const save = () => store.set(key, JSON.stringify([...hidden]));
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
        sp.dataset.key = `${key}.${s.label}`;
        sp.style.setProperty("--c", s.color);
        sp.title = "Click to show or hide · double-click to show only this series";
        sp.onclick = () => { hidden.has(s.label) ? hidden.delete(s.label) : hidden.add(s.label); apply(); };
        sp.ondblclick = () => { hidden = new Set(seriesDefs.map(x => x.label).filter(l => l !== s.label)); apply(); };
        chips.push(sp);
        legend.appendChild(sp);
      });
      const tools = el("span", "legend-tools");
      const all = el("button", "link", "all"); all.type = "button"; all.dataset.key = `${key}.all`;
      all.onclick = () => { hidden = new Set(); apply(); };
      const none = el("button", "link", "none"); none.type = "button"; none.dataset.key = `${key}.none`;
      none.onclick = () => { hidden = new Set(seriesDefs.map(x => x.label)); apply(); };
      tools.append(all, document.createTextNode(" · "), none);
      legend.appendChild(tools);
      box.appendChild(legend);
      apply();
    }
    const ro = new ResizeObserver(() => u.setSize({ width: plotEl.clientWidth, height: 200 }));
    ro.observe(plotEl);
    observers.push(ro);
  }

  // ------------------------------------------------------------ wiring
  document.querySelectorAll(".range button").forEach(b => {
    const on = b.dataset.range === range;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
    b.onclick = () => {
      range = b.dataset.range;
      store.set("status.range", range);
      document.querySelectorAll(".range button").forEach(x => { const a = x === b; x.classList.toggle("active", a); x.setAttribute("aria-pressed", String(a)); });
      refresh();
    };
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (state.hosts.length) { state.lastSig = null; render(); } });
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
