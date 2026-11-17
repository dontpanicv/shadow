# Shadow Agent Guidance

Shadow is a shadow company for a team: every employee gets a shadow, an AI agent and second brain that reads their
Slack and mail and helps them with their work. It runs on the company's own server, with no cloud service.

## General Rules

- Always talk in ASD-STE100 Simplified Technical English.
- Remove obsolete application paths; do not add compatibility layers, fallbacks, or migrations for them. Database
  migrations must use expand-and-contract so a machine on the previous version keeps working while the others
  upgrade. Remove obsolete schema only after no machine runs a version that uses it.
- Use the simplest complete implementation. Avoid speculative abstractions, configuration, and indirection. Start
  with a working end-to-end product, then add capabilities in layers. Never replace working behavior with unfinished
  complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, maintained libraries that reduce complexity or improve reliability. Reimplement common
  functionality only with a clear reason.
- Use existing dependencies first; check their documentation and types before writing code or adding packages.
- Make long-term architectural decisions; do not add stopgaps meant for later replacement.
- Make the best decision that will elevate all three: the user experience (UX), developer experience (DX), and agent
  experience (AX) always, without breaking anything.
- Cut taglines, helper text, and secondary labels. If a screen needs them to make sense, fix the layout.

## Public Repository

This repository is public. Never commit secrets, tokens, personal or company data, private hostnames or VPN
addresses, or code and data from employers or clients.

## Working Rules

- Use Bun, not npm or Yarn.
- Inspect relevant existing patterns when the implementation is unfamiliar; match their structure and primitives.
- Add guidance only for stable, non-obvious conventions not enforced or documented elsewhere.

## Web app

- The web app is the only app. Every feature is a JSON endpoint in `src/<module>/api.ts`, documented in
  `docs/api.md`, that calls the module's service in `src/<module>/<module>.ts`. The web app is a React single-page app
  in `web/`; the server sends it for every app path and has no other pages.
- Agents make and change reminders with tools; a person sees their pending ones in Upcoming and cancels one there.
- Shadow stays quiet by default: background work notifies a person only when they must act or asked for it, and a
  routine or reminder answers `QUIET` when nothing needs anyone.
- In Slack (`src/slack/`), a mention or a DM is a person's request, and an admin's goal is the consent for
  Shadow to listen: a channel's own goal there, the company's default goal in every other channel that an admin did
  not switch off. A message there gets a cheap check, then a turn in the shared realm that answers only when a reply helps,
  else `QUIET` or `notices_tell` to one person; a turn for a person tells only that person. Ambient turns never act: for a routine or a reminder that someone asks
  for, they `notices_suggest` it, and it becomes that person's own, with their realm and credentials, only when they
  accept. They post at most `AMBIENT_PER_HOUR` replies in a channel, follow a thread for `FOLLOW_MS`, stop when muted,
  and log decisions without message text. A person's own credentials serve only the turns of their own requests,
  routines, and reminders; a turn without a person uses no personal credentials.
  The bot keeps the copy of the public channels and posts Shadow's answers; the `slack_` tools
  (`src/integrations/slack.ts`) use a person's own slackcli session to search, read, and send as that person, and never
  post Shadow's answer.
- Consent first: explicit routines, reminders, and external messages still need a person's request or an accepted
  suggestion. "Read for me" (`credential.watched`) is standing consent for `src/intake/` to read that account,
  retain useful context and infer future checks. Hard rule: what intake reads from a person's accounts goes only to
  threads of that person's private channels (`privateThreads` in `src/intake/recall.ts`), never to a channel or
  thread that someone else sees. Only the person's own request in a shared thread brings their sources there. A
  private thread or channel never moves or merges into a channel that others see, and a thread of a channel that
  others see never moves into a private one. A useful development adds a visible
  source message and files to the existing subject thread; a new matter and silent filing stay in the person's
  private channels. Shadow is the
  person's second brain, not their worker: no source starts an agent, and an agent does research, analysis, or a draft
  only when a person asks. An urgent development is posted at once. The others wait for the person's one morning
  review in the 08:00 hour of the person's Slack time zone, which groups them by matter, posts one message to each thread with what it asks of the
  person, keeps a check of each ask that the morning summary nudges every 2 days until it is handled or the person
  says it is done, rejected, or someone else's, and sends the person one summary with a notification. Another notification needs a separate supported reason and a fresh
  source check; useful answers alone never notify. No separate worker thread is made. Code selects personally relevant Slack
  conversations and keeps incoming and outgoing context. Bounded batches and subject-scoped recall reach the
  configured model provider. Silent filing starts no agent turn and sends no notification.
