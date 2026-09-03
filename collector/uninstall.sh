#!/usr/bin/env bash
# Remove the Reactome status collector completely (units, files, state, user).
# Run with sudo. Keep-state variant: KEEP_STATE=1 sudo ./uninstall.sh
set -euo pipefail
systemctl disable --now reactome-status-collector.timer 2>/dev/null || true
systemctl stop reactome-status-collector.service 2>/dev/null || true
rm -f /etc/systemd/system/reactome-status-collector.timer /etc/systemd/system/reactome-status-collector.service
systemctl daemon-reload
LOG_PATH=$(python3 -c 'import json; print((json.load(open("/etc/reactome-status/config.json")).get("access_log") or {}).get("path",""))' 2>/dev/null || true)
if [[ -n "${LOG_PATH:-}" ]] && command -v setfacl >/dev/null; then
  d=$(dirname "$LOG_PATH")
  setfacl -x u:reactome-status "$d" 2>/dev/null || true
  setfacl -d -x u:reactome-status "$d" 2>/dev/null || true
  find "$d" -maxdepth 1 -type f -exec setfacl -x u:reactome-status {} + 2>/dev/null || true
fi
rm -rf /opt/reactome-status /etc/reactome-status
[[ "${KEEP_STATE:-}" == 1 ]] || rm -rf /var/lib/reactome-status
userdel reactome-status 2>/dev/null || true
groupdel reactome-status 2>/dev/null || true
echo "reactome-status collector removed"
