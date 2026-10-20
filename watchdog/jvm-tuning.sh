#!/bin/bash
# Phase 0 JVM settings for Tomcat and Solr. Edits config only; restarts nothing.
#   sudo ./jvm-tuning.sh            show what would change
#   sudo ./jvm-tuning.sh apply      back up and apply; then restart each service when convenient
#
# Tomcat: 14 GB heap (was 10), exit on OutOfMemoryError so systemd's Restart=on-failure brings it
#         back in ~2 min instead of hanging, one heap dump for diagnosis, rotating GC log.
# Solr:   2 GB heap (was 512 MB).
# Settings are appended to the end of each file, so they win over earlier values (the last
# -Xmx on the java command line is the one used). Re-running is a no-op.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
MODE=${1:-show}
MARK="# --- reactome-watchdog jvm-tuning"
TOMCAT_ENV=/opt/tomcat9/bin/setenv.sh
SOLR_ENV=/etc/default/solr.in.sh
TS=$(date +%Y%m%d%H%M%S)

TOMCAT_BLOCK="$MARK (added $TS)
CATALINA_OPTS=\"\$CATALINA_OPTS -Xmx14g -XX:+ExitOnOutOfMemoryError -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/var/tmp/tomcat-heapdumps -Xlog:gc*:file=/opt/tomcat9/logs/gc.log:time,uptime:filecount=5,filesize=20M\""

if grep -qE '^[[:space:]]*SOLR_JAVA_MEM=' "$SOLR_ENV"; then
    SOLR_BLOCK="$MARK (added $TS)
SOLR_JAVA_MEM=\"-Xms2g -Xmx2g\""
else
    SOLR_BLOCK="$MARK (added $TS)
SOLR_HEAP=\"2g\""
fi

tune_file() {  # file block
    local f=$1 block=$2
    echo "=== $f"
    if [ -f "$f" ] && grep -qF "$MARK" "$f"; then echo "already tuned:"; sed -n "/$MARK/,\$p" "$f"; return; fi
    [ -f "$f" ] && { echo "current heap/opts lines:"; grep -nE 'Xm[sx]|_OPTS|SOLR_HEAP|SOLR_JAVA_MEM' "$f" | grep -v '^[0-9]*:[[:space:]]*#' || true; }
    echo "will append:"; echo "$block"
    [ "$MODE" = apply ] || return 0
    if [ -f "$f" ]; then cp -a "$f" "$f.bak-$TS"; else install -m 755 -o root -g root /dev/null "$f"; echo '#!/bin/sh' > "$f"; fi
    printf '\n%s\n' "$block" >> "$f"
    bash -n "$f" && echo "applied (backup: $f.bak-$TS)"
}

tune_file "$TOMCAT_ENV" "$TOMCAT_BLOCK"
tune_file "$SOLR_ENV" "$SOLR_BLOCK"
install -d -m 700 -o tomcat -g tomcat /var/tmp/tomcat-heapdumps
echo
free -m | sed -n 1,2p
echo "Memory: Tomcat +4 GB heap, Solr +1.5 GB. No swap on this box; check 'available' above has room."
if [ "$MODE" = apply ]; then
    echo "Now restart when convenient:  sudo systemctl restart tomcat   and   sudo systemctl restart solr"
    echo "Verify:  ps -o args= -u tomcat | grep -o -E 'Xmx[^ ]*|ExitOnOutOfMemoryError'"
else
    echo "Nothing changed. Run 'sudo $0 apply' to apply."
fi
