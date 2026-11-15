import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type {
  Company,
  Facts,
  Role,
  SlackBotStatus,
  SlackDefaultGoal,
  SlackGoal,
} from "../app/types.ts";
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Empty,
  PageSection,
  Select,
  SettingsCard,
  SettingsRow,
} from "../ui/components.tsx";
import { dayTime } from "../ui/format.ts";
import { copy, showError, showToast } from "../ui/toast.tsx";
import {
  factsQuery,
  membersQuery,
  meQuery,
  refreshCompany,
  slackBotQuery,
  slackDecisionsQuery,
  slackDefaultGoalQuery,
  slackGoalsQuery,
  useMe,
} from "./data.ts";
import slackManifest from "./slack-app-manifest.json" with { type: "json" };

/** The name of the company, for its admins. */
export function CompanySection({ company }: { company: Company }) {
  const rename = useMutation({
    mutationFn: (name: string) =>
      request(`/companies/${company.id}`, { method: "PUT", body: { name } }),
    onSuccess: () => {
      showToast("success", "Saved");
      return queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
  });
  return (
    <SettingsCard>
      <form
        aria-busy={rename.isPending || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          rename.mutate(String(new FormData(event.currentTarget).get("name")));
        }}
      >
        <SettingsRow label="Name">
          <input
            aria-label="Name"
            className="input"
            defaultValue={company.name}
            key={company.name}
            name="name"
            required
          />
          <Button label="Save" type="submit" />
        </SettingsRow>
      </form>
    </SettingsCard>
  );
}

/** The facts that the admins write about the company, such as its teams, products, and customers; every agent reads them. */
export function FactsSection({ companyId }: { companyId: string }) {
  const facts = useQuery(factsQuery(companyId));
  const save = useMutation({
    mutationFn: (text: string) =>
      request<Facts>(`/companies/${companyId}/facts`, {
        method: "PUT",
        body: { text },
      }),
    onSuccess: (saved) => {
      showToast("success", "Saved");
      queryClient.setQueryData(factsQuery(companyId).queryKey, saved);
    },
  });
  return (
    <SettingsCard>
      <form
        aria-busy={save.isPending || undefined}
        className="settings-text-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(String(new FormData(event.currentTarget).get("text")));
        }}
      >
        <textarea
          aria-label="Facts"
          className="input multiline"
          defaultValue={facts.data?.text}
          key={facts.data?.text}
          maxLength={20_000}
          name="text"
          placeholder="Teams, products, customers, processes"
          rows={12}
        />
        <Button label="Save" type="submit" />
      </form>
    </SettingsCard>
  );
}

/** The members of a company with their roles, and a form to add one; for its admins. */
export function MembersSection({ company }: { company: Company }) {
  const companyId = company.id;
  const members = useQuery(membersQuery(companyId)).data ?? [];
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: membersQuery(companyId).queryKey,
      }),
      queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
    ]);
  const add = useMutation({
    mutationFn: (email: string) =>
      request<{ name: string }>(`/companies/${companyId}/members`, {
        method: "POST",
        body: { email },
      }),
    onSuccess: (member) => {
      showToast("success", `${member.name} joined the company`);
      return refresh();
    },
  });
  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      request(`/companies/${companyId}/members/${userId}`, {
        method: "PUT",
        body: { role },
      }),
    onSuccess: refresh,
    onError: showError,
  });
  return (
    <SettingsCard>
      {members.map((member) => (
        <SettingsRow
          compact
          description={member.email}
          key={member.userId}
          label={member.name}
          lead={<Avatar name={member.name} picture={member.picture} />}
        >
          <Select
            label={`Role of ${member.name}`}
            onChange={(role) =>
              setRole.mutate({ userId: member.userId, role: role as Role })
            }
            options={ROLES}
            value={member.role}
          />
        </SettingsRow>
      ))}
      <form
        aria-busy={add.isPending || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          add.mutate(String(new FormData(form).get("email")), {
            onSuccess: () => form.reset(),
          });
        }}
      >
        <SettingsRow label="Add a member">
          <input
            aria-label="Email"
            className="input"
            name="email"
            placeholder="name@example.com"
            required
            type="email"
          />
          <Button label="Add" type="submit" />
        </SettingsRow>
      </form>
    </SettingsCard>
  );
}

const ROLES = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "User" },
] as const;

