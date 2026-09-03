#!/usr/bin/env python3
"""Reactome status collector.

Runs every few minutes (systemd timer) on a production host, gathers a health
snapshot and uploads it to S3 for the static status page.  Standard library
only; uploads use the AWS CLI already present on the hosts.

Outputs written under s3://<bucket>/<prefix>/ :
  latest.json            current snapshot (short cache)
  series/24h.json        5-min points for the last 24 h
  series/7d.json         30-min points for the last 7 d
  series/90d.json        6-h points for the last 90 d
  events.json            service restarts (with time-to-healthy) for 90 d
and under s3://<bucket>/raw/<host>/YYYY/MM/DD/HHMM.json an immutable archive
of every snapshot (expired by an S3 lifecycle rule).

Only aggregates leave the host: no client IPs, user agents or URLs.
"""
import argparse
import json
import os
import re
import socket
import ssl
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

VERSION = "0.4.0"
NOW = time.time()
STATE = {}   # previous run's state, loaded in main()


def log(msg):
    print(f"[collector] {msg}", file=sys.stderr, flush=True)


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(cmd, timeout=20):
    try:
        env = {**os.environ, "TZ": "UTC", "LC_ALL": "C"}  # systemctl prints timestamps in TZ; keep them UTC
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return p.returncode, p.stdout, p.stderr
    except (OSError, subprocess.TimeoutExpired) as e:
        return 255, "", str(e)


# --------------------------------------------------------------------------- host

def host_metrics():
    m = {}
    try:
        with open("/proc/loadavg") as f:
            l1, l5, l15 = f.read().split()[:3]
        m["load"] = [float(l1), float(l5), float(l15)]
    except OSError:
        pass
    m["cpus"] = os.cpu_count()
    try:
        mem = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                mem[k] = int(v.strip().split()[0]) * 1024
        total = mem["MemTotal"]
        avail = mem.get("MemAvailable", mem["MemFree"])
        m["mem_total"] = total
        m["mem_used_pct"] = round(100.0 * (total - avail) / total, 1)
        if mem.get("SwapTotal"):
            m["swap_used_pct"] = round(100.0 * (mem["SwapTotal"] - mem["SwapFree"]) / mem["SwapTotal"], 1)
    except (OSError, KeyError):
        pass
    try:
        with open("/proc/uptime") as f:
            up = float(f.read().split()[0])
        m["uptime_s"] = int(up)
        m["boot_time"] = iso(NOW - up)
    except OSError:
        pass
    disks = {}
    for path in CONFIG.get("disks", ["/"]):
        try:
            st = os.statvfs(path)
            total = st.f_blocks * st.f_frsize
            free = st.f_bavail * st.f_frsize
            disks[path] = {"total": total, "used_pct": round(100.0 * (total - free) / total, 1)}
        except OSError:
            pass
    m["disks"] = disks
    return m


# ----------------------------------------------------------------------- services

TRANSIENT_STATES = {"activating", "deactivating", "reloading"}


def systemd_units(units):
    out = {}
    for u in units:
        props = _unit_props(u)
        # a unit caught mid-restart is not an outage: give it a few seconds to settle before recording
        for _ in range(4):
            if props.get("ActiveState") not in TRANSIENT_STATES:
                break
            time.sleep(5)
            props = _unit_props(u)
        if not props:
            # systemctl itself failed (timeout, D-Bus hiccup): report unknown rather than an outage,
            # keeping the previously known start time so no false restart is recorded later
            prev = (STATE.get("services") or {}).get(u) or {}
            out[u] = {"type": "systemd", "state": "unknown", "sub": "", "up": bool(prev.get("up", True)),
                      "since": prev.get("since"), "restarts": 0, "unknown": True}
            log(f"systemctl show {u} failed; carrying previous state forward")
            continue
        since = props.get("ExecMainStartTimestamp") or props.get("ActiveEnterTimestamp") or ""
        out[u] = {
            "type": "systemd",
            "state": props.get("ActiveState", "unknown"),
            "sub": props.get("SubState", ""),
            "up": props.get("ActiveState") == "active",
            "since": _systemd_ts(since),
            "restarts": int(props.get("NRestarts") or 0),
        }
    return out


