import { describe, expect, it, vi } from "vitest";

import {
  checkRepoReadable,
  startBuild,
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

describe("checkRepoReadable", () => {
  const AUTOFILL = "GET /accounts/acct-1/builds/repos/github/4291861/987/config_autofill";

  /**
   * `stubFetch` wraps every body as a successful envelope, which is exactly what these
   * cases need to contradict: the interesting input is Cloudflare's error envelope, and
   * its `code` is what separates "no access" from "no such endpoint".
   */
  function refusingFetch(status: number, code: number, message: string): typeof fetch {
    return vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status }),
    ) as unknown as typeof fetch;
  }

  function ask(fetchImpl: typeof fetch) {
    return checkRepoReadable({
      token: "cf-token",
      accountId: "acct-1",
      providerAccountId: "4291861",
      repoId: "987",
      branch: "main",
      fetchImpl,
    });
  }

  it("reads as readable when Cloudflare can analyse the repository", async () => {
    // Success here is end-to-end evidence: Cloudflare had to reach the repository
    // through its own GitHub App to answer at all.
    const { fetchImpl, calls } = stubFetch({
      [AUTOFILL]: { body: { success: true, result: { build_command: "npm run build" } } },
    });

    await expect(ask(fetchImpl)).resolves.toMatchObject({ state: "readable" });
    expect(calls).toHaveLength(1);
  });

  it("asks about the repository's own default branch", async () => {
    const { fetchImpl } = stubFetch({
      [AUTOFILL]: { body: { success: true, result: {} } },
    });

    await ask(fetchImpl);

    // The branch travels as a query parameter, which the path-keyed stub drops — so
    // assert on the call itself rather than on the route.
    const url = vi.mocked(fetchImpl).mock.calls[0][0];
    expect(String(url)).toContain("config_autofill?branch=main");
  });

  it("reads a refusal as unreadable, and quotes Cloudflare", async () => {
    // What a repository outside Cloudflare's installation looks like. The message is
    // kept because the user has no other way to see what Cloudflare actually said.
    await expect(ask(refusingFetch(404, 8000000, "Repository not found"))).resolves.toEqual({
      state: "unreadable",
      detail: "Repository not found",
    });
  });

  it("treats a routing error as unknown rather than as no access", async () => {
    // 7000 and 7003 are Cloudflare's "no route for that URI" and "could not route to".
    // That is what a moved endpoint looks like, and reading it as "no access" would
    // invent a problem in every build the day Cloudflare changes the path.
    await expect(
      ask(refusingFetch(404, 7000, "No route for that URI")),
    ).resolves.toMatchObject({ state: "unknown" });
  });

  it("treats a token problem as unknown, because it says nothing about the repository", async () => {
    await expect(
      ask(refusingFetch(401, 10000, "Authentication error")),
    ).resolves.toMatchObject({ state: "unknown" });
  });

  it("treats an unreachable Cloudflare as unknown", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;

    await expect(ask(fetchImpl)).resolves.toMatchObject({ state: "unknown" });
  });
});

describe("startBuild", () => {
  const TRIGGERS = `GET /accounts/${ACCOUNT}/builds/workers/tag-1/triggers`;

  function build(fetchImpl: typeof fetch) {
    return startBuild({
      token: "cf-token",
      accountId: ACCOUNT,
      scriptTag: "tag-1",
      branch: "main",
      fetchImpl,
    });
  }

  it("builds the branch through the trigger that covers it", async () => {
    const { fetchImpl, calls } = stubFetch({
      [TRIGGERS]: { body: [{ trigger_uuid: "trig-1", branch_includes: ["main"] }] },
      [`POST /accounts/${ACCOUNT}/builds/triggers/trig-1/builds`]: {
        body: { build_uuid: "build-1" },
      },
    });

    await expect(build(fetchImpl)).resolves.toEqual({ buildUuid: "build-1" });
    // Cloudflare requires a branch or a commit; without one it has nothing to check out.
    expect(calls[1].body).toEqual({ branch: "main" });
  });

  it("prefers the production trigger over a preview trigger", async () => {
    // A preview trigger catches every branch with `*` and deploys with
    // `wrangler versions upload`, which uploads a version without publishing it — so
    // building through it would leave the app just as unreachable as before.
    const { fetchImpl, calls } = stubFetch({
      [TRIGGERS]: {
        body: [
          { trigger_uuid: "preview", branch_includes: ["*"], branch_excludes: ["main"] },
          { trigger_uuid: "production", branch_includes: ["main"] },
        ],
      },
      [`POST /accounts/${ACCOUNT}/builds/triggers/production/builds`]: {
        body: { build_uuid: "build-2" },
      },
    });

    await expect(build(fetchImpl)).resolves.toEqual({ buildUuid: "build-2" });
    expect(calls[1].path).toContain("/triggers/production/builds");
  });

  it("falls back to a catch-all trigger", async () => {
    const { fetchImpl } = stubFetch({
      [TRIGGERS]: { body: [{ trigger_uuid: "any", branch_includes: ["*"] }] },
      [`POST /accounts/${ACCOUNT}/builds/triggers/any/builds`]: { body: { build_uuid: "b" } },
    });

    await expect(build(fetchImpl)).resolves.toEqual({ buildUuid: "b" });
  });

  it("says what to do when the Worker has no trigger for the branch", async () => {
    // Builds belong to a trigger, so there is nothing to start — and "resource not
    // found" would leave the user looking in the wrong place.
    const { fetchImpl } = stubFetch({
      [TRIGGERS]: { body: [{ trigger_uuid: "other", branch_includes: ["release"] }] },
    });

    await expect(build(fetchImpl)).rejects.toThrow(/no build trigger for main/);
  });
});
