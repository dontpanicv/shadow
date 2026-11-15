import { getRouteApi } from "@tanstack/react-router";
import { type SubmitEvent, useEffect, useState } from "react";
import { markSignedOut } from "../app/api.ts";
import { clearCache } from "../app/query.ts";
import { Button, Mark } from "../ui/components.tsx";
import { showToast } from "../ui/toast.tsx";

const route = getRouteApi("/login");

/** Sign-in with Google, the only way in. `next` is the page to open after it, such as a members artifact. */
export function LoginPage() {
  const { next, error } = route.useSearch();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (error) {
      showToast("error", error);
    }
  }, [error]);
  const signIn = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const response = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: localPath(next) ?? "/",
        // After Google, better-auth goes on with an agent's OAuth sign-in, to the consent page.
        ...(oauthQuery("/login") ? { oauth_query: oauthQuery("/login") } : {}),
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      url?: string;
      message?: string;
    } | null;
    if (response.ok && body?.url) {
      // Another person may sign in here, so the saved copy and the outbox wait until Shadow says who it is.
      markSignedOut();
      location.assign(body.url);
      return;
    }
    setBusy(false);
    showToast("error", body?.message ?? "Sign-in failed. Try again.");
  };
  return (
    <main className="auth">
      <form aria-busy={busy || undefined} onSubmit={signIn}>
        <div className="mark">
          <Mark size="large" />
          <h1>Sign in to Shadow</h1>
        </div>
        <Button
          autoFocus
          label="Continue with Google"
          size="large"
          type="submit"
          variant="primary"
        />
      </form>
    </main>
  );
}

/** The address the server sent the page for, before the router reads it and writes it again. */
const loaded = {
  // Tests load the module without a page.
  path: globalThis.location?.pathname,
  search: globalThis.location?.search.slice(1) ?? "",
};

/** The signed query of an agent's OAuth sign-in that opened `path`, which better-auth checks. */
export function oauthQuery(path: string): string | undefined {
  return loaded.path === path && new URLSearchParams(loaded.search).has("sig")
    ? loaded.search
    : undefined;
}

/** Signs out on this device and forgets what the app saved. When Shadow does not confirm it, the page stays. */
export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => null);
  if (!response?.ok) {
    showToast("error", "Sign-out failed. Try again.");
    return;
  }
  await clearCache();
  location.assign("/login");
}

/**
 * A path on this site, or null, so that a link or a sign-in never sends anyone to another site. The browser's URL
 * parser decides: it drops tabs and line breaks, and reads `\` as `/`, so `//host` and `/\host` are other sites.
 */
export function localPath(path: string | undefined): string | null {
  return path?.startsWith("/") &&
    new URL(path, "http://shadow.invalid").host === "shadow.invalid"
    ? path
    : null;
}