def _unit_props(unit):
    rc, so, _ = run(["systemctl", "show", unit, "-p",
                     "ActiveState,SubState,ActiveEnterTimestamp,ExecMainStartTimestamp,NRestarts"])
    if rc != 0:
        return {}
    return dict(line.split("=", 1) for line in so.splitlines() if "=" in line)


def _systemd_ts(s):
    # e.g. "Tue 2026-09-01 06:12:52 UTC"
    if not s:
        return None
    try:
        dt = datetime.strptime(s, "%a %Y-%m-%d %H:%M:%S %Z")
        return dt.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return s


def docker_containers(names):
    if not names:
        return {}
    rc, so, _ = run(["docker", "inspect", "-f", "{{.Name}}\t{{.State.Status}}\t{{.State.StartedAt}}\t{{.RestartCount}}"] + names)
    out = {n: {"type": "docker", "state": "missing", "up": False, "since": None, "restarts": 0} for n in names}
    for line in so.splitlines():
        parts = line.split("\t")
        if len(parts) != 4:
            continue
        name = parts[0].lstrip("/")
        started = parts[2][:19] + "Z" if parts[2] else None
        out[name] = {"type": "docker", "state": parts[1], "up": parts[1] == "running",
                     "since": started, "restarts": int(parts[3] or 0)}
    return out


# ------------------------------------------------------------------------- probes

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Report the service's own answer (3xx included) instead of following redirects, which could
    otherwise lead a localhost probe out through the public site."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)
_OPENER_INSECURE = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))


def http_probes(probes):
    out = {}
    for p in probes:
        t0 = time.monotonic()
        res = {"url": p["url"], "ok": False, "status": None, "ms": None}
        try:
            headers = {"User-Agent": "reactome-status-collector", **p.get("headers", {})}
            req = urllib.request.Request(p["url"], headers=headers)
            opener = _OPENER_INSECURE if p.get("insecure") else _OPENER
            with opener.open(req, timeout=p.get("timeout", 10)) as r:
                body = r.read(65536)
                res["status"] = r.status
                expect = p.get("expect_status", [200])
                res["ok"] = r.status in expect
                if p.get("expect_text") and p["expect_text"] not in body.decode("utf-8", "replace"):
                    res["ok"] = False
                if p.get("capture_body"):
                    res["body"] = body.decode("utf-8", "replace").strip()[:200]
        except urllib.error.HTTPError as e:
            res["status"] = e.code
            res["ok"] = e.code in p.get("expect_status", [200])
        except Exception as e:  # noqa: BLE001
            res["error"] = type(e).__name__
        res["ms"] = round((time.monotonic() - t0) * 1000, 1)
        out[p["name"]] = res
    return out


def tcp_probes(probes):
    out = {}
    for p in probes:
        t0 = time.monotonic()
        res = {"host": p["host"], "port": p["port"], "ok": False, "ms": None}
        try:
            with socket.create_connection((p["host"], p["port"]), timeout=p.get("timeout", 5)):
                res["ok"] = True
        except OSError as e:
            res["error"] = type(e).__name__
        res["ms"] = round((time.monotonic() - t0) * 1000, 1)
        out[p["name"]] = res
    return out


def apache_status(url):
    if not url:
        return None
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            text = r.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": type(e).__name__}
    kv = {}
    for line in text.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            kv[k.strip()] = v.strip()
    def num(k, cast=float):
        try:
            return cast(kv[k])
        except (KeyError, ValueError):
            return None
    return {
        "ok": True,
        "uptime_s": num("ServerUptimeSeconds", int),
        "total_accesses": num("Total Accesses", int),
        "req_per_sec": num("ReqPerSec"),
        "bytes_per_sec": num("BytesPerSec"),
        "duration_per_req_ms": num("DurationPerReq"),
        "busy_workers": num("BusyWorkers", int),
        "idle_workers": num("IdleWorkers", int),
        "conns_total": num("ConnsTotal", int),
        "version": kv.get("ServerVersion", "").split(" ")[0] or None,
    }


