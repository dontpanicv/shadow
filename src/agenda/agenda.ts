import type { Database } from "bun:sqlite";
import type { Companies } from "../companies/companies.ts";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound } from "../platform/errors.ts";
import { localTime, timeZone } from "../platform/time.ts";
import {
  dueTime,
  type Reminder,
  type Reminders,
} from "../reminders/reminders.ts";
import { nextRun, type Routine, type Routines } from "../routines/routines.ts";
import type {
  Approval,
  Suggestion as ReviewSuggestion,
  Threads,
} from "../threads/threads.ts";

/** An automation that Shadow suggests to a person; nothing runs until they accept it. */
export interface Suggestion {
  readonly id: string;
  readonly kind: "routine" | "reminder";
  /** The routine's name, or the reminder's text. */
  readonly name: string;
  /** The routine's instructions, or the reminder's text. */
  readonly text: string;
  /** The routine's cron expression in the server's time zone; null for a reminder. */
  readonly schedule: string | null;
  /** When the reminder is due, or the routine's first run. */
  readonly at: number | null;
  /** The channel the routine runs in. */
  readonly channelId: string;
  /** The thread whose messages gave the suggestion. */
  readonly threadId: string;
  readonly createdAt: number;
}

/** What Shadow will do for a person, and what waits for them. */
export interface Upcoming {
  readonly routines: readonly Routine[];
  /** The pending reminders for the person or from them. */
  readonly reminders: readonly Reminder[];
  readonly suggestions: readonly Suggestion[];
  /** The actions that wait until the person allows them. */
  readonly approvals: readonly {
    readonly threadId: string;
    readonly approval: Approval;
  }[];
}

export type AgendaCompanies = Pick<
  Companies,
  "channelsIn" | "members" | "requireMember"
>;
export type AgendaThreads = Pick<Threads, "approvalsFor" | "orchestrator">;
export type AgendaRoutines = Pick<Routines, "create" | "inCompany">;
export type AgendaReminders = Pick<
  Reminders,
  "cancel" | "create" | "get" | "list"
>;

/** A person has at most this many suggestions waiting, so Shadow asks little. */
const MAX_OPEN = 3;
/** The answered suggestions that a review sees, so that it does not ask again. */
const ANSWERED = 20;
const COLUMNS =
  "id, kind, name, text, schedule, at, channel_id AS channelId, thread_id AS threadId, created_at AS createdAt";

interface SuggestionRow extends Omit<Suggestion, "at"> {
  readonly at: string | null;
}

/**
 * Each person's agenda: the routines and reminders that Shadow runs for them, the approvals that wait for them, and the
 * automations that Shadow suggests. Shadow suggests and never makes an automation itself: a suggestion becomes a
 * routine or a reminder only when its person accepts it.
 */
export class Agenda {
  constructor(
    private readonly database: Database,
    private readonly companies: AgendaCompanies,
    private readonly threads: AgendaThreads,
    private readonly routines: AgendaRoutines,
    private readonly reminders: AgendaReminders
  ) {}

  /**
   * Keeps a suggestion from a review for its person, unless they have enough waiting, already have it, or declined
   * it; a schedule or a time that does not work is dropped.
   */
  offer(
    companyId: string,
    threadId: string,
    channelId: string,
    suggestion: ReviewSuggestion
  ): string | null {
    const routine = suggestion.kind === "routine";
    try {
      if (routine) {
        if (nextRun(suggestion.schedule, Date.now()) === null) {
          return null;
        }
      } else {
        dueTime(suggestion.at, timeZone(), Date.now());
      }
    } catch {
      return null;
    }
    const name = routine ? suggestion.name : suggestion.text;
    const { open, same } = this.database
      .query(
        "SELECT count(*) FILTER (WHERE answered_at IS NULL) AS open, count(*) FILTER (WHERE kind = ? AND lower(name) = lower(?)) AS same FROM suggestion WHERE company_id = ? AND person_id = ? AND deleted_at IS NULL"
      )
      .get(suggestion.kind, name, companyId, suggestion.personId) as {
      open: number;
      same: number;
    };
    if (open >= MAX_OPEN || same > 0) {
      return null;
    }
    const id = Bun.randomUUIDv7();
    this.database
      .query(
        "INSERT INTO suggestion (id, company_id, person_id, thread_id, channel_id, kind, name, text, schedule, at, time_zone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        companyId,
        suggestion.personId,
        threadId,
        channelId,
        suggestion.kind,
        name,
        routine ? suggestion.instructions : suggestion.text,
        routine ? suggestion.schedule : null,
        routine ? null : suggestion.at,
        routine ? null : timeZone(),
        Date.now()
      );
    return id;
  }

  /** Gives the open suggestions of a thread the channel it moved to, where an accepted routine then runs. */
  /** Moves the open suggestions of channel `from` to channel `to`, as when one channel merges into another. */
  moveChannel(from: string, to: string): void {
    this.database
      .query(
        "UPDATE suggestion SET channel_id = ? WHERE channel_id = ? AND answered_at IS NULL AND deleted_at IS NULL"
      )
      .run(to, from);
  }

  moveWithThread(threadId: string, channelId: string): void {
    this.database
      .query(
        "UPDATE suggestion SET channel_id = ? WHERE thread_id = ? AND answered_at IS NULL AND deleted_at IS NULL"
      )
      .run(channelId, threadId);
  }

