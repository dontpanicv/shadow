import { afterAll, beforeAll, expect, test } from "bun:test";
import { Type } from "@earendil-works/pi-ai";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { startTestApp, type TestApp } from "../../test/harness.ts";
import type { User } from "../platform/auth.ts";
import { Secrets } from "../platform/secrets.ts";
import { googleConnectors } from "./google.ts";
import {
  type Connector,
  Integrations,
  type SourceRead,
} from "./integrations.ts";

let shadow: TestApp;
let alice: User;
/** A member who is not the server's owner. */
let notOwner: User;
let companyId: string;
/** A sign-in server and an MCP server's address, as Plaud's are, on a local port. */
let signInServer: ReturnType<typeof Bun.serve>;
/** What the sign-in server's token endpoint got. */
const tokenRequests: URLSearchParams[] = [];
/** The access token that each MCP connection had. */
const connectedWith: (string | undefined)[] = [];
const changes: string[] = [];
let integrations: Integrations;

beforeAll(async () => {
  shadow = await startTestApp();
  await shadow.signIn("Alice", "alice@example.com");
  const { internalAdapter } = await shadow.app.auth.$context;
  const { user } = (await internalAdapter.findUserByEmail(
    "alice@example.com"
  ))!;
  alice = { id: user.id, name: user.name, email: user.email };
  companyId = (await shadow.app.companies.create(alice, "Company")).id;
  await shadow.signIn("Eve", "eve@example.com");
  const eve = (await internalAdapter.findUserByEmail("eve@example.com"))!;
  notOwner = { id: eve.user.id, name: eve.user.name, email: eve.user.email };
  await shadow.app.companies.addMember(companyId, alice, notOwner.email);
  signInServer = Bun.serve({ port: 0, fetch: signIn });
  const shop: Connector = {
    id: "shop",
    name: "Shop",
    description: "Groceries.",
    secretLabel: null,
    tools: [],
    mcp: [new URL("/mcp", signInServer.url).href],
  };
  integrations = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [shop],
      changed: (id) => changes.push(id),
      transport: (_url, provider) => {
        const [client, server] = InMemoryTransport.createLinkedPair();
        connectedWith.push(
          (provider.tokens() as { access_token: string } | undefined)
            ?.access_token
        );
        shopServer().connect(server);
        return client;
      },
    }
  );
});
afterAll(async () => {
  await integrations.close();
  signInServer.stop();
  await shadow.close();
});

