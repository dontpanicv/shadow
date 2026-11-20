import type { Database } from "bun:sqlite";
import type { Assessment } from "./assess.ts";
import { type LedgerSection, sourceTypeOf } from "./ledger.ts";

/**
 * Stores the stated time separately from the next internal review. A new check gets its ledger section, who owes it,
 * and its source; a change of an existing one is movement.
 */
export function saveCheck(
  database: Database,
  check: Assessment["checks"][number],
  scope: {
    id: string;
    companyId: string;
    ownerId: string;
    threadId: string | null;
    checkAt: number;
    now: number;
    sourceUrl?: string | null;
  }
): void {
  const prior = database
    .query(
      "SELECT source_ids,check_at,next_review_at,explicit_time FROM intake_check WHERE id=? AND company_id=? AND owner_id=?"
    )
    .get(scope.id, scope.companyId, scope.ownerId) as {
    source_ids: string;
    check_at: number;
    next_review_at: number;
    explicit_time: number;
  } | null;
  const sources = [
    ...new Set([
      ...(prior ? (JSON.parse(prior.source_ids) as string[]) : []),
      check.evidence,
    ]),
  ];
  const statedTime = check.at !== null || check.afterDays !== null;
  // A context update without a new stated time must not shorten or reset the original response period.
  const preserveTime = prior !== null && !statedTime;
  const explicitTime = statedTime ? 1 : 0;
  database
    .query(
      "INSERT INTO intake_check(id,company_id,owner_id,thread_id,text,source_ids,explicit_time,check_at,next_review_at,revised_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,source_ids=excluded.source_ids,explicit_time=excluded.explicit_time,check_at=excluded.check_at,next_review_at=excluded.next_review_at,thread_id=coalesce(excluded.thread_id,intake_check.thread_id),revised_at=excluded.revised_at,state='open',notified_at=CASE WHEN check_at != excluded.check_at THEN NULL ELSE notified_at END WHERE intake_check.state != 'stopped'"
    )
    .run(
      scope.id,
      scope.companyId,
      scope.ownerId,
      scope.threadId,
      check.text,
      JSON.stringify(sources),
      preserveTime ? prior.explicit_time : explicitTime,
      preserveTime ? prior.check_at : scope.checkAt,
      preserveTime ? prior.next_review_at : scope.checkAt,
      scope.now
    );
  const section: LedgerSection | undefined = check.section;
  if (prior) {
    database
      .query(
        "UPDATE intake_check SET last_movement_at=?,section=coalesce(?,section),owed_by=coalesce(?,owed_by),due_at=CASE WHEN explicit_time=1 THEN check_at ELSE due_at END WHERE id=? AND state='open'"
      )
      .run(scope.now, section ?? null, check.owedBy ?? null, scope.id);
  } else {
    database
      .query(
        "UPDATE intake_check SET section=?,owed_by=?,source_url=?,source_type=?,evidence_kind='direct' WHERE id=?"
      )
      .run(
        section ?? "on_me",
        check.owedBy ?? null,
        scope.sourceUrl ?? null,
        sourceTypeOf(scope.sourceUrl ?? null),
        scope.id
      );
  }
}
