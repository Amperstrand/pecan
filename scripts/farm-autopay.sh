#!/usr/bin/env bash
# farm-autopay — give the farm demo the "it just pays" behavior: a 60s
# systemd timer on inr2 self-pays every PENDING purchase invoice on the
# issuing node (the mint's own CLN — local settle, zero routing).
#
# Usage: scripts/farm-autopay.sh install|status|remove
set -eu
SERVER=root@46.224.104.12
case "${1:-install}" in
install)
  scp -q "$(dirname "$0")/farm-autopay-remote.sh" "$SERVER:/opt/pecan-tools/farm-autopay.sh"
  ssh "$SERVER" "cat > /etc/systemd/system/farm-autopay.service <<'EOF'
[Unit]
Description=Farm demo autopay (self-pay pending purchase invoices)
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/pecan-tools/farm-autopay.sh
EOF
cat > /etc/systemd/system/farm-autopay.timer <<'EOF'
[Unit]
Description=Farm demo autopay - every minute
[Timer]
OnCalendar=*:*:00
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload && systemctl enable --now farm-autopay.timer && systemctl start farm-autopay.service"
  echo "farm autopay installed (60s timer)"
  ;;
status)
  ssh "$SERVER" 'systemctl list-timers farm-autopay.timer --no-pager | head -2; journalctl -u farm-autopay.service -n 4 --no-pager | tail -4'
  ;;
remove)
  ssh "$SERVER" 'systemctl disable --now farm-autopay.timer 2>/dev/null; rm -f /etc/systemd/system/farm-autopay.{service,timer} /opt/pecan-tools/farm-autopay.sh; systemctl daemon-reload'
  echo removed
  ;;
esac
