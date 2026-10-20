#!/usr/bin/env python3
"""Exercise watchdog.main() with faked probes and systemctl. No root, no real services.
   python3 selftest.py"""
import json, os, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import watchdog as w

tmp = tempfile.mkdtemp()
cfg = {"state_dir": tmp, "evidence_dir": os.path.join(tmp, "ev"), "pause_file": os.path.join(tmp, "PAUSE"),
       "services": {
           "db": {"unit": "db", "restart": False, "probes": [{"name": "db", "type": "tcp", "host": "x", "port": 1}]},
           "app": {"unit": "app", "requires": ["db"], "fail_threshold": 3, "startup_grace_s": 600,
                   "max_restarts": 2, "restart_window_s": 3600, "probes": [{"name": "app", "type": "http", "url": "u"}]}}}
cpath = os.path.join(tmp, "config.json"); json.dump(cfg, open(cpath, "w"))

world = {"db_ok": True, "app_ok": False, "active": "active", "started_ago": 7200}
calls = []
w.probe = lambda p: (world[p["name"] + "_ok"], "fake")
def fake_run(cmd, timeout=30):
    calls.append(cmd)
    if cmd[:2] == ["systemctl", "show"]:
        mono = int((time.monotonic() - world["started_ago"]) * 1e6)
        return 0, f"ActiveState={world['active']}\nActiveEnterTimestampMonotonic={mono}\nMainPID=0\n"
    if cmd[:2] == ["systemctl", "restart"]:
        world["started_ago"] = 0
        return 0, ""
    return 0, ""
w.run = fake_run
os.geteuid = lambda: 0

def tick(advance=60):
    w.NOW += advance
    world["started_ago"] += advance
    calls.clear()
    sys.argv = ["watchdog", "-c", cpath]
    w.main()
    return [c for c in calls if c[:2] == ["systemctl", "restart"]]

def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond: sys.exit(1)

check("1st failure: no restart", not tick())
check("2nd failure: no restart", not tick())
check("3rd failure: restart", tick() == [["systemctl", "restart", "app"]])
check("evidence saved", len(os.listdir(cfg["evidence_dir"])) == 1)
for _ in range(9): check("inside startup grace: no restart", not tick())
r = []
for _ in range(3): r += tick()
check("after grace, 2nd restart", len(r) == 1)
world["started_ago"] = 7200
for _ in range(5): check("max_restarts reached: no restart", not tick())
check("gave_up event", '"gave_up"' in open(os.path.join(tmp, "events.jsonl")).read())
w.NOW += 3600
world["db_ok"] = False
for _ in range(4): check("dependency failing: no restart", not tick())
world["db_ok"] = True
open(cfg["pause_file"], "w").close()
check("paused: no restart", not tick())
os.remove(cfg["pause_file"])
world["active"] = "inactive"
check("unit stopped on purpose: no restart", not tick())
world["active"] = "active"
check("unpaused, active, failing: restart", tick() == [["systemctl", "restart", "app"]])
world["app_ok"] = True; world["started_ago"] = 7200
check("healthy: no restart", not tick())
check("failure counter reset", json.load(open(os.path.join(tmp, "state.json")))["app"]["failures"] == 0)
print("all passed")
