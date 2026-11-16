import { useMutation, useQuery } from "@tanstack/react-query";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { CompanyKey, LinearFeedStatus } from "../app/types.ts";
import {
  Badge,
  Button,
  Empty,
  SettingsCard,
  SettingsRow,
} from "../ui/components.tsx";
import { dayTime } from "../ui/format.ts";
import { showError } from "../ui/toast.tsx";
import { linearFeedQuery, linearKeyQuery } from "./data.ts";

/**
 * The company's read-only Linear key, with which everyone who has not connected Linear reads it, and the feed that files
 * Linear into the channels; for its admins.
 */
export function LinearSection({ companyId }: { companyId: string }) {
  const key = useQuery(linearKeyQuery(companyId)).data;
  const feed = useQuery({
    ...linearFeedQuery(companyId),
    enabled: Boolean(key?.key),
  }).data;
  const path = `/companies/${companyId}/integrations/linear/company-key`;
  const done = (saved: CompanyKey | null) => {
    queryClient.setQueryData(linearKeyQuery(companyId).queryKey, {
      key: saved,
    });
    return queryClient.invalidateQueries({
      queryKey: linearFeedQuery(companyId).queryKey,
    });
  };
  const save = useMutation({
    mutationFn: (value: string) =>
      request<CompanyKey>(path, { method: "PUT", body: { key: value } }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => request(path, { method: "DELETE" }),
    onSuccess: () => done(null),
    onError: showError,
  });
  if (!key) {
    return null;
  }
  return (
    <SettingsCard>
      {key.key ? (
        <SettingsRow description={feedState(feed)} label={key.key.label}>
          <Button label="Remove" onClick={() => remove.mutate()} />
        </SettingsRow>
      ) : (
        <form
          aria-busy={save.isPending || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(String(new FormData(event.currentTarget).get("key")));
          }}
        >
          <SettingsRow label="Read-only key">
            <input
              aria-label="Read-only key"
              autoComplete="off"
              className="input"
              name="key"
              placeholder="lin_api_…"
              required
              type="password"
            />
            <Button label="Save" type="submit" />
          </SettingsRow>
        </form>
      )}
    </SettingsCard>
  );
}

/** Where each Linear issue went, newest first, without its text; for its admins. */
export function LinearDecisionsSection({ companyId }: { companyId: string }) {
  const decisions = useQuery(linearFeedQuery(companyId)).data?.decisions ?? [];
  if (decisions.length === 0) {
    return <Empty title="Nothing yet" />;
  }
  return (
    <SettingsCard>
      {decisions.slice(0, 30).map((decision) => (
        <SettingsRow
          compact
          description={dayTime(decision.at)}
          key={decision.id}
          label={`${decision.identifier}${decision.channelName ? ` → #${decision.channelName}` : ""}`}
        >
          <Badge label={ACTIONS[decision.action] ?? decision.action} />
        </SettingsRow>
      ))}
    </SettingsCard>
  );
}

const ACTIONS: Record<string, string> = {
  filed: "Filed",
  posted: "Posted",
  capped: "Hour limit",
  dropped: "No channel",
};

function feedState(feed: LinearFeedStatus | undefined): string {
  if (feed?.error) {
    return feed.error;
  }
  if (!feed?.backfilledAt) {
    return "Reading the last 30 days";
  }
  return `Read ${dayTime(feed.polledThrough ?? feed.backfilledAt)}`;
}
