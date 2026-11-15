# The work computer

Agents run only TypeScript in code mode, so they have no computer of their own. The work computer is one macOS VM on
the Shadow server that all agents share, for untrusted code, file conversions, and apps. It is made with Vercel's [agent-desktop](https://agent-browser.dev/desktop/sandboxes/macos)
and cloned from one base VM that has the office tools. Agents use it with the `computer_` tools:

| Tool | Does |
| --- | --- |
| `computer_run` | Runs a zsh command in the thread's folder in `~/work`, after it copies company files there by id |
| `computer_save` | Saves a file of the computer to the thread's channel |
| `computer_desktop` | Runs agent-desktop commands on the computer's desktop, with a screenshot when asked |

The base has Homebrew, pandoc, LibreOffice, poppler, qpdf, ghostscript, ImageMagick, ffmpeg, tesseract, ocrmypdf,
7z, unar, exiftool, jq, Python 3 with python-docx, openpyxl, python-pptx, pypdf, pdfplumber, and pandas, Node.js,
and agent-browser. Agents install more with brew or pip, and have `sudo` without a password.

- Every agent uses the same computer, `shadow-computer`, also in routines and reminders. It is made from the base on
  its first call and keeps its disk. Each thread works in a folder of its own, `~/work/<thread>`, so agents do not
  overwrite each other's files; any agent can still read them, so the computer holds no private data for long.
- The computer starts on its first call, which takes up to a minute, and stops after 15 idle minutes.
- The computer has the company's sources, as `[[sources]]` in `config/shadow.toml` lists them, read-only in
  `/Volumes/My Shared Files/sources/<source>`, with the files of the newest commit and `git log`. Older versions of
  files come only through `sources_history`, because only the server can fetch them. Before the computer starts, and
  between its commands after a pull, Shadow puts an APFS clone of `data/sources/` in the VM's shared folder, so a copy
  takes no disk until a pull changes a file. Git's token never reaches the VMs.
- The VM reaches only the public internet: `scripts/install-computer-firewall.sh` blocks this Mac, the office network,
  and private addresses for it.
- Shadow reaches a guest with its own SSH key in `data/computer/`. agent-desktop runs only itself in the guest, so the
  `Shadow Address` app of the base puts the guest's user and address on its clipboard, where Shadow reads them.

## Set it up

The server needs an Apple Silicon Mac with macOS 13 or later, the Xcode Command Line Tools (`xcode-select
--install`), and about 80 GB free disk. The first setup needs a person at the server's screen, also over Screen
Sharing, signed in as the user that runs Shadow.

1. On the server, in the Shadow checkout, make the base VM. The image download takes a while; repeat `status` until
   it stops answering `working`.

   ```sh
   AD=node_modules/agent-desktop/bin/agent-desktop
   $AD sandbox install macos
   $AD sandbox create shadow-base --provider macos --set ipsw=latest
   $AD sandbox status shadow-base
   bun scripts/computer-base.ts
   $AD sandbox start shadow-base --window
   ```

2. In the guest window:
   1. Finish the macOS setup with an account of the same short name as the user that runs Shadow, because
      agent-desktop connects to the guest as that user. Turn on automatic login in **System Settings › Users &
      Groups**.
   2. Turn on **Remote Login** in **System Settings › General › Sharing**.
   3. In **Terminal**, run `sh "/Volumes/My Shared Files/guest-setup.sh"`. agent-desktop 1.3.1 runs its guest
      commands over SSH, so switch on `/usr/libexec/sshd-keygen-wrapper` under **Accessibility** and **Screen
      Recording** in **Privacy & Security** (**Device Control and Data Access** on macOS 27).
   4. In **Terminal**, run `sh "/Volumes/My Shared Files/shadow-guest.sh"`. It asks for the guest's password once,
      and installs the tools.
3. On the server, stop the base, which stays stopped from now on, and block the VMs from the private network:

   ```sh
   $AD sandbox stop shadow-base
   sudo scripts/install-computer-firewall.sh
   ```

To change the base, start it with `--window` again, change it, and stop it. Only computers made after the change
have it.
