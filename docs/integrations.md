# Integrations

People connect integrations in Settings. A new account is private, for the person's own turns; the **Private** switch
on it shares it with the turns of every member. A person can connect more than one account of an integration, such as a work and a personal
Google account. Agents name the account with the `account` argument of each tool, and `<integration>_accounts` lists
the accounts. Agents draft mail and messages, and send them as you only after you allow each one: the thread shows
what they send, and you get a notification. The person who added the account allows it, also for the turn of another
member. A routine's script cannot send.

Settings shows the steps that set up each integration: click ⓘ on it. The steps are the `guide` of its connector, in
`src/integrations/`.

Shadow has nine integrations: Google, Slack, Notion, Linear, Jira, HubSpot, Pipes, Plaud, and T3 Code, and the
company's Slack bot, which an admin connects in Company settings.

Google and HubSpot need an OAuth client of your own, which an admin sets with **Client** on the integration; the next
sign-in uses it at once. Until then, only admins see it. Google also needs `gog` on the Shadow machine, and Slack `slackcli`,
in the `PATH` of the Shadow service; install them, for example with `brew install gogcli` and
`brew install shaharia-lab/tap/slackcli`. Then click **Reload** on Configuration in Settings. Shadow does not show
these integrations without them.

The sign-in pages of every integration but Slack end at `https://localhost/shadow-sign-in?code=…`. Nothing answers at
that address, so the browser shows an error page. Copy the address from the address bar and paste it into Shadow.

## Google: Gmail, Calendar, and Drive

Shadow calls Google's APIs through [gog](https://github.com/openclaw/gogcli), with the access token of each sign-in,
which Shadow renews with its refresh token. One client serves all accounts: personal and Google Workspace ones, of every
person. Google shows that it has not verified the app; an app that is not verified can have up to 100 users.

Agents search and read mail, save its attachments to the thread's channel, make drafts, and send mail or one of your drafts after you allow it, with files of the
company attached; gog blocks sending in every other tool. For a draft, the approval shows the draft as it is in
Gmail, and Shadow sends nothing when the draft changed after you allowed it. Agents use only these tools for mail, never a mail app on a machine. They read calendars, find free time, and create, change, and delete events; the guests get an email about it only when the agent asks for it and you allow it.
They search Drive, read Docs and Sheets, create Docs, and change only the Docs that they created. They upload files of
the company to Drive and share the files that they uploaded or created, with anyone who has the link, a person, or a
domain; Google sends no invitation email.

## Slack

