import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ProfilePicture, ProfilePictures } from "../accounts/accounts.ts";
import type { Auth, User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";

/**
 * Whose private data a read sees besides what every member sees: a person's id, or `null` for none. A thread's agent
 * sees its thread's realm, so what it says in a channel every member reads never comes from a private channel.
 */
export type Realm = string | null;

/**
 * What identifies a thread: its id, its company, its conversation in that company's session, and, for an
 * orchestrator, the person it belongs to; `ownerId` is null for a thread of a channel. `realm` is the person of an
 * orchestrator or of a private channel, and null for a thread of a channel every member sees.
 */
export interface ThreadRef {
  readonly conversationId: number;
  readonly id: string;
  readonly ownerId: string | null;
  readonly realm: Realm;
  readonly companyId: string;
}
export interface Company {
  readonly id: string;
  readonly name: string;
  /** The person's role: an `admin` runs the company's settings, people, and integrations; a `member` uses it. */
  readonly role: Role;
}
export type Role = "admin" | "member";
/** A public channel of the company's Slack, as the Slack bot lists it. */
export interface SlackChannel {
  /** Whether it is the channel of everyone in Slack, such as #general. */
  readonly general: boolean;
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
}
/** What one sync with Slack changed. */
export interface SlackSync {
  readonly created: number;
  readonly hidden: number;
  readonly renamed: number;
  readonly restored: number;
}
export interface ThreadSummary {
  readonly channelId: string;
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly settledAt: number | null;
}
export interface Channel {
  readonly id: string;
  readonly name: string;
  /** The person a private channel belongs to, who alone sees it; null for a channel every member sees. */
  readonly ownerId: string | null;
  /** What the channel is for and what goes on in it, as an agent last wrote it. */
  readonly summary: string | null;
  /** An emoji for the channel, as the model last chose it. */
  readonly icon: string | null;
  /** The ID of the Slack channel it copies; null for a channel that no Slack channel made. */
  readonly slackId: string | null;
  /** The member's own private channel, which Shadow makes for each member, like a DM to oneself in Slack. */
  readonly personal: boolean;
  readonly threads: readonly ThreadSummary[];
}
/** Facts about the company that its people write by hand; every agent of the company reads them. */
export interface Facts {
  readonly text: string;
}
export interface Member {
  readonly email: string;
  readonly name: string;
  /** The address of the person's profile picture, or null for none. */
  readonly picture: string | null;
  readonly role: Role;
  readonly userId: string;
}

/** The longest facts text, so it stays a small part of every agent's instructions. */
const MAX_FACTS = 20_000;

/** Leaves out the rows of deleted companies. */
const LIVE =
  "company_id IN (SELECT id FROM organization WHERE deletedAt IS NULL)";
/** The columns of a thread as `ThreadSummary & ThreadRef`, from `thread t JOIN channel c`. */
const THREAD =
  "t.id, t.company_id AS companyId, t.conversation_id AS conversationId, t.channel_id AS channelId, t.title, t.updated_at AS updatedAt, t.settled_at AS settledAt, CASE WHEN t.orchestrator = 1 THEN t.created_by END AS ownerId, CASE WHEN t.orchestrator = 1 THEN t.created_by ELSE c.owner_id END AS realm";

/**
 * Companies are isolated: every read and write goes through a membership check, and nothing crosses
 * companies except the LLM provider.
 */
export class Companies {
  constructor(
    private readonly database: Database,
    private readonly auth: Auth,
    private readonly pictures: ProfilePictures,
    /** Called when someone joins a company, whose own integrations then reach its agents. */
    private readonly memberAdded: (companyId: string) => void = () => undefined
  ) {}

  list(user: User): Company[] {
    return this.database
      .query(
        "SELECT o.id, o.name, m.role FROM organization o JOIN member m ON m.organizationId = o.id WHERE m.userId = ? AND o.deletedAt IS NULL ORDER BY o.createdAt"
      )
      .all(user.id) as Company[];
  }

  /** Every company, for background work such as indexing that acts for no person. */
  ids(): string[] {
    return (
      this.database
        .query("SELECT id FROM organization WHERE deletedAt IS NULL")
        .all() as {
        id: string;
      }[]
    ).map((row) => row.id);
  }

  /** The company if `user` is a member; otherwise not found, so other companies stay invisible. */
  requireMember(companyId: string, user: User): Company {
    const company = this.database
      .query(
        "SELECT o.id, o.name, m.role FROM organization o JOIN member m ON m.organizationId = o.id WHERE o.id = ? AND m.userId = ? AND o.deletedAt IS NULL"
      )
      .get(companyId, user.id) as Company | null;
    if (!company) {
      throw notFound();
    }
    return company;
  }

  /** A company member for agent work that no person started, such as a routine run. */
  agentMember(companyId: string): User {
    const member = this.database
      .query(
        "SELECT u.id, u.name, u.email FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY CASE WHEN m.role = 'admin' THEN 0 ELSE 1 END, m.createdAt LIMIT 1"
      )
      .get(companyId) as User | null;
    if (!member) {
      throw notFound();
    }
    this.requireMember(companyId, member);
    return member;
  }

  /** The company if `user` is an admin of it; a member who is not an admin gets `403`. */
  requireAdmin(companyId: string, user: User): Company {
    const company = this.requireMember(companyId, user);
    if (company.role !== "admin") {
      throw new HttpError(403, "Only an admin can do this");
    }
    return company;
  }

  /**
   * Whether the person is an admin of the company; without one, of any company, for what all companies share, such
   * as the model.
   */
  isAdmin(user: User, companyId?: string): boolean {
    return this.list(user).some(
      (company) =>
        company.role === "admin" &&
        (companyId === undefined || company.id === companyId)
    );
  }

  async create(user: User, name: string): Promise<Company> {
    const trimmed = required(name, "Name");
    const slug = `${
      trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "company"
    }-${randomUUID().slice(0, 8)}`;
    const created = await this.auth.api.createOrganization({
      body: { name: trimmed, slug, userId: user.id },
    });
    if (!created) {
      throw new HttpError(500, "Could not create the company");
    }
    const company: Company = {
      id: created.id,
      name: created.name,
      role: "admin",
    };
    // The orchestrators live here until the Slack bot links it to Slack's general channel.
    this.addChannel(company.id, "general", user.id, null);
    this.personalChannelOf(company.id, user);
    return company;
  }

  rename(companyId: string, user: User, name: string): Company {
    const company = this.requireAdmin(companyId, user);
    const trimmed = required(name, "Name");
    this.database
      .query("UPDATE organization SET name = ? WHERE id = ?")
      .run(trimmed, companyId);
    return { ...company, name: trimmed };
  }

  /** The channels the person sees: those of every member, and their own private ones. */
  channels(companyId: string, user: User): Channel[] {
    this.requireMember(companyId, user);
    return this.channelsIn(companyId, user.id);
  }

  /** A channel of the person's company; not found when it is deleted or in another company. */
  channel(companyId: string, channelId: string, user: User): Channel {
    const channel = this.channels(companyId, user).find(
      (candidate) => candidate.id === channelId
    );
    if (!channel) {
      throw notFound();
    }
    return channel;
  }

  /** The channels of a company that `realm` sees, with their threads, newest first, for agents. */
  channelsIn(companyId: string, realm: Realm): Channel[] {
    return this.allChannelsIn(companyId).filter(
      (channel) => channel.ownerId === null || channel.ownerId === realm
    );
  }

  /** Every channel of a company, private ones too, for background work that acts for no person. */
  allChannelsIn(companyId: string): Channel[] {
    const channels = this.database
      .query(
        `SELECT id, name, owner_id AS ownerId, summary, icon, slack_id AS slackId, personal FROM channel WHERE company_id = ? AND deleted_at IS NULL AND ${LIVE} ORDER BY created_at, rowid`
      )
      .all(companyId) as (Omit<Channel, "threads" | "personal"> & {
      personal: number;
    })[];
    const threads = this.database
      .query(
        "SELECT id, channel_id AS channelId, title, updated_at AS updatedAt, settled_at AS settledAt FROM thread WHERE company_id = ? AND orchestrator = 0 ORDER BY updated_at DESC"
      )
      .all(companyId) as ThreadSummary[];
    return channels.map((channel) => ({
      ...channel,
      personal: channel.personal === 1,
      threads: threads.filter((thread) => thread.channelId === channel.id),
    }));
  }

  /** Adds a private channel of the person; the channels that every member sees come only from Slack. */
  createChannel(companyId: string, user: User, name: string): Channel {
    this.requireMember(companyId, user);
    return this.addChannel(companyId, name, user.id, user.id);
  }

  /**
   * The member's own private channel, made at once when they have none: named after them, else after them with a
   * number when another channel has that name.
   */
  personalChannelOf(
    companyId: string,
    person: Pick<User, "id" | "name" | "email">
  ): Channel {
    const own = this.allChannelsIn(companyId).find(
      (channel) => channel.personal && channel.ownerId === person.id
    );
    if (own) {
      return own;
    }
    const base = person.name.trim() || person.email.split("@")[0] || "me";
    for (let number = 1; ; number += 1) {
      try {
        const name = number === 1 ? base : `${base} ${number}`;
        const channel = this.addChannel(companyId, name, person.id, person.id);
        this.database
          .query("UPDATE channel SET personal = 1 WHERE id = ?")
          .run(channel.id);
        return { ...channel, personal: true };
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 409)) {
          throw error;
        }
      }
    }
  }

  /**
   * Adds a channel to a company; `createdBy` is a person's id, or `shadow` for a channel an agent made, and `ownerId`
   * the person of a private channel. Names are unique in the company, private ones too.
   */
  addChannel(
    companyId: string,
    name: string,
    createdBy: string,
    ownerId: Realm
  ): Channel {
    const slug = this.freeChannelName(companyId, name);
    const channel = {
      id: randomUUID(),
      name: slug,
      ownerId,
      summary: null,
      icon: null,
      slackId: null,
      personal: false,
      threads: [],
    };
    this.database
      .query(
        "INSERT INTO channel (id, company_id, name, owner_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(channel.id, companyId, slug, ownerId, createdBy, Date.now());
    return channel;
  }

  /** Gives a private channel of the person a new name; a channel that every member sees takes its name from Slack. */
  renameChannel(
    companyId: string,
    user: User,
    channelId: string,
    name: string
  ): Channel {
    const channel = this.channel(companyId, channelId, user);
    if (channel.ownerId === null) {
      throw new HttpError(409, `#${channel.name} takes its name from Slack`);
    }
    const slug = this.freeChannelName(companyId, name, channelId);
    this.database
      .query("UPDATE channel SET name = ? WHERE id = ?")
      .run(slug, channelId);
    return { ...channel, name: slug };
  }

  /** The channels that the person pinned to the top of their sidebar, of those they see. */
  pins(companyId: string, user: User): string[] {
    const seen = new Set(
      this.channels(companyId, user).map((channel) => channel.id)
    );
    return (
      this.database
        .query(
          "SELECT channel_id AS id FROM channel_pin WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL"
        )
        .all(companyId, user.id) as { id: string }[]
    )
      .map((row) => row.id)
      .filter((id) => seen.has(id));
  }

  /** Pins a channel that the person sees to the top of their sidebar, or unpins it. */
  pin(companyId: string, user: User, channelId: string, pinned: boolean): void {
    this.channel(companyId, channelId, user);
    this.database
      .query(
        "INSERT INTO channel_pin (company_id, channel_id, user_id, pinned_at, deleted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET pinned_at = excluded.pinned_at, deleted_at = excluded.deleted_at"
      )
      .run(
        companyId,
        channelId,
        user.id,
        Date.now(),
        pinned ? null : Date.now()
      );
  }

  /**
   * A channel name as Shadow keeps it, as Slack does: lowercase letters, also with diacritics, numbers, and `_`, with `-`
   * between words.
   * `409` when another channel of the company has it.
   */
  private freeChannelName(
    companyId: string,
    name: string,
    channelId = ""
  ): string {
    const slug = required(name, "Name")
      .normalize("NFC")
      .toLowerCase()
      .replace(/^#/, "")
      .replace(/[^\p{L}\p{M}\p{N}_]+/gu, "-")
      .replace(/^-|-$/g, "");
    if (!slug) {
      throw new HttpError(400, "Use letters or numbers in the channel name");
    }
    const exists = this.database
      .query(
        "SELECT 1 FROM channel WHERE company_id = ? AND name = ? AND id != ?"
      )
      .get(companyId, slug, channelId);
    if (exists) {
      throw new HttpError(409, `#${slug} already exists`);
    }
    return slug;
  }

  /**
   * Deletes a channel that `realm` sees, once `Threads.merge` moved all it held to another channel. Nothing is removed: the channel and its threads
   * stay in the database, hidden. Its name gets `~<id>`, which no channel name has, so a new channel can take the
   * name. The orchestrators move to the first other channel that every member sees, so a company keeps one such
   * channel at least.
   */
  removeChannel(companyId: string, channelId: string, realm: Realm): Channel {
    const channel = this.channelsIn(companyId, realm).find(
      (candidate) => candidate.id === channelId
    );
    if (!channel) {
      throw notFound();
    }
    const next = this.channelsIn(companyId, null).find(
      (candidate) => candidate.id !== channelId
    );
    if (!next) {
      throw new HttpError(409, "A company keeps one channel at least");
    }
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE thread SET channel_id = ? WHERE channel_id = ? AND orchestrator = 1"
        )
        .run(next.id, channelId);
      this.database
        .query(
          "UPDATE channel SET deleted_at = ?, name = name || '~' || id WHERE id = ?"
        )
        .run(Date.now(), channelId);
    })();
    return channel;
  }

  /** Replaces the summary of a channel, for an agent that acts for the company. */
  setChannelSummary(
    companyId: string,
    channelId: string,
    summary: string
  ): void {
    this.database
      .query(
        "UPDATE channel SET summary = ? WHERE id = ? AND company_id = ? AND deleted_at IS NULL"
      )
      .run(summary.trim() || null, channelId, companyId);
  }

  /** Replaces the emoji of a channel, for an agent that acts for the company. */
  setChannelIcon(companyId: string, channelId: string, icon: string): void {
    this.database
      .query(
        "UPDATE channel SET icon = ? WHERE id = ? AND company_id = ? AND deleted_at IS NULL"
      )
      .run(icon, channelId, companyId);
  }

  /** The facts that the people of the company wrote, such as names, birthdays, and places. */
  facts(companyId: string, user: User): Facts {
    this.requireMember(companyId, user);
    return { text: this.factsOf(companyId) };
  }

  /** The facts of a company, for its agents; empty when nobody wrote them. */
  factsOf(companyId: string): string {
    const row = this.database
      .query("SELECT text FROM company_facts WHERE company_id = ?")
      .get(companyId) as { text: string } | null;
    return row?.text ?? "";
  }

  /** Replaces the facts of the company; only an admin writes them. */
  setFacts(companyId: string, user: User, text: string): Facts {
    this.requireAdmin(companyId, user);
    if (typeof text !== "string" || text.length > MAX_FACTS) {
      throw new HttpError(
        400,
        `Write the facts as text of at most ${MAX_FACTS} characters`
      );
    }
    this.database
      .query(
        "INSERT INTO company_facts (company_id, text, changed_by, changed_at) VALUES (?, ?, ?, ?) ON CONFLICT (company_id) DO UPDATE SET text = excluded.text, changed_by = excluded.changed_by, changed_at = excluded.changed_at"
      )
      .run(companyId, text.trim(), user.id, Date.now());
    return { text: text.trim() };
  }

  /**
   * Adds a thread to a channel of the company. `Threads` checks who asks, names the thread, and creates its
   * conversation; `createdBy` is a person's id, or `shadow` for a thread an agent started. Each person has at most one
   * `orchestrator` thread in a company, their own.
   */
  registerThread(
    companyId: string,
    thread: {
      readonly channelId: string;
      readonly conversationId: number;
      readonly createdBy: string;
      readonly id: string;
      readonly orchestrator?: boolean;
      readonly title: string;
    }
  ): ThreadSummary {
    const { channelId, conversationId, title } = thread;
    const channel = this.database
      .query(
        "SELECT 1 FROM channel WHERE id = ? AND company_id = ? AND deleted_at IS NULL"
      )
      .get(channelId, companyId);
    if (!channel) {
      throw notFound();
    }
    const now = Date.now();
    this.database
      .query(
        "INSERT INTO thread (id, company_id, channel_id, title, conversation_id, created_by, created_at, updated_at, orchestrator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        thread.id,
        companyId,
        channelId,
        title,
        conversationId,
        thread.createdBy,
        now,
        now,
        thread.orchestrator ? 1 : 0
      );
    return { id: thread.id, channelId, title, updatedAt: now, settledAt: null };
  }

  /**
   * The thread if `user` is a member of its company; an orchestrator, or a thread of a private channel, only for its
   * own person.
   */
  thread(threadId: string, user: User): ThreadSummary & ThreadRef {
    const thread = this.database
      .query(
        `SELECT ${THREAD} FROM thread t JOIN member m ON m.organizationId = t.company_id JOIN channel c ON c.id = t.channel_id AND c.deleted_at IS NULL WHERE t.id = ? AND m.userId = ? AND (t.orchestrator = 0 OR t.created_by = m.userId) AND (c.owner_id IS NULL OR c.owner_id = m.userId) AND t.${LIVE}`
      )
      .get(threadId, user.id) as (ThreadSummary & ThreadRef) | null;
    if (!thread) {
      throw notFound();
    }
    return thread;
  }

  /**
   * The threads of a company that `realm` sees: those of its channels, and the orchestrator of its person. Those of
   * deleted channels are left out.
   */
  threadsIn(companyId: string, realm: Realm): (ThreadSummary & ThreadRef)[] {
    return this.allThreadsIn(companyId).filter(
      (thread) => thread.realm === null || thread.realm === realm
    );
  }

  /**
   * Every thread of a company, every person's orchestrator and private channels too, but those of deleted channels,
   * for background work that acts for no person.
   */
  allThreadsIn(companyId: string): (ThreadSummary & ThreadRef)[] {
    return this.database
      .query(
        `SELECT ${THREAD} FROM thread t JOIN channel c ON c.id = t.channel_id AND c.deleted_at IS NULL WHERE t.company_id = ? AND t.${LIVE}`
      )
      .all(companyId) as (ThreadSummary & ThreadRef)[];
  }

  /** The thread of a conversation of the company, for the tools of its agent; null for one no thread has. */
  threadOf(
    companyId: string,
    conversationId: number
  ): (ThreadSummary & ThreadRef) | null {
    return this.database
      .query(
        `SELECT ${THREAD} FROM thread t JOIN channel c ON c.id = t.channel_id AND c.deleted_at IS NULL WHERE t.company_id = ? AND t.conversation_id = ? AND t.${LIVE}`
      )
      .get(companyId, conversationId) as (ThreadSummary & ThreadRef) | null;
  }

  /** The person's thread of the company that never ends, if they have one yet; `Threads.orchestrator` makes it. */
  orchestratorOf(
    companyId: string,
    personId: string
  ): (ThreadSummary & ThreadRef) | null {
    return this.database
      .query(
        "SELECT id, company_id AS companyId, conversation_id AS conversationId, channel_id AS channelId, title, updated_at AS updatedAt, settled_at AS settledAt, created_by AS ownerId, created_by AS realm FROM thread WHERE company_id = ? AND created_by = ? AND orchestrator = 1"
      )
      .get(companyId, personId) as (ThreadSummary & ThreadRef) | null;
  }

  renameThread(threadId: string, title: string): void {
    this.database
      .query("UPDATE thread SET title = ? WHERE id = ?")
      .run(title, threadId);
  }

  /** Moves the thread up in its channel, after a new message. */
  /** Marks new activity in a thread; a settled thread opens again, so a new message never hides in the settled list. */
  touchThread(threadId: string): void {
    this.database
      .query("UPDATE thread SET updated_at = ?, settled_at = NULL WHERE id = ?")
      .run(Date.now(), threadId);
  }

  /**
   * Moves a thread of a channel that `realm` sees to another channel it sees; `Threads.move` moves what goes with it.
   * Only the person who started a thread moves it into a private channel, which takes it from the others.
   */
  moveThread(
    companyId: string,
    realm: Realm,
    personId: string,
    threadId: string,
    channelId: string
  ): {
    readonly thread: ThreadSummary & ThreadRef;
    readonly from: Channel;
    readonly to: Channel;
  } {
    const thread = this.threadsIn(companyId, realm).find(
      (candidate) => candidate.id === threadId
    );
    const channels = this.channelsIn(companyId, realm);
    const from = channels.find(
      (candidate) => candidate.id === thread?.channelId
    );
    const to = channels.find((candidate) => candidate.id === channelId);
    if (!(thread && from && to)) {
      throw notFound();
    }
    if (thread.ownerId !== null) {
      throw new HttpError(400, "This thread stays where it is");
    }
    if (from.id === to.id) {
      return { thread, from, to };
    }
    const { createdBy } = this.database
      .query("SELECT created_by AS createdBy FROM thread WHERE id = ?")
      .get(threadId) as { createdBy: string };
    if (to.ownerId !== null && createdBy !== personId) {
      throw new HttpError(
        403,
        "Only the person who started a thread moves it into a private channel"
      );
    }
    this.database
      .query("UPDATE thread SET channel_id = ? WHERE id = ?")
      .run(to.id, threadId);
    return {
      thread: { ...thread, channelId: to.id, realm: to.ownerId },
      from,
      to,
    };
  }

  /** Moves a thread into or out of its channel's settled list. */
  setThreadSettled(
    companyId: string,
    threadId: string,
    user: User,
    settled: boolean
  ): ThreadSummary {
    this.requireMember(companyId, user);
    const thread = this.thread(threadId, user);
    if (thread.companyId !== companyId) {
      throw notFound();
    }
    if (thread.ownerId !== null) {
      throw new HttpError(400, "This thread stays open");
    }
    if ((thread.settledAt !== null) === settled) {
      return thread;
    }
    this.database
      .query("UPDATE thread SET settled_at = ? WHERE id = ?")
      .run(settled ? Date.now() : null, threadId);
    return this.thread(threadId, user);
  }

  members(companyId: string, user: User): Member[] {
    this.requireMember(companyId, user);
    const members = this.database
      .query(
        "SELECT u.id AS userId, u.name, u.email, m.role FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY m.createdAt"
      )
      .all(companyId) as Omit<Member, "picture">[];
    const pictures = this.pictures.ids(members.map((member) => member.userId));
    return members.map((member) => ({
      ...member,
      picture: picturePath(pictures.get(member.userId)),
    }));
  }

  /** The address of the person's own profile picture, or null for none. */
  pictureOf(user: User): string | null {
    return picturePath(this.pictures.ids([user.id]).get(user.id));
  }

  /** A profile picture of the person or of someone who shares a company with them; otherwise not found. */
  picture(pictureId: string, user: User): ProfilePicture {
    const picture = this.pictures.get(pictureId);
    const shared =
      picture.userId === user.id ||
      this.database
        .query(
          "SELECT 1 FROM member a JOIN member b ON b.organizationId = a.organizationId JOIN organization o ON o.id = a.organizationId WHERE a.userId = ? AND b.userId = ? AND o.deletedAt IS NULL"
        )
        .get(user.id, picture.userId) !== null;
    if (!shared) {
      throw notFound();
    }
    return picture;
  }

  /** Adds someone who already has an account as a member, for an admin of the company. */
  async addMember(
    companyId: string,
    user: User,
    email: string
  ): Promise<Member> {
    this.requireAdmin(companyId, user);
    const person = this.database
      .query("SELECT id, name, email FROM user WHERE lower(email) = lower(?)")
      .get(required(email, "Email")) as {
      id: string;
      name: string;
      email: string;
    } | null;
    if (!person) {
      throw new HttpError(400, "Nobody has signed up with that email yet");
    }
    if (
      this.members(companyId, user).some(
        (member) => member.userId === person.id
      )
    ) {
      throw new HttpError(409, `${person.name} is already a member`);
    }
    await this.auth.api.addMember({
      body: { userId: person.id, organizationId: companyId, role: "member" },
    });
    this.personalChannelOf(companyId, person);
    this.memberAdded(companyId);
    return {
      userId: person.id,
      name: person.name,
      email: person.email,
      picture: this.pictureOf(person),
      role: "member",
    };
  }

  /**
   * The member with this email, for a person who writes to Shadow from Slack: someone with an allowed email who is not
   * a member yet becomes one, with an account made for them if they never signed in. Null for an email that is not
   * allowed.
   */
  async memberByEmail(
    companyId: string,
    email: string,
    name: string
  ): Promise<User | null> {
    const find = () =>
      this.database
        .query("SELECT id, name, email FROM user WHERE lower(email) = lower(?)")
        .get(email) as User | null;
    let person = find();
    if (!person) {
      const context = await this.auth.$context;
      // Making the account checks `allowed_emails`, as a sign-in does.
      const made = await context.internalAdapter
        .createUser(
          { email: email.toLowerCase(), name, emailVerified: true },
          { method: "slack" }
        )
        .catch(() => null);
      if (!made) {
        return null;
      }
      person = find();
    }
    if (!person) {
      return null;
    }
    const member = this.database
      .query("SELECT 1 FROM member WHERE organizationId = ? AND userId = ?")
      .get(companyId, person.id);
    if (!member) {
      await this.auth.api.addMember({
        body: { userId: person.id, organizationId: companyId, role: "member" },
      });
      this.personalChannelOf(companyId, person);
      this.memberAdded(companyId);
    }
    return person;
  }

  /** Makes a member an admin or a member, for an admin; a company keeps one admin at least. */
  setRole(companyId: string, user: User, memberId: string, role: Role): Member {
    this.requireAdmin(companyId, user);
    if (role !== "admin" && role !== "member") {
      throw new HttpError(400, "A role is admin or member");
    }
    const members = this.members(companyId, user);
    const member = members.find((candidate) => candidate.userId === memberId);
    if (!member) {
      throw notFound();
    }
    const admins = members.filter((candidate) => candidate.role === "admin");
    if (role === "member" && admins.length === 1 && member.role === "admin") {
      throw new HttpError(409, "A company keeps one admin at least");
    }
    this.database
      .query(
        "UPDATE member SET role = ? WHERE organizationId = ? AND userId = ?"
      )
      .run(role, companyId, memberId);
    return { ...member, role };
  }

  /**
   * Makes the channels that every member sees copy the public channels of Slack: a new Slack channel gets its channel,
   * a renamed one renames it, and one that Slack archived or deleted is deleted, so its threads stay hidden in the
   * database until Slack has it again. Slack's general channel takes over the first such channel that no Slack channel
   * made, the home of the orchestrators; another one takes over such a channel of its name.
   */
  syncSlackChannels(
    companyId: string,
    slackChannels: readonly SlackChannel[]
  ): SlackSync {
    const counts = { created: 0, hidden: 0, renamed: 0, restored: 0 };
    const known = this.database
      .query(
        "SELECT id, name, slack_id AS slackId, deleted_at AS deletedAt FROM channel WHERE company_id = ? AND owner_id IS NULL AND slack_id IS NOT NULL"
      )
      .all(companyId) as {
      id: string;
      name: string;
      slackId: string;
      deletedAt: number | null;
    }[];
    for (const slack of slackChannels) {
      const channel = known.find((row) => row.slackId === slack.id);
      if (channel?.deletedAt === null) {
        // Shadow keeps a name such as Dev-Ops! as dev-ops, so it compares the name it would give.
        const name = this.freeSlackName(companyId, slack.name, channel.id);
        if (name !== channel.name) {
          this.database
            .query("UPDATE channel SET name = ? WHERE id = ?")
            .run(name, channel.id);
          counts.renamed += 1;
        }
      } else if (channel) {
        this.database
          .query("UPDATE channel SET deleted_at = NULL WHERE id = ?")
          .run(channel.id);
        this.nameAfterSlack(companyId, channel.id, slack.name);
        counts.restored += 1;
      } else {
        this.linkSlackChannel(companyId, slack);
        counts.created += 1;
      }
    }
    const listed = new Set(slackChannels.map((slack) => slack.id));
    for (const channel of known) {
      if (
        channel.deletedAt === null &&
        !listed.has(channel.slackId) &&
        // The orchestrators need one channel that every member sees, so the last one stays.
        this.channelsIn(companyId, null).length > 1
      ) {
        this.removeChannel(companyId, channel.id, null);
        counts.hidden += 1;
      }
    }
    return counts;
  }

  /** Gives a Slack channel its channel: one of its name, or for Slack's general one the home of the orchestrators. */
  private linkSlackChannel(companyId: string, slack: SlackChannel): void {
    const unlinked = this.channelsIn(companyId, null).filter(
      (candidate) => candidate.slackId === null
    );
    const channel = slack.general
      ? unlinked[0]
      : unlinked.find((candidate) => candidate.name === slack.name);
    const id =
      channel?.id ??
      this.addChannel(
        companyId,
        this.freeSlackName(companyId, slack.name),
        "slack",
        null
      ).id;
    this.database
      .query("UPDATE channel SET slack_id = ? WHERE id = ?")
      .run(slack.id, id);
    if (channel) {
      this.nameAfterSlack(companyId, id, slack.name);
    }
    if (slack.purpose && !channel?.summary) {
      this.setChannelSummary(companyId, id, slack.purpose);
    }
  }

  private nameAfterSlack(
    companyId: string,
    channelId: string,
    name: string
  ): void {
    this.database
      .query("UPDATE channel SET name = ? WHERE id = ?")
      .run(this.freeSlackName(companyId, name, channelId), channelId);
  }

  /** Slack's name of a channel, or with `-slack` when a private channel already has it. */
  private freeSlackName(
    companyId: string,
    name: string,
    channelId = ""
  ): string {
    try {
      return this.freeChannelName(companyId, name, channelId);
    } catch {
      return this.freeChannelName(companyId, `${name}-slack`, channelId);
    }
  }
}

function picturePath(id: string | undefined): string | null {
  return id ? `/api/v1/pictures/${id}` : null;
}