/** The company's Slack bot, which listens to Slack: its public channels and their history become the shared channels. */
export function SlackBotSection({ companyId }: { companyId: string }) {
  const bot = useQuery(slackBotQuery(companyId)).data;
  const done = (status: SlackBotStatus | undefined) => {
    queryClient.setQueryData(slackBotQuery(companyId).queryKey, status);
    return refreshCompany(companyId);
  };
  const connect = useMutation({
    mutationFn: (tokens: { token: string; appToken: string }) =>
      request<SlackBotStatus>(`/companies/${companyId}/slack-bot`, {
        method: "PUT",
        body: tokens,
      }),
    onSuccess: done,
  });
  const disconnect = useMutation({
    mutationFn: () =>
      request(`/companies/${companyId}/slack-bot`, { method: "DELETE" }),
    onSuccess: () => done({ ...DISCONNECTED }),
    onError: showError,
  });
  if (!bot) {
    return null;
  }
  return (
    <SettingsCard>
      {bot.connected ? (
        <SettingsRow description={bot.error ?? botState(bot)} label={bot.team}>
          <Button label="Disconnect" onClick={() => disconnect.mutate()} />
        </SettingsRow>
      ) : (
        <form
          aria-busy={connect.isPending || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            connect.mutate({
              token: String(form.get("token")),
              appToken: String(form.get("appToken")),
            });
          }}
        >
          <SettingsRow label="Bot token">
            <input
              aria-label="Bot token"
              autoComplete="off"
              className="input"
              name="token"
              placeholder="xoxb-…"
              required
              type="password"
            />
          </SettingsRow>
          <SettingsRow label="App token">
            <input
              aria-label="App token"
              autoComplete="off"
              className="input"
              name="appToken"
              placeholder="xapp-…"
              required
              type="password"
            />
            <SlackSetup />
            <Button label="Connect" type="submit" />
          </SettingsRow>
        </form>
      )}
    </SettingsCard>
  );
}

/** The shortest way to the two tokens: a Slack app made from Shadow's manifest, with this host for link previews. */
function SlackSetup() {
  const [open, setOpen] = useState(false);
  // Slack previews links only of a real domain, so a local Shadow leaves it out.
  const unfurlDomains = location.hostname.includes(".")
    ? [location.hostname]
    : [];
  const manifest = JSON.stringify(
    {
      ...slackManifest,
      features: { ...slackManifest.features, unfurl_domains: unfurlDomains },
    },
    null,
    2
  );
  return (
    <>
      <Button
        icon="info"
        label="Set up the Slack app"
        onClick={() => setOpen(true)}
        size="icon"
        variant="ghost"
      />
      <Dialog
        onClose={() => setOpen(false)}
        open={open}
        title="Set up the Slack app"
      >
        <div className="prose">
          <ol className="guide">
            <li>
              Create the app from Shadow's manifest, in the company's workspace.
              <div className="guide-actions">
                <a
                  className="button primary"
                  href={`https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifest)}`}
                  rel="noopener"
                  target="_blank"
                >
                  Create app
                </a>
                <Button label="Copy manifest" onClick={() => copy(manifest)} />
              </div>
            </li>
            <li>
              <strong>Install App › Install to Workspace › Allow</strong>. Copy
              the <strong>Bot User OAuth Token</strong> into Bot token.
            </li>
            <li>
              <strong>Basic Information › App-Level Tokens › Generate</strong>{" "}
              with the scope <code>connections:write</code>. Copy it into App
              token.
            </li>
          </ol>
        </div>
      </Dialog>
    </>
  );
}

/** Whether Slack's events reach Shadow now, or when it last heard from Slack. */
function botState(bot: SlackBotStatus): string | null {
  if (bot.listening) {
    return "Listening";
  }
  return bot.syncedAt ? `Last heard ${dayTime(bot.syncedAt)}` : null;
}

const DISCONNECTED: SlackBotStatus = {
  connected: false,
  listening: false,
  team: null,
  syncedAt: null,
  error: null,
};

/**
 * Where Shadow listens without being asked, and how it takes part: the default goal for every channel. A channel's own
 * goal, which comes before it, and switching a channel off are on the channel's page.
 */
export function SlackGoalsSection({ companyId }: { companyId: string }) {
  const goals = useQuery(slackGoalsQuery(companyId)).data ?? [];
  const fallback = useQuery(slackDefaultGoalQuery(companyId)).data;
  if (goals.length === 0) {
    return <Empty title="No Slack channels yet" />;
  }
  return (
    <SettingsCard>
      <GoalForm
        companyId={companyId}
        goal={fallback ?? { wakeWhen: null, engagement: null }}
        label="All channels"
        path={`/companies/${companyId}/slack/default-goal`}
        saved="Shadow listens in all channels"
      />
    </SettingsCard>
  );
}

/**
 * How Shadow listens in one channel that copies a Slack channel: its own goal, the default goal, or off; for admins.
 * A channel that does not listen gets answers only when someone mentions Shadow.
 */
export function ChannelGoalSection({
  companyId,
  channelId,
}: {
  companyId: string;
  channelId: string;
}) {
  const admin =
    useMe().companies.find((company) => company.id === companyId)?.role ===
    "admin";
  const goal = useQuery({
    ...slackGoalsQuery(companyId),
    enabled: admin,
  }).data?.find((candidate) => candidate.channelId === channelId);
  const fallback = useQuery({
    ...slackDefaultGoalQuery(companyId),
    enabled: admin,
  }).data;
  if (!goal) {
    return null;
  }
  return (
    <PageSection title="Listening">
      <SettingsCard>
        <GoalForm
          channel={goal}
          companyId={companyId}
          fallback={fallback}
          goal={goal}
          key={goal.channelId}
          label={`#${goal.channelName}`}
          path={`/companies/${companyId}/slack/goals/${goal.channelId}`}
          saved={`Shadow listens in #${goal.channelName}`}
        />
      </SettingsCard>
    </PageSection>
  );
}

