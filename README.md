<img alt="Shadow" src="design/icon.svg" width="96">

# Shadow

A shadow company for your team. Every employee gets a shadow: an AI agent that reads their Slack and mail, keeps
track of what each conversation asks of them, and helps them do the work when they ask. Shadow runs on your own
server, with no cloud service between your company and its data.

## Why Shadow

- **Every employee has a shadow.** Each person has their own thread with their shadow that never ends. It knows who
  writes each message, what each person works on, and what the team decided last week.
- **It reads Slack and mail for you.** Turn on "Read for me" for Slack, Gmail, or Plaud meeting notes. Your
  shadow keeps the useful context and files it with the matter it belongs to, so you do not read every message to
  know what is happening.
- **It keeps track of what is asked of you.** Your shadow follows each open matter. When a customer has 30 days to
  reply, it checks again on day 30. Each morning it groups what changed by matter and sends you one summary. It nudges
  you about an open ask every 2 days until you deal with it, or say that it is done or someone else's.
- **It helps you do the work, when you ask.** Ask for research, an analysis, a draft reply, or a document. Your shadow
  searches mail, Slack, and files, browses the web, and builds pages and small apps. It asks you before it sends
  mail or a message as you.
- **It knows the company.** Each channel keeps a brief that Shadow writes again when a conversation goes quiet. A
  learning loop keeps short facts about each person and how things are done. Your team writes its own facts too.
  Every agent reads all of it before it answers.
- **It stays quiet.** Shadow notifies you only when you must act or when you asked for it. Routines, reminders, and
  messages to other people still need your request or approval.
- **Your company's data stays with you.** One server, one SQLite database, Markdown files, and a search index that
  runs on the server. Each person's private channels and accounts stay private until they share them.

## How a conversation flows

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/conversation-flow-dark.svg">
  <img alt="A person asks their shadow, their own endless thread, or writes in a channel thread. The shadow sends work to channel threads with send_to_thread, and the answers come back to it. Channel threads run code mode scripts. When a thread goes quiet, the channel brief is written again, the learning loop updates the learned facts, and the messages go into the search index. The brief, the learned facts, and the company facts become prompt sections that every turn reads." src="docs/assets/conversation-flow-light.svg">
</picture>

- **Channels come from Slack.** The channels that every member sees, such as `#general`, `#sales`, or `#hiring`,
  copy the public channels of the company's Slack. The Slack bot listens to Slack's events over Socket Mode: a new
  channel appears, a rename follows, and a channel that Slack archives hides with its threads until Slack has it
  again. Nobody makes them by hand. Each person also makes private channels of their own.
- **Admins and users.** An admin runs Company settings: the Slack bot, the people and their roles, the company
  facts, and what Shadow learned. Admins also choose the model and read the agents' feedback. A user works in Shadow.
  The first of `allowed_emails` is the first admin.
- **A channel holds threads.** A thread is one conversation about one thing. Several people can write in it, and its
  agent knows who wrote each message. A thread that is done is settled; its files and artifacts stay in the channel.
- **Your shadow is your endless thread.** It answers simple things itself and gives other work to the thread of the
  right channel, or starts one. The answer comes back to your shadow. A message passes between threads at most
  twice, so agents cannot talk to each other without end.
- **The endless thread does not get slow.** A memory tree of short summaries covers your conversation and the results
  that workers send back. Their internal work stays in their threads. Old messages fold into the tree, and the agent
  opens a summary again with `zoom` when it needs the details.
- **The channel's Slack history.** A new channel gets the last 30 days of its Slack channel at once: one Markdown
  file for each day, with thread replies under their message and attachments as files. Then each new message, reply,
  edit, and delete arrives as an event, and the changed day files are written within a minute. Nothing reads Slack on
  a timer: after a restart Shadow reads only what it missed, and once a day it checks the last 30 days again. Search
  and the agents find all of it.
