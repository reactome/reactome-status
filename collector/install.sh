#!/usr/bin/env bash
# Install or update the Reactome status collector on a production host.
# Run with sudo from a checkout of the repo:
#   sudo ./collector/install.sh collector/config/reactome.org.json
set -euo pipefail

CONFIG_SRC="${1:?usage: install.sh <path to host config json>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVC_USER=reactome-status

if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/reactome-status --shell /usr/sbin/nologin \
          --gid reactome "$SVC_USER"
  echo "created user $SVC_USER"
fi
# groups needed to read logs: reactome (apache access log), adm (/var/log), docker (docker inspect)
usermod -a -G adm,docker "$SVC_USER"

install -d -o root -g root -m 755 /opt/reactome-status /etc/reactome-status
install -o root -g root -m 755 "$HERE/collector.py" /opt/reactome-status/collector.py
install -o root -g root -m 644 "$CONFIG_SRC" /etc/reactome-status/config.json
install -d -o "$SVC_USER" -g reactome -m 750 /var/lib/reactome-status

install -m 644 "$HERE/reactome-status-collector.service" /etc/systemd/system/
install -m 644 "$HERE/reactome-status-collector.timer"   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now reactome-status-collector.timer

echo "running once now..."
systemctl start reactome-status-collector.service
systemctl status --no-pager reactome-status-collector.timer | head -5
journalctl -u reactome-status-collector.service -n 5 --no-pager
