import { describe, expect, it, vi } from "vitest";

import {
  connectPushToDeploy,
  ensureWorker,
  getAccountSubdomain,
  listWorkerScripts,
  probeGitIntegration,
  CloudflareApiError,
} from "./cloudflare";

interface StubRoute {
  status?: number;
  body: unknown;
}

/**
 * A fetch stub keyed by `METHOD /path`, which also records the calls so a test can
 * assert what was *not* called — the interesting property for "leave an existing Worker
 * alone".
 */
function stubFetch(routes: Record<string, StubRoute>): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; path: string; body: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace("/client/v4", "");
    const key = `${method} ${path}`;
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : (init?.body ?? null);
    calls.push({ method, path, body });

    const route = routes[key];
    if (!route) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: `no stub for ${key}` }] }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify({ success: true, result: route.body }), {
      status: route.status ?? 200,
    });
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const ACCOUNT = "acct-1";

describe("probeGitIntegration", () => {
  it("treats an existing build trigger as proof of the GitHub connection", async () => {
    // A trigger cannot exist without a repository connection, and a connection cannot
    // exist without Cloudflare's GitHub App. That chain is the whole probe: there is no
    // endpoint that lists connections.
    const { fetchImpl } = stubFetch({
      [`GET /accounts/${ACCOUNT}/workers/scripts`]: { body: [{ id: "team-notes", tag: "tag-1" }] },
      [`GET /accounts/${ACCOUNT}/builds/workers/tag-1/triggers`]: {
        body: [{ trigger_uuid: "trig-1" }],
      },
    });

    await expect(probeGitIntegration({ token: "cf", accountId: ACCOUNT, fetchImpl })).resolves.toBe(
      "connected",
    );
  });

  it("reports unconfirmed rather than missing when no Worker shows evidence", async () => {
    const { fetchImpl } = stubFetch({
      [`GET /accounts/${ACCOUNT}/workers/scripts`]: { body: [{ id: "team-notes", tag: "tag-1" }] },
      [`GET /accounts/${ACCOUNT}/builds/workers/tag-1/triggers`]: { body: [] },
    });

    await expect(probeGitIntegration({ token: "cf", accountId: ACCOUNT, fetchImpl })).resolves.toBe(
      "unconfirmed",
    );
  });

  it("stops after the cap instead of walking a large account", async () => {
    // This runs while the user waits, and an account can hold hundreds of Workers.
    const { fetchImpl, calls } = stubFetch({
      [`GET /accounts/${ACCOUNT}/workers/scripts`]: {
        body: Array.from({ length: 30 }, (_unused, index) => ({
          id: `w-${index}`,
          tag: `tag-${index}`,
        })),
      },
      ...Object.fromEntries(
        Array.from({ length: 30 }, (_unused, index) => [
          `GET /accounts/${ACCOUNT}/builds/workers/tag-${index}/triggers`,
          { body: [] },
        ]),
      ),
    });

    await probeGitIntegration({ token: "cf", accountId: ACCOUNT, maxWorkers: 3, fetchImpl });

    const triggerCalls = calls.filter((call) => call.path.includes("/triggers"));
    expect(triggerCalls).toHaveLength(3);
  });

  it("finds the evidence even when the first Workers have no builds", async () => {
    const { fetchImpl } = stubFetch({
      [`GET /accounts/${ACCOUNT}/workers/scripts`]: {
        body: [
          { id: "plain", tag: "tag-a" },
          { id: "built", tag: "tag-b" },
        ],
      },
      [`GET /accounts/${ACCOUNT}/builds/workers/tag-a/triggers`]: { body: [] },
      [`GET /accounts/${ACCOUNT}/builds/workers/tag-b/triggers`]: {
        body: [{ trigger_uuid: "trig-2" }],
      },
    });

    await expect(probeGitIntegration({ token: "cf", accountId: ACCOUNT, fetchImpl })).resolves.toBe(
      "connected",
    );
  });
});

describe("listWorkerScripts", () => {
  it("reads the tag that the Builds API needs, not just the name", async () => {
    // `GET /workers/scripts` calls the Worker's name `id`, and the immutable tag the
    // Builds API insists on `tag`. Mixing those up produces "resource not found" much
    // later, so the mapping is worth pinning down.
    const { fetchImpl } = stubFetch({
      [`GET /accounts/${ACCOUNT}/workers/scripts`]: {
        body: [
          { id: "team-notes", tag: "1a2b3c" },
          { id: "other", tag: "9z8y7x" },
        ],
      },
    });

    await expect(listWorkerScripts({ token: "cf", accountId: ACCOUNT, fetchImpl })).resolves.toEqual([
      { name: "team-notes", tag: "1a2b3c" },
      { name: "other", tag: "9z8y7x" },
    ]);
  });
});