- Every company read and write goes through `Companies.requireMember`; answer `404` to non-members.
- A member is an `admin` or a `member` ("User" in the app). Only an admin opens Company settings: the Slack bot, the Linear key and its feed, the
  VictoriaLogs and VictoriaMetrics addresses that every agent queries, the repositories where people's own agents keep notes, the members and their roles, the LLM provider and model, the usage, the facts, what Shadow learned, the name, and the
  server restart; an admin also sets the OAuth clients and reads agent feedback. A person's own Settings has only
  their integrations and account. Check with `Companies.requireAdmin` (`403`), or `isAdmin` for
  what all companies share. The first of `allowed_emails` starts the company as its first admin; one admin stays.
- The channels that every member sees copy the public channels of the company's Slack: only the Slack bot
  (`src/integrations/slack-bot.ts`, through `Companies.syncSlackChannels`) makes, renames, or hides them, by
  `channel.slack_id`. People and agents make, rename, and merge away only private channels. The bot listens over
  Socket Mode (`slack-socket.ts`); never poll Slack on a timer. `slack-history.ts` keeps each message event, reads a
  new channel's last 30 days once, a gap from the last event, and the last 36 hours once a day, writes one
  `slack-YYYY-MM-DD.md` file of the channel per changed day each minute, and gives a channel quiet for 10 minutes to
  its brief (`Threads.briefFromSlack`).
- `src/linear/` files the company's Linear, read with the company key, into the channels that every member sees: the
  last 30 days once, then every 5 minutes. It is a company source, not a person's account, so the intake rule of
  private channels does not apply. An issue goes to channels whose Slack named its key or that got it before, and the
  fast model chooses for the rest; most go nowhere. Filing writes `linear-YYYY-MM-DD.md`; a post goes only to Shadow,
  never to Slack, at most `LINEAR_POSTS_PER_HOUR` in a channel, and never from the first read.
- A group DM or private Slack channel that mentions Shadow has one Shadow channel for its current Slack participants
  who are company members. Its Slack threads stay in matching Shadow threads. A reply without a mention is recorded
  there without starting an agent; a mention is the requester's turn with their credentials. Its shared `Realm` does
  not make it visible to every member: channel membership limits all reads, search, files, and notifications.
- Shadow has one company; nobody makes or deletes one. A private channel (`channel.owner_id`) and all
  of it belong to one member. Each member has one own private channel (`channel.personal`,
  `Companies.personalChannelOf`), where their orchestrator starts the work that concerns only them. Every read of channels, threads, files, artifacts, routines, reminders, search, or memory
  names the `Realm` it serves: the person, or for an agent's turn `Threads.realm`, which is its thread's realm, or in a
  channel every member sees the person whose message the turn answers. Only background work that acts for no person
  uses the `all…` reads.
- An orchestrator (`ThreadRef.ownerId` set) belongs to one member: every route, tool, search, and memory that reads
  threads leaves out the orchestrators of other people. `send_to_thread` never goes from one orchestrator to
  another; a thread of a channel sends to an orchestrator only to answer it, after that orchestrator sent it work.
- People's own agents, such as Claude Code or Codex, reach Shadow only through `/mcp` (`src/mcp/`), with an OAuth
  access token of better-auth's OAuth provider, never a session token. Each MCP tool acts as that person, through the
  same service calls and realm as the JSON routes; `ask` reaches everything else through their orchestrator.
- Every file and artifact belongs to a channel; nothing is company-wide. An orchestrator keeps its files and artifacts
  in its person's own channel (`Threads.placeOf`), as its thread sits in a channel that others see.
- Serve HTML that an agent or a person wrote only from `/a/:id/content`, with its `sandbox` content policy; never run
  it on Shadow's origin.

## Web app data

- Data that changes keeps its rows in a TanStack DB collection (`web/<module>/data.ts`), whose `onInsert`, `onUpdate`,
  and `onDelete` call the API, so a change shows at once and rolls back if the server refuses it. Other data uses
  TanStack Query. The Query cache is saved in IndexedDB, so the app opens on what it showed last.
- The event streams of `docs/api.md` keep open threads and the working threads current; do not poll what they send.
- Text messages go through the outbox (`web/threads/outbox.ts`), which keeps them in localStorage and sends them with a
  `requestId` once Shadow answers; a message with files needs a connection.
- The saved cache and the outbox belong to one person (`confirmPerson` in `web/app/query.ts`): after a `401` or the
  start of a sign-in they wait; the same person gets both back, and the browser forgets both for another person.
- The app page has a content policy (`src/app/web.ts`): scripts, pictures, and frames come only from Shadow. A
  picture from the web in Markdown shows as a link.
- `bun start` builds the app into `dist/web/` first; `bun run dev` rebuilds it on every change.

## Modules

- `src/` is a modular monolith. A module (`accounts`, `companies`, `llm`, `integrations`, `artifacts`,
  `browser`, `sources`, `computer`, `notifications`, `threads`, `search`, `routines`, `reminders`, `agenda`, `intake`, `linear`, `feedback`, `slack`, `mcp`) holds one domain: its service, routes, and tests. `src/platform/`
  is shared code that knows no domain; `src/app/` composes the services and holds the route helpers.
