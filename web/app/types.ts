// The types of the JSON API, as docs/api.md writes them. test/web-types.test.ts checks that the server's types fit them.

export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly picture: string | null;
}

export interface Company {
  readonly id: string;
  readonly name: string;
  /** The person's role: an `admin` runs Company settings, the people, and the Slack bot; a `member` uses Shadow. */
  readonly role: Role;
}

export type Role = "admin" | "member";

/** Times are Unix milliseconds. */
export interface ThreadSummary {
  readonly id: string;
  readonly channelId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly settledAt: number | null;
}

export interface ListedThread extends ThreadSummary {
  readonly channel: string;
}

export interface Channel {
  readonly id: string;
  readonly name: string;
  /** The person a private channel belongs to; null for one every member sees. */
  readonly ownerId: string | null;
  readonly summary: string | null;
  readonly icon: string | null;
  /** The Slack channel it copies; null for a channel that no Slack channel made. */
  readonly slackId: string | null;
  /** The member's own private channel, which Shadow makes for each member. */
  readonly personal: boolean;
  /** Newest first. */
  readonly threads: readonly ThreadSummary[];
}

/** The Slack bot of a company, which listens to its Slack over Socket Mode; for its admins. */
export interface SlackBotStatus {
  readonly connected: boolean;
  readonly listening: boolean;
  readonly team: string | null;
  readonly syncedAt: number | null;
  readonly error: string | null;
}

/** A channel that copies a Slack channel, with its own goal for ambient listening; null when it uses the default goal. */
export interface SlackGoal {
  readonly channelId: string;
  readonly channelName: string;
  readonly wakeWhen: string | null;
  readonly engagement: string | null;
  /** Shadow answers only mentions here, whatever the goals say. */
  readonly off: boolean;
}

/** The goal of every Slack channel without its own goal; null when Shadow listens only where a channel has one. */
export interface SlackDefaultGoal {
  readonly wakeWhen: string | null;
  readonly engagement: string | null;
}

/** What ambient listening decided about one Slack message, without its text. */
export interface SlackDecision {
  readonly channelName: string;
  readonly slackChannelId: string;
  readonly ts: string;
  readonly reason: string;
  readonly probability: number | null;
  readonly outcome: string;
  readonly at: number;
}

export interface Facts {
  readonly text: string;
}

export interface Member {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly picture: string | null;
  readonly role: Role;
}

export interface Brief {
  /** Markdown with thread links, `[title](thread:<threadId>)`. */
  readonly text: string;
  readonly updatedAt: number;
}

export interface FileRef {
  readonly id: string;
  readonly name: string;
}

export interface Message {
  readonly id: string;
  /** Null for the agent. */
  readonly authorId: string | null;
  readonly author: string;
  readonly agent: boolean;
  readonly text: string;
  readonly time: number;
  /** The agent's answer failed; `text` is the error. */
  readonly failed: boolean;
  /** The agent is still writing this message. */
  readonly streaming: boolean;
  readonly files: readonly FileRef[];
  /** What the agent did before this answer; null for people and for an answer without work. */
  readonly work: Work | null;
}

export interface Work {
  readonly startedAt: number;
  /** Null while the agent works. */
  readonly endedAt: number | null;
  readonly stopped: boolean;
  readonly steps: readonly Step[];
}

/** A thought, words between tool calls, or a tool call. */
export interface Step {
  readonly kind: "thinking" | "text" | "tool";
  readonly text: string;
  readonly tool: string | null;
  readonly input: string | null;
  readonly output: string | null;
  readonly running: boolean;
  readonly failed: boolean;
}

export interface SavedFile {
  readonly id: string;
  readonly name: string;
  /** Bytes. */
  readonly size: number;
  readonly time: number;
}

export interface ThreadState {
  readonly thread: ThreadSummary;
  readonly messages: readonly Message[];
  readonly running: boolean;
  readonly approvals: readonly Approval[];
}

/** An action that waits for one person, or for any member when `approverId` is null. */
export interface Approval {
  readonly id: string;
  readonly tool: string;
  readonly text: string;
  readonly approverId: string | null;
  readonly expiresAt: number;
}

export type SearchKind = "thread" | "artifact" | "note" | "file" | "capture";
export type Modality = "text" | "image" | "audio" | "none";

