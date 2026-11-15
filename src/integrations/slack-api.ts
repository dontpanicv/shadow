/** How many times a call waits and tries again when Slack asks for fewer requests. */
const RETRIES = 4;
/** The longest wait that Slack's `Retry-After` gets, in seconds. */
const LONGEST_WAIT = 60;

/** Slack's Web API with a bot token: a call that waits when Slack asks for fewer requests, and file downloads. */
export class SlackApi {
  constructor(private readonly fetchSlack: typeof fetch = fetch) {}

  /** The answer of a method; throws Slack's error code, with the scopes that a `missing_scope` needs. */
  async call(
    token: string,
    method: string,
    params: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== "")
    );
    for (let tries = 0; ; tries += 1) {
      const response = await this.fetchSlack(
        `https://slack.com/api/${method}?${query}`,
        { headers: { authorization: `Bearer ${token}` }, signal }
      );
      if (response.status === 429) {
        if (tries >= RETRIES) {
          throw new Error(
            "Slack asks for fewer requests; the next sync tries again"
          );
        }
        const wait = Number(response.headers.get("retry-after")) || 1;
        await Bun.sleep(Math.min(wait, LONGEST_WAIT) * 1000);
        continue;
      }
      const body = (await response.json()) as Record<string, unknown>;
      if (body.ok !== true) {
        const error = String(body.error ?? `HTTP ${response.status}`);
        throw new Error(
          error === "missing_scope" && body.needed
            ? `The Slack app needs the scope ${String(body.needed)}`
            : error
        );
      }
      return body;
    }
  }

  /**
   * The answer of a method that writes, such as chat.postMessage, with a JSON body that can hold blocks; it waits when
   * Slack asks for fewer requests, as `call` does.
   */
  async post(
    token: string,
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    for (let tries = 0; ; tries += 1) {
      const response = await this.fetchSlack(
        `https://slack.com/api/${method}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
          signal,
        }
      );
      if (response.status === 429 && tries < RETRIES) {
        const wait = Number(response.headers.get("retry-after")) || 1;
        await Bun.sleep(Math.min(wait, LONGEST_WAIT) * 1000);
        continue;
      }
      const answer = (await response.json()) as Record<string, unknown>;
      if (answer.ok !== true) {
        throw new Error(String(answer.error ?? `HTTP ${response.status}`));
      }
      return answer;
    }
  }

  /** The address of a new Socket Mode connection, with the app token (`xapp-…`, scope `connections:write`). */
  async openSocket(appToken: string): Promise<string> {
    const response = await this.fetchSlack(
      "https://slack.com/api/apps.connections.open",
      { method: "POST", headers: { authorization: `Bearer ${appToken}` } }
    );
    const body = (await response.json()) as {
      ok?: boolean;
      url?: string;
      error?: string;
    };
    if (!(body.ok && body.url)) {
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    return body.url;
  }

  /** The bytes of a file that Slack keeps, such as an attachment's `url_private_download`. */
  async download(
    token: string,
    url: string,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const response = await this.fetchSlack(url, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) {
      throw new Error(`Slack did not give the file: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