describe("getAccountSubdomain", () => {
  it("explains the one-time dashboard step when no subdomain is registered", async () => {
    const { fetchImpl } = stubFetch({
      [`GET /accounts/${ACCOUNT}/workers/subdomain`]: { body: { subdomain: "" } },
    });

    await expect(
      getAccountSubdomain({ token: "cf", accountId: ACCOUNT, fetchImpl }),
    ).rejects.toThrow(/workers\.dev subdomain/i);
  });
});

describe("ensureWorker", () => {
  it("uploads a placeholder and publishes it on workers.dev", async () => {
    const { fetchImpl, calls } = stubFetch({
      [`GET /accounts/${ACCOUNT}/workers/subdomain`]: { body: { subdomain: "acme" } },
      [`GET /accounts/${ACCOUNT}/workers/scripts`]: { body: [] },
      [`PUT /accounts/${ACCOUNT}/workers/scripts/team-notes`]: { body: { id: "team-notes" } },
      [`POST /accounts/${ACCOUNT}/workers/scripts/team-notes/subdomain`]: {
        body: { enabled: true, previews_enabled: true },
      },
    });

    // The list is empty on the first read and has the Worker on the second, which is
    // how the tag is obtained: the upload response does not carry it.
    let listed = 0;
    const listing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/workers/scripts") && (init?.method ?? "GET") === "GET") {
        listed += 1;
        return new Response(
          JSON.stringify({
            success: true,
            result: listed === 1 ? [] : [{ id: "team-notes", tag: "tag-1" }],
          }),
          { status: 200 },
        );
      }
      return fetchImpl(input, init);
    });

    const worker = await ensureWorker({
      token: "cf",
      accountId: ACCOUNT,
      name: "team-notes",
      fetchImpl: listing as unknown as typeof fetch,
    });

    expect(worker).toEqual({
      url: "https://team-notes.acme.workers.dev",
      scriptTag: "tag-1",
      reused: false,
    });
    // Both flags are sent explicitly. Cloudflare's `previews_enabled` default follows
    // the workers.dev setting, so omitting it would publish a second public address
    // for this app per version — one nobody asked for.
    expect(
      calls.find(
        (call) =>
          call.method === "POST"
          && call.path === `/accounts/${ACCOUNT}/workers/scripts/team-notes/subdomain`,
      )?.body,
    ).toEqual({ enabled: true, previews_enabled: false });
  });

  it("never overwrites a Worker that already exists", async () => {
    // The name collided with something the user already runs. Uploading a placeholder
    // over it would take that down, so the existing script is reported untouched.
    const { fetchImpl, calls } = stubFetch({
      [`GET /accounts/${ACCOUNT}/workers/subdomain`]: { body: { subdomain: "acme" } },
      [`GET /accounts/${ACCOUNT}/workers/scripts`]: { body: [{ id: "team-notes", tag: "tag-9" }] },
    });

    const worker = await ensureWorker({
      token: "cf",
      accountId: ACCOUNT,
      name: "team-notes",
      fetchImpl,
    });

    expect(worker).toEqual({
      url: "https://team-notes.acme.workers.dev",
      scriptTag: "tag-9",
      reused: true,
    });
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("says what to fix when the token is refused", async () => {
    const { fetchImpl } = stubFetch({});
    const denying = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), {
          status: 403,
        }),
    );

    const error = await ensureWorker({
      token: "cf",
      accountId: ACCOUNT,
      name: "team-notes",
      fetchImpl: denying as unknown as typeof fetch,
    }).catch((caught: unknown) => caught);

    expect(fetchImpl).toBeDefined();
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).message).toMatch(/user token/i);
  });
});

