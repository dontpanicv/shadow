import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { HttpError, notFound } from "../platform/errors.ts";
import { localDay } from "../platform/time.ts";

/** on_me is section A, waiting B, dropped C (a B row that did not move), and decision E (a decision parked). */
export const LEDGER_SECTIONS = [
  "on_me",
  "waiting",
  "dropped",
  "decision",
] as const;
export type LedgerSection = (typeof LEDGER_SECTIONS)[number];
const BUCKETS = ["today", "week", "parked"] as const;
const WHY_MINE = [
  "promise",
  "direct_ask",
  "reply_owed",
  "blocking_decision",
] as const;
const EVIDENCE = ["direct", "transcript", "notes_page", "summary"] as const;
const SOURCE_TYPES = [
  "slack",
  "email",
  "meeting",
  "calendar",
  "dictation",
  "notion",
  "linear",
] as const;
export const MEETING_COVERAGE = [
  "gemini_transcript",
  "notion_transcript",
  "plaud_transcript",
  "summary_only",
  "notes_page_only",
  "pending",
  "not_recorded",
  "skipped",
] as const;

/** A B row moves to C after this many business days without movement. */
export const WAITING_DAYS = 5;
/** A C row needs the person after this many business days in C. */
export const DROPPED_DAYS = 10;
/** The emoji whose reaction makes a Slack message a row of the person's ledger. */
export const LEDGER_EMOJI = "ledger";
/** A ledger row that no intake source backs never goes to the judge's time review; the morning brief keeps it. */
const NEVER = 8_640_000_000_000_000;
const DAY = 24 * 60 * 60_000;
/** The check state of a row's state. */
const CHECK_STATES = {
  open: "open",
  done: "resolved",
  written_off: "stopped",
} as const;
/** What a state of a Linear issue does to its rows; the other states are only movement. */
const ISSUE_STATES: Record<string, "resolved" | "stopped"> = {
  completed: "resolved",
  canceled: "stopped",
};
const CLOSED_NOTES = {
  resolved: " Closed as done.",
  stopped: " Closed as written off.",
} as const;

/** The ledger fields of a check, next to its text, state, and sources. Times are ms; null when not known. */
export interface LedgerFields {
  /** The row's permanent number for its person, shown as #N. */
  ref: number;
  section: LedgerSection;
  /** Who owes it in section B, or who must be in the room in section E. */
  owedBy: string | null;
  bucket: (typeof BUCKETS)[number] | null;
  whyMine: (typeof WHY_MINE)[number] | null;
  needsYou: boolean;
  client: string | null;
  evidenceKind: (typeof EVIDENCE)[number] | null;
  sourceUrl: string | null;
  sourceType: (typeof SOURCE_TYPES)[number] | null;
  firstAskedAt: number | null;
  dueAt: number | null;
  lastMovementAt: number | null;
  lastChasedAt: number | null;
  movedToCAt: number | null;
  parkedUntil: number | null;
  closedAt: number | null;
  meetingId: string | null;
}

/** A change of one row by an agent or the person: no id makes a new row, unless an open row has the same source. */
export interface LedgerChange {
  id?: string;
  text?: string;
  section?: LedgerSection;
  owedBy?: string | null;
  bucket?: LedgerFields["bucket"];
  whyMine?: LedgerFields["whyMine"];
  needsYou?: boolean;
  client?: string | null;
  evidenceKind?: LedgerFields["evidenceKind"];
  sourceUrl?: string | null;
  sourceType?: LedgerFields["sourceType"];
  firstAskedAt?: string | null;
  dueAt?: string | null;
  lastChasedAt?: string | null;
  parkedUntil?: string | null;
  meetingId?: string | null;
  /** done closes the row, written_off closes it without success, open opens it again. */
  state?: "open" | "done" | "written_off";
  /** The window shows the row moved: Shadow sets its last movement to now. */
  movement?: boolean;
  /** The dated line that History gets; every change has one, and History only grows. */
  note: string;
}

