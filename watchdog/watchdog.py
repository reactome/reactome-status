#!/usr/bin/env python3
"""Reactome watchdog: restart a service that is running but no longer answering.

systemd already restarts a service whose process exits. It cannot see a JVM that is
alive but stuck (full-GC thrash after the heap fills, a wedged Jetty), which is how
Tomcat and Solr have actually failed. This script probes each watched service once
per run (a systemd timer runs it every minute) and, after `fail_threshold` failures
in a row, saves evidence and restarts the unit.

Safety rules:
  * a unit that is not active (stopped on purpose, or mid start/stop) is left alone
  * nothing is done within `startup_grace_s` of a unit starting (Tomcat takes minutes)
  * a service is not restarted while a service it depends on is failing
  * at most `max_restarts` per `restart_window_s`; after that it only logs
  * the file named by `pause_file` pauses all actions (use during releases/maintenance)

Python 3 standard library only. Must run as root (restarting units, thread dumps).
"""

import argparse
import glob
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

VERSION = "0.1.0"
NOW = time.time()


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    print(msg, flush=True)


def run(cmd, timeout=30):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout} s: {' '.join(cmd)}\n"
    except OSError as e:
        return None, f"{e}\n"


# ----------------------------------------------------------------------- probes

def probe(p):
    """Return (ok, detail). Never raises."""
    timeout = p.get("timeout_s", 20)
    start = time.time()
    if p["type"] == "tcp":
        try:
            with socket.create_connection((p["host"], p["port"]), timeout=timeout):
                return True, f"tcp ok in {time.time() - start:.1f} s"
        except OSError as e:
            return False, f"tcp {e}"
    req = urllib.request.Request(p["url"], headers=p.get("headers", {}))
    expect = p.get("expect_status", [200])
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read(65536)
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except (urllib.error.URLError, OSError) as e:
        return False, f"http {getattr(e, 'reason', e)} after {time.time() - start:.1f} s"
    took = time.time() - start
    if code not in expect:
        return False, f"http {code} in {took:.1f} s"
    return True, f"http {code} in {took:.1f} s"


# ----------------------------------------------------------------------- systemd

def unit_state(unit):
    rc, out = run(["systemctl", "show", unit, "-p", "ActiveState,ActiveEnterTimestampMonotonic,MainPID"])
    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    since = None
    try:
        mono = int(props.get("ActiveEnterTimestampMonotonic") or 0)
        if mono:
            since = NOW - (time.monotonic() - mono / 1e6)
    except ValueError:
        pass
    return props.get("ActiveState", "unknown"), since, int(props.get("MainPID") or 0)


def java_pid(svc, main_pid):
    """The service's JVM: the unit's main PID if it is java, else the first java process of the service user."""
    if main_pid:
        try:
            with open(f"/proc/{main_pid}/comm") as f:
                if f.read().strip() == "java":
                    return main_pid
        except OSError:
            pass
    user = svc.get("java_user")
    if user:
        rc, out = run(["pgrep", "-u", user, "-o", "java"])
        if rc == 0 and out.strip():
            return int(out.split()[0])
    return 0


# ----------------------------------------------------------------------- evidence

