#!/bin/sh
# Makes the base work computer ready for Shadow. Run it once in the Terminal of the shadow-base guest, after
# guest-setup.sh and with Remote Login on: sh "/Volumes/My Shared Files/shadow-guest.sh". docs/computer.md has the
# whole setup.
set -eu
share="/Volumes/My Shared Files"

# Shadow's SSH key, so Shadow runs commands and copies files.
mkdir -p ~/.ssh ~/work
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
sudo ${SUDO_ASKPASS:+-A} -v
# Agents get root in their own VM: the firewall that keeps it off private addresses runs on the server.
printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$(id -un)" | sudo tee /etc/sudoers.d/shadow >/dev/null
sudo chmod 440 /etc/sudoers.d/shadow
sudo visudo -cf /etc/sudoers.d/shadow
if [ ! -x /opt/homebrew/bin/brew ]; then
	NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv)"
# SSH commands run in a zsh that reads only ~/.zshenv.
grep -q 'brew shellenv' ~/.zshenv 2>/dev/null || cat >>~/.zshenv <<'EOF'
eval "$(/opt/homebrew/bin/brew shellenv)"
export PATH="$HOME/.local/bin:$PATH"
EOF
brew install pandoc poppler qpdf ghostscript imagemagick ffmpeg tesseract tesseract-lang ocrmypdf p7zip unar \
	exiftool jq python node
brew install --cask libreoffice
pip3 install --break-system-packages python-docx openpyxl python-pptx pypdf pdfplumber pandas
npm install --global agent-browser
agent-browser install
echo "The work computer is ready. Stop it on the server: agent-desktop sandbox stop shadow-base"