export interface Meeting {
  id: string;
  eventId: string;
  title: string;
  startAt: number;
  endAt: number | null;
  series: string | null;
  eventUrl: string | null;
  transcriptUrl: string | null;
  secondSourceUrl: string | null;
  notesUrl: string | null;
  coverage: (typeof MEETING_COVERAGE)[number];
  purpose: string | null;
  decisions: string | null;
  openQuestions: string | null;
  gaps: string | null;
  topicDiff: string | null;
  external: boolean;
  client: string | null;
  channelChecked: string | null;
  /** The refs of the ledger rows that the meeting opened or moved. */
  actions: number[];
}

export interface MeetingInput
  extends Partial<Omit<Meeting, "id" | "startAt" | "endAt" | "actions">> {
  eventId: string;
  title: string;
  startAt: string;
  endAt?: string | null;
  coverage: Meeting["coverage"];
}

export interface BriefLog {
  windowStart: number;
  windowEnd: number;
  zone: string;
  notCovered: string;
  printedRefs: number[];
}

/** A :ledger: reaction of the person in the bot's copy of Slack, with its message. */
export interface LedgerReaction {
  permalink: string;
  text: string;
  author: string;
  at: number;
  removed: boolean;
}

/** A change of a Linear issue, as the company's Linear feed reads it. */
export interface IssueChange {
  identifier: string;
  url: string;
  /** Linear's state type: completed, canceled, started, unstarted, backlog, or triage. */
  stateType: string;
  stateName: string;
  /** One line for each state move and comment since the last read. */
  changes: string[];
  at: number;
}

interface FieldRow {
  id: string;
  ref: number;
  section: string;
  owed_by: string | null;
  bucket: string | null;
  why_mine: string | null;
  needs_you: number;
  client: string | null;
  evidence_kind: string | null;
  source_url: string | null;
  source_type: string | null;
  first_asked_at: number | null;
  due_at: number | null;
  last_movement_at: number | null;
  last_chased_at: number | null;
  moved_to_c_at: number | null;
  parked_until: number | null;
  closed_at: number | null;
  meeting_id: string | null;
}

const FIELD_COLUMNS =
  "id,ref,section,owed_by,bucket,why_mine,needs_you,client,evidence_kind,source_url,source_type,first_asked_at,due_at,last_movement_at,last_chased_at,moved_to_c_at,parked_until,closed_at,meeting_id";

/**
 * The person's ledger: each check of intake is one row, in section A (on me), B (waiting on others), C (dropped
 * ball), or E (decision parked), with a permanent #ref. History is the check's revisions, which only grow: every
 * change here adds one dated line. Code keeps what is the same every morning (aging, Linear states, :ledger:
 * reactions); the person's Morning brief keeps the rest with the ledger tools.
 */
export class Ledger {
  constructor(private readonly database: Database) {}

  /** The ledger fields of the person's checks, by check id. */
  fields(companyId: string, ownerId: string): Map<string, LedgerFields> {
    const rows = this.database
      .query(
        `SELECT ${FIELD_COLUMNS} FROM intake_check WHERE company_id=? AND owner_id=? AND deleted_at IS NULL`
      )
      .all(companyId, ownerId) as FieldRow[];
    return new Map(rows.map((row) => [row.id, fieldsOf(row)]));
  }

  /** The newest History lines of each check, newest first. */
  notes(
    companyId: string,
    ownerId: string,
    ids: readonly string[],
    limit = 5
  ): Map<string, { at: number; text: string }[]> {
    const notes = new Map<string, { at: number; text: string }[]>();
    const query = this.database.query(
      "SELECT at,quote FROM intake_check_revision WHERE check_id=? AND company_id=? AND owner_id=? AND quote IS NOT NULL ORDER BY id DESC LIMIT ?"
    );
    for (const id of ids) {
      notes.set(
        id,
        (
          query.all(id, companyId, ownerId, limit) as {
            at: number;
            quote: string;
          }[]
        ).map((row) => ({ at: row.at, text: row.quote }))
      );
    }
    return notes;
  }