/**
 * One goal: the default goal, or a channel's own goal, with the default as its placeholder. A channel listens with
 * either, until an admin stops it there.
 */
function GoalForm({
  companyId,
  label,
  path,
  saved,
  goal,
  fallback,
  channel,
}: {
  companyId: string;
  label: string;
  path: string;
  saved: string;
  goal: SlackDefaultGoal;
  fallback?: SlackDefaultGoal | undefined;
  channel?: SlackGoal;
}) {
  const [draft, setDraft] = useState({
    wakeWhen: goal.wakeWhen ?? "",
    engagement: goal.engagement ?? "",
  });
  // The goals, the default goal, and the decisions all change together.
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ["companies", companyId, "slack"],
    });
  const save = useMutation({
    mutationFn: () => request(path, { method: "PUT", body: draft }),
    onSuccess: () => {
      showToast("success", saved);
      return refresh();
    },
    onError: showError,
  });
  const change = useMutation({
    mutationFn: (action: { path: string; method: "PUT" | "DELETE" }) =>
      request(action.path, { method: action.method }),
    onSuccess: refresh,
    onError: showError,
  });
  const suggest = useMutation({
    mutationFn: () =>
      request<{ wakeWhen: string; engagement: string }>(`${path}/suggest`, {
        method: "POST",
      }),
    onSuccess: setDraft,
    onError: showError,
  });
  const off = channel?.off ?? false;
  const listening = !off && Boolean(goal.wakeWhen ?? fallback?.wakeWhen);
  return (
    <form
      aria-busy={save.isPending || suggest.isPending || undefined}
      className="settings-text-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <SettingsRow label={label}>
        <Button
          label="Suggest"
          onClick={() => suggest.mutate()}
          variant="ghost"
        />
        {channel && goal.wakeWhen && fallback?.wakeWhen && !off ? (
          <Button
            label="Use default"
            onClick={() => {
              setDraft({ wakeWhen: "", engagement: "" });
              change.mutate({ path, method: "DELETE" });
            }}
            variant="ghost"
          />
        ) : null}
        {off ? (
          <Button
            label="Listen"
            onClick={() =>
              change.mutate({ path: `${path}/off`, method: "DELETE" })
            }
            variant="ghost"
          />
        ) : null}
        {listening ? (
          <Button
            label="Stop listening"
            onClick={() => {
              if (channel) {
                change.mutate({ path: `${path}/off`, method: "PUT" });
              } else {
                setDraft({ wakeWhen: "", engagement: "" });
                change.mutate({ path, method: "DELETE" });
              }
            }}
            variant="ghost"
          />
        ) : null}
      </SettingsRow>
      <input
        aria-label={`When Shadow takes part in ${label}`}
        className="input"
        onChange={(event) =>
          setDraft({ ...draft, wakeWhen: event.target.value })
        }
        placeholder={
          fallback?.wakeWhen ??
          "Wake when: questions about invoices and payments"
        }
        value={draft.wakeWhen}
      />
      <input
        aria-label={`How Shadow takes part in ${label}`}
        className="input"
        onChange={(event) =>
          setDraft({ ...draft, engagement: event.target.value })
        }
        placeholder={
          fallback?.engagement ??
          "Take part by: answering briefly, with the source"
        }
        value={draft.engagement}
      />
      <Button
        disabled={!(draft.wakeWhen.trim() && draft.engagement.trim())}
        label="Save"
        type="submit"
      />
    </form>
  );
}

/** What ambient listening decided lately, newest first, for admins to tune the goals; never the text of messages. */
export function SlackDecisionsSection({ companyId }: { companyId: string }) {
  const decisions = useQuery(slackDecisionsQuery(companyId)).data ?? [];
  if (decisions.length === 0) {
    return <Empty title="Nothing yet" />;
  }
  return (
    <SettingsCard>
      {decisions.slice(0, 30).map((decision) => (
        <SettingsRow
          compact
          description={`${dayTime(decision.at)}${
            decision.probability === null
              ? ""
              : ` · ${Math.round(decision.probability * 100)}%`
          }`}
          key={`${decision.slackChannelId}-${decision.ts}-${decision.at}`}
          label={`#${decision.channelName}`}
        >
          <Badge label={OUTCOMES[decision.outcome] ?? decision.outcome} />
        </SettingsRow>
      ))}
    </SettingsCard>
  );
}

const OUTCOMES: Record<string, string> = {
  skipped: "Skipped",
  quiet: "Stayed quiet",
  replied: "Replied",
  capped: "Hour limit",
  muted: "Muted",
  failed: "Failed",
};
