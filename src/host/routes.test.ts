import { describe, expect, it, vi } from "vitest";

import { handleApiRequest } from "@/host/routes";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const agentPayload = {
  agent: {
    id: "bc-1",
    name: "Team Notes",
    status: "ACTIVE",
    url: "https://cursor.com/agents/bc-1",
    latestRunId: "run-1",
  },
  run: { id: "run-1", agentId: "bc-1", status: "CREATING" },
};

describe("handleApiRequest", () => {
  it("answers the health check without a token", async () => {
    await expect(handleApiRequest({ method: "GET", pathname: "/api/health", body: {} })).resolves
      .toEqual({ status: 200, payload: { ok: true } });
  });

  it("rejects a GET on a token-bearing route rather than reading query strings", async () => {
    const result = await handleApiRequest({
      method: "GET",
      pathname: "/api/cursor/agents",
      body: {},
    });
    expect(result.status).toBe(405);
  });

  it("reports an unknown endpoint", async () => {
    const result = await handleApiRequest({
      method: "POST",
      pathname: "/api/nope",
      body: {},
    });
    expect(result.status).toBe(404);
  });

  describe("/api/cursor/agents", () => {
    it("launches an agent against the repository", async () => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => json(agentPayload));

      const result = await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/agents",
        body: {
          cursorToken: "crsr_key",
          repositoryUrl: "https://github.com/octocat/team-notes",
          branch: "main",
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        agent: { id: "bc-1", url: "https://cursor.com/agents/bc-1" },
        run: { id: "run-1", status: "CREATING" },
      });

      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe("https://api.cursor.com/v1/agents");
      const sent = JSON.parse(String((init!).body));
      expect(sent.repos).toEqual([
        { url: "https://github.com/octocat/team-notes", startingRef: "main" },
      ]);
      expect(sent.prompt.text).toContain("AGENTS.md");
    });

    it("never forwards credentials into the agent's environment", async () => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => json(agentPayload));

      await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/agents",
        body: {
          cursorToken: "crsr_key",
          repositoryUrl: "https://github.com/octocat/team-notes",
          githubToken: "ghp_secret",
          cloudflareToken: "cf_secret",
          envVars: { CLOUDFLARE_API_TOKEN: "cf_secret" },
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const sent = String(fetchImpl.mock.calls[0]![1]!.body);
      expect(sent).not.toContain("ghp_secret");
      expect(sent).not.toContain("cf_secret");
      expect(sent).not.toContain("envVars");
    });

    it("requires a repository URL", async () => {
      const result = await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/agents",
        body: { cursorToken: "crsr_key" },
      });
      expect(result.status).toBe(400);
      expect(result.payload).toMatchObject({ error: expect.stringContaining("repository") });
    });

    it("requires a Cursor key", async () => {
      const result = await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/agents",
        body: { repositoryUrl: "https://github.com/octocat/team-notes" },
      });
      expect(result.status).toBe(400);
    });

    it("passes plan mode through but ignores an unknown mode", async () => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => json(agentPayload));

      await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/agents",
        body: {
          cursorToken: "crsr_key",
          repositoryUrl: "https://github.com/octocat/team-notes",
          mode: "plan",
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).mode).toBe(
        "plan",
      );

      fetchImpl.mockClear();
      await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/agents",
        body: {
          cursorToken: "crsr_key",
          repositoryUrl: "https://github.com/octocat/team-notes",
          mode: "sudo",
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(
        JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).mode,
      ).toBeUndefined();
    });

    it("passes an authentication failure through with its status", async () => {
      const result = await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/agents",
        body: {
          cursorToken: "wrong",
          repositoryUrl: "https://github.com/octocat/team-notes",
        },
        fetchImpl: (async () =>
          json({ error: { message: "Invalid API key" } }, 401)) as unknown as typeof fetch,
      });

      expect(result.status).toBe(401);
      expect(result.payload).toMatchObject({ error: "Invalid API key" });
    });
  });

  describe("/api/cursor/follow-up", () => {
    it("sends the follow-up to the existing agent", async () => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        json({ run: { id: "run-2", agentId: "bc-1", status: "CREATING" } }),
      );

      const result = await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/follow-up",
        body: { cursorToken: "crsr_key", agentId: "bc-1", prompt: "Add a search box" },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result.status).toBe(200);
      expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.cursor.com/v1/agents/bc-1/runs");
      expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({
        prompt: { text: "Add a search box" },
      });
    });

    it("keeps Cursor's 409 so the UI can say the agent is still working", async () => {
      const result = await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/follow-up",
        body: { cursorToken: "crsr_key", agentId: "bc-1", prompt: "again" },
        fetchImpl: (async () =>
          json(
            { error: { message: "Agent is busy", code: "agent_busy" } },
            409,
          )) as unknown as typeof fetch,
      });

      expect(result.status).toBe(409);
      expect(result.payload).toMatchObject({ code: "agent_busy" });
    });

    it("needs both an agent and something to say", async () => {
      await expect(
        handleApiRequest({
          method: "POST",
          pathname: "/api/cursor/follow-up",
          body: { cursorToken: "k", prompt: "hi" },
        }),
      ).resolves.toMatchObject({ status: 400 });

      await expect(
        handleApiRequest({
          method: "POST",
          pathname: "/api/cursor/follow-up",
          body: { cursorToken: "k", agentId: "bc-1", prompt: "   " },
        }),
      ).resolves.toMatchObject({ status: 400 });
    });
  });

  describe("/api/cursor/status", () => {
    it("reads the agent, then its latest run when no run was given", async () => {
      const fetchImpl = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/v1/agents/bc-1")) {
          return json({ id: "bc-1", status: "IDLE", url: "u", latestRunId: "run-7" });
        }
        return json({
          id: "run-7",
          agentId: "bc-1",
          status: "FINISHED",
          result: "Implemented the notes list.",
          git: {
            branches: [
              {
                repoUrl: "github.com/octocat/team-notes",
                branch: "cursor/notes-a1b2",
                prUrl: "https://github.com/octocat/team-notes/pull/1",
              },
            ],
          },
        });
      });

      const result = await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/status",
        body: { cursorToken: "crsr_key", agentId: "bc-1" },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        agent: { status: "IDLE" },
        run: {
          status: "FINISHED",
          result: "Implemented the notes list.",
          branches: [
            {
              branch: "cursor/notes-a1b2",
              prUrl: "https://github.com/octocat/team-notes/pull/1",
            },
          ],
        },
      });
    });

    it("returns a null run for an agent that has not run yet", async () => {
      const result = await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/status",
        body: { cursorToken: "crsr_key", agentId: "bc-1" },
        fetchImpl: (async () => json({ id: "bc-1", status: "ACTIVE" })) as unknown as typeof fetch,
      });

      expect(result.payload).toMatchObject({ run: null });
    });
  });

  describe("/api/cursor/verify", () => {
    it("returns the account the key belongs to", async () => {
      const result = await handleApiRequest({
        method: "POST",
        pathname: "/api/cursor/verify",
        body: { cursorToken: "crsr_key" },
        fetchImpl: (async () => json({ email: "dev@example.com" })) as unknown as typeof fetch,
      });

      expect(result).toEqual({ status: 200, payload: { email: "dev@example.com" } });
    });
  });
});
