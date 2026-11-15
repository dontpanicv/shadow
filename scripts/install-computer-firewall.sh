#!/bin/sh
# Lets the agents' work computers reach only the public internet, as Shadow's egress does for the browser: a pf
# anchor that blocks the VMs from this Mac, the office network, and private addresses, and a LaunchDaemon that loads
# it at each boot. Replies to the connections that this Mac opens to a VM, such as Shadow's SSH, still pass.
# docs/computer.md has the setup.
#
#   sudo scripts/install-computer-firewall.sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Run it with sudo" >&2; exit 1; }
ANCHOR="com.apple/shadow.computer"
RULES="/etc/pf.anchors/shadow.computer"
LABEL="dev.shadow.computer-firewall"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
# The network that macOS gives its VMs.
GUESTS="192.168.64.0/24"
GATEWAY="192.168.64.1"

cat >"$RULES" <<EOF
table <private> const { 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 \\
  192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4 }
# A guest gets its address and resolves names through this Mac, and nothing else of it.
pass in quick proto udp from any port 68 to any port 67
pass in quick proto { udp tcp } from $GUESTS to $GATEWAY port 53
block in quick from $GUESTS to <private>
block in quick on bridge100 inet6 all
EOF

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/sbin/pfctl</string><string>-E</string><string>-a</string><string>$ANCHOR</string><string>-f</string><string>$RULES</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF

launchctl bootout "system/$LABEL" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
sleep 1
pfctl -a "$ANCHOR" -s rules
