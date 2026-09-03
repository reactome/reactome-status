#!/usr/bin/env bash
# Install or update the Reactome status collector on a production host.
# Run with sudo from a checkout of the repo:
#   sudo ./collector/install.sh collector/config/reactome.org.json
set -euo pipefail

CONFIG_SRC="${1:?usage: install.sh <path to host config json>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVC_USER=reactome-status

# Dedicated user AND group. Read access to the Apache log directory is granted with a narrow
# ACL instead of membership of the site's group, which would also expose group-readable
# files such as the CMS configuration (database credentials).
getent group "$SVC_USER" >/dev/null || groupadd --system "$SVC_USER"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/reactome-status --shell /usr/sbin/nologin \
          --gid "$SVC_USER" "$SVC_USER"
  echo "created user $SVC_USER"
else
  usermod -g "$SVC_USER" -G "" "$SVC_USER"     # drop any earlier group memberships (reactome, adm, docker)
fi

LOG_PATH=$(python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("access_log") or {}).get("path",""))' "$CONFIG_SRC")
if [[ -n "$LOG_PATH" ]]; then
  LOG_DIR=$(dirname "$LOG_PATH")
  if command -v setfacl >/dev/null; then
    setfacl -m "u:$SVC_USER:rx" "$LOG_DIR"                 # traverse + list the directory
    setfacl -d -m "u:$SVC_USER:r" "$LOG_DIR"               # files created later (log rotation) inherit read
    find "$LOG_DIR" -maxdepth 1 -type f -exec setfacl -m "u:$SVC_USER:r" {} +
    echo "granted $SVC_USER read access to $LOG_DIR via ACL"
  else
    echo "WARNING: setfacl not available; add $SVC_USER to the log directory's group manually" >&2
  fi
fi

# pause the timer while files are replaced so a scheduled run cannot start mid-copy
systemctl stop reactome-status-collector.timer 2>/dev/null || true
while [[ "$(systemctl show -p ActiveState --value reactome-status-collector.service 2>/dev/null)" == "activating" ]]; do sleep 1; done

install -d -o root -g root -m 755 /opt/reactome-status /etc/reactome-status
install -o root -g root -m 755 "$HERE/collector.py" /opt/reactome-status/collector.py
if [[ -f /etc/reactome-status/config.json ]] && ! cmp -s "$CONFIG_SRC" /etc/reactome-status/config.json; then
  cp -p /etc/reactome-status/config.json "/etc/reactome-status/config.json.bak-$(date +%s)"
  echo "NOTE: the installed config differed from $CONFIG_SRC; the old one was kept as config.json.bak-*"
fi
install -o root -g root -m 644 "$CONFIG_SRC" /etc/reactome-status/config.json
install -d -o "$SVC_USER" -g "$SVC_USER" -m 750 /var/lib/reactome-status
chown -R "$SVC_USER:$SVC_USER" /var/lib/reactome-status

install -m 644 "$HERE/reactome-status-collector.service" /etc/systemd/system/
install -m 644 "$HERE/reactome-status-collector.timer"   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now reactome-status-collector.timer

echo "To remove everything later: sudo $HERE/uninstall.sh"
echo "running once now..."
systemctl start reactome-status-collector.service || echo "FIRST RUN FAILED - see the journal lines below" >&2
echo "installed version: $(grep -oE 'VERSION = "[0-9.]+"' /opt/reactome-status/collector.py | tr -d '\"' | cut -d= -f2)"
systemctl status --no-pager reactome-status-collector.timer | head -5
journalctl -u reactome-status-collector.service -n 5 --no-pager
