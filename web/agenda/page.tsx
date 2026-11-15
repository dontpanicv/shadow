import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";
import type { Reminder, Routine, Suggestion } from "../app/types.ts";
import { channelsOf } from "../companies/data.ts";
import { PanelHeader } from "../companies/shell.tsx";
import {
  Badge,
  Button,
  DayStrip,
  Empty,
  PageSection,
  SettingsCard,
  SettingsRow,
  Switch,
} from "../ui/components.tsx";
import {
  clockTime,
  placeWindow,
  placeWords,
  weekdayTime,
} from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import {
  type AgendaItem,
  agendaGroups,
  itemId,
  scheduleWords,
  upcomingQuery,
  useAnswerSuggestion,
  useCancelReminder,
  useRoutineEnabled,
} from "./data.ts";

const companyRoute = getRouteApi("/signed-in/c/$companyId");

/** The names of the company's channels, which routine rows show. */
const ChannelNames = createContext<ReadonlyMap<string, string>>(new Map());

/** What Shadow runs for the person and what waits for them, in groups from what needs them to what is paused. */
export function UpcomingPage() {
  const { companyId } = companyRoute.useParams();
  const { data: upcoming } = useQuery(upcomingQuery(companyId));
  const groups = upcoming ? agendaGroups(upcoming, Date.now()) : [];
  const { data: channels = [] } = useLiveQuery({
    query: (q) => q.from({ channel: channelsOf(companyId) }),
  });
  return (
    <section className="conversation">
      <PanelHeader title="Upcoming" />
      <ChannelNames
        value={new Map(channels.map((channel) => [channel.id, channel.name]))}
      >
        <div className="page">
          <div className="page-content">
            {upcoming && groups.length === 0 ? (
              <Empty title="Nothing upcoming" />
            ) : null}
            {groups.map((group) => (
              <PageSection key={group.title} title={group.title}>
                <SettingsCard>
                  {group.items.map((item) => (
                    <AgendaRow
                      companyId={companyId}
                      item={item}
                      key={`${item.kind}:${itemId(item)}`}
                      soon={
                        group.title === "Today" || group.title === "Tomorrow"
                      }
                    />
                  ))}
                </SettingsCard>
              </PageSection>
            ))}
          </div>
        </div>
      </ChannelNames>
    </section>
  );
}

/** The suggestions that wait for the person, above the composer of their Shadow. */
export function SuggestionCards() {
  const { companyId } = companyRoute.useParams();
  const suggestions =
    useQuery(upcomingQuery(companyId)).data?.suggestions ?? [];
  return suggestions.map((suggestion) => (
    <section aria-label="Suggestion" className="suggestion" key={suggestion.id}>
      <Icon name={suggestion.kind === "routine" ? "play" : "clock"} />
      <div className="settings-text">
        <strong>{suggestion.name}</strong>
        <span>{suggestionWhen(suggestion)}</span>
      </div>
      <SuggestionActions companyId={companyId} suggestion={suggestion} />
    </section>
  ));
}

function AgendaRow({
  companyId,
  item,
  soon,
}: {
  companyId: string;
  item: AgendaItem;
  /** Today and Tomorrow show only the time. */
  soon: boolean;
}) {
  const when = (at: number) => (soon ? clockTime(at) : weekdayTime(at));
  switch (item.kind) {
    case "approval":
      return (
        <SettingsRow
          compact
          label={item.approval.text}
          lead={<Icon name="key" />}
        >
          <OpenThread companyId={companyId} threadId={item.threadId} />
        </SettingsRow>
      );
    case "failed":
      return (
        <RoutineRow
          companyId={companyId}
          routine={item.routine}
          when={item.routine.lastRun?.error ?? undefined}
        >
          <Badge label="Failed" tone="danger" />
        </RoutineRow>
      );
    case "suggestion":
      return (
        <SettingsRow
          compact
          description={suggestionWhen(item.suggestion)}
          label={item.suggestion.name}
          lead={
            <Icon
              name={item.suggestion.kind === "routine" ? "play" : "clock"}
            />
          }
        >
          {item.suggestion.at === null ? null : (
            <DayStrip at={item.suggestion.at} />
          )}
          <SuggestionActions
            companyId={companyId}
            suggestion={item.suggestion}
          />
        </SettingsRow>
      );
    case "reminder":
      return (
        <ReminderRow
          companyId={companyId}
          reminder={item.reminder}
          when={
            item.reminder.place && item.reminder.triggeredAt === null
              ? placeWindow(
                  item.reminder.place,
                  item.reminder.notBefore,
                  item.reminder.notAfter
                )
              : when(item.reminder.dueAt)
          }
        />
      );
    default:
      return (
        <RoutineRow
          companyId={companyId}
          routine={item.routine}
          when={
            item.routine.nextRunAt === null
              ? undefined
              : when(item.routine.nextRunAt)
          }
        />
      );
  }
}

