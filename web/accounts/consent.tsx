import { useEffect, useState } from "react";
import { Button, Mark } from "../ui/components.tsx";
import { showToast } from "../ui/toast.tsx";
import { oauthQuery } from "./login.tsx";

/**
 * Where the person allows their own agent, such as Claude Code, to use Shadow as them. better-auth's OAuth provider
 * sends them here with a signed query, which the answer sends back.
 */
export function ConsentPage() {
  const query = oauthQuery("/consent") ?? location.search.slice(1);
  const clientId = new URLSearchParams(query).get("client_id") ?? "";
  const [client, setClient] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(
      `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`
    )
      .then(async (response) => {
        if (response.status === 401) {
          // Signed out since the request started: the sign-in continues it.
          location.assign(`/login?${query}`);
          return;
        }
        const body = (await response.json()) as { client_name?: string };
        setClient(body.client_name || "An agent");
      })
      .catch(() => setClient("An agent"));
  }, [clientId, query]);
  const answer = async (accept: boolean) => {
    setBusy(true);
    const response = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept, oauth_query: query }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as {
      url?: string;
    } | null;
    if (body?.url) {
      location.assign(body.url);
      return;
    }
    setBusy(false);
    showToast("error", "That did not work. Start the sign-in again.");
  };
  return (
    <main className="auth">
      <form
        aria-busy={busy || client === null || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          answer(true);
        }}
      >
        <div className="mark">
          <Mark size="large" />
          <h1>{client ?? "An agent"} wants to use Shadow as you</h1>
        </div>
        <Button
          autoFocus
          label="Allow"
          size="large"
          type="submit"
          variant="primary"
        />
        <Button label="Cancel" onClick={() => answer(false)} size="large" />
      </form>
    </main>
  );
}
