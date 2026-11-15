import type { Database } from "bun:sqlite";
import type { User } from "../platform/auth.ts";
import { notFound } from "../platform/errors.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";

/** Something that needs a person's attention. It opens its thread, or its channel when `threadId` is null. */
export interface Notification {
  readonly id: string;
  readonly workspaceId: string;
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
  "workspaceId" | "channelId" | "threadId" | "title" | "text"
> & {
  readonly userId: string;
  /** A durable producer's id, so a retry creates no second notification. */
  readonly id?: string;
};

export interface Inbox {
  readonly notifications: readonly Notification[];
  /** The unread notifications of this workspace. */
  readonly unread: number;
}

export type NotificationWorkspaces = Pick<Workspaces, "requireMember">;

/** The newest notifications an inbox shows. */
const INBOX_SIZE = 100;
/** The most of an answer a notification keeps; the thread has all of it. */
const MAX_TEXT = 500;
const COLUMNS =
  "id, workspace_id AS workspaceId, channel_id AS channelId, thread_id AS threadId, title, text, created_at AS createdAt, read_at AS readAt";

/**
 * The inbox of each person. A person who has the thread open on a screen sees what happens there, so a notification
 * for that thread is read at once.
 */
export class Notifications {
  /** How many open screens of each person show each thread, by `<user> <thread>`. */
  private readonly watching = new Map<string, number>();

  constructor(
    private readonly database: Database,
    private readonly workspaces: NotificationWorkspaces
  ) {}

  /**
   * Puts a notification in a person's inbox, read at once when they have the thread open.
   *
   * @example
   * notifications.notify({ workspaceId, userId: anna.id, channelId, threadId, title: "Flights", text: answer });
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
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      threadId: input.threadId,
      title: input.title,
      text: truncate(plainText(input.text), MAX_TEXT),
      createdAt: now,
      readAt: seen ? now : null,
    };
    this.database
      .query(
        "INSERT INTO notification (id, workspace_id, user_id, channel_id, thread_id, title, text, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        notification.id,
        notification.workspaceId,
        input.userId,
        notification.channelId,
        notification.threadId,
        notification.title,
        notification.text,
        notification.createdAt,
        notification.readAt
      );
    return notification;
  }

  inbox(workspaceId: string, user: User): Inbox {
    this.workspaces.requireMember(workspaceId, user);
    const notifications = this.database
      .query(
        `SELECT ${COLUMNS} FROM notification WHERE user_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(user.id, workspaceId, INBOX_SIZE) as Notification[];
    const { unread } = this.database
      .query(
        "SELECT count(*) AS unread FROM notification WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL"
      )
      .get(user.id, workspaceId) as { unread: number };
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

  /** Marks one notification of the person read, or all of them in the workspace for a null `id`. */
  read(workspaceId: string, user: User, id: string | null): Inbox {
    this.workspaces.requireMember(workspaceId, user);
    const now = Date.now();
    if (id === null) {
      this.database
        .query(
          "UPDATE notification SET read_at = ? WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL"
        )
        .run(now, user.id, workspaceId);
    } else if (
      this.database
        .query(
          "UPDATE notification SET read_at = coalesce(read_at, ?) WHERE id = ? AND user_id = ? AND workspace_id = ?"
        )
        .run(now, id, user.id, workspaceId).changes === 0
    ) {
      throw notFound();
    }
    return this.inbox(workspaceId, user);
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