  /** Makes or changes one row and adds its History line; returns the row's id. */
  save(
    companyId: string,
    ownerId: string,
    change: LedgerChange,
    now = Date.now()
  ): string {
    const note = change.note?.trim();
    if (!note || note.length > 2000) {
      throw new HttpError(
        400,
        "Give a History line of at most 2000 characters"
      );
    }
    validateChange(change);
    return this.database.transaction(() => {
      const id =
        change.id ??
        (change.sourceUrl
          ? this.openBySource(companyId, ownerId, change.sourceUrl)
          : null);
      if (id) {
        this.update(companyId, ownerId, id, change, note, now);
        return id;
      }
      const text = change.text?.trim();
      if (!text) {
        throw new HttpError(400, "A new row needs its text");
      }
      const created = randomUUID();
      const due = time(change.dueAt);
      this.database
        .query(
          "INSERT INTO intake_check(id,company_id,owner_id,thread_id,text,source_ids,explicit_time,check_at,next_review_at,revised_at,first_asked_at,due_at) VALUES(?,?,?,NULL,?,'[]',?,?,?,?,?,?)"
        )
        .run(
          created,
          companyId,
          ownerId,
          text,
          due === null ? 0 : 1,
          due ?? now + 30 * DAY,
          NEVER,
          now,
          time(change.firstAskedAt) ?? now,
          due
        );
      this.setFields(
        created,
        {
          ...change,
          text: undefined,
          dueAt: undefined,
          firstAskedAt: undefined,
        },
        now
      );
      this.labelLatest(companyId, ownerId, created, note, "ledger");
      return created;
    })();
  }

  /** Adds one dated History line, without other changes. */
  note(
    companyId: string,
    ownerId: string,
    id: string,
    text: string,
    at = Date.now()
  ): void {
    this.database
      .query(
        "INSERT INTO intake_check_revision(check_id,company_id,owner_id,at,action,quote,current) SELECT id,company_id,owner_id,?,'note',?,json_object('text',text,'state',state,'sourceIds',json(source_ids),'threadId',thread_id,'checkAt',check_at,'reviewAt',next_review_at,'explicitTime',explicit_time,'notifiedAt',notified_at) FROM intake_check WHERE id=? AND company_id=? AND owner_id=?"
      )
      .run(at, text, id, companyId, ownerId);
  }

  /**
   * The aging rules, in business days (Monday to Friday): a B row without movement for `WAITING_DAYS` moves to C, and
   * a C row that stayed `DROPPED_DAYS` in C needs the person. Returns how many rows changed.
   */
  age(companyId: string, ownerId: string, now: number, zone: string): number {
    const rows = this.database
      .query(
        "SELECT id,section,first_asked_at,last_movement_at,moved_to_c_at,needs_you FROM intake_check WHERE company_id=? AND owner_id=? AND state='open' AND deleted_at IS NULL AND section IN ('waiting','dropped')"
      )
      .all(companyId, ownerId) as {
      id: string;
      section: string;
      first_asked_at: number | null;
      last_movement_at: number | null;
      moved_to_c_at: number | null;
      needs_you: number;
    }[];
    let changed = 0;
    for (const row of rows) {
      const still = row.last_movement_at ?? row.first_asked_at;
      if (
        row.section === "waiting" &&
        still !== null &&
        businessDays(still, now, zone) >= WAITING_DAYS
      ) {
        this.database
          .query(
            "UPDATE intake_check SET section='dropped',moved_to_c_at=? WHERE id=?"
          )
          .run(now, row.id);
        this.note(
          companyId,
          ownerId,
          row.id,
          `Moved to C: no movement for ${WAITING_DAYS} business days.`,
          now
        );
        changed += 1;
      } else if (
        row.section === "dropped" &&
        !row.needs_you &&
        row.moved_to_c_at !== null &&
        businessDays(row.moved_to_c_at, now, zone) >= DROPPED_DAYS
      ) {
        this.database
          .query("UPDATE intake_check SET needs_you=1 WHERE id=?")
          .run(row.id);
        this.note(
          companyId,
          ownerId,
          row.id,
          `Needs you: ${DROPPED_DAYS} business days in C.`,
          now
        );
        changed += 1;
      }
    }
    return changed;
  }

