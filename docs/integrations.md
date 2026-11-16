# Integrations

People connect integrations in Settings. Each account is personal and serves only its owner's turns.
A person can connect more than one account of an integration, such as a work and a personal
Google account. Agents name the account with the `account` argument of each tool, and `<integration>_accounts` lists
the accounts. Agents draft mail and messages, and send them as you only after you allow each one: the thread shows
what they send, and you get a notification. The person who added the account allows it. A routine's script cannot send.

Settings shows the steps that set up each integration: click ⓘ on it. The steps are the `guide` of its connector, in
`src/integrations/`.

Shadow has six Google Workspace integrations: Gmail, Drive, Docs, Sheets, Slides, and Calendar. It also has Slack, Notion, Linear, Jira, HubSpot, Pipes, Plaud, and T3 Code, and the company's Slack bot.

The six Google integrations use Google's official remote MCP servers. They use the Google OAuth client configured for Shadow sign-in in `config/shadow.toml`. In Google Cloud, mark that client **Use this client for an AI-powered agent**, and list `base_url/api/v1/integrations/callback` as an authorized redirect URI. Each Google service needs its own Google API and MCP API enabled, and each person connects each service they want to use. Google requires a client ID and secret even for MCP; Shadow uses its existing sign-in client. HubSpot needs its own client, which an admin sets with **Client** in Settings.

Slack needs `slackcli` in the Shadow service's `PATH`; install it, for example with `brew install shaharia-lab/tap/slackcli`, then click **Reload** on Configuration in Company settings.

The sign-in pages return to Shadow at `base_url/api/v1/integrations/callback`. The person signs in in the same browser session used to start the connection.

## Google Workspace MCP

Gmail offers search, thread reading, labels, and drafts. Its MCP server does not send mail or create drafts with attachments. Drive offers file search, read, copy, and create. Docs, Sheets, and Slides expose their official read and edit tools. Calendar reads events and free/busy, and it creates, changes, deletes, and answers events after the person allows each call, because they can email the guests. A Calendar connected before this needs **Connect** again for the new scope. Google MCP does not supply Shadow's automatic mail intake, attachment saving, or the former command tools.

## Slack

