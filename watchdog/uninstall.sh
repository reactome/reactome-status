#!/bin/bash
# Remove the watchdog. Keeps /var/lib/reactome-watchdog (events and evidence).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
systemctl disable --now reactome-watchdog.timer 2>/dev/null || true
rm -f /etc/systemd/system/reactome-watchdog.service /etc/systemd/system/reactome-watchdog.timer
rm -f /etc/systemd/system/tomcat.service.d/watchdog.conf
rm -rf /opt/reactome-watchdog
systemctl daemon-reload
echo "removed; config left in /etc/reactome-watchdog, data in /var/lib/reactome-watchdog"