  /**
   * Follows a Linear issue in every open row of the company that names it, by its link or its key: completed closes
   * the row as done, canceled writes it off, and any other change is movement.
   */
  issueChanged(companyId: string, issue: IssueChange): void {
    const pattern = new RegExp(
      `(^|[^A-Za-z0-9-])${issue.identifier}([^0-9]|$)`
    );
    const rows = (
      this.database
        .query(
          "SELECT id,owner_id,text,source_url,last_movement_at FROM intake_check WHERE company_id=? AND state='open' AND deleted_at IS NULL AND (source_url=? OR instr(text,?) > 0 OR EXISTS (SELECT 1 FROM intake_check_revision r WHERE r.check_id=intake_check.id AND instr(r.quote,?) > 0))"
        )
        .all(companyId, issue.url, issue.identifier, issue.identifier) as {
        id: string;
        owner_id: string;
        text: string;
        source_url: string | null;
        last_movement_at: number | null;
      }[]
    ).filter(
      (row) =>
        row.source_url === issue.url ||
        pattern.test(row.text) ||
        this.notes(companyId, row.owner_id, [row.id], 50)
          .get(row.id)!
          .some((note) => pattern.test(note.text))
    );
    for (const row of rows) {
      if ((row.last_movement_at ?? 0) >= issue.at) {
        continue;
      }
      const state = ISSUE_STATES[issue.stateType] ?? null;
      this.database
        .query(
          "UPDATE intake_check SET last_movement_at=?,state=coalesce(?,state),revised_at=? WHERE id=?"
        )
        .run(issue.at, state, issue.at, row.id);
      const closed = state ? CLOSED_NOTES[state] : "";
      this.note(
        companyId,
        row.owner_id,
        row.id,
        `${issue.identifier} is ${issue.stateName} in Linear (${issue.url}).${closed}${issue.changes.length ? ` ${issue.changes.join("; ")}` : ""}`.slice(
          0,
          2000
        ),
        issue.at
      );
    }
  }

  /**
   * Makes a row in section A for each :ledger: reaction of the person that no row has as its source yet, and adds
   * "closed?" to an open row whose reaction the person took away. Returns how many rows changed.
   */
  importReactions(
    companyId: string,
    ownerId: string,
    reactions: readonly LedgerReaction[],
    now: number
  ): number {
    let changed = 0;
    for (const reaction of reactions) {
      const row = this.database
        .query(
          "SELECT id,state FROM intake_check WHERE company_id=? AND owner_id=? AND source_url=? AND deleted_at IS NULL ORDER BY revised_at DESC LIMIT 1"
        )
        .get(companyId, ownerId, reaction.permalink) as {
        id: string;
        state: string;
      } | null;
      if (reaction.removed) {
        if (row?.state === "open" && !this.hasNote(row.id, "📒 taken away")) {
          this.note(
            companyId,
            ownerId,
            row.id,
            "📒 taken away from the message. closed?",
            now
          );
          changed += 1;
        }
        continue;
      }
      if (row) {
        continue;
      }
      const flat = reaction.text.replace(/\s+/g, " ").trim();
      this.save(
        companyId,
        ownerId,
        {
          text:
            flat.length > 140
              ? `${flat.slice(0, 140)}…`
              : flat || "Slack message",
          section: "on_me",
          evidenceKind: "direct",
          sourceUrl: reaction.permalink,
          sourceType: "slack",
          firstAskedAt: new Date(reaction.at).toISOString(),
          note: `📒 on ${reaction.author}'s message: ${flat.slice(0, 400)}`,
        },
        now
      );
      changed += 1;
    }
    return changed;
  }