  /** What a review may not suggest to a person again, as lines: their routines, reminders, and suggestions. */
  automations(companyId: string, personId: string): string {
    const person = this.companies
      .members(companyId, { id: personId, name: "", email: "" })
      .find((member) => member.userId === personId);
    if (!person) {
      return "";
    }
    const user = { id: personId, name: person.name, email: person.email };
    const routines = this.routines
      .inCompany(companyId, personId)
      .map(
        (routine) =>
          `- Routine "${routine.name}" (${routine.schedule})${routine.enabled ? "" : ", paused"}`
      );
    const reminders = this.pendingReminders(companyId, user).map(
      (reminder) =>
        `- Reminder for ${localTime(reminder.dueAt, reminder.timeZone)} (${reminder.timeZone}): ${reminder.text}`
    );
    const suggested = (
      this.database
        .query(
          `SELECT kind, name, answered_at AS answeredAt, accepted FROM suggestion WHERE company_id = ? AND person_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${ANSWERED}`
        )
        .all(companyId, personId) as {
        kind: string;
        name: string;
        answeredAt: number | null;
        accepted: number | null;
      }[]
    ).map((row) => `- Suggested ${row.kind} "${row.name}": ${answerOf(row)}`);
    const lines = [...routines, ...reminders, ...suggested];
    return lines.length ? `${person.name}:\n${lines.join("\n")}` : "";
  }

  /** The suggestions that wait for the person, oldest first. */
  suggestions(companyId: string, user: User): Suggestion[] {
    this.companies.requireMember(companyId, user);
    return (
      this.database
        .query(
          `SELECT ${COLUMNS} FROM suggestion WHERE company_id = ? AND person_id = ? AND answered_at IS NULL AND deleted_at IS NULL ORDER BY created_at`
        )
        .all(companyId, user.id) as SuggestionRow[]
    ).map((row) => suggestionOf(row));
  }

  /**
   * Answers a suggestion of the person: `accept` makes the routine in its channel, or the reminder in their
   * orchestrator, both as theirs, and returns its id; otherwise reviews do not ask again, and it returns null.
   */
  async answer(
    companyId: string,
    user: User,
    id: string,
    accept: boolean
  ): Promise<string | null> {
    this.companies.requireMember(companyId, user);
    const row = this.database
      .query(
        `SELECT ${COLUMNS}, time_zone AS timeZone FROM suggestion WHERE id = ? AND company_id = ? AND person_id = ? AND answered_at IS NULL AND deleted_at IS NULL`
      )
      .get(id, companyId, user.id) as
      | (SuggestionRow & { timeZone: string | null })
      | null;
    if (!row) {
      throw notFound();
    }
    let resultId: string | null = null;
    if (accept) {
      resultId = Bun.randomUUIDv7();
      if (row.kind === "routine") {
        if (
          !this.companies
            .channelsIn(companyId, user.id)
            .some((channel) => channel.id === row.channelId)
        ) {
          throw new HttpError(409, "Its channel is gone");
        }
        this.routines.create(companyId, row.channelId, {
          id: resultId,
          name: row.name,
          schedule: row.schedule!,
          instructions: row.text,
          createdBy: user.id,
        });
      } else {
        const orchestrator = await this.threads.orchestrator(companyId, user);
        try {
          this.reminders.create(companyId, user, orchestrator.id, user.id, {
            id: resultId,
            text: row.text,
            at: row.at!,
            timeZone: row.timeZone ?? timeZone(),
            createdBy: user.id,
          });
        } catch (error) {
          throw error instanceof HttpError
            ? error
            : new HttpError(409, "That time has passed");
        }
      }
    }
    this.database
      .query(
        "UPDATE suggestion SET answered_at = ?, accepted = ?, result_id = ? WHERE id = ?"
      )
      .run(Date.now(), accept ? 1 : 0, resultId, id);
    return resultId;
  }

  /** The person's agenda: the routines they see, their pending reminders, suggestions, and approvals. */
  upcoming(companyId: string, user: User): Upcoming {
    this.companies.requireMember(companyId, user);
    return {
      routines: this.routines.inCompany(companyId, user.id),
      reminders: this.pendingReminders(companyId, user),
      suggestions: this.suggestions(companyId, user),
      approvals: this.threads.approvalsFor(companyId, user),
    };
  }

  /** Cancels a pending reminder for the person or from them. */
  cancelReminder(companyId: string, user: User, id: string): void {
    const reminder = this.reminders.get(companyId, user, user.id, id);
    if (reminder.recipientId !== user.id && reminder.createdBy !== user.id) {
      throw notFound();
    }
    try {
      this.reminders.cancel(companyId, user, user.id, id);
    } catch (error) {
      throw error instanceof HttpError
        ? error
        : new HttpError(409, (error as Error).message);
    }
  }

  private pendingReminders(companyId: string, user: User): Reminder[] {
    return this.reminders
      .list(companyId, user, user.id)
      .filter(
        (reminder) =>
          reminder.deliveredAt === null &&
          reminder.cancelledAt === null &&
          (reminder.recipientId === user.id || reminder.createdBy === user.id)
      );
  }
}

function answerOf(row: {
  readonly answeredAt: number | null;
  readonly accepted: number | null;
}): string {
  if (row.answeredAt === null) {
    return "waiting";
  }
  return row.accepted ? "accepted" : "declined";
}

function suggestionOf(row: SuggestionRow): Suggestion {
  return {
    ...row,
    at:
      row.kind === "reminder"
        ? Date.parse(row.at!)
        : nextRun(row.schedule!, Date.now()),
  };
}