/** The OAuth metadata, client registration, and tokens of a sign-in server. */
async function signIn(request: Request): Promise<Response> {
  const { origin, pathname } = new URL(request.url);
  if (pathname === "/.well-known/oauth-protected-resource/mcp") {
    return Response.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
  }
  if (pathname === "/.well-known/oauth-authorization-server") {
    return Response.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (pathname === "/register") {
    return Response.json(
      { ...((await request.json()) as object), client_id: "shadow-client" },
      { status: 201 }
    );
  }
  if (pathname === "/oauth2/token") {
    tokenRequests.push(new URLSearchParams(await request.text()));
    return Response.json({
      access_token: "access-station",
      refresh_token: "refresh-station",
      scope: ["read_station"],
      expires_in: 10_800,
      expire_in: 10_800,
    });
  }
  if (pathname === "/token") {
    const parameters = new URLSearchParams(await request.text());
    tokenRequests.push(parameters);
    // Shadow's own client signs in to Google, whose token names the account.
    const owned =
      parameters.has("client_secret") || request.headers.has("authorization");
    if (parameters.get("grant_type") === "refresh_token") {
      return Response.json({
        access_token: "access-refreshed",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return Response.json({
      access_token:
        parameters.get("code") === "code-own" ? "access-own" : "access-1",
      token_type: "Bearer",
      refresh_token: "refresh-1",
      ...(owned
        ? {
            id_token: `x.${btoa(JSON.stringify({ email: "anna@work.example" }))}.x`,
          }
        : {}),
    });
  }
  return new Response("Not found", { status: 404 });
}

/** An MCP server with a tool that returns a value, one that returns text, and one that fails. */
function shopServer(): Server {
  const server = new Server(
    { name: "shop", version: "1" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_products",
        description: "Find products by name",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        outputSchema: {
          type: "object",
          properties: { products: { type: "array" } },
        },
      },
      {
        name: "cart",
        description: "The cart",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "checkout",
        description: "Pay",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === "search_products") {
      const products = [{ name: `${params.arguments?.query} 1 l` }];
      return {
        content: [{ type: "text", text: JSON.stringify({ products }) }],
        structuredContent: { products },
      };
    }
    if (params.name === "cart") {
      return { content: [{ type: "text", text: "The cart is empty." }] };
    }
    return {
      content: [{ type: "text", text: "Paying is not possible." }],
      isError: true,
    };
  });
  return server;
}

test("people connect an MCP server by signing in, and agents get its tools", async () => {
  expect(await integrations.tools(companyId)).toEqual([]);
  await expect(
    integrations.addCredential(companyId, alice, "shop", {
      label: "Shop",
      secret: "x",
    })
  ).rejects.toThrow("Connect it by signing in");

  const { url } = (await integrations.connect(companyId, alice, "shop")) as {
    url: string;
  };
  const page = new URL(url);
  expect(page.pathname).toBe("/authorize");
  expect(page.searchParams.get("client_id")).toBe("shadow-client");
  expect(page.searchParams.get("redirect_uri")).toBe(
    "http://localhost:3000/api/v1/integrations/callback"
  );
  expect(page.searchParams.get("resource")).toBe(`${page.origin}/mcp`);
  expect(page.searchParams.get("code_challenge_method")).toBe("S256");
  const state = page.searchParams.get("state")!;
  // The provider returns the browser to Shadow, whose proxy gives the request another address.
  const address = `http://127.0.0.1:3001/api/v1/integrations/callback?code=code-1&state=${state}`;

  await expect(
    integrations.finishConnect(
      companyId,
      alice,
      "shop",
      "http://localhost:3000/"
    )
  ).rejects.toThrow("This is not the address of your sign-in");
  expect(await integrations.finishCallback(alice, address)).toBe("Shop");
  expect(tokenRequests.at(-1)?.get("code")).toBe("code-1");
  expect(tokenRequests.at(-1)?.get("code_verifier")).toBeTruthy();
  expect(changes).toContain(companyId);
  await expect(
    integrations.finishConnect(companyId, alice, "shop", address)
  ).rejects.toThrow("This is not the address of your sign-in");
  const [shop] = integrations.list(companyId, alice);
  expect(shop).toMatchObject({ connect: "sign-in", secretLabel: null });
  expect(shop!.credentials).toMatchObject([
    { label: "Shop", ownerName: "Alice" },
  ]);

  const tools = await integrations.tools(companyId);
  expect(tools.map((tool) => tool.name)).toEqual([
    "shop_search_products",
    "shop_cart",
    "shop_checkout",
    "shop_accounts",
  ]);
  expect(connectedWith.at(-1)).toBe("access-1");
  const [search, cart, checkout] = tools;
  expect(search!.outputSchema).toBeDefined();
  const turn = { userId: alice.id };
  expect(await search!.execute({ query: "milk" }, turn)).toEqual({
    products: [{ name: "milk 1 l" }],
  });
  expect(await cart!.execute({}, turn)).toBe("The cart is empty.");
  await expect(checkout!.execute({}, turn)).rejects.toThrow(
    "Paying is not possible."
  );
  expect(integrations.namespaces()).toEqual([
    { name: "shop", prefix: "shop_", description: "Groceries." },
  ]);

  integrations.deleteCredential(companyId, alice, shop!.credentials[0]!.id);
  expect(await integrations.tools(companyId)).toEqual([]);
});

test("a shared sign-in lists an MCP server's tools, else a private one", async () => {
  const signInTo = async (code: string) => {
    const { url } = (await integrations.connect(companyId, alice, "shop")) as {
      url: string;
    };
    const state = new URL(url).searchParams.get("state")!;
    return integrations.finishConnect(
      companyId,
      alice,
      "shop",
      `http://localhost:3000/api/v1/integrations/callback?code=${code}&state=${state}`
    );
  };
  const shared = await signInTo("code-1");
  integrations.setShared(companyId, alice, shared.id, true);
  const own = await signInTo("code-own");
  await integrations.tools(companyId);
  expect(connectedWith.at(-1)).toBe("access-1");
  integrations.deleteCredential(companyId, alice, shared.id);
  await integrations.tools(companyId);
  expect(connectedWith.at(-1)).toBe("access-own");
  integrations.deleteCredential(companyId, alice, own.id);
});

test("a sign-in that did not finish adds nothing", async () => {
  const { url } = (await integrations.connect(companyId, alice, "shop")) as {
    url: string;
  };
  const state = new URL(url).searchParams.get("state")!;
  await expect(
    integrations.finishConnect(
      companyId,
      alice,
      "shop",
      `http://localhost:3000/api/v1/integrations/callback?error=access_denied&state=${state}`
    )
  ).rejects.toThrow("The sign-in did not finish");
  expect(integrations.list(companyId, alice)[0]!.credentials).toEqual([]);
});

test("a turn uses its person's own credential, else a shared one, and only its owner shares or deletes it", async () => {
  await shadow.signIn("Bob", "bob@example.com");
  const { internalAdapter } = await shadow.app.auth.$context;
  const found = (await internalAdapter.findUserByEmail("bob@example.com"))!;
  const bob = {
    id: found.user.id,
    name: found.user.name,
    email: found.user.email,
  };
  await shadow.app.companies.addMember(companyId, alice, bob.email);
  const reached: string[] = [];
  const notes = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [
        {
          id: "notes",
          name: "Notes",
          description: "Notes.",
          secretLabel: "Token",
          tools: [
            {
              name: "notes_token",
              description: "The token a call uses",
              parameters: Type.Object({}),
              execute: async (_args, secret) => secret,
            },
          ],
        },
      ],
      changed: (id) => reached.push(id),
    }
  );
  const token = async (userId: string | null) => {
    const [tool] = await notes.tools(companyId);
    return tool!.execute({}, { userId });
  };
  const company = await notes.addCredential(companyId, bob, "notes", {
    label: "Company",
    secret: "company",
  });
  expect(company).toMatchObject({ ownerId: bob.id, shared: false });
  const own = await notes.addCredential(companyId, alice, "notes", {
    label: "Mine",
    secret: "alice",
  });
  // Private: only Alice's turns use hers, and Bob's his.
  expect(await token(alice.id)).toBe("alice");
  expect(await token(bob.id)).toBe("company");
  await expect(token(null)).rejects.toThrow("Notes is not connected");
  expect(notes.list(companyId, alice)[0]!.credentials).toMatchObject([
    { label: "Mine" },
  ]);

  expect(() => notes.setShared(companyId, alice, company.id, true)).toThrow(
    "Not found"
  );
  expect(notes.setShared(companyId, bob, company.id, true)).toMatchObject({
    label: "Company",
    shared: true,
  });
  expect(reached).toEqual([companyId, companyId, companyId]);
  expect(await token(null)).toBe("company");
  expect(await token(alice.id)).toBe("alice");
  expect(notes.list(companyId, alice)[0]!.credentials).toMatchObject([
    { label: "Company", ownerName: "Bob", shared: true },
    { label: "Mine", shared: false },
  ]);
  expect(notes.list(companyId, bob)[0]!.credentials).toMatchObject([
    { label: "Company" },
  ]);

  expect(() => notes.deleteCredential(companyId, bob, own.id)).toThrow(
    "Not found"
  );
  expect(() => notes.deleteCredential(companyId, alice, company.id)).toThrow(
    "Not found"
  );
  notes.deleteCredential(companyId, alice, own.id);
  expect(await token(alice.id)).toBe("company");
  notes.deleteCredential(companyId, bob, company.id);
});

test("a tool that acts as a person asks its credential's owner every time, and only an agent in a thread can ask", async () => {
  const { internalAdapter } = await shadow.app.auth.$context;
  const bobId = (await internalAdapter.findUserByEmail("bob@example.com"))!.user
    .id;
  const sent: string[] = [];
  const messenger = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [
        {
          id: "messenger",
          name: "Messenger",
          description: "Messages.",
          secretLabel: "Session",
          // The secret is made from what the person pastes, and names the credential.
          secretFrom: async (input) => {
            if (!input.startsWith("curl ")) {
              throw new Error("Paste a cURL command");
            }
            return { secret: `session of ${input}`, label: "Company chat" };
          },
          tools: [
            {
              name: "messenger_send",
              description: "Sends a message",
              parameters: Type.Object({ text: Type.String() }),
              approval: ({ text }) => `Send: ${text}`,
              execute: async ({ text }, secret) => {
                sent.push(`${secret}: ${text}`);
                return { sent: true };
              },
            },
          ],
        },
      ],
    }
  );
  expect(messenger.list(companyId, alice)[0]!.labeled).toBe(false);
  await expect(
    messenger.addCredential(companyId, alice, "messenger", {
      secret: "hello",
    })
  ).rejects.toThrow("Paste a cURL command");
  const chat = await messenger.addCredential(companyId, alice, "messenger", {
    secret: "curl x",
  });
  expect(chat).toMatchObject({ label: "Company chat" });
  messenger.setShared(companyId, alice, chat.id, true);

  const [send] = await messenger.tools(companyId);
  const asked: [string, string | null][] = [];
  // Bob's turn uses Alice's shared credential, so Alice allows it.
  await send!.execute(
    { text: "Hi" },
    {
      userId: bobId,
      approve: async (text, approverId) => {
        asked.push([text, approverId]);
      },
    }
  );
  await expect(
    send!.execute(
      { text: "Again" },
      {
        userId: bobId,
        approve: () => Promise.reject(new Error("Alice did not allow this.")),
      }
    )
  ).rejects.toThrow("Alice did not allow this.");
  // A routine's script cannot ask.
  await expect(
    send!.execute({ text: "From a script" }, { userId: bobId })
  ).rejects.toThrow("Only an agent in a thread can use messenger_send");
  expect(asked).toEqual([["Send: Hi", alice.id]]);
  expect(sent).toEqual(["session of curl x: Hi"]);
});

