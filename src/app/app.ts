import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProfilePictures } from "../accounts/accounts.ts";
import { Agenda } from "../agenda/agenda.ts";
import { Artifacts } from "../artifacts/artifacts.ts";
import { Browser, browserRequirements } from "../browser/browser.ts";
import { Companies } from "../companies/companies.ts";
import { FeedbackReports } from "../feedback/feedback.ts";
import { Intake } from "../intake/intake.ts";
import type { Connector } from "../integrations/integrations.ts";
import { Integrations } from "../integrations/integrations.ts";
import { SlackBot } from "../integrations/slack-bot.ts";
import { Llm, type LlmProvider } from "../llm/llm.ts";
import { transcribeRequirements } from "../llm/transcribe.ts";
import { Notifications } from "../notifications/notifications.ts";
import { Places } from "../places/places.ts";
import { type Auth, createAuth, migrateAuth } from "../platform/auth.ts";
import type { Config } from "../platform/config.ts";
import { migrate, openDatabase } from "../platform/database.ts";
import { llamaRequirements } from "../platform/llama.ts";
import type { Requirement } from "../platform/requirements.ts";
import { Secrets } from "../platform/secrets.ts";
import { Reminders } from "../reminders/reminders.ts";
import { Routines } from "../routines/routines.ts";
import type { Embedder } from "../search/embedder.ts";
import { extractRequirements, jpeg, readText } from "../search/extract.ts";
import { Indexer, RecentSearches } from "../search/search.ts";
import { Threads } from "../threads/threads.ts";

export interface App {
  readonly config: Config;
  readonly database: Database;
  readonly auth: Auth;
  readonly pictures: ProfilePictures;
  readonly llm: Llm;
  readonly threads: Threads;
  readonly companies: Companies;
  readonly integrations: Integrations;
  readonly artifacts: Artifacts;
  readonly notifications: Notifications;
  readonly indexer: Indexer;
  readonly recentSearches: RecentSearches;
  readonly routines: Routines;
  readonly places: Places;
  readonly reminders: Reminders;
  readonly agenda: Agenda;
  readonly intake: Intake;
  readonly slackBot: SlackBot;
  readonly feedback: FeedbackReports;
}

/** Everything the modules need from this machine, checked before Shadow starts. */
export async function checkRequirements(): Promise<Requirement[]> {
  const requirements = await Promise.all([
    extractRequirements(),
    llamaRequirements(),
    browserRequirements(),
    transcribeRequirements(),
  ]);
  return requirements.flat();
}

