import { isNull, not, useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import {
  getRouteApi,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { ConnectAgentButton } from "../accounts/connect-agent.tsx";
import { request } from "../app/api.ts";
import type { Channel, ThreadSummary } from "../app/types.ts";
import {
  Button,
  Dialog,
  TextField,
  WorkingContext,
  WorkingSpinner,
} from "../ui/components.tsx";
import { Icon, type IconName } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import {
  channelsOf,
  inboxQuery,
  involvedQuery,
  meQuery,
  openChannels,
  orchestratorQuery,
  refreshCompany,
  refreshInbox,
  rememberOpenChannels,
  setPinned,
  setSettled,
  threadsOf,
  useMe,
} from "./data.ts";

/** The signed-in pages show once the person and their companies are known; a signed-out person goes to sign in. */
export function SignedIn() {
  return useQuery(meQuery).data ? <Outlet /> : null;
}

const companyRoute = getRouteApi("/signed-in/c/$companyId");

/** A company's pages, in the shell. Someone who is not a member sees not found. */
export function CompanyLayout() {
  const { companyId } = companyRoute.useParams();
  const member = useMe().companies.some((company) => company.id === companyId);
  if (!member) {
    return (
      <div className="empty">
        <strong>Not found</strong>
      </div>
    );
  }
  return (
    <Shell companyId={companyId}>
      <Outlet />
    </Shell>
  );
}

const SidebarContext = createContext<() => void>(() => undefined);

/** The app: the company and its channels with their threads on the left, the page in the inset panel. */
export function Shell({
  companyId,
  children,
}: {
  companyId: string | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const working = useWorking(companyId);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // On narrow screens the sidebar closes when a page opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs when the page changes
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    // `/` opens search, outside text fields.
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !companyId ||
        target?.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      event.preventDefault();
      navigate({ to: "/c/$companyId/search", params: { companyId } });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [companyId, navigate]);
  return (
    <WorkingContext value={working}>
      <SidebarContext value={() => setOpen((value) => !value)}>
        <div className="app">
          <aside className={open ? "sidebar is-open" : "sidebar"}>
            <Sidebar companyId={companyId} />
          </aside>
          <main className="panel">{children}</main>
        </div>
      </SidebarContext>
    </WorkingContext>
  );
}

/** The panel's header bar, with the menu button on narrow screens. */
export function PanelHeader({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="panel-header">
      <span className="only-narrow">
        <SidebarButton />
      </span>
      <h1 className="title">{title}</h1>
      {children}
    </header>
  );
}

/** Settings-style pages have a page title instead of a header bar, and the menu button floats. */
export function FloatingSidebarButton() {
  return (
    <span className="only-narrow floating-menu">
      <SidebarButton />
    </span>
  );
}

function SidebarButton() {
  return (
    <Button
      icon="sidebar"
      label="Menu"
      onClick={useContext(SidebarContext)}
      size="icon"
      variant="ghost"
    />
  );
}

/**
 * The threads whose agent works, from the company's working stream. Agents start threads and channels as they work,
 * so the channels and threads load again whenever work starts or ends.
 */
function useWorking(companyId: string | undefined): ReadonlySet<string> {
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!companyId) {
      return;
    }
    const source = new EventSource(`/api/v1/companies/${companyId}/working`);
    source.addEventListener("working", (event) => {
      const { threadIds } = JSON.parse(event.data) as { threadIds: string[] };
      setWorking(new Set(threadIds));
      refreshCompany(companyId);
      // A run that ends notifies a moment later.
      setTimeout(() => refreshInbox(companyId), 1000);
    });
    return () => {
      source.close();
      setWorking(new Set());
    };
  }, [companyId]);
  return working;
}

function Sidebar({ companyId }: { companyId: string | undefined }) {
  const me = useMe();
  const company = me.companies.find((candidate) => candidate.id === companyId);
  const [dialog, setDialog] = useState<"channel" | null>(null);
  return (
    <div className="sidebar-content">
      {company ? (
        <CompanyNav
          companyId={company.id}
          onNewChannel={() => setDialog("channel")}
        />
      ) : (
        <div className="sidebar-channels" />
      )}
      <nav className="nav sidebar-footer">
        <ConnectAgentButton />
        {company?.role === "admin" ? (
          <Link
            activeOptions={{ exact: true }}
            className="nav-item"
            params={{ companyId: company.id }}
            to="/c/$companyId/settings"
          >
            <NavContent icon="members" label="Company settings" />
          </Link>
        ) : null}
        <Link className="nav-item" to="/settings">
          <NavContent icon="settings" label="Settings" />
        </Link>
      </nav>
      {company ? (
        <NewChannelDialog
          companyId={company.id}
          onClose={() => setDialog(null)}
          open={dialog === "channel"}
        />
      ) : null}
    </div>
  );
}

