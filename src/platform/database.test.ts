import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import { migrate } from "./database.ts";

test("the company's one orchestrator from before becomes the own of the person who made its first channel", () => {
  const database = authDatabase();
  migrate(database);
  const { user_version: version } = database
    .query("PRAGMA user_version")
    .get() as { user_version: number };
  // The state before the migration of the orchestrators and the one after it: one orchestrator of the company,
  // made by Shadow, no OAuth clients, no channel emojis, no facts, no private channels, and no recent searches.
  database.run(`DROP INDEX channel_personal; ALTER TABLE channel DROP COLUMN personal; ALTER TABLE routine DROP COLUMN post_in_slack; DROP TABLE slack_member; DROP TABLE slack_conversation; DROP TABLE slack_reply; DROP TABLE slack_goal; DROP TABLE slack_decision; DROP TABLE slack_bot; DROP TABLE slack_history; DROP TABLE slack_message; DROP TABLE slack_day; DROP TABLE slack_file; DROP TABLE slack_user; DROP INDEX channel_slack; ALTER TABLE channel DROP COLUMN slack_id;
  ALTER TABLE reminder DROP COLUMN not_before; ALTER TABLE reminder DROP COLUMN not_after; ALTER TABLE intake_check DROP COLUMN nudge_at; DROP TABLE intake_block; DROP TABLE intake_feedback; DROP TABLE intake_archive; DROP TRIGGER intake_check_created; DROP TRIGGER intake_check_changed; DROP TABLE intake_check_revision;
  ALTER TABLE routine_run DROP COLUMN input;
	DROP TABLE intake_source_read;
	DROP TABLE intake_fts;
	DROP TABLE intake_thread_read;
	DROP TABLE intake_delivery;
	DROP TABLE intake_context;
	DROP TABLE intake_check;
	DROP TABLE intake_item;
	DROP TABLE intake_source;
	ALTER TABLE credential DROP COLUMN watched;
	DROP TABLE feedback;
	DROP TABLE place_presence;
	ALTER TABLE routine DROP COLUMN place_id;
	ALTER TABLE routine DROP COLUMN place_event;
	ALTER TABLE routine DROP COLUMN place_person_id;
	DROP TABLE place;
	ALTER TABLE reminder DROP COLUMN place_id;
	ALTER TABLE reminder DROP COLUMN place_event;
	ALTER TABLE reminder DROP COLUMN triggered_at;
	DROP TABLE profile_picture;
	DROP TABLE live_activity;
	DROP TABLE suggestion;
	DROP TABLE llm_usage;
	DROP TABLE llm_usage_seen;
	DROP TABLE recent_search;
	ALTER TABLE channel DROP COLUMN owner_id;
	DROP TABLE company_facts;
	ALTER TABLE channel DROP COLUMN icon;
	DROP TABLE oauth_client;
	DROP INDEX thread_own_orchestrator;
	CREATE UNIQUE INDEX thread_orchestrator ON thread (company_id) WHERE orchestrator = 1;
	INSERT INTO channel (id, company_id, name, created_by, created_at) VALUES ('general', 'home', 'general', 'alice', 1), ('food', 'home', 'food', 'bob', 2);
	INSERT INTO thread (id, company_id, channel_id, title, created_by, created_at, updated_at, orchestrator) VALUES ('shadow', 'home', 'food', 'Shadow', 'shadow', 1, 1, 1), ('dinner', 'home', 'food', 'Dinner', 'bob', 1, 1, 0);
	PRAGMA user_version = ${version - 37};`);
  migrate(database);
  expect(
    database
      .query("SELECT id, created_by AS createdBy FROM thread ORDER BY id")
      .all()
  ).toEqual([
    { id: "dinner", createdBy: "bob" },
    { id: "shadow", createdBy: "alice" },
  ]);
  database.run(
    "INSERT INTO thread (id, company_id, channel_id, title, created_by, created_at, updated_at, orchestrator) VALUES ('bobs', 'home', 'general', 'Shadow', 'bob', 1, 1, 1)"
  );
  expect(() =>
    database.run(
      "INSERT INTO thread (id, company_id, channel_id, title, created_by, created_at, updated_at, orchestrator) VALUES ('again', 'home', 'general', 'Shadow', 'bob', 1, 1, 1)"
    )
  ).toThrow();
});