describe("connectPushToDeploy", () => {
  const base = {
    token: "cf",
    accountId: ACCOUNT,
    providerAccountId: "4242",
    providerAccountName: "klehmann",
    repoId: "777",
    repoName: "team-notes",
    scriptTag: "tag-1",
    branch: "main",
  };

  it("creates the connection, the trigger, and the build environment", async () => {
    const { fetchImpl, calls } = stubFetch({
      [`GET /accounts/${ACCOUNT}/builds/workers/tag-1/triggers`]: { body: [] },
      [`PUT /accounts/${ACCOUNT}/builds/repos/connections`]: {
        body: { repo_connection_uuid: "conn-1" },
      },
      [`GET /accounts/${ACCOUNT}/builds/tokens`]: { body: [{ build_token_uuid: "bt-1" }] },
      [`POST /accounts/${ACCOUNT}/builds/triggers`]: { body: { trigger_uuid: "trig-1" } },
      [`PATCH /accounts/${ACCOUNT}/builds/triggers/trig-1/environment_variables`]: { body: {} },
    });

    await expect(connectPushToDeploy({ ...base, fetchImpl })).resolves.toEqual({
      repoConnectionUuid: "conn-1",
      triggerUuid: "trig-1",
      buildTokenUuid: "bt-1",
      reused: false,
    });

    const trigger = calls.find((call) => call.path.endsWith("/builds/triggers"))?.body as Record<
      string,
      unknown
    >;
    expect(trigger.external_script_id).toBe("tag-1");
    expect(trigger.branch_includes).toEqual(["main"]);
    // The generated repo ships without a lockfile, so the build installs explicitly
    // instead of relying on Cloudflare's automatic step guessing a package manager.
    expect(trigger.build_command).toContain("pnpm install");
    expect(trigger.deploy_command).toContain("wrangler deploy");

    const env = calls.find((call) => call.path.endsWith("/environment_variables"))?.body as Record<
      string,
      { value: string }
    >;
    expect(env.SKIP_DEPENDENCY_INSTALL.value).toBe("true");
  });

  it("registers the pasted token as a build token when the account has none", async () => {
    // Creating a build token needs an existing Cloudflare token's id, and the only one
    // the builder can identify is the token it was just given — via /user/tokens/verify.
    const { fetchImpl, calls } = stubFetch({
      [`GET /accounts/${ACCOUNT}/builds/workers/tag-1/triggers`]: { body: [] },
      [`PUT /accounts/${ACCOUNT}/builds/repos/connections`]: {
        body: { repo_connection_uuid: "conn-1" },
      },
      [`GET /accounts/${ACCOUNT}/builds/tokens`]: { body: [] },
      "GET /user/tokens/verify": { body: { id: "cf-token-id", status: "active" } },
      [`POST /accounts/${ACCOUNT}/builds/tokens`]: { body: { build_token_uuid: "bt-new" } },
      [`POST /accounts/${ACCOUNT}/builds/triggers`]: { body: { trigger_uuid: "trig-1" } },
      [`PATCH /accounts/${ACCOUNT}/builds/triggers/trig-1/environment_variables`]: { body: {} },
    });

    const result = await connectPushToDeploy({ ...base, fetchImpl });

    expect(result.buildTokenUuid).toBe("bt-new");
    const created = calls.find((call) => call.path.endsWith("/builds/tokens") && call.method === "POST")
      ?.body as Record<string, unknown>;
    expect(created.cloudflare_token_id).toBe("cf-token-id");
  });

  it("leaves an existing trigger alone", async () => {
    // Re-running against a Worker that is already wired up must not add a second
    // trigger, which would deploy every push twice.
    const { fetchImpl, calls } = stubFetch({
      [`GET /accounts/${ACCOUNT}/builds/workers/tag-1/triggers`]: {
        body: [
          {
            trigger_uuid: "trig-existing",
            build_token_uuid: "bt-existing",
            repo_connection: { repo_connection_uuid: "conn-existing" },
          },
        ],
      },
    });

    await expect(connectPushToDeploy({ ...base, fetchImpl })).resolves.toEqual({
      repoConnectionUuid: "conn-existing",
      triggerUuid: "trig-existing",
      buildTokenUuid: "bt-existing",
      reused: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("points at the GitHub App install step when Cloudflare cannot see the account", async () => {
    // Installing the Cloudflare GitHub App has no API — it is a one-time dashboard
    // click — and its absence surfaces as a bare 404 that tells the user nothing.
    const { fetchImpl } = stubFetch({
      [`GET /accounts/${ACCOUNT}/builds/workers/tag-1/triggers`]: { body: [] },
    });

    await expect(connectPushToDeploy({ ...base, fetchImpl })).rejects.toThrow(
      /Install the Cloudflare GitHub App/i,
    );
  });
});