/**
 * The company's orchestrator, inbox, upcoming, and search; its channels with their active threads, which fold, pinned
 * ones first and then by name; the other channels, folded; and the settled threads.
 */
function CompanyNav({
  companyId,
  onNewChannel,
}: {
  companyId: string;
  onNewChannel: () => void;
}) {
  const { admin } = useMe();
  const orchestrator = useQuery(orchestratorQuery(companyId)).data;
  const unread = useQuery(inboxQuery(companyId)).data?.unread;
  const { pathname } = useLocation();
  // An open thread reads its notifications.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs when the page changes
  useEffect(() => {
    refreshInbox(companyId);
  }, [companyId, pathname]);
  const { data: channels = [] } = useLiveQuery({
    query: (q) => q.from({ channel: channelsOf(companyId) }),
  });
  const involved = new Set(useQuery(involvedQuery(companyId)).data?.channelIds);
  const { data: active = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ thread: threadsOf(companyId) })
        .where(({ thread }) => isNull(thread.settledAt))
        .orderBy(({ thread }) => thread.updatedAt, "desc"),
  });
  const { data: settled = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ thread: threadsOf(companyId) })
        .where(({ thread }) => not(isNull(thread.settledAt)))
        .orderBy(({ thread }) => thread.settledAt, "desc"),
  });
  const [opened, setOpened] = useState(openChannels);
  const toggleOpen = (channelId: string) => {
    const next = opened.includes(channelId)
      ? opened.filter((id) => id !== channelId)
      : [...opened, channelId];
    setOpened(next);
    rememberOpenChannels(next);
  };
  const openThreadId = pathname.match(/\/thread\/([^/]+)/)?.[1];
  // The person's own channel comes first, as a DM to oneself does in Slack; then pinned ones, then by name.
  const sorted = channels.toSorted(
    (a, b) =>
      Number(b.personal) - Number(a.personal) ||
      Number(b.pinned) - Number(a.pinned) ||
      a.name.localeCompare(b.name)
  );
  const shared = sorted.filter((channel) => channel.ownerId === null);
  // A Slack channel is the person's when they pinned it, wrote or were mentioned there, or it has a thread.
  const theirs = (channel: (typeof channels)[number]) =>
    channel.pinned ||
    channel.slackId === null ||
    involved.has(channel.id) ||
    active.some((thread) => thread.channelId === channel.id);
  const others = shared.filter((channel) => !theirs(channel));
  const channelItem = (
    channel: Omit<Channel, "threads"> & { readonly pinned: boolean }
  ) => {
    const threads = active.filter((thread) => thread.channelId === channel.id);
    // The open thread stays in view, so its channel cannot fold.
    const holdsOpenThread = threads.some(
      (thread) => thread.id === openThreadId
    );
    const open = holdsOpenThread || opened.includes(channel.id);
    return (
      <div key={channel.id}>
        <div className="sidebar-channel">
          <Link
            activeOptions={{ exact: true, includeSearch: false }}
            className="nav-item"
            params={{ companyId, channelId: channel.id }}
            to="/c/$companyId/channel/$channelId"
          >
            <NavContent
              emoji={channel.icon}
              icon="hash"
              label={channel.name}
              locked={channel.ownerId !== null}
            />
          </Link>
          <span className="channel-actions">
            <span className="pin-action">
              <Button
                aria-pressed={channel.pinned}
                icon="pin"
                label={channel.pinned ? "Unpin channel" : "Pin channel"}
                onClick={() =>
                  setPinned(companyId, channel.id, !channel.pinned)
                }
                size="tiny"
                variant="ghost"
              />
            </span>
            {threads.length > 0 && !holdsOpenThread ? (
              <span className="fold-action">
                <Button
                  aria-expanded={open}
                  icon="disclosure"
                  label={open ? "Fold threads" : "Unfold threads"}
                  onClick={() => toggleOpen(channel.id)}
                  size="tiny"
                  variant="ghost"
                />
              </span>
            ) : null}
          </span>
        </div>
        {open ? (
          <div className="nav-threads">
            {threads.map((thread) => (
              <ThreadNav
                companyId={companyId}
                key={thread.id}
                thread={thread}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <>
      <div className="sidebar-channels">
        <nav className="nav">
          {orchestrator ? (
            <Link
              className="nav-item"
              params={{ companyId, threadId: orchestrator.id }}
              to="/c/$companyId/thread/$threadId"
            >
              <NavContent
                icon="shadow"
                label="Shadow"
                threadId={orchestrator.id}
              />
            </Link>
          ) : null}
          <Link
            className="nav-item"
            params={{ companyId }}
            to="/c/$companyId/inbox"
          >
            <NavContent count={unread} icon="bell" label="Inbox" />
          </Link>
          <Link
            className="nav-item"
            params={{ companyId }}
            to="/c/$companyId/upcoming"
          >
            <NavContent icon="clock" label="Upcoming" />
          </Link>
          <Link
            className="nav-item"
            params={{ companyId }}
            to="/c/$companyId/following"
          >
            <NavContent icon="eye" label="Following" />
          </Link>
          <Link
            className="nav-item"
            params={{ companyId }}
            to="/c/$companyId/search"
          >
            <NavContent icon="search" label="Search" />
          </Link>
        </nav>
        <nav aria-label="Channels" className="nav">
          <div className="nav-section">Channels</div>
          {shared.filter(theirs).map(channelItem)}
          {others.length > 0 ? (
            <details className="sidebar-others">
              <summary className="nav-section">
                Other channels ({others.length})
                <span className="disclosure">
                  <Icon name="disclosure" />
                </span>
              </summary>
              {others.map(channelItem)}
            </details>
          ) : null}
        </nav>
        <nav aria-label="Private channels" className="nav">
          <div className="nav-section">
            Private
            <Button
              icon="plus"
              label="New private channel"
              onClick={onNewChannel}
              size="tiny"
              variant="ghost"
            />
          </div>
          {sorted
            .filter((channel) => channel.ownerId !== null)
            .map(channelItem)}
          <Link
            className="nav-item"
            params={{ companyId }}
            to="/c/$companyId/ambient"
          >
            <NavContent icon="hand" label="Ambient" />
          </Link>
          {admin ? (
            <Link
              className="nav-item"
              params={{ companyId }}
              to="/c/$companyId/feedback"
            >
              <NavContent icon="info" label="Feedback" />
            </Link>
          ) : null}
        </nav>
      </div>
      {settled.length > 0 ? (
        <details className="sidebar-settled">
          <summary className="nav-section">
            Settled ({settled.length})
            <span className="disclosure">
              <Icon name="disclosure" />
            </span>
          </summary>
          <nav aria-label="Settled threads" className="settled-list">
            {settled.map((thread) => (
              <ThreadNav
                companyId={companyId}
                key={thread.id}
                thread={thread}
              />
            ))}
          </nav>
        </details>
      ) : null}
    </>
  );
}

function ThreadNav({
  companyId,
  thread,
}: {
  companyId: string;
  thread: ThreadSummary;
}) {
  const settled = thread.settledAt !== null;
  return (
    <div className="sidebar-thread">
      <Link
        className="nav-item"
        params={{ companyId, threadId: thread.id }}
        to="/c/$companyId/thread/$threadId"
      >
        <NavContent icon="compose" label={thread.title} threadId={thread.id} />
      </Link>
      <span className="settle-action">
        <Button
          icon={settled ? "inbox" : "check"}
          label={settled ? "Un-settle thread" : "Settle thread"}
          onClick={() => setSettled(companyId, thread.id, !settled)}
          size="tiny"
          variant="ghost"
        />
      </span>
    </div>
  );
}

export function NavContent({
  icon,
  emoji,
  label,
  threadId,
  count,
  locked = false,
}: {
  icon: IconName;
  /** Shows in place of the icon when set. */
  emoji?: string | null;
  label: string;
  /** A private channel, which only its person sees. */
  locked?: boolean;
  /** A thread whose spinner shows while its agent works. */
  threadId?: string;
  /** Shows when it is more than 0. */
  count?: number;
}) {
  return (
    <>
      {emoji ? (
        <span aria-hidden className="emoji">
          {emoji}
        </span>
      ) : (
        <Icon name={icon} />
      )}
      <span className="label">{label}</span>
      {locked ? (
        <span className="lock" title="Private">
          <Icon name="lock" />
        </span>
      ) : null}
      {threadId ? <WorkingSpinner threadId={threadId} /> : null}
      {count ? <span className="count">{count}</span> : null}
    </>
  );
}

function NewChannelDialog({
  companyId,
  open,
  onClose,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      busy={busy}
      onClose={onClose}
      onSubmit={async (form) => {
        setBusy(true);
        try {
          const channel = await request<{ id: string }>(
            `/companies/${companyId}/channels`,
            {
              method: "POST",
              body: { name: String(form.get("name")) },
            }
          );
          await refreshCompany(companyId);
          onClose();
          navigate({
            to: "/c/$companyId/channel/$channelId",
            params: { companyId, channelId: channel.id },
          });
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }}
      open={open}
      submit="Create channel"
      title="New private channel"
    >
      <TextField
        autoFocus
        label="Name"
        name="name"
        placeholder="research"
        required
      />
    </Dialog>
  );
}
