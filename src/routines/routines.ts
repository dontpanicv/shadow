import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  CodemodeSandbox,
  type CodemodeTool,
  renderDeclarations,
} from "@earendil-works/pi-codemode";
import { randomUUIDv5 } from "bun";
import type { Companies, Realm } from "../companies/companies.ts";
import type { Integrations } from "../integrations/integrations.ts";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
import { localTime } from "../platform/time.ts";
import type { Indexer } from "../search/search.ts";
import type { Threads } from "../threads/threads.ts";
import { routineTools } from "./tools.ts";

export type RoutineOutcome = "running" | "quiet" | "posted" | "failed";

export interface RoutineRun {
  readonly id: string;
  readonly routineId: string;
  readonly routineName: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly outcome: RoutineOutcome;
  readonly error: string | null;
}

/** Work a channel does on a schedule: an optional script collects what is new, and an agent acts on it. */
export interface Routine {
  readonly id: string;
  readonly channelId: string;
  readonly name: string;
  /** A cron expression in the server's time zone. */
  readonly schedule: string;
  readonly instructions: string;
  readonly script: string | null;
  readonly enabled: boolean;
  readonly nextRunAt: number | null;
  /** The thread where its agent answers; it starts at the first run that reaches the agent. */
  readonly threadId: string | null;
  /** Whether each answer also goes to the Slack channel that its channel copies. */
  readonly postInSlack: boolean;
  /** `morning` for a person's Morning brief, which the morning review runs at 08:00 of their time zone. */
  readonly kind: "morning" | null;
  readonly lastRun: RoutineRun | null;
}

export interface RoutineInput {
  readonly name: string;
  readonly schedule: string;
  readonly instructions: string;
  readonly script?: string | null;
  readonly postInSlack?: boolean;
}

/** What a script run gave: the text for the agent, or `null` when it found nothing new. */
export type ScriptResult =
  | {
      readonly ok: true;
      readonly text: string | null;
      readonly store: Record<string, unknown>;
    }
  | { readonly ok: false; readonly error: string; readonly text: string };

export type RoutineCompanies = Pick<
  Companies,
  | "allChannelsIn"
  | "allThreadsIn"
  | "channel"
  | "channelsIn"
  | "agentMember"
  | "members"
  | "requireMember"
  | "threadOf"
  | "threadsIn"
>;
export type RoutineThreads = Pick<
  Threads,
  | "instruct"
  | "messages"
  | "observe"
  | "realm"
  | "requester"
  | "startAgentThread"
>;
export type RoutineSearch = Pick<Indexer, "search">;

/** The id of each person's Morning brief comes from their company and id in this namespace. */
const MORNING_NAMESPACE = "0f6c3b0e-5a4f-4d35-9d0b-6a1b2c3d4e5f";
const MORNING_NAME = "Morning brief";
/** What the Morning brief shows as its schedule: every day at 8, of its person's own time zone. */
const MORNING_SCHEDULE = "0 8 * * *";
/** How often the scheduler looks for routines that are due. */
const TICK = 30_000;
/** The longest a script may run, with its tool calls. */
const SCRIPT_TIMEOUT = 5 * 60_000;
/** A routine runs at most this often, whatever its schedule says. */
const MIN_ROUTINE_GAP = 15 * 60_000;
/** The most of a script's result the agent gets. */
const MAX_RESULT = 50_000;
/** Runs the channel details page shows. */
const RECENT_RUNS = 20;

interface RoutineRow {
  readonly id: string;
  readonly companyId: string;
  readonly channelId: string;
  readonly name: string;
  readonly schedule: string;
  readonly instructions: string;
  readonly script: string | null;
  readonly store: string;
  readonly enabled: number;
  readonly nextRunAt: number | null;
  readonly threadId: string | null;
  /** The member who last wrote its instructions or script, whose turns its runs are; `shadow` when nobody did. */
  readonly createdBy: string;
  readonly postInSlack: number;
  readonly kind: "morning" | null;
  /** What the morning review gives one run of a Morning brief; only a run's copy of its routine has it. */
  readonly context?: string;
}

