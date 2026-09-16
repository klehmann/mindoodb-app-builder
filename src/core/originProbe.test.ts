import { describe, expect, it, vi } from "vitest";

import { probeOrigin, waitForOrigin } from "@/core/originProbe";

const definition = {
  format: "mindoodb.haven.app",
  formatVersion: 1,
  appId: "team-notes",
  label: "Team Notes",
  databases: [{ logicalDatabaseId: "main", permissions: ["write"] }],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("probeOrigin", () => {
  it("reports ready when the origin serves the expected definition", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(definition));

    const result = await probeOrigin({
      url: "https://team-notes.acme.workers.dev",
      expectedAppId: "team-notes",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.state).toBe("ready");
    expect(result.definition?.label).toBe("Team Notes");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://team-notes.acme.workers.dev/haven-app.json",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("treats a network failure as unreachable rather than throwing", async () => {
    const result = await probeOrigin({
      url: "https://team-notes.acme.workers.dev",
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });

    expect(result.state).toBe("unreachable");
    expect(result.definition).toBeNull();
  });

  it("reports not-published for the placeholder Worker's 404", async () => {
    const result = await probeOrigin({
      url: "https://team-notes.acme.workers.dev",
      fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
    });

    expect(result.state).toBe("not-published");
    expect(result.detail).toContain("404");
  });

  it("reports not-published when the response is not JSON", async () => {
    const result = await probeOrigin({
      url: "https://team-notes.acme.workers.dev",
      fetchImpl: (async () => new Response("<html>placeholder</html>")) as unknown as typeof fetch,
    });

    expect(result.state).toBe("not-published");
  });

  it("surfaces the first validation error for a malformed definition", async () => {
    const result = await probeOrigin({
      url: "https://team-notes.acme.workers.dev",
      fetchImpl: (async () => jsonResponse({ format: "nope" })) as unknown as typeof fetch,
    });

    expect(result.state).toBe("not-published");
    expect(result.detail).toContain("format");
  });

  it("reports a mismatch when the origin serves a different app", async () => {
    const result = await probeOrigin({
      url: "https://someone-elses-app.workers.dev",
      expectedAppId: "team-notes",
      fetchImpl: (async () =>
        jsonResponse({ ...definition, appId: "someone-elses-app" })) as unknown as typeof fetch,
    });

    expect(result.state).toBe("mismatched");
    expect(result.detail).toContain("someone-elses-app");
    expect(result.detail).toContain("team-notes");
  });

  it("accepts a URL that already points at the definition file", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(definition));

    await probeOrigin({
      url: "https://team-notes.acme.workers.dev/haven-app.json",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://team-notes.acme.workers.dev/haven-app.json",
      expect.anything(),
    );
  });

  it("does not probe at all without a URL", async () => {
    const fetchImpl = vi.fn();
    const result = await probeOrigin({
      url: "  ",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.state).toBe("unreachable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("waitForOrigin", () => {
  it("keeps polling while the deploy is still running, then reports ready", async () => {
    const responses = [
      () => new Response("", { status: 404 }),
      () => new Response("<html>placeholder</html>"),
      () => jsonResponse(definition),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!());
    const attempts: string[] = [];

    const result = await waitForOrigin({
      url: "https://team-notes.acme.workers.dev",
      expectedAppId: "team-notes",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      intervalMs: 1,
      sleep: async () => {},
      onAttempt: (probe) => attempts.push(probe.state),
    });

    expect(attempts).toEqual(["not-published", "not-published", "ready"]);
    expect(result.state).toBe("ready");
  });

  it("gives up with the last reason when the budget runs out", async () => {
    let clock = 0;
    const result = await waitForOrigin({
      url: "https://team-notes.acme.workers.dev",
      fetchImpl: (async () => new Response("", { status: 502 })) as unknown as typeof fetch,
      totalTimeoutMs: 10,
      intervalMs: 4,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(result.state).toBe("not-published");
    expect(result.detail).toContain("502");
  });

  it("stops immediately on a mismatch, because waiting cannot fix it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...definition, appId: "wrong-app" }));

    const result = await waitForOrigin({
      url: "https://wrong-app.workers.dev",
      expectedAppId: "team-notes",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });

    expect(result.state).toBe("mismatched");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