test("own credentials and machines become private ones in their owner's company, and the company's shared ones", () => {
  const database = authDatabase();
  migrate(database);
  const { user_version: version } = database
    .query("PRAGMA user_version")
    .get() as { user_version: number };
  // The tables before: a null company is a person's own. Alice paired the NAS both ways, and Bob's own "mac" has the
  // name of Alice's.
  database.run(`DROP INDEX channel_personal; ALTER TABLE channel DROP COLUMN personal; ALTER TABLE routine DROP COLUMN post_in_slack; DROP TABLE slack_member; DROP TABLE slack_conversation; DROP TABLE slack_reply; DROP TABLE slack_goal; DROP TABLE slack_decision; DROP TABLE slack_bot; DROP TABLE slack_history; DROP TABLE slack_message; DROP TABLE slack_day; DROP TABLE slack_file; DROP TABLE slack_user; DROP INDEX channel_slack; ALTER TABLE channel DROP COLUMN slack_id;
  ALTER TABLE reminder DROP COLUMN not_before; ALTER TABLE reminder DROP COLUMN not_after; ALTER TABLE intake_check DROP COLUMN nudge_at; DROP TABLE intake_block; DROP TABLE intake_feedback; DROP TABLE intake_archive; DROP TRIGGER intake_check_created; DROP TRIGGER intake_check_changed; DROP TABLE intake_check_revision;
  ALTER TABLE routine_run DROP COLUMN input;
	DROP TABLE intake_source_read;
	DROP TABLE intake_fts;
	DROP TABLE intake_thread_read;
	DROP TABLE intake_delivery;
	DROP TABLE intake_context;
	DROP TABLE intake_check;
	DROP TABLE intake_item;
	DROP TABLE intake_source;
	DROP TABLE feedback;
	DROP TABLE place_presence;
	ALTER TABLE routine DROP COLUMN place_id;
	ALTER TABLE routine DROP COLUMN place_event;
	ALTER TABLE routine DROP COLUMN place_person_id;
	DROP TABLE place;
	ALTER TABLE reminder DROP COLUMN place_id;
	ALTER TABLE reminder DROP COLUMN place_event;
	ALTER TABLE reminder DROP COLUMN triggered_at;
	DROP TABLE profile_picture;
	DROP TABLE live_activity;
	DROP TABLE suggestion;
	DROP TABLE llm_usage;
	DROP TABLE llm_usage_seen;
	DROP TABLE credential;
	DROP TABLE machine;
	CREATE TABLE credential (id TEXT PRIMARY KEY, company_id TEXT, integration TEXT NOT NULL, owner_id TEXT NOT NULL, label TEXT NOT NULL, shared INTEGER NOT NULL, secret BLOB NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER);
	CREATE TABLE machine (id TEXT PRIMARY KEY, company_id TEXT, name TEXT NOT NULL, hostname TEXT, addresses TEXT NOT NULL, port INTEGER NOT NULL, cert_sha256 TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL, version TEXT NOT NULL, paired_at INTEGER NOT NULL, deleted_at INTEGER, paired_by TEXT, trusted_members TEXT NOT NULL DEFAULT '[]', UNIQUE (company_id, cert_sha256), UNIQUE (company_id, name));
	INSERT INTO organization (id, name, createdAt, deletedAt) VALUES ('old', 'Old', 1, 5), ('home', 'Home', 2, NULL);
	INSERT INTO member (id, organizationId, userId) VALUES ('m1', 'old', 'alice'), ('m2', 'home', 'alice'), ('m3', 'home', 'bob');
	INSERT INTO channel (id, company_id, name, created_by, created_at) VALUES ('general', 'home', 'general', 'alice', 1);
	INSERT INTO credential (id, company_id, integration, owner_id, label, shared, secret, created_at) VALUES ('company-mail', 'home', 'google', 'bob', 'company', 1, x'00', 1), ('alices-mail', NULL, 'google', 'alice', 'alice', 1, x'00', 2);
	INSERT INTO machine (id, company_id, name, addresses, port, cert_sha256, os, arch, version, paired_at, paired_by) VALUES
		('old-nas', 'home', 'nas~old-nas', '[]', 1, 'n~old-nas', 'linux', 'x86_64', '1', 1, NULL),
		('shared-nas', 'home', 'nas', '[]', 1, 'n', 'linux', 'x86_64', '1', 2, 'alice'),
		('own-nas', NULL, 'nas', '[]', 1, 'n', 'linux', 'x86_64', '1', 3, 'alice'),
		('alices-mac', NULL, 'mac', '[]', 1, 'a', 'macos', 'arm64', '1', 4, 'alice'),
		('bobs-mac', NULL, 'mac', '[]', 1, 'b', 'macos', 'arm64', '1', 5, 'bob');
	UPDATE machine SET deleted_at = 1 WHERE id = 'old-nas';
	PRAGMA user_version = ${version - 31};`);
  migrate(database);
  expect(
    database
      .query(
        "SELECT id, company_id AS companyId, owner_id AS ownerId, shared FROM credential ORDER BY id"
      )
      .all()
  ).toEqual([
    { id: "alices-mail", companyId: "home", ownerId: "alice", shared: 0 },
    { id: "company-mail", companyId: "home", ownerId: "bob", shared: 1 },
  ]);
  expect(
    database
      .query(
        "SELECT id, company_id AS companyId, name, paired_by AS pairedBy, shared, deleted_at IS NOT NULL AS deleted FROM machine ORDER BY id"
      )
      .all()
  ).toEqual([
    {
      id: "alices-mac",
      companyId: "home",
      name: "mac",
      pairedBy: "alice",
      shared: 0,
      deleted: 0,
    },
    {
      id: "bobs-mac",
      companyId: "home",
      name: "mac-bobs",
      pairedBy: "bob",
      shared: 0,
      deleted: 0,
    },
    {
      id: "old-nas",
      companyId: "home",
      name: "nas~old-nas",
      pairedBy: "alice",
      shared: 1,
      deleted: 1,
    },
    {
      id: "own-nas",
      companyId: "home",
      name: "nas",
      pairedBy: "alice",
      shared: 1,
      deleted: 0,
    },
    {
      id: "shared-nas",
      companyId: "home",
      name: "nas~shared-nas",
      pairedBy: "alice",
      shared: 1,
      deleted: 1,
    },
  ]);
});

