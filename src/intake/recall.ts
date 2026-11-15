import type { Database } from "bun:sqlite";
import type { WatchedItem } from "../integrations/integrations.ts";
import type { User } from "../platform/auth.ts";
import { notFound } from "../platform/errors.ts";
import type { AssessmentInput, Evidence, FutureCheck } from "./assess.ts";
import type { Audit } from "./audit.ts";
import type {
  IntakeCompanies,
  IntakeIntegrations,
  IntakeSearch,
  IntakeThreads,
} from "./intake.ts";

export interface ItemRow {
  id: string;
  credential_id: string;
  company_id: string;
  owner_id: string;
  source_id: string;
  version: string;
  payload: string;
  at: number;
  read_at: number | null;
  reading: string | null;
  assessed_at: number | null;
  thread_id: string | null;
  archived_id: string | null;
  superseded_at: number | null;
  /** When the person deleted it, as with its blocked sender; reads leave it out. */
  deleted_at: number | null;
}
export interface SourceRow {
  credential_id: string;
  company_id: string;
  owner_id: string;
  polled_at: number;
  attempted_at: number;
  error: string | null;
  checkpoint: string;
}
interface CheckRow {
  id: string;
  thread_id: string | null;
  text: string;
  source_ids: string;
  explicit_time: number;
  check_at: number;
  next_review_at: number;
  notified_at: number | null;
}
export interface IntakeSourceStatus {
  id: string;
  name: string;
  /** Until when Shadow has read the account; null before its first read. */
  readAt: number | null;
  error: string | null;
  kept: number;
}
/** How many later messages of the owner, and of the others, each conversation gives to a review. */
const LATER_MESSAGES = 4;
/** How much of each later message a review reads; a long mail still shows that it answered. */
const LATER_MESSAGE_CHARS = 2000;

/** Reads the current private evidence and the Shadow context that a person can use. */
export class IntakeRecall {
  constructor(
    private readonly database: Database,
    private readonly companies: IntakeCompanies,
    private readonly integrations: IntakeIntegrations,
    private readonly threads: Pick<IntakeThreads, "messages">,
    private readonly search: IntakeSearch,
    private readonly audit: Audit
  ) {}

