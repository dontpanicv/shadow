/**
 * The one form in which Shadow keeps and shows a Slack message, whichever way it came: the bot's copy of the public
 * channels and the slackcli tools of a person's account give the same names, times, and links.
 */

import { localClock, localDay, localTime } from "../platform/time.ts";

const MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

/** A user as Slack's users.info gives it. */
export interface SlackUser {
  readonly id?: string;
  readonly name?: string;
  readonly real_name?: string;
  /** The person's time zone in their Slack profile, such as Asia/Bangkok. */
  readonly tz?: string;
  readonly profile?: {
    readonly real_name?: string;
    readonly display_name?: string;
  };
}

/** The name that Shadow gives a Slack user: the real name, else the display name, the handle, or the ID. */
export function slackPersonName(
  user: SlackUser | undefined,
  id: string
): string {
  return (
    user?.real_name ||
    user?.profile?.real_name ||
    user?.profile?.display_name ||
    user?.name ||
    id
  );
}

/** The user IDs that a message's text mentions. */
export function slackMentions(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map(([, id]) => id!))];
}

/** Slack's markup as Markdown: `@name` for people, `#name` for channels, and links. */
export function slackMarkdown(
  text: string,
  names: ReadonlyMap<string, string>
): string {
  return text
    .replace(MENTION, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)[^>]*>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The link of a message, as Slack's "Copy link" gives it; a reply's link opens its thread. */
export function slackPermalink(
  workspaceUrl: string,
  channelId: string,
  ts: string,
  threadTs?: string | null
): string {
  const link = new URL(
    `/archives/${channelId}/p${ts.replace(".", "")}`,
    workspaceUrl
  );
  if (threadTs && threadTs !== ts) {
    link.searchParams.set("thread_ts", threadTs);
    link.searchParams.set("cid", channelId);
  }
  return link.href;
}

/** The company's day of a Slack timestamp, as YYYY-MM-DD. */
export function slackDay(ts: string): string {
  return localDay(Number(ts) * 1000);
}

/** The company's clock time of a Slack timestamp, as HH:MM, under a heading that gives its day. */
export function slackClock(ts: string): string {
  return localClock(Number(ts) * 1000);
}

/** The time of a Slack timestamp in the form of every time of Shadow, such as 2026-11-07T09:00+01:00. */
export function slackTime(ts: string): string {
  return localTime(Number(ts) * 1000);
}
