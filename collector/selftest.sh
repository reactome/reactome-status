#!/usr/bin/env bash
# Local self-test for collector.py: fake access log, private state dir, no uploads.
# Usage: collector/selftest.sh   (exit code 0 = all checks passed)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
check() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: expected '$3', got '$2'"; fail=1; fi; }
line() { echo "1.2.3.4 - - [$(date -u +%d/%b/%Y:%H:%M:%S) +0000] \"GET $1 HTTP/1.1\" $2 123 \"-\" \"ua\" \"-\" \"-\" 500 $3"; }
cat > "$T/cfg.json" <<JSON
{"host":"selftest","s3_bucket":"none","s3_prefix":"data/selftest","systemd_units":[],"http_probes":[],"tcp_probes":[],
 "access_log":{"path":"$T/access.log","groups":{"Website":"^/(content/|$)","CS":"^/ContentService/"}}}
JSON
run() { python3 "$HERE/collector.py" -c "$T/cfg.json" --state-dir "$T/state" --no-upload --print 2>"$T/err" \
        | python3 -c "import sys,json; a=json.load(sys.stdin)['access_log']; g=a.get('groups') or {}; t=a.get('total') or {}; print(a.get('note'),'|',t.get('hits'),'|',g.get('Website',{}).get('hits'),'|',g.get('CS',{}).get('hits'),'|',a.get('ok'),'|',a.get('error'))"; }

line / 200 1 >> "$T/access.log"
check "first run skips the window"            "$(run)" "first run; window skipped | None | None | None | True | None"
line / 200 1 >> "$T/access.log"; line "/?q=1" 200 1 >> "$T/access.log"; line /ContentService/x 200 5 >> "$T/access.log"; line "/ContentService/../content/y" 200 5 >> "$T/access.log"
check "grouping incl. homepage and normpath"  "$(run)" "None | 4 | 3 | 1 | True | None"
line /ContentService/z 500 3 >> "$T/access.log"; mv "$T/access.log" "$T/access.log.1"; line /content/new 200 2 >> "$T/access.log"
check "rotation carries the old tail"         "$(run)" "rotated; finished reading the previous file | 2 | 1 | 1 | True | None"
chmod 000 "$T/access.log"
check "unreadable log does not crash"         "$(run)" "None | None | None | None | False | PermissionError"
chmod 644 "$T/access.log"
check "no .tmp files left behind"             "$(find "$T/state/out" -name '*.tmp' | wc -l)" "0"
check "series files written"                  "$(ls "$T/state/out/series" | sort | tr '\n' ' ')" "24h.json 7d.json 90d.json "
out=$(python3 "$HERE/collector.py" -c "$T/cfg.json" --no-upload 2>&1 || true)
check "refuses --no-upload on the live dir"   "$(grep -c 'refusing a --no-upload' <<<"$out")" "1"
head -c 3000 /dev/urandom > "$T/state/points.sqlite"; line / 200 1 >> "$T/access.log"; run >/dev/null
check "corrupt sqlite quarantined"            "$(ls "$T/state" | grep -c corrupt)" "1"
# expect_text past the default 64 KiB read window needs max_bytes
mkdir "$T/www"; { head -c 70000 /dev/zero | tr '\0' ' '; echo '<h4 class="result-title">'; } > "$T/www/page.html"
python3 -u -m http.server 0 --bind 127.0.0.1 --directory "$T/www" > "$T/http.log" 2>&1 & srv=$!
port=; for _ in $(seq 50); do port=$(grep -o 'port [0-9]*' "$T/http.log" | grep -o '[0-9]*' || true); [[ -n "$port" ]] && break; sleep 0.1; done
probe() { python3 - "$HERE/collector.py" "$port" "$1" <<'PY'
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("c", sys.argv[1]); c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
p = {"name": "x", "url": f"http://127.0.0.1:{sys.argv[2]}/page.html", "expect_text": 'class="result-title"', **json.loads(sys.argv[3])}
print(c.http_probes([p])["x"]["ok"])
PY
}
check "expect_text beyond 64 KiB fails by default" "$(probe '{}')" "False"
check "expect_text found with max_bytes"           "$(probe '{"max_bytes": 262144}')" "True"
kill $srv
check "test server answered"                  "$([[ -n "$port" ]] && echo yes)" "yes"
exit $fail