test("a secret of a connector with an address keeps its server's address", async () => {
  const home = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [
        {
          id: "home",
          name: "Home",
          description: "The home.",
          secretLabel: "Token",
          address: true,
          tools: [
            {
              name: "home_secret",
              description: "The secret a call gets",
              parameters: Type.Object({}),
              execute: async (_args, secret) => JSON.parse(secret),
            },
          ],
        },
      ],
    }
  );
  const add = (address?: string) =>
    home.addCredential(companyId, alice, "home", {
      label: "Home",
      secret: "token",
      ...(address === undefined ? {} : { address }),
    });
  await expect(add()).rejects.toThrow("Address is required");
  await expect(add("file:///etc")).rejects.toThrow("http:// or https://");
  await add("http://home.local:8123");
  expect(home.list(companyId, alice)[0]!.address).toBe(true);
  const [tool] = await home.tools(companyId);
  expect(await tool!.execute({}, { userId: alice.id })).toEqual({
    address: "http://home.local:8123/",
    secret: "token",
  });
});

test("a secret of a connector with an account keeps the account, which names the credential", async () => {
  const thermostat = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [
        {
          id: "thermostat",
          name: "Thermostat",
          description: "The heating.",
          secretLabel: "Password",
          username: "Email",
          tools: [
            {
              name: "thermostat_secret",
              description: "The secret a call gets",
              parameters: Type.Object({}),
              execute: async (_args, secret) => JSON.parse(secret),
            },
          ],
        },
      ],
    }
  );
  const add = (username?: string) =>
    thermostat.addCredential(companyId, alice, "thermostat", {
      secret: "pw",
      ...(username === undefined ? {} : { username }),
    });
  await expect(add()).rejects.toThrow("Email is required");
  expect((await add(" anna@example.com ")).label).toBe("anna@example.com");
  expect(thermostat.list(companyId, alice)[0]).toMatchObject({
    labeled: false,
    username: "Email",
  });
  const [tool] = await thermostat.tools(companyId);
  expect(await tool!.execute({}, { userId: alice.id })).toEqual({
    username: "anna@example.com",
    secret: "pw",
  });
});