Shadow uses [slackcli](https://github.com/shaharia-lab/slackcli) with the session of your browser, so it needs no Slack
app and no administrator. In Slack's web app, copy a request to `api/` from the developer tools as cURL, and paste it
in Shadow: slackcli checks the session with Slack, and Shadow keeps it encrypted and names the account after the Slack
workspace. Add each Slack workspace on its own. The session gives the same access as your login, and it ends when you
sign out of Slack in that browser.

### The Slack bot of the company

The channels that every member sees copy the public channels of the company's Slack; nobody makes them by hand. An
admin connects the bot once in Company settings, where the info button next to **Connect** shows these steps:

1. **Create app** opens Slack's app creation with
   [slack-app-manifest.json](../web/companies/slack-app-manifest.json) and Shadow's own hostname in `unfurl_domains`;
   **Copy manifest** copies it for **Create New App › From a manifest**. Pick the company's Slack workspace and click
   **Create**. The manifest turns on Slack's agent view, Socket Mode, interactivity, the Home tab, and the scopes and
   events below. Slack cannot switch an app back from the agent view, so turn it on for an existing app only when this
   version of Shadow runs. Keep it an app of your own workspace: Slack gives such an app the normal limits on reading
   history.
2. **Install App › Install to Workspace › Allow**, and copy the **Bot User OAuth Token** (`xoxb-…`) into Bot token.
3. **Basic Information › App-Level Tokens › Generate** with the scope `connections:write`, and copy the token
   (`xapp-…`) into App token. Shadow opens the connection to Slack, so it needs no public address.

Shadow checks both tokens with Slack, keeps them encrypted, lists the public channels at once, and then listens: Slack
sends each event over the connection, and nothing reads Slack on a timer. A new Slack channel gets its channel, with
Slack's purpose as its summary; a renamed one is renamed; one that Slack archives or deletes is hidden with its threads
until Slack has it again. Slack's general channel takes over `#general`, where each person's own thread lives.

A new channel also gets the last 30 days of its Slack channel at once: the bot joins it, and keeps each day as one
Markdown file of the channel, `slack-YYYY-MM-DD.md`: each message with its author and time, the replies of its thread
under it, and its attachments as files of the channel that it links. Then each new message, reply, edit, and delete
comes as an event; the days they change are written again within a minute, only when their text changes, and older
versions stay. A new connection, as after a restart, reads only what came since the last event; a connection that
Slack refreshes reads nothing, as the events go to the new one. Once a day Shadow reads the last 36 hours again, for an
event that never came. Events, readings, day files, and briefs each wait only for their own kind of work, so a mention
never waits for the first reading of a large workspace, which can take hours, and a day file never waits for a brief. Search finds the files, and
the brief of a channel quiet for 10 minutes reads each new or changed message once, at most the newest 180,000
characters of them.

### Shadow in Slack

People talk to Shadow in Slack as on the web; `src/slack/` is the second app.

- **Mention it** in a public channel: the Slack thread becomes a Shadow thread of that channel, which starts with what
  the Slack thread said before. The turn is the asker's, with their realm and accounts, and it leaves out what only
  they may see, because guests of the Slack channel may read the answer. A routine asked for there can post in Slack. Shadow shows what it does now ("Google mail search…") with a Stop button, and then puts
  its answer in place, with a link to the thread in Shadow and feedback buttons. Shadow follows the thread for 7 days.
- **DM it**: Shadow is an agent in Slack's agent view. Each conversation there is a thread of the DM, whose agent
  session shows "processing" while Shadow works; Slack's Stop stops it. The DM goes to the person's own thread, which
  hands work on to the channels, as on the web, and knows which public channel the person looks at, so "sum up this
  channel" works. The suggested prompts come from the manifest.
- **Group DMs and private channels**: mention Shadow in a group DM, or in a private channel that someone invited
  Shadow to. Shadow makes one channel for that Slack conversation and one thread for each Slack thread where someone
  mentions it. Only current participants who are Shadow members see that channel and its threads. Later replies in
  that Slack thread appear in the Shadow thread without starting an agent; later mentions continue its agent conversation.
  Each turn uses the asker's accounts. The bot posts the
  answer in Slack, where everyone in that conversation can read it, so Shadow leaves out what only the asker may see.
- **Who**: a Slack user whose email is in `allowed_emails` becomes a member at their first message; others get one
  answer that they are not allowed.
- **Listening**: an admin gives a channel a goal on the channel's page, or every channel the default goal in Company
  settings: when Shadow wakes, and how it takes part (**Suggest** writes one from the channel's brief). The goal is the
  consent to listen there. Each new message at the
  top of that channel, and each reply in a thread that Shadow follows, goes through a cheap check with the fast model:
  a message that is clearly not for Shadow costs nothing more. A message that passes starts a turn, which answers only
  when a reply clearly helps, else stays quiet, or tells one person privately. When someone asks for recurring work or a
  reminder there, Shadow offers it to them with **Set it up**: it becomes their own routine, with their accounts and
  posting in the channel, only when they click it; another person's click does nothing. Shadow posts at most 4 such replies an
  hour in a channel, never acts unasked, and stops in a thread that someone mutes. **Listening decisions** shows each
  decision without the text of messages.
- **Approvals**: an action that waits for a person's approval, such as sending mail, asks them in a Slack DM with
  Allow and Deny.
- **Notices**: each notification that a person has not seen, such as a reminder or the morning review, comes as a DM
  too, with all of its text, so the whole morning briefing reads in Slack. A routine with `post_in_slack` posts each answer in its channel's Slack channel; a quiet run posts nothing.
- **Home tab**: what waits for the person, and their routines and reminders.
- **Links**: a link to an artifact shows its title.

Each person's own Slack account below stays theirs.

Agents search and read messages, channels, threads, unread messages, and canvases, find people, make drafts that you
send from Slack, and send messages after you allow each one. Each command runs in a home of its own, which Shadow
removes after it.

## Notion, Linear, and Jira

Each is the service's own MCP server: Notion at `https://mcp.notion.com/mcp`, Linear at `https://mcp.linear.app/mcp`,
and Atlassian's Rovo MCP server at `https://mcp.atlassian.com/v1/mcp` for Jira and Confluence. Click **Connect**, sign
in; Shadow registers itself with the server, so nobody makes an app.
Agents get the server's tools with what your account may see and do: they search and read, and they create or change
pages and issues when you ask. A comment, which other people read, waits until you allow that call. When the Atlassian sign-in refuses Shadow, an Atlassian admin allows the Rovo MCP server
for the site.

## HubSpot

HubSpot's MCP server, `https://mcp.hubspot.com`, registers no clients. An admin of Shadow makes one once: in HubSpot,
**Development › MCP Auth Apps**, create an app with the redirect URL `base_url/api/v1/integrations/callback`, then paste its
client ID and client secret with **Client** on HubSpot in Settings. Then each person clicks **Connect** and signs in
to HubSpot. Agents read and change the CRM, with what the person may do there. Landing pages, website pages, blog
posts, and social posts reach the public, so each such call waits until the person allows it. A HubSpot connected
before its server had write tools needs **Connect** again for their scopes.

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
