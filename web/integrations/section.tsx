import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import ReactMarkdown from "react-markdown";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Integration } from "../app/types.ts";
import {
  Button,
  Dialog,
  SettingsCard,
  SettingsRow,
  Switch,
  TextField,
} from "../ui/components.tsx";
import { Icon } from "../ui/icon.tsx";
import { showToast } from "../ui/toast.tsx";

/**
 * The integrations, with the person's own credentials. Secrets go to the server and never come back.
 */
export function IntegrationsSection({ companyId }: { companyId: string }) {
  const base = `/companies/${companyId}`;
  const queryKey = ["companies", companyId, "integrations"];
  const { data: integrations = [] } = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      request<Integration[]>(`${base}/integrations`, {
        signal,
      }),
  });
  const [adding, setAdding] = useState<Integration | null>(null);
  const [settingClient, setSettingClient] = useState<Integration | null>(null);
  const [guiding, setGuiding] = useState<Integration | null>(null);
  const [signingIn, setSigningIn] = useState<Integration | null>(null);
  const add = useMutation({
    mutationFn: (input: { integrationId: string; form: FormData }) =>
      request(`${base}/integrations/${input.integrationId}/credentials`, {
        method: "POST",
        body: {
          label: input.form.get("label") ?? undefined,
          secret: String(input.form.get("secret")),
          address: input.form.get("address") ?? undefined,
          username: input.form.get("username") ?? undefined,
        },
      }),
    onSuccess: () => {
      setAdding(null);
      showToast("success", "Credential added");
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  // The provider returns to Shadow's callback after sign-in.
  const connect = useMutation({
    mutationFn: (input: { integration: Integration; address?: string }) =>
      request<{ url: string }>(
        `${base}/integrations/${input.integration.id}/connect`,
        { method: "POST", body: { address: input.address } }
      ),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  // The server's owner sets the OAuth client that Shadow signs in with; the next sign-in uses it.
  const setClient = useMutation({
    mutationFn: (input: { integration: Integration; form: FormData }) =>
      request(`/integrations/${input.integration.id}/client`, {
        method: "PUT",
        body: {
          clientId: String(input.form.get("clientId")),
          clientSecret: String(input.form.get("clientSecret")),
        },
      }),
    onSuccess: (_, { integration }) => {
      setSettingClient(null);
      showToast("success", `${integration.name} client saved`);
      return queryClient.invalidateQueries({
        predicate: ({ queryKey: key }) => key.includes("integrations"),
      });
    },
  });
  const watch = useMutation({
    mutationFn: (input: { credentialId: string; watched: boolean }) =>
      request(`${base}/credentials/${input.credentialId}`, {
        method: "PUT",
        body: { watched: input.watched },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const remove = useMutation({
    mutationFn: (credentialId: string) =>
      request(`${base}/credentials/${credentialId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      showToast("success", "Credential deleted");
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  return (
    <>
      {integrations.map((integration) => (
        <SettingsCard key={integration.id}>
          <SettingsRow
            description={
              integration.secretLabel === null
                ? accountCount(integration.credentials.length)
                : `${accountCount(integration.credentials.length)} · ${integration.secretLabel}`
            }
            label={integration.name}
          >
            {integration.client?.changeable ? (
              <Button
                icon="key"
                label="Client"
                onClick={() => setSettingClient(integration)}
                size="small"
              />
            ) : null}
            {integration.connect === "sign-in" && (
              <Button
                disabled={
                  connect.isPending || integration.client?.clientId === null
                }
                icon="link"
                label="Connect"
                onClick={() =>
                  integration.address
                    ? setSigningIn(integration)
                    : connect.mutate({ integration })
                }
                size="small"
              />
            )}
            {integration.connect === "secret" && (
              <Button
                icon="plus"
                label="Add credential"
                onClick={() => setAdding(integration)}
                size="small"
              />
            )}
            {integration.guide.length > 0 && (
              <Button
                icon="info"
                label={`Set up ${integration.name}`}
                onClick={() => setGuiding(integration)}
                size="icon"
                variant="ghost"
              />
            )}
          </SettingsRow>
          {integration.credentials.map((credential) => (
            <Fragment key={credential.id}>
              <SettingsRow
                compact
                label={credential.label}
                lead={<Icon name="key" />}
              >
                {credential.reconnect ? (
                  <Button
                    disabled={connect.isPending}
                    icon="link"
                    label="Connect again"
                    onClick={() =>
                      integration.address
                        ? setSigningIn(integration)
                        : connect.mutate({ integration })
                    }
                    size="small"
                  />
                ) : null}
                <Button
                  icon="trash"
                  label={`Delete ${credential.label}`}
                  onClick={() => remove.mutate(credential.id)}
                  size="icon"
                  variant="ghost"
                />
              </SettingsRow>
              {integration.watchable ? (
                <SettingsRow
                  compact
                  label="Read for me"
                  lead={<Icon name="check" />}
                >
                  <Switch
                    checked={
                      watch.isPending &&
                      watch.variables.credentialId === credential.id
                        ? watch.variables.watched
                        : credential.watched
                    }
                    label={`Read ${credential.label} for me`}
                    onChange={(checked) =>
                      watch.mutate({
                        credentialId: credential.id,
                        watched: checked,
                      })
                    }
                  />
                </SettingsRow>
              ) : null}
            </Fragment>
          ))}
        </SettingsCard>
      ))}
      <Dialog
        busy={add.isPending}
        onClose={() => setAdding(null)}
        onSubmit={(form) =>
          adding && add.mutate({ integrationId: adding.id, form })
        }
        open={adding !== null}
        submit="Add credential"
        title={`Add a ${adding?.name ?? ""} credential`}
      >
        {adding?.labeled !== false && (
          <TextField
            autoFocus
            label="Label"
            name="label"
            placeholder="Work account"
            required
          />
        )}
        {adding?.username ? (
          <TextField
            autoComplete="username"
            autoFocus
            label={adding.username}
            name="username"
            required
          />
        ) : null}
        {adding?.address === true && (
          <TextField
            autoComplete="off"
            label="Address"
            name="address"
            placeholder="http://my-mac:3774"
            required
            type="url"
          />
        )}
        <TextField
          autoComplete={adding?.username ? "current-password" : "off"}
          autoFocus={adding?.labeled === false && !adding.username}
          label={adding?.secretLabel ?? "Secret"}
          name="secret"
          required
          type="password"
        />
      </Dialog>
      <Dialog
        onClose={() => setGuiding(null)}
        open={guiding !== null}
        title={`Set up ${guiding?.name ?? ""}`}
      >
        <div className="prose">
          <ol className="guide">
            {guiding?.guide.map((step) => (
              <li key={step}>
                <ReactMarkdown
                  components={{
                    a: ({ href, children }) => (
                      <a href={href} rel="noopener" target="_blank">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {step}
                </ReactMarkdown>
              </li>
            ))}
          </ol>
        </div>
      </Dialog>
      <Dialog
        busy={setClient.isPending}
        onClose={() => setSettingClient(null)}
        onSubmit={(form) =>
          settingClient &&
          setClient.mutate({ integration: settingClient, form })
        }
        open={settingClient !== null}
        submit="Save"
        title={`${settingClient?.name ?? ""} OAuth client`}
      >
        <TextField
          autoComplete="off"
          autoFocus
          defaultValue={settingClient?.client?.clientId ?? ""}
          label="Client ID"
          name="clientId"
          required
        />
        <TextField
          autoComplete="off"
          label="Client secret"
          name="clientSecret"
          required
          type="password"
        />
      </Dialog>
      <Dialog
        busy={connect.isPending}
        onClose={() => setSigningIn(null)}
        onSubmit={(form) =>
          signingIn &&
          connect.mutate({
            integration: signingIn,
            address: String(form.get("server")),
          })
        }
        open={signingIn !== null}
        submit="Continue"
        title={`Connect ${signingIn?.name ?? ""}`}
      >
        <TextField
          autoComplete="off"
          autoFocus
          key="server"
          label="Address"
          name="server"
          placeholder="http://my-mac:3774"
          required
          type="url"
        />
      </Dialog>
    </>
  );
}

function accountCount(count: number): string {
  if (count === 0) {
    return "Not connected";
  }
  return count === 1 ? "1 account" : `${count} accounts`;
}