test("only an admin sets Shadow's own client, and its MCP server hides the tools that send", async () => {
  const chat: Connector = {
    id: "chat",
    name: "Chat",
    description: "Messages.",
    secretLabel: null,
    tools: [],
    mcp: [new URL("/mcp", signInServer.url).href],
    registered: true,
    scope: "search chat:write",
    hiddenTools: ["checkout"],
  };
  const { database, companies } = shadow.app;
  const withOwner = new Integrations(database, Secrets.forTests(), companies, {
    catalog: [chat],
    transport: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      shopServer().connect(serverSide);
      return clientSide;
    },
  });
  // Until an admin sets the client, only admins see the integration, and nobody can connect it.
  expect(withOwner.list(companyId, notOwner)).toEqual([]);
  expect(withOwner.list(companyId, alice)[0]!.client).toEqual({
    clientId: null,
    changeable: true,
  });
  await expect(withOwner.connect(companyId, alice, "chat")).rejects.toThrow(
    "An admin has not set the client of Chat"
  );
  await expect(
    withOwner.setClient(notOwner, "chat", { clientId: "x", clientSecret: "y" })
  ).rejects.toThrow("Only an admin sets the client");
  await withOwner.setClient(alice, "chat", {
    clientId: " own-client ",
    clientSecret: "shh",
  });
  expect(withOwner.list(companyId, notOwner)[0]!.client).toEqual({
    clientId: "own-client",
    changeable: false,
  });

  const { url } = (await withOwner.connect(companyId, alice, "chat")) as {
    url: string;
  };
  const page = new URL(url);
  expect(page.searchParams.get("client_id")).toBe("own-client");
  expect(page.searchParams.get("scope")).toBe("search chat:write");
  const credential = await withOwner.finishConnect(
    companyId,
    alice,
    "chat",
    `http://localhost:3000/api/v1/integrations/callback?code=code-2&state=${page.searchParams.get("state")}`
  );
  expect(credential.label).toBe("anna@work.example");
  expect((await withOwner.tools(companyId)).map((tool) => tool.name)).toEqual([
    "chat_search_products",
    "chat_cart",
    "chat_accounts",
  ]);
  withOwner.deleteCredential(companyId, alice, credential.id);
  await withOwner.close();
});

