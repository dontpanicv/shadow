import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Company, Facts, Role, SlackBotStatus } from "../app/types.ts";
import {
  Avatar,
  Button,
  Select,
  SettingsCard,
  SettingsRow,
} from "../ui/components.tsx";
import { dayTime } from "../ui/format.ts";
import { showError, showToast } from "../ui/toast.tsx";
import {
  factsQuery,
  membersQuery,
  meQuery,
  refreshCompany,
  slackBotQuery,
} from "./data.ts";

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

/** The company's Slack bot, whose public channels the channels that every member sees copy every 5 minutes. */
export function SlackBotSection({ companyId }: { companyId: string }) {
  const bot = useQuery(slackBotQuery(companyId)).data;
  const done = (status: SlackBotStatus | undefined) => {
    queryClient.setQueryData(slackBotQuery(companyId).queryKey, status);
    return refreshCompany(companyId);
  };
  const connect = useMutation({
    mutationFn: (token: string) =>
      request<SlackBotStatus>(`/companies/${companyId}/slack-bot`, {
        method: "PUT",
        body: { token },
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
        <SettingsRow
          description={
            bot.error ??
            (bot.syncedAt ? `Synced ${dayTime(bot.syncedAt)}` : null)
          }
          label={bot.team}
        >
          <Button label="Disconnect" onClick={() => disconnect.mutate()} />
        </SettingsRow>
      ) : (
        <form
          aria-busy={connect.isPending || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            connect.mutate(
              String(new FormData(event.currentTarget).get("token"))
            );
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
            <Button label="Connect" type="submit" />
          </SettingsRow>
        </form>
      )}
    </SettingsCard>
  );
}

const DISCONNECTED: SlackBotStatus = {
  connected: false,
  team: null,
  syncedAt: null,
  error: null,
};
