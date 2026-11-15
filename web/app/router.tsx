import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { LoginPage } from "../accounts/login.tsx";
import { SuggestionCards, UpcomingPage } from "../agenda/page.tsx";
import { CompanyHome, Home, OrchestratorPage } from "../companies/pages.tsx";
import { CompanyLayout, SignedIn } from "../companies/shell.tsx";
import { FeedbackPage } from "../feedback/page.tsx";
import { FollowingPage } from "../intake/page.tsx";
import { InboxPage } from "../notifications/page.tsx";
import { ChannelDetails } from "../routines/details.tsx";
import { SearchPage } from "../search/page.tsx";
import { CompanySettingsPage, SettingsPage } from "../settings/pages.tsx";
import { ChannelPage, ThreadPage } from "../threads/pages.tsx";
import { TooltipProvider } from "../ui/components.tsx";
import { FilePreview } from "../ui/file-preview.tsx";
import { Toasts } from "../ui/toast.tsx";

/** A search parameter that is text, or nothing. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `?artifact=` opens an artifact in the side panel. */
const withArtifact = (
  search: Record<string, unknown>
): { artifact?: string } => ({
  artifact: text(search.artifact),
});

const root = createRootRoute({
  component: () => (
    <TooltipProvider>
      <Outlet />
      <FilePreview />
      <Toasts />
    </TooltipProvider>
  ),
});

const login = createRoute({
  getParentRoute: () => root,
  path: "/login",
  // A failed Google sign-in comes back with `error` and `error_description`.
  validateSearch: (search): { next?: string; error?: string } => ({
    next: text(search.next),
    error: text(search.error_description) ?? text(search.error),
  }),
  component: LoginPage,
});

const signedIn = createRoute({
  getParentRoute: () => root,
  id: "signed-in",
  component: SignedIn,
});

const home = createRoute({
  getParentRoute: () => signedIn,
  path: "/",
  component: Home,
});

const settings = createRoute({
  getParentRoute: () => signedIn,
  path: "/settings",
  component: SettingsPage,
});

const company = createRoute({
  getParentRoute: () => signedIn,
  path: "/c/$companyId",
  component: CompanyLayout,
});

const companyHome = createRoute({
  getParentRoute: () => company,
  path: "/",
  component: CompanyHome,
});

const orchestrator = createRoute({
  getParentRoute: () => company,
  path: "/orchestrator",
  validateSearch: withArtifact,
  component: OrchestratorPage,
});

const channel = createRoute({
  getParentRoute: () => company,
  path: "/channel/$channelId",
  validateSearch: withArtifact,
  // The channel's details come from the routines module, which comes after threads.
  component: () => <ChannelPage details={<ChannelDetails />} />,
});

const thread = createRoute({
  getParentRoute: () => company,
  path: "/thread/$threadId",
  validateSearch: withArtifact,
  // The suggestions over the orchestrator's composer come from the agenda module, which comes after threads.
  component: () => <ThreadPage orchestratorCards={<SuggestionCards />} />,
});

const inbox = createRoute({
  getParentRoute: () => company,
  path: "/inbox",
  component: InboxPage,
});

const upcoming = createRoute({
  getParentRoute: () => company,
  path: "/upcoming",
  component: UpcomingPage,
});

const following = createRoute({
  getParentRoute: () => company,
  path: "/following",
  component: FollowingPage,
});

const feedback = createRoute({
  getParentRoute: () => company,
  path: "/feedback",
  component: FeedbackPage,
});

const searchRoute = createRoute({
  getParentRoute: () => company,
  path: "/search",
  validateSearch: (values): { q?: string } => ({ q: text(values.q) }),
  component: SearchPage,
});

const companySettings = createRoute({
  getParentRoute: () => company,
  path: "/settings",
  component: CompanySettingsPage,
});

export const router = createRouter({
  routeTree: root.addChildren([
    login,
    signedIn.addChildren([
      home,
      settings,
      company.addChildren([
        companyHome,
        orchestrator,
        channel,
        thread,
        inbox,
        upcoming,
        following,
        feedback,
        searchRoute,
        companySettings,
      ]),
    ]),
  ]),
  defaultPreload: "intent",
  defaultNotFoundComponent: () => (
    <div className="empty">
      <strong>Not found</strong>
    </div>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