test("notification permission expands the intake schema and leaves queued updates silent", () => {
  const database = authDatabase();
  migrate(database);
  const { user_version: version } = database
    .query("PRAGMA user_version")
    .get() as { user_version: number };
  database.run(`DROP INDEX channel_personal; ALTER TABLE channel DROP COLUMN personal; ALTER TABLE routine DROP COLUMN post_in_slack; DROP TABLE slack_member; DROP TABLE slack_conversation; DROP TABLE slack_reply; DROP TABLE slack_goal; DROP TABLE slack_decision; DROP TABLE slack_bot; DROP TABLE slack_history; DROP TABLE slack_message; DROP TABLE slack_day; DROP TABLE slack_file; DROP TABLE slack_user; DROP INDEX channel_slack; ALTER TABLE channel DROP COLUMN slack_id;
  ALTER TABLE reminder DROP COLUMN not_before; ALTER TABLE reminder DROP COLUMN not_after; ALTER TABLE intake_check DROP COLUMN nudge_at; DROP TABLE intake_block; DROP TABLE intake_feedback; DROP TABLE intake_archive; DROP TRIGGER intake_check_created; DROP TRIGGER intake_check_changed; DROP TABLE intake_check_revision;
  DROP TABLE intake_source_read;
    DROP INDEX intake_conversation;
    ALTER TABLE intake_item DROP COLUMN deleted_at;
    ALTER TABLE intake_delivery DROP COLUMN subject;
    ALTER TABLE intake_delivery DROP COLUMN notification;
    INSERT INTO intake_delivery(id,company_id,owner_id,thread_id,body,attention,check_ids,evidence_ids,created_at)
    VALUES('queued','home','alice','subject','Useful context','now','[]','[]',1);
    ALTER TABLE place_presence DROP COLUMN watched;
    DROP INDEX place_point_of_interest;
    DROP INDEX place_name;
    ALTER TABLE place DROP COLUMN osm_id;
    CREATE UNIQUE INDEX place_name ON place (company_id, owner_id, name COLLATE NOCASE);
    PRAGMA user_version = ${version - 18};`);
  migrate(database);
  expect(
    database
      .query("SELECT body,notification FROM intake_delivery WHERE id='queued'")
      .get()
  ).toEqual({ body: "Useful context", notification: null });
  expect(
    database
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='intake_conversation'"
      )
      .get()
  ).toMatchObject({ name: "intake_conversation" });
});
