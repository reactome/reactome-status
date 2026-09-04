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
  // ------------------------------------------------------------ theme (auto / light / dark)
  const THEMES = ["auto", "light", "dark"];
  let theme = THEMES.includes(store.get("status.theme")) ? store.get("status.theme") : "auto";
  function applyTheme() {
    if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    const b = document.getElementById("theme");
    if (b) {
      b.textContent = theme === "auto" ? "◐" : theme === "light" ? "☀" : "☾";
      b.title = `Theme: ${theme === "auto" ? "follows your system" : theme} (click to change)`;
    }
  }
  applyTheme();

  // ------------------------------------------------------------ shareable state in the URL hash
  // #range=7d  |  #range=24h&chart=<host>|<title>&crange=custom&from=<unix>&to=<unix>
  const readHash = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  const hashState = readHash();
  let range = RANGE_SECONDS[hashState.range] ? hashState.range : (RANGE_SECONDS[store.get("status.range")] ? store.get("status.range") : "24h");
  function writeHash() {
    const q = new URLSearchParams({ range });
    if (expanded) {
      q.set("chart", expanded.key);
      if (expanded.range && expanded.range !== range) q.set("crange", expanded.range);
      if (expanded.range === "custom" && finite(expanded.from) && finite(expanded.to)) { q.set("from", String(Math.floor(expanded.from))); q.set("to", String(Math.floor(expanded.to))); }
    }
    history.replaceState(null, "", `#${q.toString()}`);
  }

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
  // binary units, matching what `free` and `df` show on the server (a 64 GiB machine reports 61.8 GiB usable)
  const GiB = 1024 ** 3;
  const fmtBytes = (b) => !finite(b) ? "–" : b >= 1024 * GiB ? `${(b / (1024 * GiB)).toFixed(2)} TiB` : b >= GiB ? `${(b / GiB).toFixed(1)} GiB` : `${(b / 1024 ** 2).toFixed(0)} MiB`;
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
    if (hashState.chart && !expanded && chartDefs.has(hashState.chart)) {
      const r = hashState.crange === "custom" ? "custom" : (RANGE_SECONDS[hashState.crange] ? hashState.crange : range);
      openModal(hashState.chart, { key: hashState.chart, range: r, from: +hashState.from || null, to: +hashState.to || null });
      delete hashState.chart;   // only on first load
    }
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
    const sig = JSON.stringify([range, theme, window.matchMedia("(prefers-color-scheme: dark)").matches, state.hosts.map(h => {
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
    if (expanded && !chartDefs.has(expanded.key)) closeModal();
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
  const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };
  const RANGE_LABEL = { "24h": "last 24 hours", "7d": "last 7 days", "90d": "last 90 days" };
  const STEP_LABEL = (step) => step <= 300 ? "5-minute points" : step <= 1800 ? "30-minute averages" : "6-hour averages";

  /** Chart catalogue: how to derive each chart's series from a list of points. */
  const CHARTS = [
    { title: "Requests per minute by service", sub: () => "From the Apache access log, all clients", unit: "/min",
      build: (pts, C, groups) => groups.map(g => ({ label: g, color: colorFor(C, g, GROUP_ORDER), data: pts.map(p => perMin(p, g, 0)) })) },
    { title: "Responses by HTTP status class", sub: () => "Requests per minute, all services", unit: "/min",
      build: (pts, C) => [["2xx", 1], ["3xx", 2], ["4xx", 3], ["5xx", 4]].map(([label, idx], i) => ({ label, color: C[i], data: pts.map(p => perMin(p, "_total", idx)) })) },
    { title: "Response time, 95th percentile", sub: (step) => step <= 300 ? "Apache-measured time to serve, by service" : "Apache-measured; hit-weighted mean of 5-minute p95 values", unit: "ms", fmt: fmtMs,
      build: (pts, C, groups) => groups.map(g => ({ label: g, color: colorFor(C, g, GROUP_ORDER), data: pts.map(p => finite(p.log?.[g]?.[6]) ? p.log[g][6] : null) })) },
    { title: "Health check latency", sub: () => "Local checks run by the collector", unit: "ms", fmt: fmtMs,
      build: (pts, C) => { const names = [...new Set(pts.flatMap(p => Object.keys(p.probe_ms || {})))]; return names.map(n => ({ label: n, color: colorFor(C, n, names), data: pts.map(p => finite(p.probe_ms?.[n]) ? p.probe_ms[n] : null) })); } },
    { title: "Apache workers", sub: () => "Busy vs idle worker processes", unit: "",
      build: (pts, C) => [{ label: "busy", color: C[1], data: pts.map(p => finite(p.busy) ? p.busy : null) }, { label: "idle", color: C[0], data: pts.map(p => finite(p.idle) ? p.idle : null) }] },
    { title: "Load average (1 min)", sub: () => "", unit: "",
      build: (pts, C) => [{ label: "load", color: C[0], data: pts.map(p => finite(p.load1) ? p.load1 : null) }] },
    { title: "Memory and disk used", sub: () => "Percent of total", unit: "%", max: 100,
      build: (pts, C) => [{ label: "memory", color: C[0], data: pts.map(p => finite(p.mem) ? p.mem : null) }, { label: "disk /", color: C[2], data: pts.map(p => finite(p.disk) ? p.disk : null) }] },
  ];
  const perMin = (p, g, i) => (p && p.log?.[g] && finite(p.win) && p.win > 0 && finite(p.log[g][i])) ? +(p.log[g][i] / (p.win / 60)).toFixed(2) : null;
  const colorFor = (C, name, order) => { const i = order.indexOf(name); return C[(i >= 0 ? i : order.length + Math.abs(hash(name))) % 8]; };
  const groupsIn = (pts) => {
    const present = [...new Set(pts.flatMap(p => Object.keys(p.log || {}).filter(k => k !== "_total")))];
    return [...GROUP_ORDER.filter(g => present.includes(g)), ...present.filter(g => !GROUP_ORDER.includes(g)).sort()];
  };

  /** A view = the window [x0, x1] plus the points (with gap markers) that fall in it. */
  function makeView(series, x0, x1) {
    const step = finite(series?.step_s) ? series.step_s : 300;
    const all = (Array.isArray(series?.points) ? series.points : []).filter(p => p && finite(p.t));
    const pts = withGaps(all.filter(p => p.t >= x0 - step && p.t <= x1 + step), step);
    return { x0, x1, step, pts, t: pts.map(p => p.t) };
  }

  function renderCharts(container, series, seriesError, hostName) {
    if (!Array.isArray(series?.points) || !series.points.length) {
      container.replaceChildren(el("p", "empty", seriesError && seriesError !== "not found" ? `Could not load the ${range} history (${seriesError}).` : "No time-series data for this range yet."));
      return;
    }
    const now = Math.floor(nowS());
    const view = makeView(series, now - RANGE_SECONDS[range], now);
    for (const spec of CHARTS) chart(container, hostName, spec, view);
  }

  /** Insert a null row wherever a gap > 1.5 steps exists so lines break instead of bridging outages. */
  function withGaps(points, step) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      if (i && points[i].t - points[i - 1].t > step * 1.5) out.push({ t: points[i - 1].t + step });
      out.push(points[i]);
    }
    return out;
  }

  const chartDefs = new Map();      // `${host}|${title}` -> { hostName, spec }, for the enlarged view
  let expanded = null;              // { key, range, from, to } while a chart is enlarged; survives refreshes
  const modalPlots = [];

  function chart(container, hostName, spec, view) {
    const key = `${hostName}|${spec.title}`;
    chartDefs.set(key, { hostName, spec });
    const box = el("div", "chart");
    const head = el("div", "chart-head");
    head.append(el("h3", null, spec.title));
    const C = SERIES();
    const seriesDefs = spec.build(view.pts, C, groupsIn(view.pts));
    const hasData = seriesDefs.length && seriesDefs.some(s => s.data.some(v => v != null));
    if (hasData) {
      const btn = el("button", "expand", "⤢");
      btn.type = "button"; btn.title = "Enlarge this chart"; btn.setAttribute("aria-label", `Enlarge ${spec.title}`);
      btn.dataset.key = `expand.${key}`;
      btn.onclick = () => openModal(key);
      head.append(btn);
    }
    box.append(head);
    const sub = spec.sub(view.step);
    if (sub) box.append(el("p", "sub", sub));
    container.appendChild(box);
    if (!hasData) { box.append(el("div", "empty", "No data")); return; }
    mountPlot(box, { hostName, spec, seriesDefs, view }, 200, plots);
    box.querySelector(".plot").ondblclick = () => openModal(key);
    if (expanded?.key === key) openModal(key, expanded);   // re-render while enlarged: refresh the enlarged copy too
  }

  /** Build a uPlot with legend chips into `box` and register the instance in `list`. */
  function mountPlot(box, def, height, list) {
    const { hostName, spec, seriesDefs, view } = def;
    const opts = spec;
    const plotEl = el("div", "plot"); plotEl.style.height = `${height}px`;
    box.append(plotEl);
    const legend = el("div", "legend");
    const fmt = opts.fmt || (v => !finite(v) ? "–" : `${+v.toFixed(v >= 100 ? 0 : 1)}${opts.unit || ""}`);
    const tip = el("div", "u-tooltip"); tip.style.display = "none";
    box.style.position = "relative"; box.appendChild(tip);
    const big = height > 300;
    const font = `${big ? 12 : 11}px Roboto, system-ui`;

    const u = new uPlot({
      width: plotEl.clientWidth || 340, height,
      cursor: { points: { size: 8 }, drag: { x: false, y: false } },
      legend: { show: false },
      // the x-axis always spans the requested window, however much data exists in it
      scales: { x: { time: true, range: () => [view.x0, view.x1] }, y: { range: (u, min, max) => [0, opts.max ?? (!finite(max) || max <= 0 ? 1 : max * 1.1)] } },
      axes: [
        { stroke: css("--muted"), grid: { stroke: css("--grid"), width: 1 }, ticks: { stroke: css("--axis"), width: 1 }, font },
        { stroke: css("--muted"), grid: { stroke: css("--grid"), width: 1 }, ticks: { show: false }, size: big ? 64 : 56, gap: 6, font,
          values: (u, vals) => vals.map(v => opts.fmt ? opts.fmt(v) : opts.unit === "%" ? `${v}%` : `${v}`) },
      ],
      series: [{}, ...seriesDefs.map(s => ({ label: s.label, stroke: s.color, width: big ? 2.5 : 2, spanGaps: false, points: { size: 6, fill: s.color } }))],
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
    }, [view.t, ...seriesDefs.map(s => s.data)], plotEl);
    list.push(u);

    if (seriesDefs.length > 1) {
      // per-host, per-chart visibility, remembered in this browser and shared with the enlarged view
      const key = `status.series.${hostName}.${spec.title}`;
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
        sp.dataset.key = `${key}.${s.label}${big ? ".big" : ""}`;
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
    const ro = new ResizeObserver(() => u.setSize({ width: plotEl.clientWidth, height }));
    ro.observe(plotEl);
    observers.push(ro);
  }

  // ------------------------------------------------------------ enlarged view with its own time range
  /** Series files by range for a host, fetched on demand and cached until the next refresh. */
  async function seriesFor(hostName, r) {
    const h = state.hosts.find(x => x.name === hostName);
    const d = state.data[hostName];
    if (!h || !d) return null;
    d.seriesByRange ||= {};
    if (d.series && d.seriesRange === r) d.seriesByRange[r] = d.series;
    if (!d.seriesByRange[r]) {
      const res = await getJSON(`${h.prefix}/series/${r}.json`);
      d.seriesByRange[r] = res.ok ? res.data : null;
    }
    return d.seriesByRange[r];
  }
  /** Finest history file that covers a window starting at x0. */
  const rangeCovering = (x0) => { const age = nowS() - x0; return age <= RANGE_SECONDS["24h"] ? "24h" : age <= RANGE_SECONDS["7d"] ? "7d" : "90d"; };
  const toLocalInput = (ts) => { const d = new Date(ts * 1000); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

  async function openModal(key, sel) {
    const def = chartDefs.get(key);
    if (!def) return;
    const wasOpen = expanded?.key === key;
    sel = sel || (wasOpen ? expanded : { key, range, from: null, to: null });
    expanded = { ...sel, key };
    const { hostName, spec } = def;
    const now = Math.floor(nowS());

    // resolve the window and the history file for it
    let x0, x1, fileRange, note = "";
    if (sel.range === "custom" && finite(sel.from) && finite(sel.to)) {
      x0 = Math.min(sel.from, sel.to); x1 = Math.max(sel.from, sel.to);
      if (x1 > now) x1 = now;
      if (x1 - x0 < 1800) x0 = x1 - 1800;
      if (x0 < now - RANGE_SECONDS["90d"]) { x0 = now - RANGE_SECONDS["90d"]; note = " · history starts 90 days ago"; }
      fileRange = rangeCovering(x0);
    } else {
      fileRange = RANGE_SECONDS[sel.range] ? sel.range : range;
      x1 = now; x0 = now - RANGE_SECONDS[fileRange];
    }
    const series = await seriesFor(hostName, fileRange);
    if (expanded?.key !== key) return;                         // closed or changed while loading
    const view = makeView(series, x0, x1);
    const C = SERIES();
    const seriesDefs = spec.build(view.pts, C, groupsIn(view.pts));

    // (re)build the dialog
    modalPlots.splice(0).forEach(p => p.destroy());
    let overlay = document.getElementById("modal");
    if (!overlay) {
      overlay = el("div", "modal"); overlay.id = "modal";
      overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true");
      overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
      document.body.appendChild(overlay);
      document.body.classList.add("modal-open");
    }
    overlay.setAttribute("aria-label", `${spec.title}, enlarged`);
    const dialog = el("div", "modal-box");
    const head = el("div", "chart-head modal-head");
    const titles = el("div");
    const windowText = sel.range === "custom" ? `${fmtTime(x0)} – ${fmtTime(x1)}` : RANGE_LABEL[fileRange];
    titles.append(el("h3", null, spec.title), el("p", "sub", `${hostName} · ${windowText} · ${STEP_LABEL(view.step)}${note}${spec.sub(view.step) ? ` · ${spec.sub(view.step)}` : ""}`));
    const controls = el("div", "modal-controls");
    const rangeCtl = el("div", "range"); rangeCtl.setAttribute("role", "group"); rangeCtl.setAttribute("aria-label", "Time range for this chart");
    for (const r of ["24h", "7d", "90d", "custom"]) {
      const b = el("button", null, r === "custom" ? "Custom…" : r.replace("h", " h").replace("d", " d"));
      b.type = "button"; b.dataset.range = r;
      const on = sel.range === r;
      b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
      b.onclick = () => openModal(key, r === "custom" ? { key, range: "custom", from: sel.from ?? now - 6 * 3600, to: sel.to ?? now } : { key, range: r, from: null, to: null });
      rangeCtl.appendChild(b);
    }
    const close = el("button", "close", "✕"); close.type = "button"; close.title = "Close (Esc)"; close.setAttribute("aria-label", "Close enlarged chart");
    close.onclick = () => closeModal();
    const tools = el("div", "modal-tools");
    const csv = el("button", "btn", "Download CSV"); csv.type = "button"; csv.title = "The points shown in this chart, one row per time";
    csv.onclick = () => downloadCsv(hostName, spec, view, seriesDefs, windowText);
    const link = el("button", "btn", "Copy link"); link.type = "button"; link.title = "Copy a link that opens this chart with this range";
    link.onclick = async () => {
      writeHash();
      try { await navigator.clipboard.writeText(location.href); link.textContent = "Copied"; link.classList.add("done"); }
      catch (_) { link.textContent = "Copy failed"; }
      setTimeout(() => { link.textContent = "Copy link"; link.classList.remove("done"); }, 1800);
    };
    tools.append(csv, link);
    controls.append(rangeCtl, tools, close);
    writeHash();
    head.append(titles, controls);
    dialog.append(head);
    if (sel.range === "custom") {
      const form = el("form", "custom-range");
      const from = el("input"); from.type = "datetime-local"; from.value = toLocalInput(x0); from.setAttribute("aria-label", "From");
      const to = el("input"); to.type = "datetime-local"; to.value = toLocalInput(x1); to.setAttribute("aria-label", "To");
      to.max = from.max = toLocalInput(now); to.min = from.min = toLocalInput(now - RANGE_SECONDS["90d"]);
      const apply = el("button", "apply", "Apply"); apply.type = "submit";
      const quick = el("span", "quick");
      for (const [label, secs] of [["Last 6 h", 6 * 3600], ["Last 2 d", 2 * 86400], ["Last 30 d", 30 * 86400]]) {
        const q = el("button", "link", label); q.type = "button";
        q.onclick = () => openModal(key, { key, range: "custom", from: now - secs, to: now });
        quick.append(q);
      }
      form.append(el("label", null, "From"), from, el("label", null, "To"), to, apply, quick);
      form.onsubmit = (e) => { e.preventDefault(); const f = Date.parse(from.value) / 1000, t = Date.parse(to.value) / 1000; if (finite(f) && finite(t)) openModal(key, { key, range: "custom", from: f, to: t }); };
      dialog.append(form);
    }
    overlay.replaceChildren(dialog);
    const height = Math.max(320, Math.min(640, Math.floor(window.innerHeight * 0.55)));
    if (!seriesDefs.length || !seriesDefs.some(s => s.data.some(v => v != null))) {
      dialog.append(el("p", "empty", series ? "No data in this window." : `Could not load the ${fileRange} history.`));
    } else {
      mountPlot(dialog, { hostName, spec, seriesDefs, view }, height, modalPlots);
    }
    if (!wasOpen) close.focus();
  }

  function closeModal(clearState = true) {
    modalPlots.splice(0).forEach(p => p.destroy());
    document.getElementById("modal")?.remove();
    document.body.classList.remove("modal-open");
    if (clearState) {
      const key = expanded?.key; expanded = null;
      writeHash();
      if (key) document.querySelector(`[data-key="${CSS.escape(`expand.${key}`)}"]`)?.focus();
    }
  }

  /** CSV of the visible window: ISO time first, then one column per series (hidden series included). */
  function downloadCsv(hostName, spec, view, seriesDefs, windowText) {
    const esc = (v) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const unit = spec.unit ? ` (${spec.unit.replace("/min", "per min")})` : "";
    const rows = [["time_utc", ...seriesDefs.map(s => `${s.label}${unit}`)].map(esc).join(",")];
    view.pts.forEach((p, i) => {
      if (!p || p.t == null || (p.log === undefined && p.svc === undefined && p.probe_ok === undefined && p.load1 === undefined)) return; // gap marker
      rows.push([new Date(p.t * 1000).toISOString(), ...seriesDefs.map(s => s.data[i] == null ? "" : s.data[i])].map(esc).join(","));
    });
    const blob = new Blob([`# ${hostName} · ${spec.title} · ${windowText} · ${STEP_LABEL(view.step)}\n${rows.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
    const a = el("a"); a.href = URL.createObjectURL(blob);
    a.download = `${hostName}-${spec.title}-${new Date(view.x0 * 1000).toISOString().slice(0, 16)}_${new Date(view.x1 * 1000).toISOString().slice(0, 16)}.csv`.replace(/[^\w.\-]+/g, "_");
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && expanded) closeModal(); });

  // ------------------------------------------------------------ wiring
  document.querySelectorAll(".range button").forEach(b => {
    const on = b.dataset.range === range;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
    b.onclick = () => {
      range = b.dataset.range;
      store.set("status.range", range);
      document.querySelectorAll(".range button").forEach(x => { const a = x === b; x.classList.toggle("active", a); x.setAttribute("aria-pressed", String(a)); });
      writeHash();
      refresh();
    };
  });
  document.getElementById("theme").onclick = () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set("status.theme", theme);
    applyTheme();
    state.lastSig = null; render();          // charts read their colours from CSS variables
  };
  writeHash();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (theme === "auto" && state.hosts.length) { state.lastSig = null; render(); } });
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
