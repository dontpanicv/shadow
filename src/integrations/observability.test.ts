import { expect, test } from "bun:test";
import { authDatabase } from "../../test/database.ts";
import type { User } from "../platform/auth.ts";
import { migrate } from "../platform/database.ts";
import { HttpError } from "../platform/errors.ts";
import { Observability } from "./observability.ts";

const admin = { id: "admin" } as User;
const member = { id: "member" } as User;
const companies = {
  requireAdmin: (_companyId: string, user: User) => {
    if (user.id !== "admin") {
      throw new HttpError(403, "Only an admin can do this");
    }
    return {} as never;
  },
};

function setup(answer: (url: string, init?: RequestInit) => Response) {
  const database = authDatabase();
  migrate(database);
  const requests: { url: string; body: string }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: String(init?.body ?? "") });
    return answer(url, init);
  }) as typeof globalThis.fetch;
  return {
    observability: new Observability(database, companies, fetch),
    requests,
  };
}

async function call(
  observability: Observability,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = observability.tools("c1").find((each) => each.name === name)!;
  const result = await tool.execute(
    args as never,
    {} as never,
    { abortSignal: new AbortController().signal } as never
  );
  return JSON.parse((result.output![0] as { text: string }).text);
}

test("only an admin sets the addresses, which must be http or https", () => {
  const { observability } = setup(() => new Response());
  expect(() => observability.settings("c1", member)).toThrow(HttpError);
  expect(() =>
    observability.setSettings("c1", admin, { logsUrl: "ftp://vl" })
  ).toThrow(HttpError);
  expect(
    observability.setSettings("c1", admin, {
      logsUrl: " https://vl.example.com/ ",
      metricsUrl: "",
    })
  ).toEqual({ logsUrl: "https://vl.example.com", metricsUrl: "" });
  expect(observability.settings("c1", admin)).toEqual({
    logsUrl: "https://vl.example.com",
    metricsUrl: "",
  });
});

test("the logs tool queries LogsQL and gives the entries as a list", async () => {
  const { observability, requests } = setup(
    () =>
      new Response('{"_msg":"one","level":"error"}\n{"_msg":"two"}\n', {
        status: 200,
      })
  );
  observability.setSettings("c1", admin, { logsUrl: "http://vl:9428" });
  expect(
    await call(observability, "observability_logs", {
      query: "level:error",
      limit: 5000,
    })
  ).toEqual([{ _msg: "one", level: "error" }, { _msg: "two" }]);
  expect(requests[0]!.url).toBe("http://vl:9428/select/logsql/query");
  const body = new URLSearchParams(requests[0]!.body);
  expect(body.get("query")).toBe("level:error");
  expect(body.get("limit")).toBe("1000");
  expect(body.get("start")).toBeTruthy();
});

test("the metrics tool makes an instant or a range query and names a refusal", async () => {
  const { observability, requests } = setup((url) =>
    url.includes("bad")
      ? Response.json(
          { status: "error", error: "parse error" },
          { status: 400 }
        )
      : Response.json({
          status: "success",
          data: { resultType: "vector", result: [] },
        })
  );
  await expect(
    call(observability, "observability_metrics", { query: "up" })
  ).rejects.toThrow("Company settings");
  observability.setSettings("c1", admin, { metricsUrl: "http://vm:8428" });
  expect(
    await call(observability, "observability_metrics", { query: "up" })
  ).toEqual({ resultType: "vector", result: [] });
  await call(observability, "observability_metrics", {
    query: "up",
    start: "2026-11-16T00:00:00Z",
    step: "5m",
  });
  expect(requests.map((request) => request.url)).toEqual([
    "http://vm:8428/api/v1/query?query=up",
    "http://vm:8428/api/v1/query_range?query=up&start=2026-11-16T00%3A00%3A00Z&step=5m",
  ]);
  await expect(
    call(observability, "observability_metrics", { query: "bad" })
  ).rejects.toThrow("400");
});
