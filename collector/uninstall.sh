#!/usr/bin/env bash
# Remove the Reactome status collector completely (units, files, state, user).
# Run with sudo. Keep-state variant: KEEP_STATE=1 sudo ./uninstall.sh
set -euo pipefail
systemctl disable --now reactome-status-collector.timer 2>/dev/null || true
systemctl stop reactome-status-collector.service 2>/dev/null || true
rm -f /etc/systemd/system/reactome-status-collector.timer /etc/systemd/system/reactome-status-collector.service
systemctl daemon-reload
rm -rf /opt/reactome-status /etc/reactome-status
[[ "${KEEP_STATE:-}" == 1 ]] || rm -rf /var/lib/reactome-status
userdel reactome-status 2>/dev/null || true
echo "reactome-status collector removed"