export interface SearchResult {
  /** `thread:<id>`, `artifact:<id>`, or a path under the company folder. */
  readonly uri: string;
  readonly kind: SearchKind;
  readonly modality: Modality;
  readonly title: string;
  readonly threadId: string | null;
  readonly channelId: string | null;
  readonly snippet: string;
  readonly score: number;
  readonly updatedAt: number;
}

/** A query that the person searched, and when they last searched it. */
export interface RecentSearch {
  readonly query: string;
  readonly searchedAt: number;
}

export interface SearchResponse {
  readonly results: readonly SearchResult[];
  /** False while the search model starts: results then match words only. */
  readonly semantic: boolean;
}

export interface Credential {
  readonly id: string;
  readonly label: string;
  /** The person who connected it; only they share or delete it. */
  readonly ownerId: string;
  readonly ownerName: string;
  /** Whether every member's turns use it; else only its owner's. */
  readonly watched: boolean;
  readonly createdAt: number;
}

export interface Integration {
  readonly id: string;
  readonly name: string;
  /** With a secret, by signing in on its page, or by linking a phone number with a code. */
  readonly connect: "secret" | "sign-in";
  /** The name of the secret, for `connect: "secret"`. */
  readonly secretLabel: string | null;
  /** Whether the person names a credential; else Shadow names it from the secret. */
  readonly labeled: boolean;
  /** Whether the secret, or the sign-in, also needs the address of the person's own server. */
  readonly address: boolean;
  /** The name of the account that the secret also needs, such as `Email`, which names the credential. */
  readonly username: string | null;
  /** The steps that set it up, in Markdown; empty when Connect is all. */
  readonly guide: readonly string[];
  readonly watchable: boolean;
  /** Shadow's own OAuth client, which an admin sets: its ID, and whether this person may set it. */
  readonly client: {
    readonly clientId: string | null;
    readonly changeable: boolean;
  } | null;
  readonly credentials: readonly Credential[];
}

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

export interface Routine {
  readonly id: string;
  readonly channelId: string;
  readonly name: string;
  /** A cron expression in the server's time zone. */
  readonly schedule: string;
  readonly enabled: boolean;
  /** Null while paused. */
  readonly nextRunAt: number | null;
  readonly threadId: string | null;
  /** Whether each answer also goes to the Slack channel that its channel copies. */
  readonly postInSlack: boolean;
  readonly lastRun: RoutineRun | null;
}

export interface Artifact {
  /** Four words, such as "amber-fox-lake-moss"; names from before have two. */
  readonly id: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly title: string;
  readonly visibility: "public" | "members";
  readonly url: string;
  readonly visitors: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ArtifactRecord {
  readonly id: string;
  /** Null for a shared record. */
  readonly visitor: string | null;
  readonly name: string | null;
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: number;
}

export type Effort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** What an agent reported about Shadow itself; only an admin reads it. */
export interface Feedback {
  readonly id: string;
  readonly kind: "error" | "missing" | "better";
  readonly tool: string | null;
  readonly summary: string;
  readonly detail: string;
  /** The thread of the turn; null when the admin does not see it. */
  readonly threadId: string | null;
  readonly createdAt: number;
}

export interface LlmStatus {
  readonly connected: boolean;
  /** Whether the person is an admin, who alone changes the login, the model, and the effort. */
  readonly admin: boolean;
  readonly provider: string;
  readonly model: string;
  readonly effort: Effort;
  readonly models: readonly {
    readonly id: string;
    readonly name: string;
    readonly efforts: readonly Effort[];
  }[];
  readonly login: {
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresAt: number;
  } | null;
  readonly error: string | null;
}

/** Something that needs the person: it opens its thread, or its channel without one. */
export interface Notification {
  readonly id: string;
  readonly companyId: string;
  readonly channelId: string;
  readonly threadId: string | null;
  readonly title: string;
  readonly text: string;
  readonly createdAt: number;
  readonly readAt: number | null;
}

export interface Inbox {
  readonly notifications: readonly Notification[];
  readonly unread: number;
}

/** Tokens and cost of model calls; `input` leaves out `cacheRead`, the tokens read from the prompt cache. */
export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** US dollars at the model's list price, which a ChatGPT login does not pay. */
  readonly cost: number;
}

