#!/bin/sh
# Makes the work computer's own user of one person, for Shadow: no admin, no sudo, a home that only it reads, and
# Shadow's SSH key. guest.sh installs it as /Library/Shadow/person, which the base user runs with sudo.
set -eu
person="${1:-}"
case "$person" in
shadow-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
*)
	echo "usage: person shadow-<12 hex digits>" >&2
	exit 64
	;;
esac
home="/Users/$person"
if ! id "$person" >/dev/null 2>&1; then
	sysadminctl -addUser "$person" -fullName "Shadow $person" -home "$home" \
		-password "$(openssl rand -base64 30)" >/dev/null 2>&1
	dscl . -create "/Users/$person" IsHidden 1
	dseditgroup -o edit -a "$person" -t user com.apple.access_ssh
fi
createhomedir -c -u "$person" >/dev/null
mkdir -p "$home/.ssh" "$home/work"
install -m 600 /Library/Shadow/shadow.pub "$home/.ssh/authorized_keys"
chown -R "$person:staff" "$home/.ssh" "$home/work"
chmod 700 "$home" "$home/.ssh"