Shadow uses [slackcli](https://github.com/shaharia-lab/slackcli) with the session of your browser, so it needs no Slack
app and no administrator. In Slack's web app, copy a request to `api/` from the developer tools as cURL, and paste it
in Shadow: slackcli checks the session with Slack, and Shadow keeps it encrypted and names the account after the Slack
workspace. Add each Slack workspace on its own. The session gives the same access as your login, and it ends when you
sign out of Slack in that browser.

### The Slack bot of the company

The channels that every member sees copy the public channels of the company's Slack; nobody makes them by hand. An
admin connects the bot once in Company settings:

1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App › From a manifest**, select the
   company's Slack workspace, and paste [slack-app-manifest.json](slack-app-manifest.json), with Shadow's own
   hostname in `unfurl_domains`. The manifest turns on Slack's agent view, Socket Mode, interactivity, the Home tab, and
   the scopes and events below. Slack cannot switch an app back from the agent view, so turn it on for an existing app
   only when this version of Shadow runs. Keep it an app of your own workspace: Slack gives such an app the normal limits on reading history.
2. Under **Basic Information › App-Level Tokens**, make a token with the scope `connections:write` (`xapp-…`).
   Shadow opens the connection to Slack, so it needs no public address.
3. Install the app to the Slack workspace, copy the **Bot User OAuth Token** (`xoxb-…`), and paste both tokens under
   **Slack** in Company settings.

Shadow checks both tokens with Slack, keeps them encrypted, lists the public channels at once, and then listens: Slack
sends each event over the connection, and nothing reads Slack on a timer. A new Slack channel gets its channel, with
Slack's purpose as its summary; a renamed one is renamed; one that Slack archives or deletes is hidden with its threads
until Slack has it again. Slack's general channel takes over `#general`, where each person's own thread lives.

A new channel also gets the last 30 days of its Slack channel at once: the bot joins it, and keeps each day as one
Markdown file of the channel, `slack-YYYY-MM-DD.md`: each message with its author and time, the replies of its thread
under it, and its attachments as files of the channel that it links. Then each new message, reply, edit, and delete
comes as an event; the days they change are written again within a minute, only when their text changes, and older
versions stay. A new connection, as after a restart, reads only what came since the last event, and once a day Shadow
reads the last 30 days again, for an event that never came. Search finds the files, and the brief of a channel quiet
for 10 minutes reads each new or changed message once.

### Shadow in Slack

People talk to Shadow in Slack as on the web; `src/slack/` is the second app.

- **Mention it** in a public channel: the Slack thread becomes a Shadow thread of that channel, which starts with what
  the Slack thread said before. Shadow shows what it does now ("Google mail search…") with a Stop button, and then puts
  its answer in place, with a link to the thread in Shadow and feedback buttons. Shadow follows the thread for 7 days.
- **DM it**: Shadow is an agent in Slack's agent view. Each conversation there is a thread of the DM, whose agent
  session shows "processing" while Shadow works; Slack's Stop stops it. The DM goes to the person's own thread, which
  hands work on to the channels, as on the web, and knows which public channel the person looks at, so "sum up this
  channel" works. The suggested prompts come from the manifest.
- **Group DMs**: mention Shadow in a group DM. The asker's own thread answers, with the group DM's conversation as
  data, and it leaves out what only the asker may see, because everyone in the group reads the answer. Shadow keeps no
  shared place for a group, so the group's conversation stays in Slack.
- **Who**: a Slack user whose email is in `allowed_emails` becomes a member at their first message; others get one
  answer that they are not allowed. Private channels come later.
- **Listening**: an admin gives a channel a goal in Company settings: when Shadow wakes, and how it takes part
  (**Suggest** writes one from the channel's brief). The goal is the consent to listen there. Each new message at the
  top of that channel, and each reply in a thread that Shadow follows, goes through a cheap check with the fast model:
  a message that is clearly not for Shadow costs nothing more. A message that passes starts a turn, which answers only
  when a reply clearly helps, else stays quiet, or tells one person privately. Shadow posts at most 4 such replies an
  hour in a channel, never acts unasked, and stops in a thread that someone mutes. **Listening decisions** shows each
  decision without the text of messages.
- **Approvals**: an action that waits for a person's approval, such as sending mail, asks them in a Slack DM with
  Allow and Deny.
- **Notices**: each notification that a person has not seen, such as a reminder or the morning review, comes as a DM
  too. A routine with `post_in_slack` posts each answer in its channel's Slack channel; a quiet run posts nothing.
- **Home tab**: what waits for the person, and their routines and reminders.
- **Links**: a link to an artifact shows its title.

Each person's own Slack account below stays theirs.

Agents search and read messages, channels, threads, unread messages, and canvases, find people, make drafts that you
send from Slack, and send messages after you allow each one. Each command runs in a home of its own, which Shadow
removes after it.

## Notion, Linear, and Jira

Each is the service's own MCP server: Notion at `https://mcp.notion.com/mcp`, Linear at `https://mcp.linear.app/mcp`,
and Atlassian's Rovo MCP server at `https://mcp.atlassian.com/v1/mcp` for Jira and Confluence. Click **Connect**, sign
in, and paste the address where the sign-in ends; Shadow registers itself with the server, so nobody makes an app.
Agents get the server's tools with what your account may see and do: they search and read, and they create or change
pages and issues when you ask. Tools that only post a comment for other people are hidden, because an MCP server's tool
cannot wait for your approval. When the Atlassian sign-in refuses Shadow, an Atlassian admin allows the Rovo MCP server
for the site.

## HubSpot

HubSpot's MCP server, `https://mcp.hubspot.com`, registers no clients. An admin of Shadow makes one once: in HubSpot,
**Development › MCP Auth Apps**, create an app with the redirect URL `https://localhost/shadow-sign-in`, then paste its
client ID and client secret with **Client** on HubSpot in Settings. Then each person clicks **Connect** and signs in
to HubSpot. Agents read the CRM, with what the person may see.

## Pipes and Engage

Each Meiro Pipes instance has its own MCP server at `/mcp`. Enter the address of your instance, click **Continue**,
sign in to Pipes, and select **Allow**. Agents read the configuration, profiles, events, dashboard metrics, profile
reports, journey and delivery performance, and the product guide, with your access. A change is only a proposal: Pipes
sends you a link, and the change happens after you approve it there. Settings › API tokens in Pipes lists Shadow under
connected apps.

## T3 Code

Agents use the MCP server of the person's own T3 Code: they list its projects, start a thread in a project, or in a new
worktree of it, with a task, and read, answer, wait for, or stop its threads. Shadow gets only these tools; the others
serve an agent inside a T3 Code thread.

In Settings, **Connect** asks for the address of the T3 Code server, such as `http://my-mac:3774`. Shadow and the
browser of the sign-in must both reach that address, because T3 Code gives tokens only for the address that the
sign-in used. On T3 Code's page, the person chooses the access of Shadow's threads, from read-only to full access, and
approves with their T3 Code session or with a pairing code from `t3 pair`. A thread that Shadow starts runs with at
most that access. T3 Code gives no refresh token: after 30 days, connect it again.