export type UsageSource =
  | "thread"
  | "orchestrator"
  | "routine"
  | "reminder"
  | "intake"
  | "slack"
  | "background";

export interface Usage {
  /** "YYYY-MM-DD" in UTC, oldest first; a day without use is left out. */
  readonly days: readonly (UsageTotals & { readonly day: string })[];
  readonly total: UsageTotals;
  readonly sources: readonly (UsageTotals & { readonly source: UsageSource })[];
  readonly models: readonly (UsageTotals & { readonly model: string })[];
  readonly threads: readonly (UsageTotals & {
    readonly threadId: string;
    readonly title: string;
  })[];
  /** Only for an admin; userId "" is work for nobody. */
  readonly people:
    | readonly (UsageTotals & {
        readonly userId: string;
        readonly name: string;
      })[]
    | null;
}

/** What Shadow learned: a fact about a person, or a how-to of a channel. */
export interface Learned {
  readonly id: number;
  readonly kind: "about" | "howto";
  readonly personId: string | null;
  /** Null for a fact, and for a how-to of the person's own orchestrator. */
  readonly channelId: string | null;
  /** The person who alone sees it; null for every member. */
  readonly realm: string | null;
  readonly text: string;
  readonly threadId: string | null;
  readonly updatedAt: number;
}

/** An automation that Shadow suggests; nothing runs until the person accepts it. */
export interface Suggestion {
  readonly id: string;
  readonly kind: "routine" | "reminder";
  readonly name: string;
  readonly text: string;
  readonly schedule: string | null;
  /** When the reminder is due, or the routine's first run. */
  readonly at: number | null;
  readonly channelId: string;
  readonly threadId: string;
  readonly createdAt: number;
}

export interface Reminder {
  readonly id: string;
  readonly threadId: string;
  readonly recipientId: string;
  readonly createdBy: string | null;
  readonly text: string;
  readonly dueAt: number;
}

export interface Upcoming {
  readonly routines: readonly Routine[];
  readonly reminders: readonly Reminder[];
  readonly suggestions: readonly Suggestion[];
  readonly approvals: readonly {
    readonly threadId: string;
    readonly approval: Approval;
  }[];
}

export interface CheckSnapshot {
  text: string;
  state: "open" | "resolved" | "stopped";
  sourceIds: string[];
  threadId: string | null;
  checkAt: number;
  reviewAt: number;
  explicitTime: number;
  notifiedAt: number | null;
}
export interface FollowingCheck extends CheckSnapshot {
  id: string;
  revision: number;
  updatedAt: number;
}
/** A source observation: a mail, a message, or a note that intake keeps. */
export interface IntakeEvidence {
  id: string;
  source: string;
  text: string;
  at: number;
  url: string | null;
  fromOwner: boolean;
  attachments?: readonly { name: string; type: string; size: number }[];
}
export interface FollowingDetail {
  check: FollowingCheck;
  evidence: IntakeEvidence[];
  history: {
    id: number;
    at: number;
    action: string;
    quote: string | null;
    previous: CheckSnapshot | null;
    current: CheckSnapshot;
  }[];
}
export interface FollowingOverview {
  sources: {
    id: string;
    name: string;
    readAt: number | null;
    error: string | null;
    kept: number;
  }[];
  updates: IntakeUpdate[];
  kept: IntakeKept[];
  feedback: IntakeFeedback[];
  blocked: IntakeBlock[];
}
export interface IntakeBlock {
  id: string;
  kind: "sender" | "chat";
  label: string;
  createdAt: number;
}
export interface IntakeUpdate {
  id: string;
  threadId: string | null;
  threadTitle: string | null;
  newThread: string | null;
  body: string;
  attention: "now" | "brief";
  notice: string | null;
  createdAt: number;
  deliveredAt: number | null;
  cancelledAt: number | null;
  evidence: IntakeEvidence[];
}
export interface IntakeKept extends IntakeEvidence {
  outcome: "thread" | "filed" | "context";
  threadId: string | null;
  place: string | null;
}
export interface IntakeFeedback {
  id: string;
  target: string;
  about: string;
  quote: string;
  createdAt: number;
}
export interface FollowingChange {
  action: "handled" | "stop" | "reopen" | "correct" | "undo";
  revision: number;
  quote: string;
}
