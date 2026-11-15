import type { Database } from "bun:sqlite";
import type { Companies } from "../companies/companies.ts";
import type { User } from "../platform/auth.ts";
import { notFound } from "../platform/errors.ts";

/** Something that needs a person's attention. It opens its thread, or its channel when `threadId` is null. */
export interface Notification {
  readonly id: string;
  readonly companyId: string;
  readonly channelId: string;
  readonly threadId: string | null;
  readonly title: string;
  /** Plain text, without Markdown. */
  readonly text: string;
  readonly createdAt: number;
  readonly readAt: number | null;
}

export type NotificationInput = Pick<
  Notification,
  "companyId" | "channelId" | "threadId" | "title" | "text"
> & {
  readonly userId: string;
  /** A durable producer's id, so a retry creates no second notification. */
  readonly id?: string;
};

export interface Inbox {
  readonly notifications: readonly Notification[];
  /** The unread notifications of this company. */
  readonly unread: number;
}

export type NotificationCompanies = Pick<Companies, "requireMember">;

/** The newest notifications an inbox shows. */
const INBOX_SIZE = 100;
/** The most of an answer a notification keeps; the thread has all of it. */
const MAX_TEXT = 500;
const COLUMNS =
  "id, company_id AS companyId, channel_id AS channelId, thread_id AS threadId, title, text, created_at AS createdAt, read_at AS readAt";

/**
 * The inbox of each person. A person who has the thread open on a screen sees what happens there, so a notification
 * for that thread is read at once.
 */
export class Notifications {
  /** How many open screens of each person show each thread, by `<user> <thread>`. */
  private readonly watching = new Map<string, number>();
  /** Who also delivers a notification that its person has not seen, such as Slack as a DM. */
  private readonly deliveries: ((
    notification: Notification,
    userId: string,
    markdown: string
  ) => void)[] = [];

  constructor(
    private readonly database: Database,
    private readonly companies: NotificationCompanies
  ) {}

  /**
   * Puts a notification in a person's inbox, read at once when they have the thread open.
   *
   * @example
   * notifications.notify({ companyId, userId: anna.id, channelId, threadId, title: "Flights", text: answer });
   */
  notify(input: NotificationInput): Notification {
    if (input.id) {
      const existing = this.database
        .query(`SELECT ${COLUMNS} FROM notification WHERE id=? AND user_id=?`)
        .get(input.id, input.userId) as Notification | null;
      if (existing) {
        return existing;
      }
    }
    const now = Date.now();
    const seen =
      input.threadId !== null &&
      this.watching.has(watchKey(input.userId, input.threadId));
    const notification: Notification = {
      id: input.id ?? Bun.randomUUIDv7(),
      companyId: input.companyId,
      channelId: input.channelId,
      threadId: input.threadId,
      title: input.title,
      text: truncate(plainText(input.text), MAX_TEXT),
      createdAt: now,
      readAt: seen ? now : null,
    };
    this.database
      .query(
        "INSERT INTO notification (id, company_id, user_id, channel_id, thread_id, title, text, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        notification.id,
        notification.companyId,
        input.userId,
        notification.channelId,
        notification.threadId,
        notification.title,
        notification.text,
        notification.createdAt,
        notification.readAt
      );
    if (!seen) {
      for (const deliver of this.deliveries) {
        deliver(notification, input.userId, input.text);
      }
    }
    return notification;
  }

  /**
   * Also delivers each notification that its person has not seen, such as in a Slack DM, with all of its Markdown, which
   * the inbox keeps only the start of.
   */
  onDelivery(
    deliver: (
      notification: Notification,
      userId: string,
      markdown: string
    ) => void
  ): void {
    this.deliveries.push(deliver);
  }

  inbox(companyId: string, user: User): Inbox {
    this.companies.requireMember(companyId, user);
    const notifications = this.database
      .query(
        `SELECT ${COLUMNS} FROM notification WHERE user_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(user.id, companyId, INBOX_SIZE) as Notification[];
    const { unread } = this.database
      .query(
        "SELECT count(*) AS unread FROM notification WHERE user_id = ? AND company_id = ? AND read_at IS NULL"
      )
      .get(user.id, companyId) as { unread: number };
    return { notifications, unread };
  }

  /** Gives the notifications of a thread the channel it moved to. */
  /** Moves the notifications of channel `from` to channel `to`, as when one channel merges into another. */
  moveChannel(from: string, to: string): void {
    this.database
      .query("UPDATE notification SET channel_id = ? WHERE channel_id = ?")
      .run(to, from);
  }

  moveWithThread(threadId: string, channelId: string): void {
    this.database
      .query("UPDATE notification SET channel_id = ? WHERE thread_id = ?")
      .run(channelId, threadId);
  }

  /** Marks one notification of the person read, or all of them in the company for a null `id`. */
  read(companyId: string, user: User, id: string | null): Inbox {
    this.companies.requireMember(companyId, user);
    const now = Date.now();
    if (id === null) {
      this.database
        .query(
          "UPDATE notification SET read_at = ? WHERE user_id = ? AND company_id = ? AND read_at IS NULL"
        )
        .run(now, user.id, companyId);
    } else if (
      this.database
        .query(
          "UPDATE notification SET read_at = coalesce(read_at, ?) WHERE id = ? AND user_id = ? AND company_id = ?"
        )
        .run(now, id, user.id, companyId).changes === 0
    ) {
      throw notFound();
    }
    return this.inbox(companyId, user);
  }

  /**
   * Notes that a screen of the person shows a thread, and marks the thread's notifications read. Call the returned
   * function when the screen closes or goes to the background.
   */
  watch(user: User, threadId: string): () => void {
    const key = watchKey(user.id, threadId);
    this.watching.set(key, (this.watching.get(key) ?? 0) + 1);
    this.database
      .query(
        "UPDATE notification SET read_at = ? WHERE user_id = ? AND thread_id = ? AND read_at IS NULL"
      )
      .run(Date.now(), user.id, threadId);
    let watching = true;
    return () => {
      if (!watching) {
        return;
      }
      watching = false;
      const count = (this.watching.get(key) ?? 1) - 1;
      if (count === 0) {
        this.watching.delete(key);
      } else {
        this.watching.set(key, count);
      }
    };
  }
}

/** Markdown as one line of plain text: link texts stay, pictures, cards, markup, and tags go. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^```card[^\n]*\n[\s\S]*?^```[^\S\n]*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, length: number): string {
  return text.length <= length
    ? text
    : `${text.slice(0, length - 1).trimEnd()}…`;
}

function watchKey(userId: string, threadId: string): string {
  return `${userId} ${threadId}`;
}