const ROUTINE_COLUMNS =
  "id, company_id AS companyId, channel_id AS channelId, name, schedule, instructions, script, store, enabled, next_run_at AS nextRunAt, thread_id AS threadId, created_by AS createdBy, post_in_slack AS postInSlack, kind";
const RUN_COLUMNS =
  "r.id, r.routine_id AS routineId, t.name AS routineName, r.started_at AS startedAt, r.finished_at AS finishedAt, r.outcome, r.error";

/**
 * The routines of every channel, and the scheduler that runs them. A run first runs the routine's script in a code mode
 * sandbox; a script that finds nothing new ends the run without the agent. Otherwise, or without a script,
 * the agent of the routine's thread gets the instructions and the script's result, and answers there, or stays quiet.
 * A script that fails goes to the agent too, which repairs it.
 */
export class Routines {
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private readonly database: Database,
    private readonly companies: RoutineCompanies,
    private readonly integrations: Pick<Integrations, "tools">,
    private readonly threads: RoutineThreads,
    private readonly search: RoutineSearch,
    /** Called with each answer of a routine that posts in Slack. */
    private readonly posted: (
      routine: Pick<Routine, "id" | "name" | "channelId"> & {
        readonly companyId: string;
      },
      answer: string
    ) => void = () => undefined
  ) {}

  /**
   * Starts the scheduler, and finishes the runs that a stop cut off. Their agent goes on with its turn after the stop,
   * and a run waits for that turn's answer again, under the same request id, so the agent never does the work twice.
   */
  start(): void {
    const cutOff = this.database
      .query(
        "SELECT id, routine_id AS routineId, started_at AS startedAt, input, result FROM routine_run WHERE outcome = 'running'"
      )
      .all() as {
      id: string;
      routineId: string;
      startedAt: number;
      input: string | null;
      result: string | null;
    }[];
    for (const run of cutOff) {
      const [routine] = this.live(
        this.database
          .query(
            `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE id = ? AND deleted_at IS NULL`
          )
          .all(run.routineId) as RoutineRow[]
      );
      if (routine) {
        this.finish(
          run.input === null
            ? routine
            : {
                ...routine,
                ...JSON.parse(run.input),
                channelId: routine.channelId,
                threadId: routine.threadId,
              },
          run.id,
          run.startedAt,
          run.result === null ? null : JSON.parse(run.result)
        ).catch(() => {
          // The run records its own failure; this one is a database closed while it ran.
        });
      } else {
        this.database
          .query(
            "UPDATE routine_run SET outcome = 'failed', finished_at = ?, error = 'Shadow stopped during the run', input = NULL, result = NULL WHERE id = ?"
          )
          .run(Date.now(), run.id);
      }
    }
    this.timer = setInterval(() => this.tick(), TICK);
  }

  /** Stops the scheduler. A run that fails from now on, as the agents stop, stays running for the next start. */
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  /** Starts each enabled routine that is due, once, however many runs it missed. */
  tick(now = Date.now()): Promise<RoutineRun>[] {
    const due = this.database
      .query(
        `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE enabled = 1 AND next_run_at <= ? AND deleted_at IS NULL`
      )
      .all(now) as RoutineRow[];
    return this.live(due)
      .filter((routine) => !this.running.has(routine.id))
      .map((routine) => this.run(routine, now));
  }

  /** The routines of a channel and their newest runs. */
  inChannel(
    companyId: string,
    channelId: string,
    user: User
  ): { routines: Routine[]; runs: RoutineRun[] } {
    this.companies.channel(companyId, channelId, user);
    const rows = this.database
      .query(
        `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE channel_id = ? AND deleted_at IS NULL ORDER BY created_at`
      )
      .all(channelId) as RoutineRow[];
    const runs = this.database
      .query(
        `SELECT ${RUN_COLUMNS} FROM routine_run r JOIN routine t ON t.id = r.routine_id WHERE t.channel_id = ? AND t.deleted_at IS NULL ORDER BY r.started_at DESC LIMIT ${RECENT_RUNS}`
      )
      .all(channelId) as RoutineRun[];
    return { routines: rows.map((row) => this.routineOf(row)), runs };
  }

  /** A routine of a company that `user` is a member of. */
  get(routineId: string, user: User): Routine {
    return this.routineOf(this.rowFor(routineId, user));
  }

  setEnabled(routineId: string, user: User, enabled: boolean): Routine {
    const row = this.rowFor(routineId, user);
    this.database
      .query("UPDATE routine SET enabled = ?, next_run_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, nextRunOf(row, Date.now()), row.id);
    return this.get(routineId, user);
  }

  /** Changes a routine's instructions for a person who sees its channel; its runs become theirs. */
  setInstructions(
    routineId: string,
    user: User,
    instructions: string
  ): Routine {
    const row = this.rowFor(routineId, user);
    return this.update(
      row.companyId,
      user.id,
      routineId,
      { instructions },
      user.id
    );
  }

  /** Moves the routine that runs in a thread to the channel the thread moved to, so its results stay in its channel. */
  /** Moves the routines of channel `from` to channel `to`, as when one channel merges into another. */
  moveChannel(from: string, to: string): void {
    this.database
      .query("UPDATE routine SET channel_id = ? WHERE channel_id = ?")
      .run(to, from);
  }

  moveWithThread(threadId: string, channelId: string): void {
    this.database
      .query(
        "UPDATE routine SET channel_id = ? WHERE thread_id = ? AND deleted_at IS NULL"
      )
      .run(channelId, threadId);
  }

  delete(routineId: string, user: User): void {
    this.softDelete(this.rowFor(routineId, user).id);
  }

  /** Runs a routine now, in the background; its run shows on the channel's details page. */
  runNow(routineId: string, user: User): void {
    const row = this.rowFor(routineId, user);
    if (this.running.has(row.id)) {
      throw new HttpError(409, `${row.name} is running`);
    }
    this.run(row, Date.now()).catch(() => {
      // The run records its own failure; this one is a database closed while it ran.
    });
  }

  /** The routines of a company in the channels `realm` sees, for its agents. */
  inCompany(companyId: string, realm: Realm): Routine[] {
    return this.live(
      this.database
        .query(
          `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE company_id = ? AND deleted_at IS NULL ORDER BY created_at`
        )
        .all(companyId) as RoutineRow[],
      realm
    ).map((row) => this.routineOf(row));
  }

  /** Adds a routine to a channel for an agent of the company. Creating it again with the same id changes nothing. */
  create(
    companyId: string,
    channelId: string,
    input: RoutineInput & { readonly id: string; readonly createdBy: string }
  ): Routine {
    const name = required(input.name, "Name");
    const now = Date.now();
    const schedule = required(input.schedule, "Schedule");
    this.database
      .query(
        "INSERT OR IGNORE INTO routine (id, company_id, channel_id, name, schedule, instructions, script, store, enabled, next_run_at, created_by, post_in_slack, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?, ?, ?)"
      )
      .run(
        input.id,
        companyId,
        channelId,
        name,
        schedule,
        required(input.instructions, "Instructions"),
        input.script?.trim() || null,
        nextRun(schedule, now),
        input.createdBy,
        input.postInSlack ? 1 : 0,
        now
      );
    return this.routineOf(this.row(companyId, input.id));
  }

  /**
   * Runs the person's Morning brief in their own channel with what the morning review found, in the background; the
   * first time, it makes the routine with `instructions`. A brief that the person paused or deleted does not run.
   */
  runMorning(
    companyId: string,
    owner: User,
    channelId: string,
    instructions: string,
    context: string
  ): void {
    const id = randomUUIDv5(`${companyId}:${owner.id}`, MORNING_NAMESPACE);
    this.database
      .query(
        "INSERT OR IGNORE INTO routine (id, company_id, channel_id, name, schedule, instructions, script, store, enabled, next_run_at, created_by, post_in_slack, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, NULL, '{}', 1, NULL, ?, 0, ?, 'morning')"
      )
      .run(
        id,
        companyId,
        channelId,
        MORNING_NAME,
        MORNING_SCHEDULE,
        instructions,
        owner.id,
        Date.now()
      );
    const [routine] = this.live(
      this.database
        .query(
          `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE id = ? AND enabled = 1 AND deleted_at IS NULL`
        )
        .all(id) as RoutineRow[]
    );
    if (!routine || this.running.has(routine.id)) {
      return;
    }
    this.run({ ...routine, context }, Date.now()).catch(() => {
      // The run records its own failure; this one is a database closed while it ran.
    });
  }

  /**
   * Changes a routine for an agent of the company. A new schedule moves the next run. The person who writes new instructions or a new script, `changedBy`, becomes the
   * person its runs are for.
   */
  update(
    companyId: string,
    realm: Realm,
    routineId: string,
    changes: Partial<RoutineInput> & { readonly enabled?: boolean },
    changedBy: string
  ): Routine {
    const row = this.row(companyId, routineId, realm);
    const routine = this.routineOf(row);
    const createdBy =
      changes.script === undefined && changes.instructions === undefined
        ? row.createdBy
        : changedBy;
    if (row.kind === "morning" && changes.schedule !== undefined) {
      throw new HttpError(
        400,
        "The Morning brief has no schedule: it runs at the morning review, in the 08:00 hour of its person's time zone."
      );
    }
    const moved = changes.schedule !== undefined;
    const schedule = changes.schedule ?? row.schedule;
    const enabled = changes.enabled ?? routine.enabled;
    const script =
      changes.script === undefined
        ? routine.script
        : changes.script?.trim() || null;
    this.database
      .query(
        "UPDATE routine SET name = ?, schedule = ?, instructions = ?, script = ?, enabled = ?, next_run_at = ?, created_by = ?, post_in_slack = ? WHERE id = ?"
      )
      .run(
        required(changes.name ?? routine.name, "Name"),
        schedule,
        required(changes.instructions ?? routine.instructions, "Instructions"),
        script,
        enabled ? 1 : 0,
        moved || changes.enabled !== undefined
          ? nextRunOf({ ...row, schedule }, Date.now())
          : routine.nextRunAt,
        createdBy,
        (changes.postInSlack ?? routine.postInSlack) ? 1 : 0,
        routineId
      );
    return this.routineOf(this.row(companyId, routineId));
  }

  /** Deletes a routine in a channel `realm` sees, for an agent of the company; its thread stays. */
  remove(companyId: string, realm: Realm, routineId: string): Routine {
    const routine = this.routineOf(this.row(companyId, routineId, realm));
    this.softDelete(routineId);
    return routine;
  }

  /**
   * Runs a script once, as a routine run would, with the values a routine stored and the integrations of the person
   * who tests it; nothing is saved. Only the routine's own person tests with its stored values, which their
   * integrations filled.
   */
  async test(
    companyId: string,
    realm: Realm,
    script: string,
    routineId: string | undefined,
    userId: string | null
  ): Promise<ScriptResult> {
    const routine = routineId
      ? this.row(companyId, routineId, realm)
      : undefined;
    if (routine && routine.createdBy !== (userId ?? "shadow")) {
      throw new Error(
        "Only the person who last wrote this routine can test with its stored values. Test without the routine."
      );
    }
    const running =
      routine &&
      (this.database
        .query(
          "SELECT result FROM routine_run WHERE routine_id = ? AND outcome = 'running' AND result IS NOT NULL AND (input IS NULL OR json_extract(input, '$.createdBy') = ?) ORDER BY started_at DESC LIMIT 1"
        )
        .get(routine.id, userId ?? "shadow") as
        | { result: string }
        | null
        | undefined);
    const result = running
      ? (JSON.parse(running.result) as ScriptResult)
      : undefined;
    const store = result?.ok
      ? result.store
      : JSON.parse(routine?.store ?? "{}");
    return this.execute(companyId, script, store, userId, realm);
  }

  /** The TypeScript declarations of the tools that scripts of a company can call. */
  async declarations(companyId: string): Promise<string> {
    return renderDeclarations({
      tools: await this.scriptTools(companyId, null, null),
    });
  }

  /** The agent tools that create, change, test, and delete routines. */
  async tools(companyId: string) {
    return routineTools(
      this,
      this.companies,
      this.threads,
      companyId,
      await this.declarations(companyId)
    );
  }

  private run(routine: RoutineRow, now: number): Promise<RoutineRun> {
    const id = randomUUID();
    const startedAt = Date.now();
    this.database
      .query(
        "INSERT INTO routine_run (id, routine_id, started_at, outcome, input) VALUES (?, ?, ?, 'running', ?)"
      )
      .run(id, routine.id, startedAt, JSON.stringify(routine));
    this.database
      .query("UPDATE routine SET next_run_at = ? WHERE id = ?")
      .run(nextRunOf(routine, now + MIN_ROUTINE_GAP), routine.id);
    return this.finish(routine, id, startedAt, null);
  }

  /** Performs a run, with what its script found when a stop cut it off after the script, and records its outcome. */
  private async finish(
    routine: RoutineRow,
    id: string,
    startedAt: number,
    found: ScriptResult | null
  ): Promise<RoutineRun> {
    this.running.add(routine.id);
    let outcome: RoutineOutcome;
    let error: string | null = null;
    try {
      outcome = await this.perform(routine, id, startedAt, found);
    } catch (failure) {
      if (this.closed) {
        return {
          id,
          routineId: routine.id,
          routineName: routine.name,
          startedAt,
          finishedAt: null,
          outcome: "running",
          error: null,
        };
      }
      outcome = "failed";
      error = (failure as Error).message;
      await this.reportFailure(routine, id, error).catch((report: unknown) => {
        console.error(
          `Reporting the failed run of ${routine.name} failed`,
          report
        );
      });
    } finally {
      this.running.delete(routine.id);
    }
    const finishedAt = Date.now();
    this.database
      .query(
        // The run's copy of the routine and its script result serve only a run that a stop cut off.
        "UPDATE routine_run SET outcome = ?, error = ?, finished_at = ?, input = NULL, result = NULL WHERE id = ?"
      )
      .run(outcome, error, finishedAt, id);
    return {
      id,
      routineId: routine.id,
      routineName: routine.name,
      startedAt,
      finishedAt,
      outcome,
      error,
    };
  }

  private async perform(
    routine: RoutineRow,
    runId: string,
    startedAt: number,
    found: ScriptResult | null
  ): Promise<"quiet" | "posted"> {
    if (routine.createdBy !== "shadow") {
      try {
        this.companies.requireMember(routine.companyId, {
          id: routine.createdBy,
          name: "",
          email: "",
        });
      } catch (error) {
        throw new Error(
          "Its person is no longer a member; change it to run it as yourself.",
          { cause: error }
        );
      }
    }
    if (routine.kind === "morning") {
      // The person keeps the brief to be told: its answer notifies them.
      const answer = await this.tell(
        routine,
        runId,
        morningTask(routine, startedAt),
        [routine.createdBy]
      );
      return answer === null ? "quiet" : "posted";
    }
    if (!routine.script) {
      const answer = await this.tell(
        routine,
        runId,
        runTask(routine, null, startedAt),
        []
      );
      this.post(routine, answer);
      return answer === null ? "quiet" : "posted";
    }
    const result =
      found ??
      (await this.execute(
        routine.companyId,
        routine.script,
        JSON.parse(routine.store),
        routine.createdBy,
        this.realmOf(routine)
      ));
    // A run that a stop cuts off goes on with this result: a new script run could find other things.
    this.database
      .query("UPDATE routine_run SET result = ? WHERE id = ?")
      .run(JSON.stringify(result), runId);
    if (!result.ok) {
      // The run's failure notifies its person once; the agent's repair answer stays in the thread.
      await this.tell(
        routine,
        runId,
        repairTask(routine, result, startedAt),
        []
      );
      throw new Error(result.error);
    }
    // Saved only once the agent has what the script found, so a failed answer finds it again next run.
    const answer =
      result.text === null
        ? null
        : await this.tell(
            routine,
            runId,
            runTask(routine, result.text, startedAt),
            []
          );
    this.database
      .query("UPDATE routine SET store = ? WHERE id = ?")
      .run(JSON.stringify(result.store), routine.id);
    this.post(routine, answer);
    return answer === null ? "quiet" : "posted";
  }

  /** Gives an answer of a routine that posts in Slack to Slack; a quiet run posts nothing. */
  private post(routine: RoutineRow, answer: string | null): void {
    if (answer !== null && routine.postInSlack === 1) {
      this.posted(routine, answer);
    }
  }

  /**
   * Gives the agent of the routine's thread a task, and starts the thread on the first one. Its answer notifies
   * `notify`: a run's answer notifies nobody, as the agent calls notify when something is wrong or unusual; a repair's
   * answer, which says what does not work, notifies everyone who sees the thread.
   */
  private async tell(
    routine: RoutineRow,
    runId: string,
    text: string,
    notify: readonly string[] | "everyone"
  ): Promise<string | null> {
    return this.threads.instruct(
      await this.threadFor(routine),
      text,
      `routine:${runId}`,
      notify,
      routine.createdBy,
      "routine"
    );
  }

  /**
   * Tells the routine's person in its thread that a run failed, with a notification, every time, also when the agent
   * repaired the script or could not answer.
   */
  private async reportFailure(
    routine: RoutineRow,
    runId: string,
    error: string
  ): Promise<void> {
    if (routine.createdBy === "shadow") {
      return;
    }
    await this.threads.observe(
      await this.threadFor(routine),
      `The routine "${routine.name}" failed: ${error}`,
      `routine:${runId}:failed`,
      { id: routine.createdBy, name: "", email: "" },
      true
    );
  }

  /** The routine's thread, started at its first run; read again, as an earlier step of this run may have started it. */
  private async threadFor(routine: RoutineRow) {
    const { threadId } = this.database
      .query("SELECT thread_id AS threadId FROM routine WHERE id = ?")
      .get(routine.id) as { threadId: string | null };
    const existing = this.companies
      .allThreadsIn(routine.companyId)
      .find((candidate) => candidate.id === threadId);
    if (existing) {
      return existing;
    }
    const thread = await this.threads.startAgentThread(
      routine.companyId,
      routine.channelId,
      routine.name
    );
    this.database
      .query("UPDATE routine SET thread_id = ? WHERE id = ?")
      .run(thread.id, routine.id);
    return thread;
  }

  /** Runs a script with the integrations of the person `userId`'s turns use, and what `realm` sees. */
  private async execute(
    companyId: string,
    script: string,
    store: Record<string, unknown>,
    userId: string | null,
    realm: Realm
  ): Promise<ScriptResult> {
    const sandbox = new CodemodeSandbox({
      tools: await this.scriptTools(companyId, userId, realm),
      timeoutMs: SCRIPT_TIMEOUT,
      memoryLimitBytes: 256 * 1024 * 1024,
    });
    try {
      const result = await sandbox.execute(script, { store });
      const printed = result.output
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      if (!result.ok) {
        return {
          ok: false,
          error: `${result.error.name ?? result.error.kind}: ${result.error.message}`,
          text: printed,
        };
      }
      for (const key of result.storeWrites.delete) {
        delete store[key];
      }
      Object.assign(store, result.storeWrites.set);
      const { value } = result;
      const nothing =
        value === undefined ||
        value === null ||
        (Array.isArray(value) && value.length === 0);
      const text = [printed, nothing ? "" : JSON.stringify(value, null, 2)]
        .filter(Boolean)
        .join("\n");
      return {
        ok: true,
        text: text ? cut(text) : null,
        store,
      };
    } finally {
      await sandbox.close();
    }
  }

  /** The person of a routine's private channel; null for a channel every member sees. */
  private realmOf(routine: RoutineRow): Realm {
    return (
      this.companies
        .allChannelsIn(routine.companyId)
        .find((channel) => channel.id === routine.channelId)?.ownerId ?? null
    );
  }

  /**
   * What scripts call: the connectors' tools, and reading the channels, threads, and search of the company that
   * `realm` sees.
   */
  private async scriptTools(
    companyId: string,
    userId: string | null,
    realm: Realm
  ): Promise<CodemodeTool[]> {
    const connectors = (await this.integrations.tools(companyId)).map(
      (tool): CodemodeTool => ({
        name: tool.name,
        description: tool.description,
        // A TypeBox schema is a JSON schema.
        inputSchema: { ...tool.parameters },
        execute: (args, { signal }) => tool.execute(args, { userId, signal }),
      })
    );
    return [
      ...connectors,
      {
        name: "list_channels",
        description:
          "The channels of the company with their summaries and threads, newest thread first.",
        inputSchema: { type: "object", properties: {} },
        execute: () =>
          this.companies.channelsIn(companyId, realm).map((channel) => ({
            name: channel.name,
            summary: channel.summary,
            threads: channel.threads.map(({ id, title, updatedAt }) => ({
              id,
              title,
              updatedAt,
            })),
          })),
      },
      {
        name: "read_thread",
        description:
          "The newest messages of a thread, oldest first. `time` is in Unix milliseconds.",
        inputSchema: {
          type: "object",
          properties: {
            thread: { type: "string", description: "The thread id" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
          required: ["thread"],
        },
        execute: async (args) => {
          const { thread: threadId, limit } = args as {
            thread: string;
            limit?: number;
          };
          // A script reads no person's own thread.
          const thread = this.companies
            .threadsIn(companyId, realm)
            .find(
              (candidate) =>
                candidate.id === threadId && candidate.ownerId === null
            );
          if (!thread) {
            throw new Error(`There is no thread ${threadId}.`);
          }
          const { messages } = await this.threads.messages(thread);
          return messages
            .filter((message) => !message.streaming)
            .slice(-(limit ?? 50))
            .map(({ author, text, time }) => ({ author, text, time }));
        },
      },
      {
        name: "search",
        description:
          "Search the company: threads, notes, files, and captured mail or threads.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
          required: ["query"],
        },
        execute: async (args) => {
          const { query, limit } = args as { query: string; limit?: number };
          return (
            await this.search.search(companyId, query, limit ?? 10, realm)
          ).results;
        },
      },
    ];
  }

  private routineOf(row: RoutineRow): Routine {
    const lastRun = this.database
      .query(
        `SELECT ${RUN_COLUMNS} FROM routine_run r JOIN routine t ON t.id = r.routine_id WHERE r.routine_id = ? ORDER BY r.started_at DESC LIMIT 1`
      )
      .get(row.id) as RoutineRun | null;
    return {
      id: row.id,
      channelId: row.channelId,
      name: row.name,
      schedule: row.schedule,
      instructions: row.instructions,
      script: row.script,
      enabled: row.enabled === 1,
      nextRunAt: row.enabled === 1 ? row.nextRunAt : null,
      threadId: row.threadId,
      postInSlack: row.postInSlack === 1,
      kind: row.kind,
      lastRun,
    };
  }

  /** Nothing is removed: a deleted routine stays, hidden, and never runs again. */
  private softDelete(routineId: string): void {
    this.database
      .query("UPDATE routine SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), routineId);
  }

  /**
   * The routines among `rows` whose channel is not deleted, and that `realm` sees when given; a deleted channel's
   * routines rest with it.
   */
  private live(rows: RoutineRow[], realm?: Realm): RoutineRow[] {
    const channels = new Map<string, Set<string>>();
    return rows.filter((row) => {
      let ids = channels.get(row.companyId);
      if (!ids) {
        ids = new Set(
          (realm === undefined
            ? this.companies.allChannelsIn(row.companyId)
            : this.companies.channelsIn(row.companyId, realm)
          ).map((channel) => channel.id)
        );
        channels.set(row.companyId, ids);
      }
      return ids.has(row.channelId);
    });
  }

  private row(companyId: string, routineId: string, realm?: Realm): RoutineRow {
    const [row] = this.live(
      this.database
        .query(
          `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE id = ? AND company_id = ? AND deleted_at IS NULL`
        )
        .all(routineId, companyId) as RoutineRow[],
      realm
    );
    if (!row) {
      throw new Error(
        `There is no routine ${routineId}. routines_list shows the routines.`
      );
    }
    return row;
  }

  private rowFor(routineId: string, user: User): RoutineRow {
    const [row] = this.live(
      this.database
        .query(
          `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE id = ? AND deleted_at IS NULL`
        )
        .all(routineId) as RoutineRow[]
    );
    if (!row) {
      throw notFound();
    }
    this.companies.channel(row.companyId, row.channelId, user);
    return row;
  }
}

/** The next time after `now` that a cron expression names; throws for one that is not valid. */
export function nextRun(schedule: string, now: number): number | null {
  try {
    return Bun.cron.parse(schedule, now)?.getTime() ?? null;
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: HttpError takes the cause as its third argument.
    throw new HttpError(
      400,
      `The schedule "${schedule}" is not a cron expression: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

function runTask(
  routine: RoutineRow,
  found: string | null,
  startedAt: number
): string {
  return [
    `The routine "${routine.name}" (routine ${routine.id}) runs now, at ${localTime(startedAt)}.`,
    `Its instructions: ${routine.instructions}`,
    found === null ? "" : `What its script found:\n${found}`,
    `Do what the instructions say, with your tools. Write your answer for the people in this channel; it stays in this thread and notifies nobody. Call notify only when something is wrong or not usual, such as a source or a connector that fails, or when the instructions ask you to alert people. If nothing needs anyone's attention, answer with only QUIET.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function morningTask(routine: RoutineRow, startedAt: number): string {
  return [
    `Your Morning brief (routine ${routine.id}) runs now, at ${localTime(startedAt)}, after Shadow's morning review.`,
    `Its instructions, which the person and you may change with routines_update:\n${routine.instructions}`,
    routine.context ?? "The person started this run by hand.",
    "Do what the instructions say, with your tools. Write the brief for the person; it stays in this thread and notifies them. If nothing needs them, answer with only QUIET.",
  ].join("\n\n");
}

/** The next run of a routine on its schedule; a Morning brief runs only at the morning review. */
function nextRunOf(
  routine: Pick<RoutineRow, "kind" | "schedule">,
  now: number
): number | null {
  return routine.kind === "morning" ? null : nextRun(routine.schedule, now);
}

function repairTask(
  routine: RoutineRow,
  result: { readonly error: string; readonly text: string },
  startedAt: number
): string {
  return [
    `The script of the routine "${routine.name}" (routine ${routine.id}) failed at ${localTime(startedAt)}: ${result.error}`,
    result.text ? `It printed:\n${cut(result.text)}` : "",
    `The script:\n${routine.script}`,
    "Find the cause. If the script is wrong, fix it: run the new script with routines_test_script, then save it with routines_update. Say in plain words what did not work and what you did; when something outside the script fails, such as a connector or a website, say what the people can do. Shadow notifies the routine's person of the failure itself.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function cut(text: string): string {
  return text.length > MAX_RESULT
    ? `${text.slice(0, MAX_RESULT)}\n[The rest of the ${text.length} characters is cut.]`
    : text;
}
