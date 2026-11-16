import type { Database } from "bun:sqlite";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { Companies } from "../companies/companies.ts";
import type { User } from "../platform/auth.ts";
import { HttpError } from "../platform/errors.ts";

/** The addresses of the company's VictoriaLogs and VictoriaMetrics; `""` when an admin did not set one. */
export interface ObservabilitySettings {
  readonly logsUrl: string;
  readonly metricsUrl: string;
}

/** The longest that one query may take. */
const QUERY_MS = 60_000;
const LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 1000;
const HOUR_MS = 60 * 60_000;

/**
 * The company's VictoriaLogs and VictoriaMetrics, which every agent of the company queries. An admin sets their
 * addresses in Company settings; they need no credentials, as they are on the company's network, such as its VPN.
 * The queries use a plain `fetch` and not `Egress`, because an admin chose the address, often a private one, and the
 * agent chooses only the query.
 *
 * @example
 * const observability = new Observability(database, companies);
 * observability.setSettings(companyId, admin, { logsUrl: "https://vl.example.com", metricsUrl: "" });
 * const tools = observability.tools(companyId);
 */
export class Observability {
  constructor(
    private readonly database: Database,
    private readonly companies: Pick<Companies, "requireAdmin">,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch
  ) {}

  /** The addresses, for an admin. */
  settings(companyId: string, user: User): ObservabilitySettings {
    this.companies.requireAdmin(companyId, user);
    return this.settingsOf(companyId);
  }

  /** Replaces both addresses; an empty one switches its tool off. Only an admin sets them. */
  setSettings(
    companyId: string,
    user: User,
    input: { logsUrl?: unknown; metricsUrl?: unknown }
  ): ObservabilitySettings {
    this.companies.requireAdmin(companyId, user);
    const settings = {
      logsUrl: address(input.logsUrl, "VictoriaLogs"),
      metricsUrl: address(input.metricsUrl, "VictoriaMetrics"),
    };
    this.database
      .query(
        "INSERT INTO observability (company_id, logs_url, metrics_url, changed_by, changed_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (company_id) DO UPDATE SET logs_url = ?2, metrics_url = ?3, changed_by = ?4, changed_at = ?5"
      )
      .run(
        companyId,
        settings.logsUrl,
        settings.metricsUrl,
        user.id,
        Date.now()
      );
    return settings;
  }