  meetings(companyId: string, ownerId: string, since: number): Meeting[] {
    const rows = this.database
      .query(
        "SELECT * FROM intake_meeting WHERE company_id=? AND owner_id=? AND start_at>=? AND deleted_at IS NULL ORDER BY start_at"
      )
      .all(companyId, ownerId, since) as Record<string, unknown>[];
    const actions = this.database.query(
      "SELECT ref FROM intake_check WHERE company_id=? AND owner_id=? AND meeting_id=? AND deleted_at IS NULL ORDER BY ref"
    );
    return rows.map((row) => ({
      id: row.id as string,
      eventId: row.event_id as string,
      title: row.title as string,
      startAt: row.start_at as number,
      endAt: row.end_at as number | null,
      series: row.series as string | null,
      eventUrl: row.event_url as string | null,
      transcriptUrl: row.transcript_url as string | null,
      secondSourceUrl: row.second_source_url as string | null,
      notesUrl: row.notes_url as string | null,
      coverage: row.coverage as Meeting["coverage"],
      purpose: row.purpose as string | null,
      decisions: row.decisions as string | null,
      openQuestions: row.open_questions as string | null,
      gaps: row.gaps as string | null,
      topicDiff: row.topic_diff as string | null,
      external: row.external === 1,
      client: row.client as string | null,
      channelChecked: row.channel_checked as string | null,
      actions: (
        actions.all(companyId, ownerId, row.id as string) as { ref: number }[]
      ).map((each) => each.ref),
    }));
  }

  /** Keeps one meeting by its calendar event; saving the same event again changes it. Returns its id. */
  saveMeeting(
    companyId: string,
    ownerId: string,
    input: MeetingInput,
    now = Date.now()
  ): string {
    const startAt = time(input.startAt);
    if (!(input.eventId?.trim() && input.title?.trim() && startAt !== null)) {
      throw new HttpError(
        400,
        "A meeting needs its event id, title, and start"
      );
    }
    if (!MEETING_COVERAGE.includes(input.coverage)) {
      throw new HttpError(
        400,
        `Coverage is one of ${MEETING_COVERAGE.join(", ")}`
      );
    }
    this.database
      .query(
        "INSERT INTO intake_meeting(id,company_id,owner_id,event_id,title,start_at,end_at,series,event_url,transcript_url,second_source_url,notes_url,coverage,purpose,decisions,open_questions,gaps,topic_diff,external,client,channel_checked,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,owner_id,event_id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,series=excluded.series,event_url=excluded.event_url,transcript_url=excluded.transcript_url,second_source_url=excluded.second_source_url,notes_url=excluded.notes_url,coverage=excluded.coverage,purpose=excluded.purpose,decisions=excluded.decisions,open_questions=excluded.open_questions,gaps=excluded.gaps,topic_diff=excluded.topic_diff,external=excluded.external,client=excluded.client,channel_checked=excluded.channel_checked,updated_at=excluded.updated_at"
      )
      .run(
        randomUUID(),
        companyId,
        ownerId,
        input.eventId.trim(),
        input.title.trim(),
        startAt,
        time(input.endAt),
        input.series ?? null,
        input.eventUrl ?? null,
        input.transcriptUrl ?? null,
        input.secondSourceUrl ?? null,
        input.notesUrl ?? null,
        input.coverage,
        input.purpose ?? null,
        input.decisions ?? null,
        input.openQuestions ?? null,
        input.gaps ?? null,
        input.topicDiff ?? null,
        input.external ? 1 : 0,
        input.client ?? null,
        input.channelChecked ?? null,
        now,
        now
      );
    return (
      this.database
        .query(
          "SELECT id FROM intake_meeting WHERE company_id=? AND owner_id=? AND event_id=?"
        )
        .get(companyId, ownerId, input.eventId.trim()) as { id: string }
    ).id;
  }

  /** The window of the person's last brief; null before the first. */
  lastBrief(companyId: string, ownerId: string): BriefLog | null {
    const row = this.database
      .query(
        "SELECT window_start,window_end,zone,not_covered,printed_refs FROM intake_brief WHERE company_id=? AND owner_id=? ORDER BY window_end DESC LIMIT 1"
      )
      .get(companyId, ownerId) as {
      window_start: number;
      window_end: number;
      zone: string;
      not_covered: string;
      printed_refs: string;
    } | null;
    return row
      ? {
          windowStart: row.window_start,
          windowEnd: row.window_end,
          zone: row.zone,
          notCovered: row.not_covered,
          printedRefs: JSON.parse(row.printed_refs),
        }
      : null;
  }