# --------------------------------------------------------------------- access log

# Reactome's "combined_format":
# %a %l %u %t "%r" %s %b "%{Referer}i" "%{User-Agent}i" "%{CONTENT-LENGTH}i" "%{cookie}n" %I %{ms}T
# Parsed with a linear scan rather than a regex: the request line is client-controlled and a
# backtracking regex could be made to take tens of seconds per line (ReDoS); the scan also
# honours Apache's escaping so an embedded \" cannot spoof the status or size fields.
MAX_LINE_BYTES = 16 * 1024


def parse_line(line):
    """Return (path, status, bytes, ms) or None if the line is not in the expected format."""
    if len(line) > MAX_LINE_BYTES:
        return None
    i = line.find('] "')
    if i < 0:
        return None
    j = i + 3                      # first char of the request line
    n = len(line)
    k = j
    while k < n:                    # find the closing quote, skipping backslash escapes
        c = line[k]
        if c == "\\":
            k += 2
            continue
        if c == '"':
            break
        k += 1
    if k >= n:
        return None
    req = line[j:k]
    rest = line[k + 1:].split(" ", 3)      # ['', status, bytes, remainder]
    if len(rest) < 3 or rest[0] != "":
        return None
    status_s, bytes_s = rest[1], rest[2]
    if len(status_s) != 3 or not (status_s.isascii() and status_s.isdigit()):
        return None
    status = int(status_s)
    nbytes = int(bytes_s) if (bytes_s.isascii() and bytes_s.isdigit()) else 0
    # %I and %{ms}T are the last two server-generated fields
    tail = line.rstrip("\n").rsplit(" ", 2)
    ms = None
    if len(tail) == 3 and tail[2].isascii() and tail[2].isdigit() and tail[1].isascii() and tail[1].isdigit():
        ms = int(tail[2])
    parts = req.split(" ", 2)
    path = parts[1] if len(parts) >= 2 else ""
    return path, status, nbytes, ms


def _find_by_inode(directory, inode):
    if not inode:
        return None
    try:
        for entry in os.scandir(directory):
            try:
                if entry.is_file(follow_symlinks=False) and entry.stat().st_ino == inode:
                    return entry.path
            except OSError:
                continue
    except OSError:
        pass
    return None


def percentile(sorted_vals, pct):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return round(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo), 1)


def new_group():
    return {"hits": 0, "s2xx": 0, "s3xx": 0, "s4xx": 0, "s5xx": 0, "bytes": 0, "_ms": []}


def finish_group(g):
    ms = sorted(g.pop("_ms"))
    g["p50_ms"] = percentile(ms, 0.50)
    g["p95_ms"] = percentile(ms, 0.95)
    g["max_ms"] = ms[-1] if ms else None
    return g