test("people sign in to the MCP server at the address of their own machine, and agents get only its shown tools", async () => {
  const coding: Connector = {
    id: "coding",
    name: "Coding",
    description: "Coding agents.",
    secretLabel: null,
    address: true,
    tools: [],
    mcp: ["/mcp"],
    shownTools: ["cart"],
  };
  const connectedTo: string[] = [];
  const own = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [coding],
      transport: (server) => {
        connectedTo.push(server.href);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        shopServer().connect(serverSide);
        return clientSide;
      },
    }
  );
  await expect(
    own.connect(companyId, alice, "coding", { address: "my-mac:3774" })
  ).rejects.toThrow("Address must start with http:// or https://");
  const machine = new URL(signInServer.url);
  const { url } = (await own.connect(companyId, alice, "coding", {
    address: `${machine.origin}/`,
  })) as { url: string };
  const page = new URL(url);
  expect(page.origin).toBe(machine.origin);
  expect(page.searchParams.get("resource")).toBe(`${machine.origin}/mcp`);
  const credential = await own.finishConnect(
    companyId,
    alice,
    "coding",
    `http://localhost:3000/api/v1/integrations/callback?code=code-5&state=${page.searchParams.get("state")}`
  );
  expect(credential.label).toBe(machine.host);
  const tools = await own.tools(companyId);
  expect(tools.map((tool) => tool.name)).toEqual([
    "coding_cart",
    "coding_accounts",
  ]);
  expect(await tools[0]!.execute({}, { userId: alice.id })).toBe(
    "The cart is empty."
  );
  expect(connectedTo).toEqual([`${machine.origin}/mcp`]);
  own.deleteCredential(companyId, alice, credential.id);
  await own.close();
});

