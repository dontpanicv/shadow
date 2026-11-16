#!/bin/sh
# Makes the base work computer ready for Shadow. Run it in the Terminal of the shadow-base guest, after
# guest-setup.sh and with Remote Login on: sh "/Volumes/My Shared Files/shadow-guest.sh". It runs again safely.
# docs/computer.md has the whole setup.
set -eu
share="$(cd "$(dirname "$0")" && pwd)"

# Shadow's SSH key, so Shadow makes the users of people and uses the desktop.
mkdir -p ~/.ssh
chmod 700 ~/.ssh
key="$(cat "$share/shadow.pub")"
grep -qxF "$key" ~/.ssh/authorized_keys 2>/dev/null || printf '%s\n' "$key" >>~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
if ! nc -z 127.0.0.1 22; then
	echo "Turn on Remote Login in System Settings > General > Sharing, then run this script again." >&2
	exit 1
fi

# agent-desktop runs only itself in the guest; this app puts the guest's <user>@<address> on its clipboard for
# Shadow.
mkdir -p ~/Applications
osacompile -o ~/Applications/"Shadow Address.app" \
	-e 'do shell script "printf %s@%s \"$(id -un)\" \"$(ipconfig getifaddr en0)\" | pbcopy"'
open -W ~/Applications/"Shadow Address.app"
echo "Address: $(pbpaste)"

# The tools of the work computer.
# Over SSH, a SUDO_ASKPASS program gives the password.
sudo ${SUDO_ASKPASS:+-A} true
# A run again gives Homebrew back to this user while it installs.
[ ! -d /opt/homebrew ] || sudo chown -R "$(id -un):admin" /opt/homebrew
if [ ! -x /opt/homebrew/bin/brew ]; then
	NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install pandoc poppler qpdf ghostscript imagemagick ffmpeg tesseract tesseract-lang ocrmypdf p7zip unar \
	exiftool jq python node
brew install --cask libreoffice
pip3 install --break-system-packages python-docx openpyxl python-pptx pypdf pdfplumber pandas
npm install --global agent-browser
agent-browser install
sudo mkdir -p /Library/Shadow
sudo rm -rf /Library/Shadow/browsers
sudo cp -R ~/.agent-browser/browsers /Library/Shadow/browsers
sudo chown -R root:wheel /opt/homebrew /Library/Shadow/browsers
sudo chmod -R go+rX,go-w /opt/homebrew /Library/Shadow/browsers
chrome="$(find /Library/Shadow/browsers -maxdepth 5 -path '*/Contents/MacOS/*' -type f | head -n 1)"

# The commands of each person run as their own user, which /Library/Shadow/person makes: no admin, no sudo, and a
# home that only that user reads. This user keeps the desktop and runs only person as root. Root owns the tools, so
# no command changes what the commands of other people run.
sudo install -o root -g wheel -m 755 "$share/shadow-person.sh" /Library/Shadow/person
sudo install -o root -g wheel -m 644 "$share/shadow.pub" /Library/Shadow/shadow.pub
# SSH commands run in a zsh that reads only the zshenv files.
printf '%s\n' \
	'export HOMEBREW_PREFIX=/opt/homebrew HOMEBREW_CELLAR=/opt/homebrew/Cellar HOMEBREW_REPOSITORY=/opt/homebrew' \
	'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"' \
	"export AGENT_BROWSER_EXECUTABLE_PATH='$chrome'" \
	'umask 077' | sudo tee /etc/zshenv >/dev/null
rm -f ~/.zshenv
# The last sudo: from now on, without its password, this user runs only person as root.
rule="$(mktemp)"
printf '%s ALL=(root) NOPASSWD: /Library/Shadow/person\n' "$(id -un)" >"$rule"
sudo sh -c 'visudo -cf "$1" && install -o root -g wheel -m 440 "$1" /etc/sudoers.d/shadow' sh "$rule"
rm -f "$rule"
chmod 700 ~
# Before, the commands of all threads ran as this user, in ~/work.
rm -rf ~/work
echo "The work computer is ready. Stop it on the server: agent-desktop sandbox stop shadow-base"