def save_evidence(cfg, name, svc, pid, failures):
    """Best effort: everything here may hang on a stuck JVM, so every step has a timeout."""
    d = os.path.join(cfg["evidence_dir"], f"{datetime.fromtimestamp(NOW, timezone.utc):%Y%m%dT%H%M%SZ}-{name}")
    os.makedirs(d, mode=0o700, exist_ok=True)

    def write(fname, text):
        with open(os.path.join(d, fname), "w") as f:
            f.write(text)

    write("failures.txt", "\n".join(failures) + "\n")
    write("host.txt", "".join(run(c)[1] for c in (["uptime"], ["free", "-m"], ["df", "-h", "/"])))
    if pid:
        write("top-threads.txt", run(["top", "-H", "-b", "-n", "1", "-p", str(pid)])[1][:200000])
        user = svc.get("java_user")
        jstat = cfg.get("jstat", "jstat")
        if user:
            write("jstat-gcutil.txt", run(["runuser", "-u", user, "--", jstat, "-gcutil", str(pid), "1000", "5"], 20)[1])
        # SIGQUIT makes the JVM print a thread dump to its own stdout (journal / catalina.out); it never blocks us
        try:
            os.kill(pid, 3)
            write("thread-dump.txt", f"SIGQUIT sent to {pid}: see the service's stdout log (journalctl -u {svc['unit']})\n")
        except OSError as e:
            write("thread-dump.txt", f"SIGQUIT failed: {e}\n")
    log_path = cfg.get("access_log")
    if log_path:
        write("access-log-last-10min.txt", access_summary(log_path))
    return d


