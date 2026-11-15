import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Application tables. better-auth owns `user`, `session`, `account`, `verification`, `organization` (companies),
 * `member`, and `invitation`; it migrates them itself. Append a migration; never edit one that shipped.
 *
 * Each table has one owner module, and only that module queries it: `accounts` owns `profile_picture`, `companies` owns `channel`, `thread`, and `company_facts` (and reads
 * `organization` and `member`, and writes the name and `deletedAt` of an `organization`), `integrations` owns
 * `credential`, `oauth_client`, and `integration_setting` (no longer read), `llm` owns `provider_credential`, `llm_usage`, `llm_usage_seen`, and its keys in `setting`,
 * `places` owns `place` and `place_presence`, `artifacts` owns `artifact`, `artifact_name`, `artifact_visitor`, and `artifact_record`,
 * `routines` owns `routine` and `routine_run`, `reminders` owns `reminder`, `agenda` owns `suggestion`, `feedback` owns `feedback`, and `notifications` owns
 * `notification`. No module reads `machine`, `push_device`, or `live_activity` since the machines and the phone apps went.
 * Start a new migration with a comment that names its owner.
 */
const migrations = [
  `CREATE TABLE channel (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		name TEXT NOT NULL,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		UNIQUE (company_id, name)
	);
	CREATE TABLE thread (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		channel_id TEXT NOT NULL REFERENCES channel (id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX thread_channel ON thread (channel_id, updated_at);
	CREATE TABLE credential (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		integration TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		label TEXT NOT NULL,
		shared INTEGER NOT NULL,
		secret BLOB NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX credential_company ON credential (company_id, integration);
	CREATE TABLE integration_setting (
		company_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		integration TEXT NOT NULL,
		enabled INTEGER NOT NULL,
		PRIMARY KEY (company_id, user_id, integration)
	);
	CREATE TABLE provider_credential (
		provider_id TEXT PRIMARY KEY,
		secret BLOB NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE setting (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);`,
  // companies: a thread is one conversation in its company's session.sqlite. Threads from before kept a session
  // file each; their rows go, and their files stay on disk.
  `ALTER TABLE thread ADD COLUMN conversation_id INTEGER;
	DELETE FROM thread WHERE conversation_id IS NULL;`,
  // hands: the machines paired with a company. `addresses` is a JSON array.
  `CREATE TABLE machine (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		name TEXT NOT NULL,
		hostname TEXT,
		addresses TEXT NOT NULL,
		port INTEGER NOT NULL,
		cert_sha256 TEXT NOT NULL,
		os TEXT NOT NULL,
		arch TEXT NOT NULL,
		version TEXT NOT NULL,
		paired_at INTEGER NOT NULL,
		UNIQUE (company_id, cert_sha256),
		UNIQUE (company_id, name)
	);`,
  // companies: what a channel is for and what goes on in it, as an agent last wrote it.
  "ALTER TABLE channel ADD COLUMN summary TEXT;",
  // routines: the scheduled work of a channel. `schedule` is a cron expression in the server's time zone, `script`
  // runs in code mode (null: the agent does the work), and `store` is the JSON the script keeps between runs.
  `CREATE TABLE routine (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		channel_id TEXT NOT NULL REFERENCES channel (id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		schedule TEXT NOT NULL,
		instructions TEXT NOT NULL,
		script TEXT,
		store TEXT NOT NULL,
		enabled INTEGER NOT NULL,
		next_run_at INTEGER,
		thread_id TEXT,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX routine_channel ON routine (channel_id);
	CREATE TABLE routine_run (
		id TEXT PRIMARY KEY,
		routine_id TEXT NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
		started_at INTEGER NOT NULL,
		finished_at INTEGER,
		outcome TEXT NOT NULL,
		error TEXT
	);
	CREATE INDEX routine_run_routine ON routine_run (routine_id, started_at);`,
  // artifacts: the pages and small apps agents make in a thread, and the data their visitors keep. `visibility` is
  // `public` or `members`; `request_key` lets a create that a crash repeats find the artifact it made. A record's
  // `scope` is `shared` or the visitor that owns it, and `value` is JSON.
  `CREATE TABLE artifact (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		thread_id TEXT NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		html TEXT NOT NULL,
		visibility TEXT NOT NULL,
		request_key TEXT UNIQUE,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX artifact_thread ON artifact (thread_id);
	CREATE TABLE artifact_visitor (
		artifact_id TEXT NOT NULL REFERENCES artifact (id) ON DELETE CASCADE,
		visitor TEXT NOT NULL,
		name TEXT,
		seen_at INTEGER NOT NULL,
		PRIMARY KEY (artifact_id, visitor)
	);
	CREATE TABLE artifact_record (
		artifact_id TEXT NOT NULL REFERENCES artifact (id) ON DELETE CASCADE,
		scope TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (artifact_id, scope, key)
	);`,
  // artifacts: every name an artifact had, such as `amber-fox`; names stay after their artifact goes, so they are
  // never given out again.
  `CREATE TABLE artifact_name (id TEXT PRIMARY KEY);
	INSERT INTO artifact_name (id) SELECT id FROM artifact;`,
  // companies: keep finished threads available without showing them among active threads.
  "ALTER TABLE thread ADD COLUMN settled_at INTEGER;",
  // companies: the one thread of a company that never ends and that nobody settles. It is in the first channel,
  // which channel lists leave it out of.
  `ALTER TABLE thread ADD COLUMN orchestrator INTEGER NOT NULL DEFAULT 0;
	CREATE UNIQUE INDEX thread_orchestrator ON thread (company_id) WHERE orchestrator = 1;`,
  // Deletes are soft: a deleted row keeps everything and gets `deleted_at`, and reads leave it out.
  // companies: a deleted channel hides its threads; its name gets `~<id>`, so a new channel can take the name.
  "ALTER TABLE channel ADD COLUMN deleted_at INTEGER;",
  // artifacts: deleted artifacts, records, and visitors.
  `ALTER TABLE artifact ADD COLUMN deleted_at INTEGER;
	ALTER TABLE artifact_record ADD COLUMN deleted_at INTEGER;
	ALTER TABLE artifact_visitor ADD COLUMN deleted_at INTEGER;`,
  // routines: deleted routines, which never run again.
  "ALTER TABLE routine ADD COLUMN deleted_at INTEGER;",
  // hands: removed machines; their name and certificate get `~<id>`, so the machine can pair again.
  "ALTER TABLE machine ADD COLUMN deleted_at INTEGER;",
  // integrations: deleted credentials, which no tool uses again.
  "ALTER TABLE credential ADD COLUMN deleted_at INTEGER;",
  // llm: the login of a provider after a logout, which nothing reads again.
  "ALTER TABLE provider_credential ADD COLUMN deleted_at INTEGER;",
  // artifacts: an artifact belongs to its channel and stays after its thread is settled; `thread_id` is the thread
  // that made it. The orchestrator's belong to the company: their `channel_id` is null.
  `ALTER TABLE artifact ADD COLUMN channel_id TEXT;
	UPDATE artifact SET channel_id = (SELECT CASE WHEN orchestrator = 1 THEN NULL ELSE channel_id END FROM thread WHERE thread.id = artifact.thread_id);
	CREATE INDEX artifact_channel ON artifact (channel_id);`,
  // reminders: one due time, tied to the person and thread that asked for it.
  `CREATE TABLE reminder (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		recipient_id TEXT NOT NULL,
		text TEXT NOT NULL,
		due_at INTEGER NOT NULL,
		time_zone TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at INTEGER NOT NULL,
		last_error TEXT,
		delivered_at INTEGER,
		cancelled_at INTEGER,
		deleted_at INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX reminder_due ON reminder (next_attempt_at) WHERE delivered_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL;
	CREATE INDEX reminder_company ON reminder (company_id, due_at);`,
  // notifications: what needs a person's attention, which opens a thread or a channel, and the devices that get pushes.
  `CREATE TABLE notification (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		thread_id TEXT,
		title TEXT NOT NULL,
		text TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		read_at INTEGER
	);
	CREATE INDEX notification_inbox ON notification (user_id, company_id, created_at);
	CREATE TABLE push_device (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		token TEXT NOT NULL,
		environment TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	CREATE INDEX push_device_user ON push_device (user_id) WHERE deleted_at IS NULL;`,
  // integrations: a credential without a company is its owner's own, for their turns in each of their companies.
  // SQLite cannot drop NOT NULL from a column, so the table is made again with the same rows.
  `CREATE TABLE credential_next (
		id TEXT PRIMARY KEY,
		company_id TEXT,
		integration TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		label TEXT NOT NULL,
		shared INTEGER NOT NULL,
		secret BLOB NOT NULL,
		created_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	INSERT INTO credential_next SELECT id, company_id, integration, owner_id, label, shared, secret, created_at, deleted_at FROM credential;
	DROP TABLE credential;
	ALTER TABLE credential_next RENAME TO credential;
	CREATE INDEX credential_company ON credential (company_id, integration);
	CREATE INDEX credential_owner ON credential (owner_id, integration) WHERE company_id IS NULL;`,
  // reminders: the person who asked for a reminder or last changed it; its turn runs as them. Null for older rows.
  "ALTER TABLE reminder ADD COLUMN created_by TEXT;",
  // hands: the member who paired a machine, who allows what agents do on it for others.
  "ALTER TABLE machine ADD COLUMN paired_by TEXT;",
  // hands: a machine without a company is the own machine of the person who paired it, for their turns in each of
  // their companies. SQLite cannot drop NOT NULL from a column, so the table is made again with the same rows.
  `CREATE TABLE machine_next (
		id TEXT PRIMARY KEY,
		company_id TEXT,
		name TEXT NOT NULL,
		hostname TEXT,
		addresses TEXT NOT NULL,
		port INTEGER NOT NULL,
		cert_sha256 TEXT NOT NULL,
		os TEXT NOT NULL,
		arch TEXT NOT NULL,
		version TEXT NOT NULL,
		paired_at INTEGER NOT NULL,
		deleted_at INTEGER,
		paired_by TEXT,
		UNIQUE (company_id, cert_sha256),
		UNIQUE (company_id, name)
	);
	INSERT INTO machine_next SELECT id, company_id, name, hostname, addresses, port, cert_sha256, os, arch, version, paired_at, deleted_at, paired_by FROM machine;
	DROP TABLE machine;
	ALTER TABLE machine_next RENAME TO machine;
	CREATE UNIQUE INDEX machine_own_cert ON machine (paired_by, cert_sha256) WHERE company_id IS NULL;
	CREATE UNIQUE INDEX machine_own_name ON machine (paired_by, name) WHERE company_id IS NULL;`,
  // routines: what a run's script found, kept until the run ends, so a run that a stop cuts off goes on with it.
  "ALTER TABLE routine_run ADD COLUMN result TEXT;",
  // hands and routines: standing approvals, unused since dcg alone decides what waits for a person; drop both.
  "ALTER TABLE machine ADD COLUMN trusted_members TEXT NOT NULL DEFAULT '[]';",
  "ALTER TABLE routine ADD COLUMN machine_ids TEXT NOT NULL DEFAULT '[]';",
  // companies: each member has an orchestrator of their own, and its `created_by` is that member. The company's one
  // orchestrator from before becomes the own of the person who made the company, who made its first channel.
  `UPDATE thread SET created_by = (SELECT c.created_by FROM channel c WHERE c.company_id = thread.company_id ORDER BY c.created_at, c.rowid LIMIT 1) WHERE orchestrator = 1;
	DROP INDEX thread_orchestrator;
	CREATE UNIQUE INDEX thread_own_orchestrator ON thread (company_id, created_by) WHERE orchestrator = 1;`,
  // integrations: Shadow's own OAuth client of an integration whose sign-in server does not register clients, such as
  // Google's; an admin sets it in Settings. `secret` is the encrypted client secret.
  `CREATE TABLE oauth_client (
		integration TEXT PRIMARY KEY,
		client_id TEXT NOT NULL,
		secret BLOB NOT NULL,
		changed_by TEXT NOT NULL,
		changed_at INTEGER NOT NULL
	);`,
  // companies: the emoji that the model chose for a channel, which people see before its name.
  "ALTER TABLE channel ADD COLUMN icon TEXT;",
  // companies: the facts that the people of a company write by hand, such as names, birthdays, and places.
  `CREATE TABLE company_facts (
		company_id TEXT PRIMARY KEY,
		text TEXT NOT NULL,
		changed_by TEXT NOT NULL,
		changed_at INTEGER NOT NULL
	);`,
  // companies: a private channel belongs to one member, who alone sees it, its threads, files, artifacts, and
  // routines; `owner_id` is null for a channel every member sees.
  "ALTER TABLE channel ADD COLUMN owner_id TEXT;",
  // search: what each person searched in a company, which the search page shows before a query.
  `CREATE TABLE recent_search (
		company_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		query TEXT NOT NULL COLLATE NOCASE,
		searched_at INTEGER NOT NULL,
		PRIMARY KEY (company_id, user_id, query)
	);`,
  // integrations and hands: a person adds each credential and machine in their own Settings, in the company, and it
  // is shared, for every member's turns, or private, for its owner's turns only. The own ones from before become
  // private ones in their owner's company, and the company's become shared. A machine paired both ways stays once:
  // the own row, whose key the machine trusts, now shared. Names are unique in the company, so a later machine with
  // a taken name gets the start of its id. SQLite cannot add NOT NULL to a column, so both tables are made again.
  `UPDATE credential SET shared = company_id IS NOT NULL;
	UPDATE credential SET company_id = (SELECT m.organizationId FROM member m JOIN organization o ON o.id = m.organizationId WHERE m.userId = credential.owner_id ORDER BY o.deletedAt IS NOT NULL, o.createdAt LIMIT 1) WHERE company_id IS NULL;
	CREATE TABLE credential_next (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		integration TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		label TEXT NOT NULL,
		shared INTEGER NOT NULL,
		secret BLOB NOT NULL,
		created_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	INSERT INTO credential_next SELECT id, company_id, integration, owner_id, label, shared, secret, created_at, deleted_at FROM credential;
	DROP TABLE credential;
	ALTER TABLE credential_next RENAME TO credential;
	CREATE INDEX credential_company ON credential (company_id, integration);
	UPDATE machine SET paired_by = (SELECT c.created_by FROM channel c WHERE c.company_id = machine.company_id ORDER BY c.created_at, c.rowid LIMIT 1) WHERE paired_by IS NULL;
	CREATE TABLE machine_next (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		name TEXT NOT NULL,
		hostname TEXT,
		addresses TEXT NOT NULL,
		port INTEGER NOT NULL,
		cert_sha256 TEXT NOT NULL,
		os TEXT NOT NULL,
		arch TEXT NOT NULL,
		version TEXT NOT NULL,
		paired_at INTEGER NOT NULL,
		paired_by TEXT NOT NULL,
		shared INTEGER NOT NULL,
		deleted_at INTEGER
	);
	INSERT INTO machine_next SELECT id, COALESCE(company_id, (SELECT m.organizationId FROM member m JOIN organization o ON o.id = m.organizationId WHERE m.userId = machine.paired_by ORDER BY o.deletedAt IS NOT NULL, o.createdAt LIMIT 1)), name, hostname, addresses, port, cert_sha256, os, arch, version, paired_at, paired_by, company_id IS NOT NULL OR EXISTS (SELECT 1 FROM machine twin WHERE twin.company_id IS NOT NULL AND twin.deleted_at IS NULL AND twin.paired_by = machine.paired_by AND twin.cert_sha256 = machine.cert_sha256), deleted_at FROM machine;
	UPDATE machine_next SET deleted_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), name = name || '~' || id, cert_sha256 = cert_sha256 || '~' || id WHERE id IN (SELECT twin.id FROM machine twin JOIN machine own ON own.company_id IS NULL AND own.deleted_at IS NULL AND own.paired_by = twin.paired_by AND own.cert_sha256 = twin.cert_sha256 WHERE twin.company_id IS NOT NULL AND twin.deleted_at IS NULL);
	UPDATE machine_next SET name = name || '-' || substr(id, 1, 4) WHERE deleted_at IS NULL AND EXISTS (SELECT 1 FROM machine_next other WHERE other.deleted_at IS NULL AND other.company_id = machine_next.company_id AND other.name = machine_next.name COLLATE NOCASE AND (other.paired_at, other.id) < (machine_next.paired_at, machine_next.id));
	DROP TABLE machine;
	ALTER TABLE machine_next RENAME TO machine;
	CREATE UNIQUE INDEX machine_cert ON machine (company_id, paired_by, cert_sha256);
	CREATE UNIQUE INDEX machine_name ON machine (company_id, name COLLATE NOCASE);`,
  // llm: what the model calls cost, by day, person, source, thread, and model, which Settings shows; and the usage of
  // each conversation that the first table has counted.
  `CREATE TABLE llm_usage (
		company_id TEXT NOT NULL,
		day TEXT NOT NULL,
		user_id TEXT NOT NULL,
		source TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		model TEXT NOT NULL,
		input INTEGER NOT NULL,
		output INTEGER NOT NULL,
		cache_read INTEGER NOT NULL,
		cache_write INTEGER NOT NULL,
		cost REAL NOT NULL,
		PRIMARY KEY (company_id, day, user_id, source, thread_id, model)
	);
	CREATE TABLE llm_usage_seen (
		company_id TEXT NOT NULL,
		conversation_id INTEGER NOT NULL,
		usage TEXT NOT NULL,
		PRIMARY KEY (company_id, conversation_id)
	);`,
  // agenda: the automations that Shadow suggests to a person, which wait until they accept or decline one.
  `CREATE TABLE suggestion (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		person_id TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		name TEXT NOT NULL,
		text TEXT NOT NULL,
		schedule TEXT,
		at TEXT,
		time_zone TEXT,
		created_at INTEGER NOT NULL,
		answered_at INTEGER,
		accepted INTEGER,
		result_id TEXT,
		deleted_at INTEGER
	);
	CREATE INDEX suggestion_person ON suggestion (company_id, person_id, created_at);`,
  // notifications: the Live Activities of the iOS app, each following the work for one message of a person, and the
  // last state Shadow pushed to it.
  `CREATE TABLE live_activity (
		token TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		company_id TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		environment TEXT NOT NULL,
		state TEXT,
		started_at INTEGER NOT NULL,
		ended_at INTEGER
	);
	CREATE INDEX live_activity_open ON live_activity (company_id, ended_at);`,
  // accounts: the pictures that people upload for their profile; the newest that is not deleted is theirs.
  `CREATE TABLE profile_picture (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		content_type TEXT NOT NULL,
		data BLOB NOT NULL,
		created_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	CREATE INDEX profile_picture_user ON profile_picture (user_id, deleted_at);`,
  // places: the places that a person marks on a map in Settings, private to their turns or shared with every member's.
  // A removed place gets `~<id>` in its name, so the name is free again.
  `CREATE TABLE place (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		name TEXT NOT NULL,
		latitude REAL NOT NULL,
		longitude REAL NOT NULL,
		radius INTEGER NOT NULL,
		shared INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	CREATE UNIQUE INDEX place_name ON place (company_id, owner_id, name COLLATE NOCASE);`,
  // reminders: a reminder at a place waits until its person's iPhone reports that they arrived or left
  // (`place_event`); then `triggered_at` and its due time are set. Null for a reminder at a time.
  `ALTER TABLE reminder ADD COLUMN place_id TEXT;
	ALTER TABLE reminder ADD COLUMN place_event TEXT;
	ALTER TABLE reminder ADD COLUMN triggered_at INTEGER;`,
  // routines: a routine at a place runs each time the iPhone of `place_person_id` reports that they arrived or left
  // (`place_event`); its `schedule` is '' and its `next_run_at` null. Null for a routine on a schedule.
  `ALTER TABLE routine ADD COLUMN place_id TEXT;
	ALTER TABLE routine ADD COLUMN place_event TEXT;
	ALTER TABLE routine ADD COLUMN place_person_id TEXT;`,
  // places: whether each person was in each place when their iPhone last said, and when; only the last state, no
  // history. The iPhone reports a state only at a crossing or when it starts to watch the place.
  `CREATE TABLE place_presence (
		place_id TEXT NOT NULL,
		person_id TEXT NOT NULL,
		inside INTEGER NOT NULL,
		at INTEGER NOT NULL,
		PRIMARY KEY (place_id, person_id)
	);`,
  // feedback: what agents report about Shadow itself, for the admins; `person_id` is the person of the turn,
  // null for background work.
  `CREATE TABLE feedback (
		id TEXT PRIMARY KEY,
		company_id TEXT NOT NULL,
		thread_id TEXT,
		person_id TEXT,
		kind TEXT NOT NULL,
		tool TEXT,
		summary TEXT NOT NULL,
		detail TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	CREATE INDEX feedback_company ON feedback (company_id, deleted_at, created_at);`,
  // routines: keep the definition and script store a run started with; older servers leave this nullable column unset.
  "ALTER TABLE routine_run ADD COLUMN input TEXT;",

  // integrations: whether the owner of a credential lets Shadow read its account for them.
  "ALTER TABLE credential ADD COLUMN watched INTEGER NOT NULL DEFAULT 0;",
  // intake: durable source observations, private context, future checks, and idempotent deliveries.
  `CREATE TABLE intake_source (
    credential_id TEXT PRIMARY KEY, company_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    polled_at INTEGER NOT NULL DEFAULT 0, attempted_at INTEGER NOT NULL DEFAULT 0, error TEXT, checkpoint TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE intake_item (
    id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, company_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    source_id TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL,
    read_at INTEGER, reading TEXT, assessed_at INTEGER, thread_id TEXT, archived_id TEXT, superseded_at INTEGER,
    UNIQUE(credential_id,source_id,version)
  );
  CREATE INDEX intake_pending ON intake_item(owner_id,assessed_at,at);
  CREATE VIRTUAL TABLE intake_fts USING fts5(text, tokenize="unicode61 remove_diacritics 2");
  CREATE TABLE intake_check (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT,
    text TEXT NOT NULL, source_ids TEXT NOT NULL, explicit_time INTEGER NOT NULL, check_at INTEGER NOT NULL, next_review_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'open', notified_at INTEGER, revised_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX intake_due ON intake_check(state,check_at);
  CREATE TABLE intake_context (
    company_id TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    summary TEXT NOT NULL, source_ids TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(company_id,owner_id,thread_id)
  );
  CREATE TABLE intake_delivery (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    thread_id TEXT, body TEXT NOT NULL, attention TEXT NOT NULL,
    check_ids TEXT NOT NULL, evidence_ids TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER, cancelled_at INTEGER
  );
  CREATE TABLE intake_thread_read (
    company_id TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, version TEXT NOT NULL,
    PRIMARY KEY(company_id,owner_id,thread_id)
  );`,
  // intake: a thread update is silent unless the judge supplies a separate notification reason.
  `ALTER TABLE intake_delivery ADD COLUMN notification TEXT;
   CREATE INDEX intake_conversation ON intake_item(company_id,owner_id,credential_id,json_extract(payload,'$.chat'),at);`,
  `CREATE TABLE intake_source_read (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, credential_id TEXT NOT NULL, source_ids TEXT NOT NULL,
    observed_at INTEGER NOT NULL, assessed_at INTEGER, deleted_at INTEGER
  );
  CREATE INDEX intake_unassessed_read ON intake_source_read(company_id,owner_id,assessed_at);`,
  "ALTER TABLE intake_delivery ADD COLUMN subject TEXT;",
  // intake: durable check history, including writes from machines on the previous version.
  `CREATE TABLE intake_check_revision (
    id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT NOT NULL,
    company_id TEXT NOT NULL, owner_id TEXT NOT NULL, at INTEGER NOT NULL,
    action TEXT NOT NULL DEFAULT 'review', quote TEXT, previous TEXT, current TEXT NOT NULL
  );
  CREATE INDEX intake_check_history ON intake_check_revision(company_id,owner_id,check_id,id);
  INSERT INTO intake_check_revision(check_id,company_id,owner_id,at,current)
    SELECT id,company_id,owner_id,revised_at,json_object('text',text,'state',state,'sourceIds',json(source_ids),'threadId',thread_id,'checkAt',check_at,'reviewAt',next_review_at,'explicitTime',explicit_time,'notifiedAt',notified_at) FROM intake_check WHERE deleted_at IS NULL;
  CREATE TRIGGER intake_check_created AFTER INSERT ON intake_check BEGIN
    INSERT INTO intake_check_revision(check_id,company_id,owner_id,at,current)
    VALUES(NEW.id,NEW.company_id,NEW.owner_id,NEW.revised_at,json_object('text',NEW.text,'state',NEW.state,'sourceIds',json(NEW.source_ids),'threadId',NEW.thread_id,'checkAt',NEW.check_at,'reviewAt',NEW.next_review_at,'explicitTime',NEW.explicit_time,'notifiedAt',NEW.notified_at));
  END;
  CREATE TRIGGER intake_check_changed AFTER UPDATE ON intake_check
    WHEN OLD.text IS NOT NEW.text OR OLD.state IS NOT NEW.state OR OLD.source_ids IS NOT NEW.source_ids
      OR OLD.check_at IS NOT NEW.check_at OR OLD.next_review_at IS NOT NEW.next_review_at
      OR OLD.thread_id IS NOT NEW.thread_id OR OLD.explicit_time IS NOT NEW.explicit_time
      OR OLD.notified_at IS NOT NEW.notified_at
    BEGIN
    INSERT INTO intake_check_revision(check_id,company_id,owner_id,at,previous,current)
    VALUES(NEW.id,NEW.company_id,NEW.owner_id,CAST(unixepoch('subsec')*1000 AS INTEGER),json_object('text',OLD.text,'state',OLD.state,'sourceIds',json(OLD.source_ids),'threadId',OLD.thread_id,'checkAt',OLD.check_at,'reviewAt',OLD.next_review_at,'explicitTime',OLD.explicit_time,'notifiedAt',OLD.notified_at),json_object('text',NEW.text,'state',NEW.state,'sourceIds',json(NEW.source_ids),'threadId',NEW.thread_id,'checkAt',NEW.check_at,'reviewAt',NEW.next_review_at,'explicitTime',NEW.explicit_time,'notifiedAt',NEW.notified_at));
  END;`,
  // intake: one derived file for each source conversation and destination, with retryable consolidation.
  `CREATE TABLE intake_archive (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    channel_id TEXT NOT NULL, credential_id TEXT NOT NULL, integration TEXT NOT NULL,
    conversation TEXT NOT NULL, period TEXT NOT NULL,
    item_ids TEXT NOT NULL, file_id TEXT, content_hash TEXT, pending INTEGER NOT NULL DEFAULT 1,
    attachment_ids TEXT NOT NULL DEFAULT '{}', obsolete_ids TEXT NOT NULL DEFAULT '[]',
    deleted_at INTEGER
  );
  CREATE INDEX intake_archive_owner ON intake_archive(company_id,owner_id,deleted_at);`,
  // intake: the person's words about an observation, an update, or a source, which later assessments respect.
  `CREATE TABLE intake_feedback (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    target TEXT NOT NULL, about TEXT NOT NULL, quote TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
  );
  CREATE INDEX intake_feedback_owner ON intake_feedback(company_id,owner_id,created_at);`,
  // intake: the person deletes an observation, and blocks its sender or chat so that intake never reads it again.
  `ALTER TABLE intake_item ADD COLUMN deleted_at INTEGER;
  CREATE TABLE intake_block (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, owner_id TEXT NOT NULL, credential_id TEXT,
    kind TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
  );
  CREATE INDEX intake_block_owner ON intake_block(company_id,owner_id,deleted_at);`,
  // reminders: a reminder at a place fires only within its window, not before `not_before`, and at `not_after` at the
  // latest. intake: a check of what the owner must do is nudged in the morning summary from `nudge_at`, every 2 days.
  `ALTER TABLE reminder ADD COLUMN not_before INTEGER;
  ALTER TABLE reminder ADD COLUMN not_after INTEGER;
  ALTER TABLE intake_check ADD COLUMN nudge_at INTEGER;`,
  // routines: a finished run keeps no copy of its routine or its script result; only a run that a stop cut off needs them.
  "UPDATE routine_run SET input = NULL, result = NULL WHERE outcome != 'running';",
  // places: a person's last state at a place counts only while their phone watches the place and reports it.
  "ALTER TABLE place_presence ADD COLUMN watched INTEGER NOT NULL DEFAULT 1;",
  // companies, and every module that keeps a reference: channels are topics and threads are chats.
  `DROP TRIGGER intake_check_created;
  DROP TRIGGER intake_check_changed;
  DROP INDEX thread_channel;
  DROP INDEX routine_channel;
  DROP INDEX artifact_thread;
  DROP INDEX artifact_channel;
  DROP INDEX thread_own_orchestrator;
  ALTER TABLE thread RENAME COLUMN channel_id TO topic_id;
  ALTER TABLE routine RENAME COLUMN channel_id TO topic_id;
  ALTER TABLE routine RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE artifact RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE artifact RENAME COLUMN channel_id TO topic_id;
  ALTER TABLE reminder RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE notification RENAME COLUMN channel_id TO topic_id;
  ALTER TABLE notification RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE llm_usage RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE suggestion RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE suggestion RENAME COLUMN channel_id TO topic_id;
  ALTER TABLE live_activity RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE feedback RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE intake_item RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE intake_check RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE intake_context RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE intake_delivery RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE intake_thread_read RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE intake_source_read RENAME COLUMN thread_id TO chat_id;
  ALTER TABLE intake_archive RENAME COLUMN channel_id TO topic_id;
  ALTER TABLE channel RENAME TO topic;
  ALTER TABLE thread RENAME TO chat;
  ALTER TABLE intake_thread_read RENAME TO intake_chat_read;
  CREATE INDEX chat_topic ON chat (topic_id, updated_at);
  CREATE INDEX routine_topic ON routine (topic_id);
  CREATE INDEX artifact_chat ON artifact (chat_id);
  CREATE INDEX artifact_topic ON artifact (topic_id);
  CREATE UNIQUE INDEX chat_own_orchestrator ON chat (company_id, created_by) WHERE orchestrator = 1;
  CREATE TRIGGER intake_check_created AFTER INSERT ON intake_check BEGIN
    INSERT INTO intake_check_revision(check_id,company_id,owner_id,at,current)
    VALUES(NEW.id,NEW.company_id,NEW.owner_id,NEW.revised_at,json_object('text',NEW.text,'state',NEW.state,'sourceIds',json(NEW.source_ids),'chatId',NEW.chat_id,'checkAt',NEW.check_at,'reviewAt',NEW.next_review_at,'explicitTime',NEW.explicit_time,'notifiedAt',NEW.notified_at));
  END;
  CREATE TRIGGER intake_check_changed AFTER UPDATE ON intake_check
    WHEN OLD.text IS NOT NEW.text OR OLD.state IS NOT NEW.state OR OLD.source_ids IS NOT NEW.source_ids
      OR OLD.check_at IS NOT NEW.check_at OR OLD.next_review_at IS NOT NEW.next_review_at
      OR OLD.chat_id IS NOT NEW.chat_id OR OLD.explicit_time IS NOT NEW.explicit_time
      OR OLD.notified_at IS NOT NEW.notified_at
    BEGIN
    INSERT INTO intake_check_revision(check_id,company_id,owner_id,at,previous,current)
    VALUES(NEW.id,NEW.company_id,NEW.owner_id,CAST(unixepoch('subsec')*1000 AS INTEGER),json_object('text',OLD.text,'state',OLD.state,'sourceIds',json(OLD.source_ids),'chatId',OLD.chat_id,'checkAt',OLD.check_at,'reviewAt',OLD.next_review_at,'explicitTime',OLD.explicit_time,'notifiedAt',OLD.notified_at),json_object('text',NEW.text,'state',NEW.state,'sourceIds',json(NEW.source_ids),'chatId',NEW.chat_id,'checkAt',NEW.check_at,'reviewAt',NEW.next_review_at,'explicitTime',NEW.explicit_time,'notifiedAt',NEW.notified_at));
  END;`,
  // places: a point of interest is a place from OpenStreetMap that only reminders use; many can have the same name.
  `ALTER TABLE place ADD COLUMN osm_id TEXT;
  DROP INDEX place_name;
  CREATE UNIQUE INDEX place_name ON place (company_id, owner_id, name COLLATE NOCASE) WHERE osm_id IS NULL;
  CREATE UNIQUE INDEX place_point_of_interest ON place (company_id, owner_id, osm_id) WHERE osm_id IS NOT NULL;`,
  // companies, and every module that keeps a reference: topics are channels and chats are threads again, as in Slack.
  `DROP TRIGGER intake_check_created;
  DROP TRIGGER intake_check_changed;
  DROP INDEX chat_topic;
  DROP INDEX routine_topic;
  DROP INDEX artifact_chat;
  DROP INDEX artifact_topic;
  DROP INDEX chat_own_orchestrator;
  ALTER TABLE topic RENAME TO channel;
  ALTER TABLE chat RENAME TO thread;
  ALTER TABLE intake_chat_read RENAME TO intake_thread_read;
  ALTER TABLE thread RENAME COLUMN topic_id TO channel_id;
  ALTER TABLE routine RENAME COLUMN topic_id TO channel_id;
  ALTER TABLE routine RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE artifact RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE artifact RENAME COLUMN topic_id TO channel_id;
  ALTER TABLE reminder RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE notification RENAME COLUMN topic_id TO channel_id;
  ALTER TABLE notification RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE llm_usage RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE suggestion RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE suggestion RENAME COLUMN topic_id TO channel_id;
  ALTER TABLE live_activity RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE feedback RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_item RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_check RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_context RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_delivery RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_thread_read RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_source_read RENAME COLUMN chat_id TO thread_id;
  ALTER TABLE intake_archive RENAME COLUMN topic_id TO channel_id;
  CREATE INDEX thread_channel ON thread (channel_id, updated_at);
  CREATE INDEX routine_channel ON routine (channel_id);
  CREATE INDEX artifact_thread ON artifact (thread_id);
  CREATE INDEX artifact_channel ON artifact (channel_id);
  CREATE UNIQUE INDEX thread_own_orchestrator ON thread (company_id, created_by) WHERE orchestrator = 1;
  CREATE TRIGGER intake_check_created AFTER INSERT ON intake_check BEGIN
    INSERT INTO intake_check_revision(check_id,company_id,owner_id,at,current)
    VALUES(NEW.id,NEW.company_id,NEW.owner_id,NEW.revised_at,json_object('text',NEW.text,'state',NEW.state,'sourceIds',json(NEW.source_ids),'threadId',NEW.thread_id,'checkAt',NEW.check_at,'reviewAt',NEW.next_review_at,'explicitTime',NEW.explicit_time,'notifiedAt',NEW.notified_at));
  END;
  CREATE TRIGGER intake_check_changed AFTER UPDATE ON intake_check
    WHEN OLD.text IS NOT NEW.text OR OLD.state IS NOT NEW.state OR OLD.source_ids IS NOT NEW.source_ids
      OR OLD.check_at IS NOT NEW.check_at OR OLD.next_review_at IS NOT NEW.next_review_at
      OR OLD.thread_id IS NOT NEW.thread_id OR OLD.explicit_time IS NOT NEW.explicit_time
      OR OLD.notified_at IS NOT NEW.notified_at
    BEGIN
    INSERT INTO intake_check_revision(check_id,company_id,owner_id,at,previous,current)
    VALUES(NEW.id,NEW.company_id,NEW.owner_id,CAST(unixepoch('subsec')*1000 AS INTEGER),json_object('text',OLD.text,'state',OLD.state,'sourceIds',json(OLD.source_ids),'threadId',OLD.thread_id,'checkAt',OLD.check_at,'reviewAt',OLD.next_review_at,'explicitTime',OLD.explicit_time,'notifiedAt',OLD.notified_at),json_object('text',NEW.text,'state',NEW.state,'sourceIds',json(NEW.source_ids),'threadId',NEW.thread_id,'checkAt',NEW.check_at,'reviewAt',NEW.next_review_at,'explicitTime',NEW.explicit_time,'notifiedAt',NEW.notified_at));
  END;`,
  // companies: a channel that every member sees copies a public channel of the company's Slack, by its Slack ID.
  // integrations: the Slack bot of a company, whose encrypted `token` lists the Slack channels every 5 minutes, and
  // the history of each Slack channel: its messages, the day file of each day, its attachments, and the names of people.
  `ALTER TABLE channel ADD COLUMN slack_id TEXT;
  CREATE UNIQUE INDEX channel_slack ON channel (company_id, slack_id) WHERE slack_id IS NOT NULL;
  CREATE TABLE slack_bot (
    company_id TEXT PRIMARY KEY,
    token BLOB NOT NULL,
    team_id TEXT NOT NULL,
    team_name TEXT NOT NULL,
    connected_by TEXT NOT NULL,
    connected_at INTEGER NOT NULL,
    synced_at INTEGER,
    error TEXT,
    deleted_at INTEGER
  );
  CREATE TABLE slack_history (
    company_id TEXT NOT NULL,
    slack_channel_id TEXT NOT NULL,
    synced_at INTEGER NOT NULL,
    PRIMARY KEY (company_id, slack_channel_id)
  );
  CREATE TABLE slack_message (
    company_id TEXT NOT NULL,
    slack_channel_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    thread_ts TEXT,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    files TEXT NOT NULL,
    day TEXT NOT NULL,
    briefed INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    PRIMARY KEY (company_id, slack_channel_id, ts)
  );
  CREATE INDEX slack_message_day ON slack_message (company_id, slack_channel_id, day);
  CREATE INDEX slack_message_thread ON slack_message (company_id, slack_channel_id, thread_ts);
  CREATE TABLE slack_day (
    company_id TEXT NOT NULL,
    slack_channel_id TEXT NOT NULL,
    day TEXT NOT NULL,
    file_id TEXT,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (company_id, slack_channel_id, day)
  );
  CREATE TABLE slack_file (
    company_id TEXT NOT NULL,
    slack_file_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (company_id, slack_file_id)
  );
  CREATE TABLE slack_user (
    company_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (company_id, user_id)
  );`,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const database = new Database(path, { create: true, strict: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA busy_timeout = 5000");
  return database;
}

/** Runs the application migrations that this database has not run yet. */
export function migrate(database: Database): void {
  const { user_version: version } = database
    .query("PRAGMA user_version")
    .get() as { user_version: number };
  for (const [index, sql] of migrations.entries()) {
    if (index < version) {
      continue;
    }
    database.transaction(() => {
      database.run(sql);
      database.run(`PRAGMA user_version = ${index + 1}`);
    })();
  }
}

export function setting(database: Database, key: string): string | undefined {
  return (
    database.query("SELECT value FROM setting WHERE key = ?").get(key) as {
      value: string;
    } | null
  )?.value;
}

export function setSetting(
  database: Database,
  key: string,
  value: string
): void {
  database
    .query(
      "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}