def access_log_stats(cfg, state):
    """Parse only the bytes appended since the last run (rotation-safe)."""
    if not cfg:
        return None
    path = cfg["path"]
    groups_cfg = [(name, re.compile(rx)) for name, rx in cfg.get("groups", {}).items()]
    max_bytes = cfg.get("max_bytes_per_run", 200 * 1024 * 1024)
    result = {"ok": True, "path": path, "groups": {}}
    try:
        st = os.stat(path)
    except OSError as e:
        log(f"access log unreadable: {path}: {e}")
        return {"ok": False, "error": type(e).__name__}

    prev = state.get("access_log") or {}
    offset = prev.get("offset", None)
    carry_path, carry_offset = None, 0  # rotated-away file whose tail still belongs to this window
    if offset is None:
        # first run: start from the current end; nothing to report for this run
        state["access_log"] = {"inode": st.st_ino, "offset": st.st_size, "ts": NOW}
        result["note"] = "first run; window skipped"
        result["window_s"] = 0
        return result
    if prev.get("inode") != st.st_ino:
        # rotated: finish reading the old file (same inode, new name, not yet compressed) then start at 0
        old_path = _find_by_inode(os.path.dirname(path), prev.get("inode"))
        if st.st_size > 64 * 1024 * 1024:
            # a freshly rotated log is small; a large "new" file means our state is stale, not a rotation
            result["note"] = "inode changed but file is large; window skipped"
            state["access_log"] = {"inode": st.st_ino, "offset": st.st_size, "ts": NOW}
            result["window_s"] = 0
            return result
        # only trust a same-directory sibling that is at least as long as where we left off
        if old_path and os.path.basename(old_path).startswith(os.path.basename(path)):
            try:
                if os.stat(old_path).st_size >= offset:
                    carry_path, carry_offset = old_path, offset
                    result["note"] = "rotated; finished reading the previous file"
                else:
                    result["note"] = "rotated; previous file shorter than expected, its tail was skipped"
            except OSError:
                result["note"] = "rotated; previous file unreadable"
        else:
            result["note"] = "rotated; previous file not found, its tail was skipped"
        offset = 0
    elif st.st_size < offset:
        offset = 0  # truncated in place
        result["note"] = "log truncated; reading from start"

    to_read = st.st_size - offset
    if to_read > max_bytes:
        result["note"] = f"skipped {to_read - max_bytes} bytes"
        offset = st.st_size - max_bytes

    total = new_group()
    groups = {name: new_group() for name, _ in groups_cfg}
    groups["other"] = new_group()
    codes = {}
    parsed = skipped = 0
    def _consume(raw):
        nonlocal parsed, skipped
        try:
            parsed_line = parse_line(raw.decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001 - a single odd line must never take the run down
            parsed_line = None
        if parsed_line is None:
            skipped += 1
            return
        parsed += 1
        path_, status, nbytes, ms = parsed_line
        klass = f"s{status // 100}xx" if 2 <= status // 100 <= 5 else None
        target = groups["other"]
        for name, rx in groups_cfg:
            if rx.search(path_):
                target = groups[name]
                break
        for g in (total, target):
            g["hits"] += 1
            if klass:
                g[klass] += 1
            g["bytes"] += nbytes
            if ms is not None:
                g["_ms"].append(ms)
        codes[status] = codes.get(status, 0) + 1

    try:
        if carry_path:
            with open(carry_path, "rb") as f:   # streamed, never loaded whole
                f.seek(carry_offset)
                budget = max_bytes
                for raw in f:
                    budget -= len(raw)
                    if budget < 0 or not raw.endswith(b"\n"):
                        break
                    _consume(raw)

        with open(path, "rb") as f:
            f.seek(offset)
            if result.get("note", "").startswith("skipped"):
                offset += len(f.readline())  # discard the partial line we landed in
            for raw in f:
                if not raw.endswith(b"\n"):
                    break  # partial last line, leave for next run
                offset += len(raw)
                _consume(raw)
    except OSError as e:
        log(f"access log read failed: {e}")
        return {"ok": False, "error": type(e).__name__}

    state["access_log"] = {"inode": st.st_ino, "offset": offset, "ts": NOW}
    result["window_s"] = int(NOW - prev.get("ts", NOW)) if prev.get("ts") else None
    result["parsed"] = parsed
    result["unparsed"] = skipped
    result["total"] = finish_group(total)
    result["groups"] = {k: finish_group(v) for k, v in groups.items()}
    result["status_codes"] = {str(k): v for k, v in sorted(codes.items())}
    return result


# ------------------------------------------------------------------------ events

def detect_restarts(services, probes, state, events):
    """Emit a restart event when a service's start time changes and, when a
    probe for it exists, record how long until the probe first passed."""
    prev = state.get("services") or {}
    pending = state.get("pending_recovery") or {}
    expected = set(CONFIG.get("expected_restarts", []))
    for name, svc in services.items():
        old = prev.get(name)
        if name in expected and svc.get("up"):
            # scheduled restarts (e.g. Apache's half-hourly cron) are not events, but a recovery
            # after a recorded outage still is, so "went down" always gets its closing entry
            if old is not None and not old.get("up"):
                events.append({"ts": iso(NOW), "service": name, "kind": "healthy", "started_at": svc.get("since"),
                               "healthy_within_s": None, "note": "back up after an outage"})
            pending.pop(name, None)
            continue
        if old is not None and svc.get("since") and old.get("since") != svc["since"]:
            ev = {"ts": iso(NOW), "service": name, "kind": "restart",
                  "started_at": svc["since"], "previous_start": old.get("since")}
            events.append(ev)
            pending[name] = svc["since"]
            log(f"restart detected: {name} started {svc['since']}")
        if old is not None and old.get("up") and not svc.get("up"):
            events.append({"ts": iso(NOW), "service": name, "kind": "down", "state": svc.get("state")})
    # recovery timing
    for name, since in list(pending.items()):
        probe_name = CONFIG.get("service_probe", {}).get(name)
        probe = probes.get(probe_name) if probe_name else None
        svc = services.get(name, {})
        healthy = probe["ok"] if probe else svc.get("up")
        if healthy:
            try:
                t_start = datetime.strptime(since, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
                took = int(NOW - t_start)
            except (ValueError, TypeError):
                took = None
            events.append({"ts": iso(NOW), "service": name, "kind": "healthy",
                           "started_at": since, "healthy_within_s": took,
                           "note": f"healthy at first check after restart (checks every {CONFIG.get('interval_seconds', 300)} s)"})
            del pending[name]
    state["pending_recovery"] = pending
    state["services"] = {k: {"since": v.get("since"), "up": v.get("up")} for k, v in services.items()}


# ----------------------------------------------------------------------- storage

def db_connect(path):
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE IF NOT EXISTS points (ts INTEGER PRIMARY KEY, json TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, json TEXT NOT NULL)")
    return db


def compact_point(snap):
    """The small per-interval record kept for time series."""
    p = {"t": int(NOW)}
    h = snap["host"]
    p["load1"] = h.get("load", [None])[0]
    p["mem"] = h.get("mem_used_pct")
    p["disk"] = (h.get("disks") or {}).get("/", {}).get("used_pct")
    p["svc"] = {k: 1 if v.get("up") else 0 for k, v in snap["services"].items()}
    p["probe_ms"] = {k: (v["ms"] if v.get("ok") else None) for k, v in snap["probes"].items()}
    p["probe_ok"] = {k: 1 if v.get("ok") else 0 for k, v in snap["probes"].items()}
    a = snap.get("apache") or {}
    if a.get("ok"):
        p["busy"] = a.get("busy_workers")
        p["idle"] = a.get("idle_workers")
    lg = snap.get("access_log") or {}
    if lg.get("ok") and lg.get("window_s"):
        p["win"] = lg["window_s"]
        p["log"] = {}
        for name, g in lg["groups"].items():
            p["log"][name] = [g["hits"], g["s2xx"], g["s3xx"], g["s4xx"], g["s5xx"], g["p50_ms"], g["p95_ms"]]
        t = lg["total"]
        p["log"]["_total"] = [t["hits"], t["s2xx"], t["s3xx"], t["s4xx"], t["s5xx"], t["p50_ms"], t["p95_ms"]]
    return p


def rollup(db, seconds, bucket):
    """Average numeric fields per `bucket` seconds over the last `seconds`."""
    since = int(NOW) - seconds
    rows = db.execute("SELECT ts, json FROM points WHERE ts >= ? ORDER BY ts", (since,)).fetchall()
    if bucket <= CONFIG.get("interval_seconds", 300):
        return [json.loads(j) for _, j in rows]
    buckets = {}
    for ts, j in rows:
        buckets.setdefault(ts - ts % bucket, []).append(json.loads(j))
    out = []
    for b, pts in sorted(buckets.items()):
        out.append(_merge_points(b, pts))
    return out


def _avg(vals):
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


def _merge_points(t, pts):
    # t is the bucket start; t0/t1 are the first and last real samples inside it, so the page
    # can compute "expected samples" from real coverage rather than from bucket boundaries
    m = {"t": t, "n": len(pts), "t0": min(p["t"] for p in pts), "t1": max(p["t"] for p in pts)}
    for k in ("load1", "mem", "disk", "busy", "idle"):
        m[k] = _avg([p.get(k) for p in pts])
    m["svc"] = {}
    for k in {k for p in pts for k in p.get("svc", {})}:
        m["svc"][k] = round(_avg([p["svc"].get(k) for p in pts if k in p.get("svc", {})]) or 0, 2)
    m["probe_ok"] = {}
    m["probe_ms"] = {}
    for k in {k for p in pts for k in p.get("probe_ok", {})}:
        m["probe_ok"][k] = round(_avg([p["probe_ok"].get(k) for p in pts if k in p.get("probe_ok", {})]) or 0, 2)
        m["probe_ms"][k] = _avg([p.get("probe_ms", {}).get(k) for p in pts])
    logs = [p for p in pts if p.get("log")]
    if logs:
        m["win"] = sum(p.get("win") or 0 for p in logs)
        m["log"] = {}
        for k in {k for p in logs for k in p["log"]}:
            rows = [p["log"][k] for p in logs if k in p["log"]]
            hits = sum(r[0] for r in rows)
            m["log"][k] = [hits, sum(r[1] for r in rows), sum(r[2] for r in rows), sum(r[3] for r in rows),
                           sum(r[4] for r in rows),
                           _weighted([(r[5], r[0]) for r in rows]), _weighted([(r[6], r[0]) for r in rows])]
    return m


def _weighted(pairs):
    pairs = [(v, w) for v, w in pairs if v is not None and w]
    if not pairs:
        return None
    return round(sum(v * w for v, w in pairs) / sum(w for _, w in pairs), 1)


# ------------------------------------------------------------------------ upload

def s3_sync(local_dir, s3_uri, cache_control, excludes=()):
    cmd = ["aws", "s3", "sync", "--only-show-errors", local_dir, s3_uri,
           "--content-type", "application/json", "--cache-control", cache_control]
    for e in excludes:
        cmd += ["--exclude", e]
    if CONFIG.get("aws_region"):
        cmd += ["--region", CONFIG["aws_region"]]
    rc, so, se = run(cmd, timeout=60)
    if rc != 0:
        log(f"upload failed for {s3_uri}: {se.strip()}")
    return rc == 0


def prune_raw(raw_dir, keep_days=2):
    """Local raw snapshots only need to live until they have been synced."""
    cutoff = NOW - keep_days * 86400
    for root, dirs, files in os.walk(raw_dir, topdown=False):
        for f in files:
            fp = os.path.join(root, f)
            try:
                if os.stat(fp).st_mtime < cutoff:
                    os.remove(fp)
            except OSError:
                pass
        for d in dirs:
            try:
                os.rmdir(os.path.join(root, d))  # only succeeds when empty
            except OSError:
                pass


# -------------------------------------------------------------------------- main

def main():
    global CONFIG
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-c", "--config", required=True, help="path to host config JSON")
    ap.add_argument("--no-upload", action="store_true", help="write files locally only")
    ap.add_argument("--print", action="store_true", help="print the snapshot to stdout")
    args = ap.parse_args()

    with open(args.config) as f:
        CONFIG = json.load(f)
    state_dir = CONFIG.get("state_dir", "/var/lib/reactome-status")
    os.makedirs(state_dir, exist_ok=True)
    out_dir = os.path.join(state_dir, "out")
    os.makedirs(os.path.join(out_dir, "series"), exist_ok=True)
    state_path = os.path.join(state_dir, "state.json")
    global STATE
    try:
        with open(state_path) as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    STATE = state

    services = {}
    services.update(systemd_units(CONFIG.get("systemd_units", [])))
    services.update(docker_containers(CONFIG.get("docker_containers", [])))
    probes = {}
    probes.update(http_probes(CONFIG.get("http_probes", [])))
    probes.update(tcp_probes(CONFIG.get("tcp_probes", [])))

    snap = {
        "schema": 1,
        "collector_version": VERSION,
        "host": {"name": CONFIG["host"], **host_metrics()},
        "generated_at": iso(NOW),
        "interval_seconds": CONFIG.get("interval_seconds", 300),
        "services": services,
        "probes": probes,
        "apache": apache_status(CONFIG.get("apache_status_url")),
        "access_log": access_log_stats(CONFIG.get("access_log"), state),
    }
    snap["ok"] = all(s["up"] for s in services.values()) and all(p["ok"] for p in probes.values())

    events = []
    detect_restarts(services, probes, state, events)

    # persist the log offset and service state now, before anything that could be slow or fail:
    # a killed run must never re-count the same log window
    with open(state_path + ".tmp", "w") as f:
        json.dump(state, f)
    os.replace(state_path + ".tmp", state_path)
    # everything below is published on a public page: keep only what a reader needs
    for pr in snap["probes"].values():
        pr["kind"] = "tcp" if "port" in pr else "http"
        for k in ("url", "host", "port"):
            pr.pop(k, None)
    if snap.get("apache"):
        snap["apache"].pop("version", None)
    if snap.get("access_log"):
        snap["access_log"].pop("path", None)

    db = db_connect(os.path.join(state_dir, "points.sqlite"))
    with db:
        db.execute("INSERT OR REPLACE INTO points (ts, json) VALUES (?, ?)", (int(NOW), json.dumps(compact_point(snap))))
        for ev in events:
            db.execute("INSERT INTO events (ts, json) VALUES (?, ?)", (int(NOW), json.dumps(ev)))
        db.execute("DELETE FROM points WHERE ts < ?", (int(NOW) - 91 * 86400,))
        db.execute("DELETE FROM events WHERE ts < ?", (int(NOW) - 91 * 86400,))

    all_events = [json.loads(j) for (j,) in db.execute("SELECT json FROM events ORDER BY ts DESC LIMIT 500")]
    snap["recent_events"] = all_events[:20]

    files = {
        "latest.json": (snap, "max-age=60"),
        "series/24h.json": ({"host": CONFIG["host"], "step_s": 300, "generated": int(NOW), "points": rollup(db, 86400, 300)}, "max-age=120"),
        "events.json": ({"host": CONFIG["host"], "events": all_events}, "max-age=120"),
    }
    # the coarse series change slowly and cost a full history scan: rebuild them every 30 min,
    # or whenever the file is missing
    run_no = int(NOW) // CONFIG.get("interval_seconds", 300)
    for rel, span, step in (("series/7d.json", 7 * 86400, 1800), ("series/90d.json", 90 * 86400, 21600)):
        if run_no % 6 == 0 or not os.path.exists(os.path.join(out_dir, rel)):
            files[rel] = ({"host": CONFIG["host"], "step_s": step, "generated": int(NOW), "points": rollup(db, span, step)}, None)
    raw_rel = datetime.fromtimestamp(NOW, tz=timezone.utc).strftime("raw/%Y/%m/%d/%H%M.json")
    files[raw_rel] = (snap, None)
    for rel, (obj, _) in files.items():
        local = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(local), exist_ok=True)
        with open(local, "w") as f:
            json.dump(obj, f, separators=(",", ":"))
    prune_raw(os.path.join(out_dir, "raw"))

    upload_ok = True
    if not args.no_upload:
        bucket = CONFIG["s3_bucket"]
        prefix = CONFIG["s3_prefix"].strip("/")
        raw_prefix = CONFIG.get("s3_raw_prefix", f"raw/{CONFIG['host']}").strip("/")
        # two calls instead of one per file: live files (short cache) and the immutable raw archive
        upload_ok = s3_sync(out_dir, f"s3://{bucket}/{prefix}/", "max-age=60", excludes=["raw/*"])
        upload_ok = s3_sync(os.path.join(out_dir, "raw"), f"s3://{bucket}/{raw_prefix}/", "max-age=31536000, immutable") and upload_ok

    if args.print:
        json.dump(snap, sys.stdout, indent=2)
        print()
    log(f"done: ok={snap['ok']} services={sum(s['up'] for s in services.values())}/{len(services)} "
        f"probes={sum(p['ok'] for p in probes.values())}/{len(probes)} "
        f"log_hits={(snap['access_log'] or {}).get('total', {}).get('hits')}"
        + ("" if upload_ok else " UPLOAD FAILED"))
    if not upload_ok:
        sys.exit(1)   # make the failure visible in systemctl status / journal


if __name__ == "__main__":
    main()
