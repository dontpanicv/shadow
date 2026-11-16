import { HttpError } from "../platform/errors.ts";

const LINEAR_API = "https://api.linear.app/graphql";
/** The read tools of Linear's MCP server that do not read only the key owner's own things, such as their inbox. */
const READ_TOOLS = new Set([
  "linear_search_documentation",
  "linear_extract_images",
]);

/** Whether a company key may call a tool of Linear's MCP server, by its agent name: only reads. */
export function linearReads(tool: string): boolean {
  return (
    READ_TOOLS.has(tool) ||
    (/^linear_(get|list)_/.test(tool) && !tool.includes("notification"))
  );
}

/**
 * Gives the name of the Linear workspace of an API key, and refuses a key that may change issues: Linear answers a
 * write with a key without the write scope by naming the scope, before it reads the input. The probe names a team
 * that does not exist, so even a key with write access creates nothing.
 */
export async function checkLinearKey(
  key: string,
  fetch: typeof globalThis.fetch = globalThis.fetch
): Promise<string> {
  const { organization } = (await linearGraphql(
    key,
    "query { organization { name } }",
    {},
    undefined,
    fetch
  )) as { organization: { name: string } };
  const probe = (await (
    await request(
      key,
      'mutation { issueCreate(input: { title: "Shadow checks the key", teamId: "00000000-0000-0000-0000-000000000000" }) { success } }',
      {},
      undefined,
      fetch
    )
  ).json()) as { errors?: { message: string }[] };
  if (!probe.errors?.some((error) => /scope/i.test(error.message))) {
    throw new HttpError(
      400,
      "This Linear key can change issues. In Linear, make a key with only Read access."
    );
  }
  return organization.name;
}

/** The data of a query of Linear's GraphQL API with an API key; an error names Linear's own reason. */
export async function linearGraphql(
  key: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
  fetch: typeof globalThis.fetch = globalThis.fetch
): Promise<unknown> {
  const response = await request(key, query, variables, signal, fetch);
  const answer = (await response.json().catch(() => ({}))) as {
    data?: unknown;
    errors?: { message: string }[];
  };
  if (!response.ok || answer.errors?.length || !answer.data) {
    throw new HttpError(
      response.status === 401 ? 400 : 502,
      `Linear refused the request: ${answer.errors?.map((error) => error.message).join("; ") ?? response.status}`
    );
  }
  return answer.data;
}

function request(
  key: string,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal | undefined,
  fetch: typeof globalThis.fetch
): Promise<Response> {
  return fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.any([
      AbortSignal.timeout(60_000),
      ...(signal ? [signal] : []),
    ]),
  });
}