test("all Google MCP servers use Shadow’s configured sign-in client", async () => {
  const services = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: googleConnectors(
        "http://localhost:3000/api/v1/integrations/callback"
      ),
      googleClient: {
        clientId: "workspace-client",
        clientSecret: "workspace-secret",
      },
    }
  );
  expect(services.list(companyId, notOwner)).toHaveLength(6);
  for (const service of services.list(companyId, notOwner)) {
    expect(service.client?.clientId).toBe("workspace-client");
    expect(service.watchable).toBe(service.id === "google");
  }
});

test("a Google MCP server signs in with the saved client and exposes its tools", async () => {
  const gmail: Connector = {
    ...googleConnectors(
      "http://localhost:3000/api/v1/integrations/callback"
    )[0]!,
    oauth: new URL(signInServer.url).origin,
    mcp: [new URL("/mcp", signInServer.url).href],
  };
  const service = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [gmail],
      googleClient: {
        clientId: "workspace-client",
        clientSecret: "workspace-secret",
      },
      transport: () => {
        const [client, server] = InMemoryTransport.createLinkedPair();
        shopServer().connect(server);
        return client;
      },
    }
  );
  const { url } = await service.connect(companyId, alice, "google");
  const page = new URL(url);
  expect(page.searchParams.get("client_id")).toBe("workspace-client");
  await service.finishCallback(
    alice,
    `http://localhost:3000/api/v1/integrations/callback?code=code-4&state=${page.searchParams.get("state")}`
  );
  expect((await service.tools(companyId)).map((tool) => tool.name)).toContain(
    "google_search_products"
  );
  await service.close();
});

test("the own tools of a sign-in get a fresh access token, which the refresh token renews", async () => {
  const google: Connector = {
    id: "google",
    name: "Google",
    description: "Mail and calendars.",
    secretLabel: null,
    oauth: new URL(signInServer.url).origin,
    registered: true,
    scope: "openid email mail",
    authorizationParameters: { access_type: "offline" },
    tools: [
      {
        name: "google_token",
        description: "The access token that the call got.",
        parameters: Type.Object({}),
        execute: async (_args, accessToken) => accessToken,
      },
    ],
  };
  const withOwner = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [google],
      googleClient: { clientId: "own-client", clientSecret: "shh" },
    }
  );
  expect(withOwner.list(companyId, alice)[0]).toMatchObject({
    connect: "sign-in",
  });
  const { url } = (await withOwner.connect(companyId, alice, "google")) as {
    url: string;
  };
  const page = new URL(url);
  expect(page.pathname).toBe("/authorize");
  expect(page.searchParams.get("access_type")).toBe("offline");
  expect(page.searchParams.has("resource")).toBe(false);
  const credential = await withOwner.finishConnect(
    companyId,
    alice,
    "google",
    `http://localhost:3000/api/v1/integrations/callback?code=code-3&state=${page.searchParams.get("state")}`
  );
  expect(credential.label).toBe("anna@work.example");

  const [token, accounts] = await withOwner.tools(companyId);
  expect(accounts!.name).toBe("google_accounts");
  const refreshes = () =>
    tokenRequests.filter(
      (request) => request.get("grant_type") === "refresh_token"
    ).length;
  const before = refreshes();
  const turn = { userId: alice.id };
  expect(await token!.execute({}, turn)).toBe("access-refreshed");
  // The token stays until shortly before it expires.
  expect(await token!.execute({}, turn)).toBe("access-refreshed");
  expect(refreshes()).toBe(before + 1);
  expect(tokenRequests.at(-1)?.get("refresh_token")).toBe("refresh-1");
  withOwner.deleteCredential(companyId, alice, credential.id);
  await withOwner.close();
});