  /** The query tools; each reads the address at call time, so a change in settings needs no reload. */
  tools(companyId: string) {
    return [
      defineTool({
        name: "observability_logs",
        description:
          'Query the company\'s VictoriaLogs with LogsQL, such as `kubernetes.pod_namespace:"bp-instance-acme" AND level:error`, or with pipes such as `error | stats by (kubernetes.container_name) count()`. Always narrow by namespace, service, or level. Returns a JSON list of log entries, each with _time, _msg, and its fields; an empty list means no matching logs. Summarize patterns and counts with a few representative lines; never paste a large dump.',
        parameters: Type.Object({
          query: Type.String({ description: "The LogsQL query" }),
          start: Type.Optional(
            Type.String({
              description:
                "The start, as RFC3339 or Unix seconds; one hour ago when not given",
            })
          ),
          end: Type.Optional(
            Type.String({
              description:
                "The end, as RFC3339 or Unix seconds; now when not given",
            })
          ),
          limit: Type.Optional(
            Type.Number({
              description: `The most entries, newest first; ${LOG_LIMIT} when not given, at most ${MAX_LOG_LIMIT}`,
            })
          ),
        }),
        replay: "safe",
        execute: async (args, _api, context) => {
          const body = new URLSearchParams({
            query: args.query,
            start: args.start ?? new Date(Date.now() - HOUR_MS).toISOString(),
            limit: String(
              Math.min(Math.max(1, args.limit ?? LOG_LIMIT), MAX_LOG_LIMIT)
            ),
            ...(args.end ? { end: args.end } : {}),
          });
          const text = await this.query(
            companyId,
            "logsUrl",
            "/select/logsql/query",
            { method: "POST", body },
            context.abortSignal
          );
          const entries = text
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line));
          return json(entries);
        },
      }),
      defineTool({
        name: "observability_metrics",
        description:
          'Query the company\'s VictoriaMetrics with PromQL or MetricsQL, such as `sum(rate(pipes_collect_events_received_total{namespace="bp-instance-acme"}[5m]))`. Keep a namespace, job, or instance selector in every query, and bound discovery with topk, such as `topk(20, count by (__name__)({namespace="bp-instance-acme"}))`. Without start it is an instant query at time; with start it is a range query from start to end by step. Returns the JSON data of the Prometheus query API: resultType and result. An empty result is missing data, not zero. Use increase for counter totals and rate for counter throughput.',
        parameters: Type.Object({
          query: Type.String({ description: "The PromQL or MetricsQL query" }),
          time: Type.Optional(
            Type.String({
              description:
                "An instant query's time, as RFC3339 or Unix seconds; now when not given",
            })
          ),
          start: Type.Optional(
            Type.String({
              description:
                "A range query's start, as RFC3339 or Unix seconds; makes the query a range query",
            })
          ),
          end: Type.Optional(
            Type.String({
              description: "A range query's end; now when not given",
            })
          ),
          step: Type.Optional(
            Type.String({
              description:
                "A range query's step between points, such as 1m or 1h; keep the points few",
            })
          ),
        }),
        replay: "safe",
        execute: async (args, _api, context) => {
          const range = args.start !== undefined;
          const given = range
            ? { start: args.start, end: args.end, step: args.step }
            : { time: args.time };
          const params = new URLSearchParams({ query: args.query });
          for (const [key, value] of Object.entries(given)) {
            if (value) {
              params.set(key, value);
            }
          }
          const text = await this.query(
            companyId,
            "metricsUrl",
            `/api/v1/${range ? "query_range" : "query"}?${params}`,
            {},
            context.abortSignal
          );
          const answer = JSON.parse(text) as {
            status: string;
            data?: unknown;
            error?: string;
          };
          if (answer.status !== "success") {
            throw new Error(
              `VictoriaMetrics refused the query: ${answer.error}`
            );
          }
          return json(answer.data);
        },
      }),
    ];
  }

  private settingsOf(companyId: string): ObservabilitySettings {
    const row = this.database
      .query(
        "SELECT logs_url, metrics_url FROM observability WHERE company_id = ?"
      )
      .get(companyId) as { logs_url: string; metrics_url: string } | null;
    return { logsUrl: row?.logs_url ?? "", metricsUrl: row?.metrics_url ?? "" };
  }

  /** The text of a request to the store that `key` names; an error names the store's own reason. */
  private async query(
    companyId: string,
    key: keyof ObservabilitySettings,
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined
  ): Promise<string> {
    const name = key === "logsUrl" ? "VictoriaLogs" : "VictoriaMetrics";
    const base = this.settingsOf(companyId)[key];
    if (!base) {
      throw new Error(
        `This company has no ${name}. An admin sets its address in Company settings › Observability.`
      );
    }
    const response = await this.fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.any([
        AbortSignal.timeout(QUERY_MS),
        ...(signal ? [signal] : []),
      ]),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${name} answered ${response.status}: ${text.slice(0, 1000)}`
      );
    }
    return text;
  }
}

/** An http or https address without its trailing slash, or `""`. */
function address(value: unknown, name: string): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const url = typeof value === "string" ? URL.parse(value.trim()) : null;
  if (!(url && (url.protocol === "http:" || url.protocol === "https:"))) {
    throw new HttpError(
      400,
      `Enter the ${name} address as an http or https URL`
    );
  }
  return url.href.replace(/\/+$/, "");
}

function json(value: unknown): ToolExecutionResult {
  return { output: [{ type: "text", text: JSON.stringify(value) }] };
}