- **The channel brief.** When a thread is quiet for 10 minutes, or settled, and when its Slack channel is quiet for 10 minutes, the cheap
  fast model (ChatGPT's Luna), thinking hard, writes the channel's brief again: its purpose, what is happening now, the
  decisions, and the open questions. Every thread of the channel starts from it.
- **Learned facts.** The learning loop reads the new messages and keeps only lasting facts about each person, such
  as their role, their customers, and how they like to work, and how-tos for each channel; it skips the details of
  one task. It can also suggest a routine or a reminder. An admin sees, changes, and removes what it learned in
  Company settings, and
  it does not learn a removed fact again.
- **Company facts.** The admins write facts about the company in Company settings: teams, products, customers,
  and processes.
- **Recall.** Every message, file, note, and artifact goes into the search index. Agents look things up there with the
  `recall` tool before they say that they do not know.

The brief, the learned facts, and the company facts are prompt sections. A section keeps the
same text until its content changes, so the model's prompt cache stays warm.

## Your accounts, read for you

Turn on "Read for me" for each account in Settings. Shadow reads incoming and outgoing material every 15 minutes.
The first read covers one day; later reads continue from a saved cursor, including after an outage.

- **Slack:** the messages that you send, your mentions, DMs and group DMs, and the replies in those Slack threads.
- **Gmail:** incoming mail from the Primary inbox after your Gmail filters, and sent mail for context. It leaves out
  archived mail, other inbox categories, spam, trash, and drafts before it fetches the bodies.
- **Plaud:** the summaries of your recorded meetings.

The configured model reads bounded batches, with the history of the same subject and the threads that could match.
EmbeddingGemma stays the local model for recall. There is no separate model that only judges relevance.

A useful development adds a visible message and its source files to the existing subject thread. The message says
what changed and what it asks of you. An existing shared thread that matches can get the sources too. A new subject
starts in your own private channels; when none fits, Shadow makes a private channel and its first thread. The thread
agent has its normal tools and can find older related mail and tickets.

The clock also starts work. A stated response period gets a durable check. When it is due, Shadow reads fresh source
evidence before it decides whether you need to know. An acknowledgement does not count as an answer. A promise
without a date gets an internal review, with no claim that a deadline was missed.

- **Urgent developments** are posted at once.
- **The others wait for the morning review** in the 08:00 hour (Europe/Prague). One plan groups them by matter, posts
  one message to each thread, and sends you one summary with a notification.
- **A separate notification** needs exact source evidence: you asked for it, an awaited reply needs attention, a
  stated time arrived, or preparation helps now. Shadow checks the latest source first. Normal messages, mentions,
  and an hour without a reply are not reasons alone.
- **Silent filing** sends no notification and starts no agent.

Your shadow is your second brain, not a worker that acts alone: no source starts an agent, so it does research or
drafts only when you ask. Messages to other people still need your request and approval.

**Following** shows what Shadow follows for you, the sources of each matter, and its history. Mark a matter handled,
stop it, open it again, or correct it in plain words. Stopping a matter does not mark it done. Corrections stay in
the audit and guide later assessments.

Source data, model calls, searches, state changes, agent work, and corrections go to a separate private
`audit.sqlite`. Source files stay grouped: one per Gmail or Slack thread, one per Plaud meeting, and one per
conversation per day for Slack DMs. New messages update the same file.

See [the process and verification notes](docs/proactive.md), [the API](docs/api.md#intake-srcintake), and
[data storage](docs/data.md). Upcoming keeps explicit reminders and routines; it has no inferred task list.

Private replay data must stay outside this public repository.

## Under the hood

### Pi Durable

Agents run on [Pi Durable](https://github.com/earendil-works/pi), the durable agent runtime of Earendil. The company
has one Pi Durable session, and each thread is one conversation in it, with its transcript, runs, and tasks. A run that
a restart stopped continues when Shadow starts again, and messages that came while Shadow was off are caught up. A
tool that is safe to repeat, such as `send_to_thread`, runs again after a crash and finds the message it sent before.
Each person's endless thread compacts itself when its context gets long.

Each routine keeps one durable conversation and its full transcript. A new run starts a new active context with its
saved instructions and script result; a restart resumes that same run, boundary, and tool tasks. Progress stays in
the routine's script store. A long run compacts between tool rounds at 160 KiB of serialized input, and a provider
guard refuses routine input above 256 KiB. These are byte limits, not exact token counts. Older runs remain available
in the thread and through search.

### Code mode

The model calls only a small set of core tools directly: channels, threads, files, `recall`, and web search. Every
other tool is in a namespace that the model uses from a short TypeScript script, in the code mode sandbox of
[Pi](https://github.com/earendil-works/pi) (`pi-codemode`, 256 MB, its own worker):

```ts
const mail = await tools.google_mail_search({ account: "work", query: "from:acme.com newer_than:7d" });
const slack = await tools.slack_search({ account: "work", query: "acme in:#sales" });
return { mail, slack };
```

The namespaces are `artifacts_`, `browser_`, `routines_`, `reminders_`, and one for each connected integration,
such as `google_` or `slack_`. The agent finds tools with `describeNamespace()` and `searchTools()`, so the prompt
does not list hundreds of tools. One script can call many tools and return only what matters, which keeps the
context small.

### Integrations

Each person connects their own accounts in Settings. An account is private to their turns until they share it, and
a person can connect several accounts of one service, such as two Google accounts. Agents send mail and messages as
a person only after that person allows each one. [docs/integrations.md](docs/integrations.md) has the setup of each
one.

| Integration | What agents do | How it connects |
| --- | --- | --- |
| Google (Gmail, Calendar, Drive, Docs, Sheets) | Search and read mail, draft, send after approval, calendar, files | Google sign-in, through [gog](https://github.com/openclaw/gogcli) |
| Slack | Search and read, draft, send after approval | A request of the Slack web app, pasted as cURL, through [slackcli](https://github.com/shaharia-lab/slackcli) |
| Notion | Search and read pages and databases, create and change them | Notion's MCP server |
| Linear | Find and read issues and projects, create and change issues | Linear's MCP server |
| Jira | Search and read Jira issues and Confluence pages, create and change them | Atlassian's Rovo MCP server |
| HubSpot | Search and read the CRM | HubSpot's MCP server, with a client that an admin sets |
| Pipes and Engage | Read configuration, profiles, events, and performance; propose changes that the person approves in Pipes | The MCP server of the person's Pipes instance |
| Plaud | Recordings and their meeting notes | Plaud's MCP server |
| T3 Code | Start and follow coding threads in a project on the person's machine | The MCP server of their own T3 Code |

A connector is a file in `src/integrations/`. A connector with an MCP server gives its tools as they are, under its
namespace.

### Search and recall

The company has one search index, `index.sqlite`, on the server. The Search page of the web app and the agents'
`recall` tool use it, so a person and their shadow find the same things.

- **What goes in.** The messages of every thread, the text of every artifact, and every file in the company and its
  channels:
  - documents (Markdown, Office, OpenDocument, mail, calendars, and more) in chunks of about 1800 characters;
  - PDFs page by page, where a scanned page is rendered as a picture and read with OCR;
  - pictures, at most 1024 pixels long, and screenshots with their OCR text;
  - audio in 30-second windows, without silence;
  - video as a frame every 3 seconds when the shot changes, plus its sound as audio.

  An answer card goes in as the words on the card. A file that Shadow cannot read is still found by its name.
- **Words.** SQLite FTS5 with stemming finds the words of the query; a title counts three times as much as the text.
- **Meaning.** Google's [EmbeddingGemma 2](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF) runs on the
  server, in a pinned [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` that Shadow starts and stops.
  On the first start Shadow downloads the text model (310 MB) and the picture and audio encoders (555 MB) and checks
  their SHA-256. Text that reads as prose, pictures, and audio all get a 768-dimension vector in **one shared space**,
  so a question in words finds a photo of a whiteboard or a voice memo, also when no word matches. The vectors are
  float16 rows in SQLite, compared by brute force, with no vector database.
- **Ranking.** It follows [DigUp](https://github.com/ARahim3/DigUp). For each source, the best match of its vectors
  becomes a z-score against all the scores of the query, measured for each kind, because pictures and audio score on
  another scale than text. The share of query words that a source contains adds to it. A source shows when it stands
  out by meaning (z ≥ 3) or holds at least half of the words, so a search shows nothing rather than noise. A query of
  ids or numbers counts the words more.
- **Privacy.** Before it ranks, a search leaves out what its person may not see. A person finds the channels that every
  member sees, their own private channels, and their own shadow thread. An agent's `recall` sees what the person of
  its turn sees: in your shadow thread or private channel that is you, and in a shared channel it is the person whose
  message the agent answers.
- **Recall.** Agents call `recall` with a question in plain words, and get up to 20 results (8 by default), each with
  its kind, title, date, the link of its thread, and a snippet. They are told to recall before they say that they do
  not know.
- **The Search page.** Results come as you type, each with the Markdown lines around the first word that matches.
  Before a query, the page shows your recent searches.
- **Freshness.** Shadow indexes a thread a second after it changes and checks the files every minute; it reads and
  embeds again only what changed. Until the model runs, search finds words only, and the Search page says so.

[docs/data.md](docs/data.md) has every file kind and the details.

### Artifacts

An artifact is a page or a small app that an agent writes in HTML: a status page, a poll, a sign-up sheet, an
onboarding checklist, or a report to print or save as a PDF. It belongs to the channel of the thread that made it and
stays there when the thread is settled. The side panel of a thread shows the artifacts of its channel.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/artifacts-dark.svg">
  <img alt="A member opens the app's host, and anyone with a link opens a.example.com. Both hosts are on Cloudflare and reach the server through an outbound cloudflared tunnel; the public host passes only artifact paths and answers 404 to the rest. The server listens on 127.0.0.1:3000, checks who may open the artifact, and shows it in a sandboxed page. The page keeps its data through the shadow runtime in shadow.sqlite, where the thread agent writes the HTML." src="docs/assets/artifacts-light.svg">
</picture>

- **Members or public.** A new artifact is for members: only signed-in people who can see its channel open it, so an
  artifact of a private channel stays private. Any member who sees it, or an agent, can make it public; then anyone
  with its link opens it, without an account, such as a customer or a candidate. A link is four words, such as
  `amber-fox-lake-moss`: easy to know again, and too many to guess. A name is never given out again, also after a
  delete.
- **Data without a backend.** The page keeps data through `shadow`, a small runtime that Shadow puts at its start:
  `shadow.mine` for the records of one visitor, `shadow.shared` for the records that everybody shares, and
  `shadow.everyone` to list the records of all visitors, such as the answers of a poll. Visitors give their name with
  `shadow.setName`. The records are rows in `shadow.sqlite`; agents read and change them with `artifacts_data` and
  `artifacts_set_data`, and the side panel shows them under **Data**.
- **A sandbox, never Shadow's origin.** The HTML runs in a frame without `allow-same-origin`, so it cannot read
  Shadow's cookies or call Shadow's API. Its content policy lets scripts come only from three public CDNs (jsDelivr,
  unpkg, and cdnjs), and styles and fonts also from Google Fonts. It blocks every network request
  (`connect-src 'none'`), so data goes only through `shadow`. Shadow serves a page that a person or an agent wrote only
  from its own `content` address, never from a path of the app.
- **The public host.** Public links use their own host, such as `a.example.com`, on the same Cloudflare Tunnel as
  Shadow. Three layers keep the rest of Shadow private: the tunnel lets through only `/<name>`, `/<name>/content`, and
  `/<name>/rpc` and answers `404` to everything else; Shadow answers on that host only for public artifacts, and does
  not tell a members artifact from a missing one; and Shadow listens only on `127.0.0.1`. An address that asks for 20
  links that do not exist in 10 minutes gets `429`. [docs/artifacts-sharing.md](docs/artifacts-sharing.md) has the
  setup.

### More

- **Browser.** Agents visit websites in a headless Chrome of their own for each thread and person, driven by Vercel's
  [agent-browser](https://github.com/vercel-labs/agent-browser). They search the web with ChatGPT's own search,
  because search engines block a headless browser. All their web traffic goes through one egress that blocks the
  server, the office network, and private addresses.
- **Routines and reminders.** Ask in plain words: "check the support queue every morning", "remind me on Friday to
  send the invoice". A routine is a schedule, instructions, and an optional script that collects what is new; when the
  script finds nothing, the run ends without the model. A reminder comes at a time.
- **Upcoming and suggestions.** Upcoming shows your routines, reminders, approvals, and the suggestions that wait for
  you. Accept a suggestion and it becomes a routine or a reminder.
- **Feedback from the agents.** When a tool fails or answers wrong, when no tool can do the work, or when an agent sees
  an easier way, it reports this with `feedback_report` and continues. An admin reads the reports under
  **Private** › **Feedback** and dismisses each one when it is done. A report describes Shadow, not the person, and
  links its thread only when the admin can see it.
- **The model.** Shadow uses ChatGPT, signed in once with the device login of OpenAI's Codex. An admin
  chooses the model and the effort for everybody.

## The web app

The web app is a React single-page app with one design system, Ember: shades of black and white, one rust accent,
square corners, 16 × 16 pixel icons, and a fine dither. Channels and threads work as in Slack. It talks to the JSON
API in [docs/api.md](docs/api.md). It keeps its data local, shows each change at once, and stays current over
server-sent events. It opens on what it showed last, also before the server answers. Notifications go to each
person's inbox in the app.

## Self-hosting

### What you need

- **A Mac with Apple silicon**, such as a Mac mini, that stays on. Linux on x86-64 or arm64 also works for the server.
- **[Bun](https://bun.sh)**, and these tools, which Shadow checks before it starts:
  `brew install ffmpeg poppler tesseract whisper-cpp dicklesworthstone/tap/dcg cloudflared`.
- **A domain on Cloudflare**, for the tunnel and the HTTPS address. Google sign-in needs `https` on a public name.
- **A Google Cloud project** for Google sign-in. Nobody can sign in with a password.
- **A ChatGPT account** for the model, and enough free memory for the local search model.
- **Optional:** `gog` for Google and `slackcli` for each person's own Slack account.

### Run it

```sh
git clone https://github.com/dontpanicv/shadow.git && cd shadow
bun install
bunx --bun agent-browser install   # Chrome for the agents' browser, if Google Chrome is not installed
bun start                          # makes config/shadow.toml on the first start, then stops
```

Fill in `config/shadow.toml` and start Shadow again:

```toml
base_url = "https://shadow.example.com"
allowed_emails = ["you@example.com", "colleague@example.com"]   # the first one is the first admin

[google]
client_id = "….apps.googleusercontent.com"
client_secret = "…"
```

[google-sign-in.md](google-sign-in.md) shows how to make the Google client. Then sign in, connect ChatGPT in
Settings, connect the Slack bot and add your colleagues in Company settings
([docs/integrations.md](docs/integrations.md#the-slack-bot-of-the-company)). Each person adds their own accounts in
their Settings.

Shadow keeps everything in two folders ([docs/data.md](docs/data.md)). `SHADOW_CONFIG` and `SHADOW_DATA` move them.

- `config/`: `shadow.toml` and `secret.key`. Keep a copy of it safe and apart from the data backups.
- `data/`: the database, the threads, the files, the search index and its model, and the logs. Back it up offsite.

### The recommended deployment: a Mac mini behind a Cloudflare Tunnel

This setup opens no port on your router and keeps the server off the internet:

1. **Shadow listens only on `127.0.0.1:3000`**, which is the default `host` in `config/shadow.toml`.
2. **`cloudflared` connects out to Cloudflare** and brings the traffic for `shadow.example.com` to `127.0.0.1:3000`.
   Cloudflare holds the TLS certificate. There is no open port, no dynamic DNS, and no reverse proxy to keep up to
   date.
3. **Only the people in `allowed_emails` can sign in**, with Google.
4. **Public artifact links use a second host**, such as `a.example.com`, on the same tunnel. Its ingress lets through
   only the paths of an artifact, and Shadow answers there only for public artifacts (see [Artifacts](#artifacts)).

Make a tunnel in the Cloudflare dashboard (Zero Trust › Networks › Tunnels) with these public hostnames, and save its
token in `config/share-tunnel.token`:

| Hostname | Path | Service |
| --- | --- | --- |
| `shadow.example.com` | | `http://127.0.0.1:3000` |
| `a.example.com` | `^/[a-z]+(-[a-z]+){1,3}(/content\|/rpc)?$` | `http://127.0.0.1:3000` |
| | everything else | `http_status:404` |

Then install both services, which start at login and restart when they stop:

```sh
scripts/install-service.sh         # Shadow, as the LaunchAgent dev.shadow.server; logs in data/logs/shadow.log
scripts/install-share-tunnel.sh    # cloudflared, as the LaunchAgent dev.shadow.share
```

Set `share_url = "https://a.example.com"` in `config/shadow.toml`. In the Cloudflare zone, turn off Email
Obfuscation, because it breaks the app's content policy, and do not cache the Shadow host except `/app/` and
`/assets/`. `sudo scripts/install-service.sh --daemon` runs Shadow from boot, before anyone logs in.

To update: `git pull && bun install`, then the restart command that `install-service.sh` printed, such as
`launchctl kickstart -k gui/$(id -u)/dev.shadow.server`. Shadow builds the web app when it starts.

### Let your agent set it up

Paste this prompt into a coding agent, such as Claude Code or Codex, on the Mac that will run Shadow:

```text
Set up Shadow (https://github.com/dontpanicv/shadow) on this Mac as a self-hosted server for my company.

1. Read README.md, google-sign-in.md, docs/artifacts-sharing.md, and docs/integrations.md first.
2. Check that this is a Mac with Apple silicon. Install what is missing with Homebrew: bun, ffmpeg, poppler,
   tesseract, whisper-cpp, dicklesworthstone/tap/dcg, and cloudflared.
3. Clone the repository to ~/shadow, and run `bun install` and `bunx --bun agent-browser install`.
4. Run `bun start` once, so Shadow writes config/shadow.toml, and stop it.
5. Ask me for: the Shadow hostname (such as shadow.example.com), the artifact hostname (such as a.example.com),
   and the Google emails of the team, the first admin first. Write base_url, allowed_emails, and share_url into
   config/shadow.toml. Keep host = "127.0.0.1".
6. Guide me through the Google OAuth client of google-sign-in.md, with the redirect URI
   https://<shadow hostname>/api/auth/callback/google, and write client_id and client_secret into config/shadow.toml.
   I do the steps in the Google Cloud console myself.
7. Guide me to make a Cloudflare Tunnel with the two public hostnames of the README (the artifact host with its
   path rule, and a 404 for everything else), and to save its token in config/share-tunnel.token.
8. Run scripts/install-service.sh and scripts/install-share-tunnel.sh. Check that https://<shadow hostname>
   opens Shadow and that data/logs/shadow.log shows no requirement that is missing.
9. Tell me to sign in, connect ChatGPT in Settings, and connect the Slack bot and add the team in Company settings.

Never print, commit, or send the secrets in config/. Stop and ask me before any step that you cannot undo.
```

## Development

```sh
bun run dev        # http://localhost:3000, rebuilds the web app on every change
bun test
bun run typecheck
bun run lint       # Ultracite (Biome); `bun run format` fixes what it can
```

- `src/` is a modular monolith: one module for each domain, each with its service, routes, and tests
  ([docs/modular-monolith.md](docs/modular-monolith.md)). `web/` has the same modules.
- `design/tokens.json` holds every color, size, space, radius, and shadow; `bun run tokens` makes the CSS, the
  16 × 16 pixel icons, and the logo's paths from it. `design/components.md` is the spec of every component.
- `design/icon.svg` is Shadow's badge in an 8 × 12 grid: an employee badge, white on black, whose right half is its
  shadow in accent (#c8603f) noise, under an accent clip. `bun scripts/icon.ts` makes it and every app icon, with one
  noise cell a point at the size where each shows.
- `.claude/skills/` has the agent skills of this repository, such as
  [Stageshow](https://github.com/benjitaylor/skills) for product demos. The diagrams are made with
  [Archify](https://github.com/tt-a1i/archify) from `docs/assets/*.archify.json`.

## Credits

Shadow stands on the work of these projects and people:

- **Agents:** [Pi](https://github.com/earendil-works/pi) by Earendil (Pi Durable, Pi Codemode, Pi AI, and Chord);
  the memory tree follows
  [UniiChat](https://github.com/VictorTaelin/UniiChat); the search ranking follows
  [DigUp](https://github.com/ARahim3/DigUp); web search follows [pi-web-access](https://github.com/nicobailon/pi-web-access);
  [agent-browser](https://github.com/vercel-labs/agent-browser); the
  [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk).
- **Server:** [Bun](https://bun.sh), [TypeScript](https://www.typescriptlang.org), [Effect](https://effect.website),
  [SQLite](https://sqlite.org), [better-auth](https://www.better-auth.com), [llama.cpp](https://github.com/ggml-org/llama.cpp),
  [FFmpeg](https://ffmpeg.org), [Poppler](https://poppler.freedesktop.org),
  [Tesseract](https://github.com/tesseract-ocr/tesseract), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [unpdf](https://github.com/unjs/unpdf), and
  [Cloudflare Tunnel](https://github.com/cloudflare/cloudflared).
- **Web:** [React](https://react.dev), [TanStack Router, Query, and DB](https://tanstack.com),
  [Radix](https://www.radix-ui.com), [react-markdown](https://github.com/remarkjs/react-markdown),
  [Shiki](https://shiki.style), [Leaflet](https://leafletjs.com) with [OpenStreetMap](https://www.openstreetmap.org),
  [Chart.js](https://www.chartjs.org), [docx-preview](https://github.com/VolodymyrBaydalka/docxjs), and
  [read-excel-file](https://gitlab.com/catamphetamine/read-excel-file).
- **Integrations:** [gog](https://github.com/openclaw/gogcli) and [slackcli](https://github.com/shaharia-lab/slackcli).
- **Models:** [EmbeddingGemma 2](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF) by Google (Apache 2.0).
- **Design:** the Ember look, inspired by the work of [Charles Postiaux](https://x.com/postiauxcharles); the measures of
  [Linear](https://linear.app), the layout of
  [T3 Code](https://github.com/pingdotgg/t3code); and the [Inter](https://rsms.me/inter/) and
  [Geist Mono](https://github.com/vercel/geist-font) fonts (SIL Open Font License).
- **Tools for this repository:** [Stageshow](https://github.com/benjitaylor/skills) by Benji Taylor (MIT) and
  [Archify](https://github.com/tt-a1i/archify).

## Status

Shadow is early. It changes often, and we build it in public.