def access_summary(path, max_bytes=50 * 1024 * 1024, minutes=10):
    """Top clients and paths in the last few minutes of the Apache log (stays on the host, root-only)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read().decode("utf-8", "replace").splitlines()[1:]
    except OSError as e:
        return f"cannot read {path}: {e}\n"
    cutoff = NOW - minutes * 60
    ips, paths, n = {}, {}, 0
    for line in data:
        lb = line.find("[")
        if lb < 0:
            continue
        try:
            ts = datetime.strptime(line[lb + 1:lb + 27], "%d/%b/%Y:%H:%M:%S %z").timestamp()
        except ValueError:
            continue
        if ts < cutoff:
            continue
        n += 1
        ip = line.split(" ", 1)[0]
        ips[ip] = ips.get(ip, 0) + 1
        q = line.find('"', lb)
        parts = line[q + 1:line.find('"', q + 1)].split(" ")
        if len(parts) > 1:
            p = parts[1].split("?", 1)[0]
            paths[p] = paths.get(p, 0) + 1
    top = lambda d: "".join(f"{c:8d} {k}\n" for k, c in sorted(d.items(), key=lambda x: -x[1])[:25])
    return f"requests in last {minutes} min: {n}\n\n--- top clients\n{top(ips)}\n--- top paths\n{top(paths)}"


def prune(cfg):
    for rule in cfg.get("prune", []):
        files = sorted(glob.glob(rule["glob"]), key=os.path.getmtime, reverse=True)
        for f in files[rule.get("keep", 1):]:
            try:
                if os.path.isdir(f):
                    subprocess.run(["rm", "-rf", "--", f], timeout=60)
                else:
                    os.remove(f)
                log(f"pruned {f}")
            except (OSError, subprocess.TimeoutExpired) as e:
                log(f"prune failed for {f}: {e}")


# ----------------------------------------------------------------------- restart

def restart(svc, pid):
    """systemctl restart; if the stop hangs or fails, SIGKILL the JVM and start again."""
    unit = svc["unit"]
    rc, out = run(["systemctl", "restart", unit], svc.get("restart_timeout_s", 180))
    if rc == 0:
        return "restarted"
    log(f"{unit}: systemctl restart failed ({out.strip()[:300]}); killing and starting")
    if pid:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
    run(["systemctl", "kill", "--kill-whom=all", "--signal=SIGKILL", unit], 30)
    time.sleep(5)
    rc, out = run(["systemctl", "start", unit], svc.get("restart_timeout_s", 180))
    return "killed and started" if rc == 0 else f"start failed: {out.strip()[:300]}"


# ----------------------------------------------------------------------- main

def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def event(cfg, ev):
    """Append-only event log, no client data: safe for the status collector to read later."""
    ev = {"ts": iso(NOW), **ev}
    with open(os.path.join(cfg["state_dir"], "events.jsonl"), "a") as f:
        f.write(json.dumps(ev) + "\n")
    os.chmod(os.path.join(cfg["state_dir"], "events.jsonl"), 0o644)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-c", "--config", default="/etc/reactome-watchdog/config.json")
    ap.add_argument("--dry-run", action="store_true", help="probe and report, never restart or write state")
    ap.add_argument("--version", action="version", version=VERSION)
    args = ap.parse_args()
    if os.geteuid() != 0 and not args.dry_run:
        sys.exit("must run as root (or use --dry-run)")

    cfg = load_json(args.config, None)
    if cfg is None:
        sys.exit(f"cannot read config {args.config}")
    dry = args.dry_run or cfg.get("dry_run", False)
    if not args.dry_run:
        os.makedirs(cfg["state_dir"], mode=0o755, exist_ok=True)
        os.makedirs(cfg["evidence_dir"], mode=0o700, exist_ok=True)
    state_path = os.path.join(cfg["state_dir"], "state.json")
    state = load_json(state_path, {}) if not args.dry_run else {}
    paused = os.path.exists(cfg.get("pause_file", "/nonexistent"))

    # probe everything first so dependencies are known before any action
    health = {}
    for name, svc in cfg["services"].items():
        fails = []
        for p in svc["probes"]:
            ok, detail = probe(p)
            if not ok:
                fails.append(f"{p.get('name', p.get('url', p.get('port')))}: {detail}")
        health[name] = fails

    for name, svc in cfg["services"].items():
        st = state.setdefault(name, {"failures": 0, "restarts": []})
        fails = health[name]
        active, since, main_pid = unit_state(svc["unit"])
        if not fails:
            if args.dry_run:
                log(f"{name}: ok (unit {active})")
            if st["failures"]:
                log(f"{name}: healthy again after {st['failures']} failed check(s)")
                if st["failures"] >= svc.get("fail_threshold", 3) and not dry:
                    event(cfg, {"service": name, "kind": "recovered"})
            st["failures"] = 0
            continue
        st["failures"] += 1
        log(f"{name}: check failed {st['failures']}x ({'; '.join(fails)}); unit {active}")

        if not svc.get("restart", True):
            continue
        if st["failures"] < svc.get("fail_threshold", 3):
            continue
        if active != "active":
            log(f"{name}: unit is {active}, not acting (stopped on purpose or in transition)")
            continue
        if since and NOW - since < svc.get("startup_grace_s", 600):
            log(f"{name}: started {int(NOW - since)} s ago, inside startup grace; waiting")
            continue
        blocked = [d for d in svc.get("requires", []) if health.get(d)]
        if blocked:
            log(f"{name}: not restarting while dependency {', '.join(blocked)} is failing")
            continue
        window = svc.get("restart_window_s", 3600)
        st["restarts"] = [t for t in st["restarts"] if NOW - t < window]
        if len(st["restarts"]) >= svc.get("max_restarts", 2):
            log(f"{name}: {len(st['restarts'])} restarts in the last {window} s; giving up until the window passes")
            if not dry and not st.get("gave_up"):
                event(cfg, {"service": name, "kind": "gave_up", "restarts_in_window": len(st["restarts"])})
            st["gave_up"] = True
            continue
        st["gave_up"] = False
        if paused:
            log(f"{name}: would restart, but {cfg['pause_file']} exists (paused)")
            continue
        if dry:
            log(f"{name}: DRY RUN, would save evidence and restart {svc['unit']}")
            continue

        pid = java_pid(svc, main_pid)
        evdir = save_evidence(cfg, name, svc, pid, fails)
        log(f"{name}: evidence in {evdir}; restarting {svc['unit']}")
        outcome = restart(svc, pid)
        log(f"{name}: {outcome}")
        st["restarts"].append(NOW)
        st["failures"] = 0
        event(cfg, {"service": name, "kind": "auto_restart", "unit": svc["unit"],
                    "failed_checks": len(fails), "outcome": outcome})

    if not args.dry_run:
        save_json(state_path, state)
        prune(cfg)


if __name__ == "__main__":
    main()
