#!/bin/bash
# Install or update the Reactome watchdog. Idempotent.
#   sudo watchdog/install.sh watchdog/config/<host>.json   (first time)
#   sudo watchdog/install.sh                               (update code, keep installed config)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
SRC=$(cd "$(dirname "$0")" && pwd)
CONF=${1:-}

install -d -m 755 /opt/reactome-watchdog /etc/reactome-watchdog
install -d -m 755 /var/lib/reactome-watchdog
install -d -m 700 /var/lib/reactome-watchdog/evidence
install -m 755 "$SRC/watchdog.py" /opt/reactome-watchdog/watchdog.py
# the host config is private (git-ignored): pass it on first install; later updates keep the installed one
if [ -n "$CONF" ]; then
    if [ -f /etc/reactome-watchdog/config.json ] && ! cmp -s "$CONF" /etc/reactome-watchdog/config.json; then
        cp -a /etc/reactome-watchdog/config.json "/etc/reactome-watchdog/config.json.bak-$(date +%Y%m%d%H%M%S)"
    fi
    install -m 600 "$CONF" /etc/reactome-watchdog/config.json
elif [ ! -f /etc/reactome-watchdog/config.json ]; then
    echo "first install needs a config: sudo $0 watchdog/config/<host>.json (start from config/example.json)" >&2
    exit 1
fi
install -m 644 "$SRC/reactome-watchdog.service" "$SRC/reactome-watchdog.timer" /etc/systemd/system/

# heap dumps from -XX:+HeapDumpOnOutOfMemoryError (see jvm-tuning.sh); the watchdog keeps only the newest
if id tomcat >/dev/null 2>&1; then
    install -d -m 700 -o tomcat -g tomcat /var/tmp/tomcat-heapdumps
    # a hung Tomcat ignores SIGTERM; don't wait the default 90 s before SIGKILL
    install -d -m 755 /etc/systemd/system/tomcat.service.d
    printf '[Service]\nTimeoutStopSec=30s\n' > /etc/systemd/system/tomcat.service.d/watchdog.conf
fi

systemctl daemon-reload
echo "--- dry run (probes only, no actions)"
/usr/bin/python3 /opt/reactome-watchdog/watchdog.py -c /etc/reactome-watchdog/config.json --dry-run
systemctl enable --now reactome-watchdog.timer
echo "--- installed $(/usr/bin/python3 /opt/reactome-watchdog/watchdog.py --version)"
systemctl list-timers reactome-watchdog.timer --no-pager
echo "Logs:   journalctl -u reactome-watchdog -n 50"
echo "Pause:  sudo touch /etc/reactome-watchdog/PAUSE   (resume: sudo rm /etc/reactome-watchdog/PAUSE)"