  logBrief(
    companyId: string,
    ownerId: string,
    log: BriefLog,
    now = Date.now()
  ): void {
    if (
      !(
        log.windowStart <= log.windowEnd &&
        log.printedRefs.every(Number.isSafeInteger)
      )
    ) {
      throw new HttpError(
        400,
        "A brief needs its window and the refs it showed"
      );
    }
    this.database
      .query(
        "INSERT INTO intake_brief(id,company_id,owner_id,window_start,window_end,zone,not_covered,printed_refs,created_at) VALUES(?,?,?,?,?,?,?,?,?)"
      )
      .run(
        randomUUID(),
        companyId,
        ownerId,
        log.windowStart,
        log.windowEnd,
        log.zone,
        log.notCovered,
        JSON.stringify(log.printedRefs),
        now
      );
  }

  /** The open row with this source, so a row is never made twice. */
  private openBySource(
    companyId: string,
    ownerId: string,
    sourceUrl: string
  ): string | null {
    return (
      (
        this.database
          .query(
            "SELECT id FROM intake_check WHERE company_id=? AND owner_id=? AND source_url=? AND state='open' AND deleted_at IS NULL ORDER BY revised_at DESC LIMIT 1"
          )
          .get(companyId, ownerId, sourceUrl) as { id: string } | null
      )?.id ?? null
    );
  }

  private update(
    companyId: string,
    ownerId: string,
    id: string,
    change: LedgerChange,
    note: string,
    now: number
  ): void {
    const row = this.database
      .query(
        "SELECT section,state FROM intake_check WHERE id=? AND company_id=? AND owner_id=? AND deleted_at IS NULL"
      )
      .get(id, companyId, ownerId) as { section: string; state: string } | null;
    if (!row) {
      throw notFound();
    }
    const state = change.state && CHECK_STATES[change.state];
    const due = change.dueAt === undefined ? undefined : time(change.dueAt);
    const before = this.latestRevision(id);
    this.database
      .query(
        "UPDATE intake_check SET text=coalesce(?1,text),state=coalesce(?2,state),explicit_time=CASE WHEN ?3 IS NULL THEN explicit_time ELSE 1 END,check_at=coalesce(?3,check_at),revised_at=?4 WHERE id=?5"
      )
      .run(change.text?.trim() || null, state ?? null, due ?? null, now, id);
    if (due !== undefined) {
      this.database
        .query("UPDATE intake_check SET due_at=? WHERE id=?")
        .run(due, id);
    }
    if (change.firstAskedAt !== undefined) {
      this.database
        .query("UPDATE intake_check SET first_asked_at=? WHERE id=?")
        .run(time(change.firstAskedAt), id);
    }
    // A row that leaves B or C for another section starts its aging again.
    if (change.section && change.section !== row.section) {
      this.database
        .query("UPDATE intake_check SET moved_to_c_at=?,needs_you=0 WHERE id=?")
        .run(change.section === "dropped" ? now : null, id);
    }
    this.setFields(id, change, now);
    if (this.latestRevision(id) === before) {
      this.note(companyId, ownerId, id, note, now);
    } else {
      this.labelLatest(companyId, ownerId, id, note, "ledger");
    }
  }

  private setFields(id: string, change: LedgerChange, now: number): void {
    const columns: [string, unknown][] = [
      ["section", change.section],
      ["owed_by", change.owedBy],
      ["bucket", change.bucket],
      ["why_mine", change.whyMine],
      [
        "needs_you",
        change.needsYou === undefined ? undefined : Number(change.needsYou),
      ],
      ["client", change.client],
      ["evidence_kind", change.evidenceKind],
      ["source_url", change.sourceUrl],
      ["source_type", change.sourceType],
      [
        "last_chased_at",
        change.lastChasedAt === undefined
          ? undefined
          : time(change.lastChasedAt),
      ],
      [
        "parked_until",
        change.parkedUntil === undefined ? undefined : time(change.parkedUntil),
      ],
      ["meeting_id", change.meetingId],
      ["last_movement_at", change.movement ? now : undefined],
    ];
    for (const [column, value] of columns) {
      if (value !== undefined) {
        this.database
          .query(`UPDATE intake_check SET ${column}=? WHERE id=?`)
          .run(value as string | number | null, id);
      }
    }
  }