  async context(
    companyId: string,
    owner: User,
    evidence: Evidence[],
    checks: FutureCheck[],
    subjectId?: string,
    includeRecent = false
  ): Promise<AssessmentInput["threads"]> {
    this.companies.requireMember(companyId, owner);
    const available = new Map(
      this.companies
        .threadsIn(companyId, owner.id)
        .map((thread) => [thread.id, thread])
    );
    const ids = new Set<string>();
    if (includeRecent && !subjectId) {
      const recent = [...available.values()]
        .toSorted((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 12);
      for (const thread of recent) {
        ids.add(thread.id);
      }
    }
    if (subjectId) {
      if (!available.has(subjectId)) {
        throw notFound();
      }
      ids.add(subjectId);
    } else {
      for (const id of await this.candidateIds(
        companyId,
        owner,
        evidence,
        checks
      )) {
        ids.add(id);
      }
    }
    const candidates = [...ids]
      .flatMap((id) => (available.has(id) ? [available.get(id)!] : []))
      .slice(0, 24);
    const budget = Math.min(
      2400,
      Math.floor(6000 / Math.max(1, candidates.length))
    );
    const result: AssessmentInput["threads"] = [];
    for (const thread of candidates) {
      const state = await this.threads.messages(thread);
      const known = this.database
        .query(
          "SELECT summary FROM intake_context WHERE company_id=? AND owner_id=? AND thread_id=?"
        )
        .get(companyId, owner.id, thread.id) as { summary: string } | null;
      const context = [
        "Latest messages first:",
        ...state.messages
          .slice(-4)
          .toReversed()
          .map((message) => `${message.author}: ${message.text.slice(0, 600)}`),
        known ? `Prior source summary: ${known.summary.slice(0, 600)}` : "",
      ]
        .join("\n")
        .slice(0, budget);
      result.push({
        id: thread.id,
        channelId: thread.channelId,
        title: thread.title,
        context,
      });
    }
    return result;
  }

  private async candidateIds(
    companyId: string,
    owner: User,
    evidence: Evidence[],
    checks: FutureCheck[]
  ): Promise<Set<string>> {
    return new Set([
      ...evidence.flatMap((item) =>
        item.url?.startsWith("thread:") ? [item.url.slice(7)] : []
      ),
      ...[
        ...this.conversationRows(companyId, owner, evidence),
        ...this.matches(companyId, owner, evidence),
      ].flatMap((row) => (row.thread_id ? [row.thread_id] : [])),
      ...(await this.searchIds(companyId, owner, evidence)),
      ...checks.flatMap((check) => (check.threadId ? [check.threadId] : [])),
    ]);
  }

  private async searchIds(
    companyId: string,
    owner: User,
    evidence: Evidence[]
  ): Promise<string[]> {
    const result: string[] = [];
    for (const group of Map.groupBy(
      evidence,
      (item) => item.conversation
    ).values()) {
      const query = group
        .slice(-6)
        .map((item) => item.text.slice(0, 600))
        .join("\n")
        .slice(0, 1800);
      if (!query) {
        continue;
      }
      const found = await this.search.search(
        companyId,
        query,
        4,
        owner.id,
        "thread"
      );
      this.audit.record(
        `search:${new Bun.CryptoHasher("sha256").update(query).digest("hex")}`,
        "search.results",
        companyId,
        owner.id,
        { query, results: found.results }
      );
      result.push(
        ...found.results.flatMap((hit) => (hit.threadId ? [hit.threadId] : []))
      );
    }
    return result;
  }

  relevantChecks(
    companyId: string,
    owner: User,
    evidence: Evidence[],
    threadIds: string[]
  ): FutureCheck[] {
    const sourceIds = new Set([
      ...evidence.map((item) => item.id),
      ...this.matches(companyId, owner, evidence).map((row) => row.id),
    ]);
    const conversations = new Set(evidence.map((item) => item.conversation));
    return this.checks(companyId, owner)
      .filter(
        (check) =>
          (check.threadId !== null && threadIds.includes(check.threadId)) ||
          check.sourceIds.some(
            (id) =>
              sourceIds.has(id) ||
              conversations.has(this.conversationOf(companyId, owner, id))
          )
      )
      .slice(0, 12);
  }

  /** The conversation of a source, also of an older version of it, as a check keeps the version it was made from. */
  private conversationOf(companyId: string, owner: User, id: string): string {
    const row = this.database
      .query(
        "SELECT credential_id,json_extract(payload,'$.chat') AS chat FROM intake_item WHERE id=? AND company_id=? AND owner_id=?"
      )
      .get(id, companyId, owner.id) as {
      credential_id: string;
      chat: string;
    } | null;
    return row ? `${row.credential_id}:${row.chat}` : "";
  }

  /**
   * The channels where a new matter of the person's sources may start: only their private ones, so their mail and
   * threads reach a channel that others see only as a visible update to an existing matching thread there.
   */
  channels(companyId: string, owner: User): AssessmentInput["channels"] {
    this.companies.requireMember(companyId, owner);
    return this.companies
      .channelsIn(companyId, owner.id)
      .filter((channel) => channel.ownerId === owner.id)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        summary: channel.summary,
        private: true,
      }));
  }

  async relatedEvidence(
    companyId: string,
    owner: User,
    fresh: Evidence[],
    checks: FutureCheck[]
  ): Promise<Evidence[]> {
    const result = new Map(fresh.map((item) => [item.id, item]));
    const originals: Evidence[] = [];
    for (const id of new Set(checks.flatMap((check) => check.sourceIds))) {
      const row = this.database
        .query(
          "SELECT * FROM intake_item WHERE id=? AND company_id=? AND owner_id=?"
        )
        .get(id, companyId, owner.id) as ItemRow | null;
      if (row && this.visible(companyId, owner, [row]).length) {
        const item = this.evidence([row])[0]!;
        result.set(id, item);
        originals.push(item);
      }
    }
    for (const item of this.evidence(
      this.laterMessages(companyId, owner, [...fresh, ...originals])
    )) {
      if (!result.has(item.id)) {
        result.set(item.id, {
          ...item,
          text: item.text.slice(0, LATER_MESSAGE_CHARS),
        });
      }
    }
    const candidates = [
      ...this.conversationRows(companyId, owner, [...fresh, ...originals]),
      ...this.matches(companyId, owner, [...fresh, ...originals]),
    ];
    let size = 0,
      count = 0;
    for (const item of this.evidence(candidates)) {
      if (
        result.has(item.id) ||
        count >= 12 ||
        size + item.text.length > 8000
      ) {
        continue;
      }
      result.set(item.id, item);
      size += item.text.length;
      count += 1;
    }
    return [...result.values()].sort((a, b) => a.at - b.at);
  }

  /**
   * What each conversation said after its earliest given source: the newest messages of the owner and of the others,
   * so a reply shows that a request is handled. Each conversation has its own limit, as a busy thread must not hide the
   * answer in another.
   */
  private laterMessages(
    companyId: string,
    owner: User,
    evidence: Evidence[]
  ): ItemRow[] {
    const rows = this.database
      .query(`SELECT * FROM (
        SELECT i.*,ROW_NUMBER() OVER (
          PARTITION BY i.credential_id,json_extract(i.payload,'$.chat'),json_extract(i.payload,'$.fromOwner') ORDER BY i.at DESC
        ) AS position
        FROM intake_item i JOIN (
          SELECT credential_id,json_extract(payload,'$.chat') AS chat,min(at) AS since FROM intake_item
          WHERE id IN (SELECT value FROM json_each(?)) AND company_id=? AND owner_id=? GROUP BY credential_id,chat
        ) source ON i.credential_id=source.credential_id AND json_extract(i.payload,'$.chat')=source.chat AND i.at>source.since
        WHERE i.company_id=? AND i.owner_id=? AND i.superseded_at IS NULL AND i.deleted_at IS NULL
      ) WHERE position<=? ORDER BY at`)
      .all(
        JSON.stringify(evidence.map((item) => item.id)),
        companyId,
        owner.id,
        companyId,
        owner.id,
        LATER_MESSAGES
      ) as ItemRow[];
    return this.visible(companyId, owner, rows);
  }

  private conversationRows(
    companyId: string,
    owner: User,
    evidence: Evidence[]
  ): ItemRow[] {
    const rows = this.database
      .query(`SELECT DISTINCT i.* FROM intake_item i JOIN intake_item original
      ON i.credential_id=original.credential_id AND json_extract(i.payload,'$.chat')=json_extract(original.payload,'$.chat')
      WHERE original.id IN (SELECT value FROM json_each(?)) AND original.company_id=? AND original.owner_id=?
      AND i.company_id=? AND i.owner_id=? AND i.superseded_at IS NULL AND i.deleted_at IS NULL ORDER BY i.at DESC LIMIT 24`)
      .all(
        JSON.stringify(evidence.map((item) => item.id)),
        companyId,
        owner.id,
        companyId,
        owner.id
      ) as ItemRow[];
    return this.visible(companyId, owner, rows);
  }

  private matches(
    companyId: string,
    owner: User,
    evidence: Evidence[]
  ): ItemRow[] {
    const terms = [
      ...new Set(
        evidence
          .map((item) => item.text.slice(0, 1000))
          .join(" ")
          .match(/[\p{L}\p{N}@.]{4,}/gu) ?? []
      ),
    ].slice(0, 24);
    if (!terms.length) {
      return [];
    }
    const match = terms
      .map((word) => `"${word.replaceAll('"', '""')}"`)
      .join(" OR ");
    const rows = this.database
      .query(
        "SELECT i.* FROM intake_fts f JOIN intake_item i ON i.rowid=f.rowid WHERE intake_fts MATCH ? AND i.superseded_at IS NULL AND i.deleted_at IS NULL AND i.company_id=? AND i.owner_id=? AND i.id NOT IN (SELECT value FROM json_each(?)) ORDER BY bm25(intake_fts),i.at DESC LIMIT 6"
      )
      .all(
        match,
        companyId,
        owner.id,
        JSON.stringify(evidence.map((item) => item.id))
      ) as ItemRow[];
    return this.visible(companyId, owner, rows);
  }

  evidence(rows: ItemRow[]): Evidence[] {
    return rows.map((row) => {
      const item = JSON.parse(row.payload) as WatchedItem & { source: string };
      return {
        id: row.id,
        conversation: `${row.credential_id}:${item.chat}`,
        bulk: item.bulk,
        attachments: item.attachments?.map(({ name, type, size }) => ({
          name,
          type,
          size,
        })),
        text: item.text,
        at: item.at,
        ...(item.observedAt === undefined
          ? {}
          : { observedAt: item.observedAt }),
        source: `${item.source}; ${item.chatName}; ${item.sender}`,
        url: item.url,
        fromOwner: item.fromOwner,
      };
    });
  }

  checks(companyId: string, owner: User): FutureCheck[] {
    this.companies.requireMember(companyId, owner);
    return (
      this.database
        .query(
          "SELECT * FROM intake_check WHERE company_id=? AND owner_id=? AND state='open' AND deleted_at IS NULL ORDER BY check_at"
        )
        .all(companyId, owner.id) as CheckRow[]
    )
      .filter((row) => this.visibleCheck(companyId, owner, row))
      .map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        text: row.text,
        sourceIds: JSON.parse(row.source_ids),
        checkAt: row.check_at,
        deadlineAt: row.explicit_time ? row.check_at : null,
        reviewAt: row.next_review_at,
        notifiedAt: row.notified_at,
      }));
  }

  coverage(companyId: string, owner: User): AssessmentInput["coverage"] {
    return (
      this.database
        .query("SELECT * FROM intake_source WHERE company_id=? AND owner_id=?")
        .all(companyId, owner.id) as SourceRow[]
    )
      .filter((source) =>
        this.sources(companyId, owner).has(source.credential_id)
      )
      .map((source) => ({
        source: source.credential_id,
        through: source.polled_at,
        error: source.error,
      }));
  }

  status(companyId: string, owner: User, query = "") {
    return {
      evidence: this.evidence(this.items(companyId, owner, query, 30)),
      checks: this.checks(companyId, owner),
      coverage: this.coverage(companyId, owner),
    };
  }

  /** The person's visible observations that match `query`, best first, or else the newest. */
  items(companyId: string, owner: User, query: string, limit: number) {
    this.companies.requireMember(companyId, owner);
    const terms = (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 32);
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    const rows = match
      ? (this.database
          .query(
            "SELECT i.* FROM intake_fts f JOIN intake_item i ON i.rowid=f.rowid WHERE (intake_fts MATCH ?) AND i.deleted_at IS NULL AND i.company_id=? AND i.owner_id=? ORDER BY bm25(intake_fts),i.at DESC LIMIT ?"
          )
          .all(match, companyId, owner.id, limit) as ItemRow[])
      : (this.database
          .query(
            "SELECT * FROM intake_item WHERE superseded_at IS NULL AND deleted_at IS NULL AND company_id=? AND owner_id=? ORDER BY at DESC LIMIT ?"
          )
          .all(companyId, owner.id, limit) as ItemRow[]);
    return this.visible(companyId, owner, rows);
  }

  /** Each account that the person lets Shadow read: how far Shadow read it, its error, and how much it keeps. */
  sourceStatus(companyId: string, owner: User): IntakeSourceStatus[] {
    this.companies.requireMember(companyId, owner);
    return this.integrations
      .watched()
      .filter(
        (each) => each.companyId === companyId && each.ownerId === owner.id
      )
      .map((credential) => {
        const row = this.database
          .query(
            "SELECT polled_at,error,(SELECT count(*) FROM intake_item WHERE credential_id=? AND superseded_at IS NULL AND deleted_at IS NULL) AS kept FROM intake_source WHERE credential_id=?"
          )
          .get(credential.id, credential.id) as {
          polled_at: number;
          error: string | null;
          kept: number;
        } | null;
        return {
          id: credential.id,
          name: `${credential.integrationName} · ${credential.label}`,
          readAt: row?.polled_at || null,
          error: row?.error ?? null,
          kept: row?.kept ?? 0,
        };
      });
  }
  visible(companyId: string, owner: User, rows: ItemRow[]): ItemRow[] {
    const sources = this.sources(companyId, owner);
    return rows.filter(
      (row) => row.deleted_at === null && sources.has(row.credential_id)
    );
  }

  private sources(companyId: string, owner: User): Set<string> {
    this.companies.requireMember(companyId, owner);
    return new Set([
      ...this.integrations
        .watched()
        .filter(
          (each) => each.companyId === companyId && each.ownerId === owner.id
        )
        .map((each) => each.id),
      ...this.companies
        .threadsIn(companyId, owner.id)
        .map((each) => `thread:${each.id}`),
    ]);
  }

  private visibleCheck(
    companyId: string,
    owner: User,
    check: CheckRow
  ): boolean {
    if (
      check.thread_id &&
      !this.companies
        .threadsIn(companyId, owner.id)
        .some((thread) => thread.id === check.thread_id)
    ) {
      return false;
    }
    const ids = JSON.parse(check.source_ids) as string[];
    return ids.every((id) => {
      const row = this.database
        .query(
          "SELECT * FROM intake_item WHERE id=? AND company_id=? AND owner_id=?"
        )
        .get(id, companyId, owner.id) as ItemRow | null;
      return row !== null && this.visible(companyId, owner, [row]).length > 0;
    });
  }
}