test("a turn picks one of its person's accounts by name, and lists them", async () => {
  const notes = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [
        {
          id: "mail",
          name: "Mail",
          description: "Mail.",
          secretLabel: "Password",
          tools: [
            {
              name: "mail_secret",
              description: "The secret a call uses",
              parameters: Type.Object({}),
              execute: async (_args, password) => password,
            },
          ],
        },
      ],
    }
  );
  const company = await notes.addCredential(companyId, alice, "mail", {
    label: "company@example.com",
    secret: "company",
  });
  notes.setShared(companyId, alice, company.id, true);
  await notes.addCredential(companyId, alice, "mail", {
    label: "work@example.com",
    secret: "work",
  });
  await notes.addCredential(companyId, alice, "mail", {
    label: "me@example.com",
    secret: "me",
  });
  const [secret, accounts] = await notes.tools(companyId);
  expect(secret!.parameters).toMatchObject({
    properties: { account: { type: "string" } },
  });
  const turn = { userId: alice.id };
  expect(await secret!.execute({}, turn)).toBe("me");
  expect(await secret!.execute({ account: "work@example.com" }, turn)).toBe(
    "work"
  );
  expect(await secret!.execute({ account: "company@example.com" }, turn)).toBe(
    "company"
  );
  expect(await accounts!.execute({}, turn)).toEqual([
    { account: "me@example.com", of: "own" },
    { account: "work@example.com", of: "own" },
    { account: "company@example.com", of: "own" },
  ]);
  expect(await accounts!.execute({}, { userId: null })).toEqual([
    { account: "company@example.com", of: "shared" },
  ]);
});

test("only a credential's owner lets Shadow read it for them, and only a watched one is read", async () => {
  await shadow.signIn("Bob", "bob@example.com");
  const { internalAdapter } = await shadow.app.auth.$context;
  const found = (await internalAdapter.findUserByEmail("bob@example.com"))!;
  const bob = {
    id: found.user.id,
    name: found.user.name,
    email: found.user.email,
  };
  if (
    !shadow.app.companies
      .members(companyId, alice)
      .some((member) => member.userId === bob.id)
  ) {
    await shadow.app.companies.addMember(companyId, alice, bob.email);
  }
  const sinces: number[] = [];
  const watching = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [
        {
          id: "mail",
          name: "Mail",
          description: "Mail.",
          secretLabel: "Token",
          tools: [],
          watch: async ({ since, account, secret, seen }) => {
            sinces.push(since);
            return [
              {
                id: "m1",
                kind: "message",
                chat: "t1",
                chatName: `${account} ${await secret()}`,
                group: false,
                sender: "Carol",
                fromOwner: false,
                at: since,
                text: seen("m1") ? "seen" : "new",
                url: null,
              },
            ];
          },
          attachment: async ({ secret }, item, attachment) =>
            new TextEncoder().encode(`${item} ${attachment} ${await secret()}`),
        },
        {
          id: "lights",
          name: "Lights",
          description: "Lights.",
          secretLabel: "Token",
          tools: [],
        },
      ],
    }
  );
  const mail = await watching.addCredential(companyId, bob, "mail", {
    label: "bob@mail",
    secret: "token",
  });
  const lights = await watching.addCredential(companyId, bob, "lights", {
    label: "Home",
    secret: "token",
  });
  expect(watching.list(companyId, bob).map((each) => each.watchable)).toEqual([
    true,
    false,
  ]);
  expect(watching.watched()).toEqual([]);
  await expect(watching.watch(mail.id, 1, () => false)).rejects.toThrow(
    "Shadow does not watch this credential"
  );
  watching.setShared(companyId, bob, mail.id, true);
  expect(() => watching.setWatched(companyId, alice, mail.id, true)).toThrow(
    "Not found"
  );
  expect(() => watching.setWatched(companyId, bob, lights.id, true)).toThrow(
    "Shadow cannot read this integration for you"
  );
  expect(watching.setWatched(companyId, bob, mail.id, true)).toMatchObject({
    shared: true,
    watched: true,
  });
  expect(watching.watched()).toEqual([
    {
      id: mail.id,
      companyId,
      integration: "mail",
      integrationName: "Mail",
      ownerId: bob.id,
      label: "bob@mail",
    },
  ]);
  expect(await watching.watch(mail.id, 5, () => true)).toMatchObject([
    { chatName: "bob@mail token", text: "seen", at: 5 },
  ]);
  expect(sinces).toEqual([5]);
  expect(
    new TextDecoder().decode(await watching.attachment(mail.id, "m1", "a1"))
  ).toBe("m1 a1 token");
  watching.setWatched(companyId, bob, mail.id, false);
  await expect(watching.attachment(mail.id, "m1", "a1")).rejects.toThrow(
    "Shadow does not watch this credential"
  );
  expect(watching.watched()).toEqual([]);
});