/** `embedder` gives search its meaning; without one, search and recall use keywords only. */
export async function createApp(
  config: Config,
  llmProvider: LlmProvider,
  secrets?: Secrets,
  embedder: Embedder | null = null,
  /** The connectors; tests give their own. */
  catalog?: readonly Connector[]
): Promise<App> {
  mkdirSync(config.dataDirectory, { recursive: true });
  const resolvedSecrets =
    secrets ?? (await Secrets.load(config.configDirectory));
  const database = openDatabase(join(config.dataDirectory, "shadow.sqlite"));
  const auth = createAuth({
    database,
    secret: resolvedSecrets.authSecret,
    baseUrl: config.baseUrl,
    allowedEmails: config.allowedEmails,
    google: config.google,
  });
  await migrateAuth(auth);
  migrate(database);
  const audit = Intake.audit(join(config.dataDirectory, "audit.sqlite"));
  const llm = new Llm(
    database,
    resolvedSecrets,
    llmProvider,
    (user, companyId) => companies.isAdmin(user, companyId),
    (spend, data) =>
      audit.record(
        `model:${spend?.source ?? "background"}:${spend?.threadId ?? ""}`,
        "model.call",
        spend?.companyId ?? "",
        spend?.userId ?? "",
        data
      )
  );
  // New connector tools reach the agents' next runs.
  const reloadTools = (companyId: string) => {
    threads
      .reloadTools(companyId)
      .catch((error: unknown) =>
        console.error("reloading the tools failed", error)
      );
  };
  const pictures = new ProfilePictures(database);
  const companies = new Companies(database, auth, pictures, reloadTools);
  const integrations = new Integrations(database, resolvedSecrets, companies, {
    changed: reloadTools,
    catalog,
  });
  // The change hooks point at the indexer, which reads the threads and the artifacts.
  const artifacts = new Artifacts(database, companies, config, (companyId) =>
    indexer.touch(companyId)
  );
  const browser = new Browser();
  const notifications = new Notifications(database, companies);
  // The recall port points at the indexer too; files read as search reads them.
  // The routine tools come from routines, which runs its work in threads.
  const threads: Threads = new Threads(
    config.dataDirectory,
    llm,
    companies,
    integrations,
    artifacts,
    browser,
    notifications,
    {
      audit: (companyId, ownerId, trace, stage, data) =>
        audit.record(trace, stage, companyId, ownerId, data),
      recall: (companyId, query, limit, personId) =>
        indexer.search(companyId, query, limit, personId),
      changed: (companyId) => indexer.touch(companyId),
      observedContext: (companyId, threadId, ownerId, claim) =>
        intake.contextFor(companyId, threadId, ownerId, claim),
      answered: (companyId, threadId, personId) =>
        intake.finishClaims(companyId, threadId, personId),
      sourceRead: (thread, ownerId, read) =>
        intake.recordSourceRead(thread, ownerId, read),
      moved: (threadId, channelId) => {
        routines.moveWithThread(threadId, channelId);
        agenda.moveWithThread(threadId, channelId);
      },
      merged: (from, to) => {
        routines.moveChannel(from, to);
        agenda.moveChannel(from, to);
        intake.moveChannel(from, to);
      },
      tools: async (companyId) => [
        ...(await routines.tools(companyId)),
        ...reminders.tools(companyId),
        ...intake.tools(companyId),
        ...feedback.tools(companyId),
      ],
      automations: (companyId, personId) =>
        agenda.automations(companyId, personId),
      suggest: (companyId, threadId, channelId, suggestion) =>
        agenda.offer(companyId, threadId, channelId, suggestion),
      read: readText,
      picture: jpeg,
    }
  );
  const indexer = new Indexer(
    config.dataDirectory,
    companies,
    threads,
    artifacts,
    embedder
  );
  const places = new Places(database, companies);
  const routines = new Routines(
    database,
    companies,
    integrations,
    threads,
    indexer,
    places
  );
  const reminders = new Reminders(database, companies, threads, places);
  const agenda = new Agenda(
    database,
    companies,
    threads,
    routines,
    reminders,
    places
  );
  const intake = new Intake(
    database,
    companies,
    integrations,
    threads,
    indexer,
    llm,
    audit,
    notifications,
    reminders
  );
  // The Slack bot works for no person; the files of a channel take the member that background work acts as.
  const slackBot = new SlackBot(
    database,
    resolvedSecrets,
    companies,
    (companyId) => threads.channelsChanged(companyId),
    {
      writeFile: (companyId, channelId, file, replaces) =>
        threads.writeFile(
          companyId,
          channelId,
          companies.agentMember(companyId),
          file,
          replaces
        ),
      deleteFile: async (companyId, fileId) => {
        await threads.deleteFile(
          companyId,
          companies.agentMember(companyId),
          fileId
        );
      },
      brief: (companyId, channelId, messages) =>
        threads.briefFromSlack(companyId, channelId, messages),
    }
  );
  const feedback = new FeedbackReports(database, companies, threads);
  return {
    config,
    database,
    auth,
    pictures,
    llm,
    threads,
    companies,
    integrations,
    artifacts,
    notifications,
    indexer,
    recentSearches: new RecentSearches(database),
    routines,
    places,
    reminders,
    agenda,
    intake,
    slackBot,
    feedback,
  };
}

export async function closeApp(app: App): Promise<void> {
  await app.slackBot.close();
  await app.intake.close();
  app.reminders.close();
  app.routines.close();
  await app.indexer.close();
  await app.threads.closeAll();
  await app.integrations.close();
  app.intake.audit.close();
  app.database.close();
}