- A module uses only the modules before it in that list, through their `<module>.ts` file, or their `pages.ts` from
  routes. A module reads only the tables it owns. `test/architecture.test.ts` enforces these rules;
  `docs/modular-monolith.md` explains them.
- `web/` has the same modules, and `settings`; each uses only `web/app/`, `web/ui/`, and the modules before it. It never
  imports from `src/`: `web/app/types.ts` holds the types of `docs/api.md`, and `test/web-types.test.ts` checks them
  against the server's.
- Register new route tables in `src/app/routes.ts` and new services in `createApp` in `src/app/app.ts`.
- A person adds integration credentials only in their own Settings, never in Company settings. The one exception is a
  read-only key of the whole company (`Connector.companyKey`, `company_key`), such as Linear's, which an admin gives in
  Company settings: a turn of a person without their own account, or of no person, uses it with only the read tools. Like a
  private channel, each one belongs to one member (`credential.owner_id`) and is private to their
  turns; only its owner changes or removes it. A
  tool call uses only the credential of its turn's person (`src/integrations/integrations.ts`). A
  person can connect several accounts of one integration; each tool takes an `account`.
- A connector tool that acts as a person, such as one that sends mail or a message, has an `approval`: the owner of
  its credential allows each call in the thread, and a routine's script cannot call it. A connector lists such tools
  of its MCP server in `approvedTools`.
- The model calls only the core tools of channels, threads, files, and web search directly. Every other tool is
  script-only (`callers: ["tools"]`) and its name starts with its codemode namespace: `NAMESPACES` in
  `src/threads/threads.ts`, or `<integration>_` for a connector, whose MCP server gives its tools.
- A prompt section of the agents renders the same text until its content changes: no times and no order by time. Pi
  Durable adds each changed section to the conversation again, so a section that changes often repeats itself.
- How Shadow talks (voice, length, humor) is only in `SOUL` in `src/threads/threads.ts`, the first section of every
  agent's prompt; `INSTRUCTIONS` and the task texts say how it works and never set a tone.
- Only connector tools with an `approval` or in `approvedTools` wait for a person. All web traffic of agents goes through `Egress`
  (`src/platform/egress.ts`), never a plain `fetch`. Only the work computer (`src/computer/`), one VM with its own
  network, reaches the web without it; `scripts/install-computer-firewall.sh` keeps it off private addresses.
- On the work computer, the commands of each realm run as its own guest user (`guestUser`), without `sudo`; the base
  user only makes those users and keeps the shared desktop. `docs/computer.md` has the setup.

## Design System

- Change colors, type, spacing, radii, sizes, shadows, and pixel icons only in `design/tokens.json`, then run
  `bun run tokens`. Never edit `public/tokens.css` or `web/ui/pixels.ts` by hand. The logo has one drawing, `logo` in
  `scripts/icon.ts`: `bun scripts/icon.ts` makes the icons from it and `bun run tokens` the path that the web app
  draws. Never add another logo.
- Components live in `public/styles.css` and `web/ui/`, with the look of Linear's web app.
- `design/components.md` is the spec for every component, measured from Linear's web app. The web never uses a native
  select, picker, menu, toggle, or alert; menus, selects, and tooltips are Radix primitives in `web/ui/`.

## Code Conventions

- Use descriptive names; do not abbreviate domain concepts.
- Shadow's conversations use Slack's words: the company has channels, as a Slack workspace does, and a channel has threads. A source's own
  conversation, such as a Slack conversation of a watched account, is a `chat` (`WatchedItem.chat`).
- Do not introduce `mock.module()` in tests; use dependency injection.
- Order functions top-down by call hierarchy, with entry points before their helpers.
- Use JSDoc for exported user-facing code examples.
- Every backend HTTP route declares `auth: 'required' | 'optional' | 'none'`.
- Deletes are soft; nothing is ever removed. Set `deleted_at` and leave such rows out of every read; move a deleted
  file aside. A unique name gets `~<id>` when deleted, so the name is free again. `docs/data.md` has the rules.

## Verification

Run the smallest relevant check while developing and the full test sweep once before handoff.

## Shortcuts

- `agent-learn` / `al`: add only stable, reusable, non-discoverable guidance; otherwise change nothing.
- `agent-check` / `ac`: run lint, typecheck, and relevant tests; fix and re-run failures.
- `agent-commit` / `acm`: run `al`, `ac`, and the full test sweep, then commit only intended files using a Conventional
  Commit with any known ticket; do not add AI attribution.
- `agent-plan` / `ap`: inspect the affected code and write a detailed implementation plan; ask one question only if
  the target is unclear.
- `agent-review` / `ar`: review the branch diff for correctness, security, performance, architecture, and docs.

## Repository Invariants

Every directory containing `AGENTS.md` must contain a sibling `CLAUDE.md` relative symlink to it. `AGENTS.md` is the
source of truth.