test("only an opted-in account owner's chat receives verified read observations", async () => {
  const evidence = {
    id: "answer",
    kind: "message" as const,
    chat: "claim",
    chatName: "Claim",
    group: false,
    sender: "Builder",
    fromOwner: false,
    at: 1,
    text: "The claim is resolved.",
    url: null,
  };
  const connector: Connector = {
    id: "evidence",
    name: "Evidence",
    description: "Read evidence",
    secretLabel: "Token",
    watch: async () => [],
    observations: async (tool, _args, result) =>
      tool === "evidence_read" ? [result as typeof evidence] : [],
    tools: ["read", "draft", "fail"].map((name) => ({
      name: `evidence_${name}`,
      description: name,
      parameters: Type.Object({}),
      execute: async () => {
        if (name === "fail") {
          throw new Error("Read failed");
        }
        return evidence;
      },
    })),
  };
  const observed = new Integrations(
    shadow.app.database,
    Secrets.forTests(),
    shadow.app.companies,
    {
      catalog: [connector],
    }
  );
  const credential = await observed.addCredential(
    companyId,
    alice,
    "evidence",
    { label: "Private", secret: "token" }
  );
  const tools = await observed.tools(companyId);
  const read = tools.find((tool) => tool.name === "evidence_read")!;
  const received: SourceRead[] = [];
  const observe = async (observation: SourceRead) => {
    await Promise.resolve();
    received.push(observation);
  };
  await read.execute({}, { userId: alice.id, observe });
  expect(received).toEqual([]);
  observed.setWatched(companyId, alice, credential.id, true);
  await read.execute({}, { userId: alice.id, observe });
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    credential: { id: credential.id, ownerId: alice.id },
    tool: "evidence_read",
    result: evidence,
    items: [evidence],
  });
  await tools
    .find((tool) => tool.name === "evidence_draft")!
    .execute({}, { userId: alice.id, observe });
  await expect(
    tools
      .find((tool) => tool.name === "evidence_fail")!
      .execute({}, { userId: alice.id, observe })
  ).rejects.toThrow("Read failed");
  observed.setShared(companyId, alice, credential.id, true);
  await read.execute({}, { userId: notOwner.id, observe });
  await read.execute({}, { userId: alice.id });
  observed.setWatched(companyId, alice, credential.id, false);
  await read.execute({}, { userId: alice.id, observe });
  expect(received).toHaveLength(1);
  await observed.close();
});