/** A routine: its time and channel, a switch that pauses it, and its thread. */
function RoutineRow({
  companyId,
  routine,
  when,
  children,
}: {
  companyId: string;
  routine: Routine;
  when?: string;
  children?: ReactNode;
}) {
  const channel = useContext(ChannelNames).get(routine.channelId);
  const enabled = useRoutineEnabled(companyId);
  return (
    <SettingsRow
      compact
      description={[
        when ??
          (routine.place
            ? placeWords(routine.place)
            : scheduleWords(routine.schedule ?? "")),
        channel && `#${channel}`,
      ]
        .filter(Boolean)
        .join(" · ")}
      label={routine.name}
      lead={<Icon name={routine.place ? "place" : "play"} />}
    >
      {routine.nextRunAt === null ? null : <DayStrip at={routine.nextRunAt} />}
      {children}
      <Switch
        checked={
          enabled.isPending ? enabled.variables.enabled : routine.enabled
        }
        label={`Run ${routine.name}`}
        onChange={(checked) =>
          enabled.mutate({ id: routine.id, enabled: checked })
        }
      />
      {routine.threadId ? (
        <OpenThread companyId={companyId} threadId={routine.threadId} />
      ) : null}
    </SettingsRow>
  );
}

function ReminderRow({
  companyId,
  reminder,
  when,
}: {
  companyId: string;
  reminder: Reminder;
  when: string;
}) {
  const cancel = useCancelReminder(companyId);
  return (
    <SettingsRow
      compact
      description={when}
      label={reminder.text}
      lead={<Icon name={reminder.place ? "place" : "clock"} />}
    >
      {reminder.place && reminder.triggeredAt === null ? null : (
        <DayStrip at={reminder.dueAt} />
      )}
      <Button
        disabled={cancel.isPending}
        label="Cancel"
        onClick={() => cancel.mutate(reminder.id)}
        size="small"
      />
    </SettingsRow>
  );
}

function OpenThread({
  companyId,
  threadId,
}: {
  companyId: string;
  threadId: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      icon="forward"
      label="Open thread"
      onClick={() =>
        navigate({
          to: "/c/$companyId/thread/$threadId",
          params: { companyId, threadId },
        })
      }
      size="icon"
      variant="ghost"
    />
  );
}

function SuggestionActions({
  companyId,
  suggestion,
}: {
  companyId: string;
  suggestion: Suggestion;
}) {
  const answer = useAnswerSuggestion(companyId);
  return (
    <>
      <Button
        disabled={answer.isPending}
        label="Decline"
        onClick={() => answer.mutate({ id: suggestion.id, accept: false })}
        size="small"
      />
      <Button
        disabled={answer.isPending}
        label="Accept"
        onClick={() => answer.mutate({ id: suggestion.id, accept: true })}
        size="small"
        variant="primary"
      />
    </>
  );
}

/** A routine's schedule and its first run, or a reminder's time. */
function suggestionWhen(suggestion: Suggestion): string {
  const at = suggestion.at === null ? null : weekdayTime(suggestion.at);
  if (suggestion.schedule === null) {
    return at ?? "";
  }
  const schedule = scheduleWords(suggestion.schedule);
  return at ? `${schedule} · First ${at}` : schedule;
}