  private latestRevision(id: string): number | null {
    return (
      this.database
        .query(
          "SELECT max(id) AS id FROM intake_check_revision WHERE check_id=?"
        )
        .get(id) as { id: number | null }
    ).id;
  }

  /** Gives the revision that a change just made its History line. */
  private labelLatest(
    companyId: string,
    ownerId: string,
    id: string,
    note: string,
    action: string
  ): void {
    this.database
      .query(
        "UPDATE intake_check_revision SET action=?,quote=? WHERE id=(SELECT max(id) FROM intake_check_revision WHERE check_id=? AND company_id=? AND owner_id=?)"
      )
      .run(action, note, id, companyId, ownerId);
  }

  private hasNote(id: string, words: string): boolean {
    return (
      this.database
        .query(
          "SELECT 1 FROM intake_check_revision WHERE check_id=? AND instr(quote,?) > 0 LIMIT 1"
        )
        .get(id, words) !== null
    );
  }
}

/** The weekdays after the day of `from` up to and with the day of `to`, in `zone`. */
export function businessDays(from: number, to: number, zone: string): number {
  const start = Date.parse(`${localDay(from, zone)}T00:00:00Z`);
  const end = Date.parse(`${localDay(to, zone)}T00:00:00Z`);
  let count = 0;
  for (let day = start + DAY; day <= end; day += DAY) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      count += 1;
    }
  }
  return count;
}

/** The type of a source by its link. */
export function sourceTypeOf(url: string | null): LedgerFields["sourceType"] {
  if (!url) {
    return null;
  }
  if (/slack\.com\//.test(url)) {
    return "slack";
  }
  if (/mail\.google\.com\//.test(url)) {
    return "email";
  }
  if (/linear\.app\//.test(url)) {
    return "linear";
  }
  if (/notion\.(so|site)\/|app\.notion\.com\//.test(url)) {
    return "notion";
  }
  return /calendar\.google\.com\//.test(url) ? "calendar" : null;
}

function fieldsOf(row: FieldRow): LedgerFields {
  return {
    ref: row.ref,
    section: row.section as LedgerSection,
    owedBy: row.owed_by,
    bucket: row.bucket as LedgerFields["bucket"],
    whyMine: row.why_mine as LedgerFields["whyMine"],
    needsYou: row.needs_you === 1,
    client: row.client,
    evidenceKind: row.evidence_kind as LedgerFields["evidenceKind"],
    sourceUrl: row.source_url,
    sourceType: row.source_type as LedgerFields["sourceType"],
    firstAskedAt: row.first_asked_at,
    dueAt: row.due_at,
    lastMovementAt: row.last_movement_at,
    lastChasedAt: row.last_chased_at,
    movedToCAt: row.moved_to_c_at,
    parkedUntil: row.parked_until,
    closedAt: row.closed_at,
    meetingId: row.meeting_id,
  };
}

function validateChange(change: LedgerChange): void {
  const oneOf = (value: unknown, allowed: readonly unknown[], name: string) => {
    if (value !== undefined && value !== null && !allowed.includes(value)) {
      throw new HttpError(400, `${name} is one of ${allowed.join(", ")}`);
    }
  };
  oneOf(change.section, LEDGER_SECTIONS, "section");
  oneOf(change.bucket, BUCKETS, "bucket");
  oneOf(change.whyMine, WHY_MINE, "whyMine");
  oneOf(change.evidenceKind, EVIDENCE, "evidenceKind");
  oneOf(change.sourceType, SOURCE_TYPES, "sourceType");
  oneOf(change.state, ["open", "done", "written_off"], "state");
  for (const name of [
    "firstAskedAt",
    "dueAt",
    "lastChasedAt",
    "parkedUntil",
  ] as const) {
    const value = change[name];
    if (value !== undefined && value !== null && time(value) === null) {
      throw new HttpError(400, `${name} is an ISO date or time`);
    }
  }
}

/** An ISO date or time in ms; null for null or an unreadable value. */
function time(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
