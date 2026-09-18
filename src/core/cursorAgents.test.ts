import { describe, expect, it, vi } from "vitest";

import {
  buildLaunchPrompt,
  CURSOR_DEFAULT_MODEL_ID,
  explainCursorLaunchError,
  launchAgent,
} from "./cursorAgents";

describe("explainCursorLaunchError", () => {
  it("leaves an unrelated failure alone", () => {
    expect(explainCursorLaunchError("Cursor rate limit reached", 429)).toBe(
      "Cursor rate limit reached",
    );
  });

  it("says which GitHub App is missing when Cursor cannot see the repository", () => {
    // The builder's token is never sent. A private repository it just created is
    // therefore invisible until Cursor's own installation can see it.
    const explained = explainCursorLaunchError("Cursor was not able to access the repo", 400);

    expect(explained).toContain("github.com/apps/cursor/installations/new");
    expect(explained).toContain("All repositories");
    expect(explained).toContain("Cursor was not able to access the repo");
  });
});

/**
 * The failure these pin has no error anywhere: Cursor's `workOnCurrentBranch` defaults
 * to `false`, which pushes to a generated `cursor/...` branch. Cloudflare Workers Builds
 * deploys on a push to the default branch, so the agent finishes, the app never changes,
 * and nothing reports a problem. Sending the field is the whole fix.
 */
describe("launchAgent", () => {
  function fakeFetch() {
    return vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          agent: { id: "bc-1", url: "https://cursor.com/agents/bc-1" },
          run: { id: "run-1", agentId: "bc-1", status: "RUNNING" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  function bodyOf(fetchImpl: ReturnType<typeof fakeFetch>): Record<string, unknown> {
    const init = fetchImpl.mock.calls[0]![1];
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
  }

  it("pushes to the repository's own branch and opens no pull request", async () => {
    const fetchImpl = fakeFetch();

    await launchAgent({
      apiKey: "key",
      repositoryUrl: "https://github.com/octocat/team-notes",
      branch: "main",
      fetchImpl,
    });

    const body = bodyOf(fetchImpl);
    expect(body.workOnCurrentBranch).toBe(true);
    expect(body.autoCreatePR).toBe(false);
    expect(body.model).toEqual({ id: CURSOR_DEFAULT_MODEL_ID });
    expect(CURSOR_DEFAULT_MODEL_ID).toBe("grok-4.6");
    expect(body.repos).toEqual([
      { url: "https://github.com/octocat/team-notes", startingRef: "main" },
    ]);
  });

  it("sends both fields even when the caller mentions neither", async () => {
    // Omitting them is what caused the bug: an absent field is Cursor's default, not
    // ours, and the default is the branch nothing deploys from.
    const fetchImpl = fakeFetch();

    await launchAgent({ apiKey: "key", repositoryUrl: "https://github.com/o/r", fetchImpl });

    const body = bodyOf(fetchImpl);
    expect(body).toHaveProperty("workOnCurrentBranch", true);
    expect(body).toHaveProperty("autoCreatePR", false);
  });

  it("still lets a caller ask for a pull request", async () => {
    const fetchImpl = fakeFetch();

    await launchAgent({
      apiKey: "key",
      repositoryUrl: "https://github.com/o/r",
      branch: "main",
      workOnCurrentBranch: false,
      autoCreatePR: true,
      fetchImpl,
    });

    const body = bodyOf(fetchImpl);
    expect(body.workOnCurrentBranch).toBe(false);
    expect(body.autoCreatePR).toBe(true);
  });

  it("tells the agent the same thing the launch options do", async () => {
    // The agent has git and can open a PR by hand, so the prompt has to say it too.
    const fetchImpl = fakeFetch();

    await launchAgent({
      apiKey: "key",
      repositoryUrl: "https://github.com/o/r",
      branch: "trunk",
      fetchImpl,
    });

    const body = bodyOf(fetchImpl);
    const text = (body.prompt as { text: string }).text;
    expect(text).toContain("push to trunk directly");
    expect(text).toContain("Do not create a pull request");
  });

  it("leaves a caller's own prompt alone", async () => {
    const fetchImpl = fakeFetch();

    await launchAgent({
      apiKey: "key",
      repositoryUrl: "https://github.com/o/r",
      prompt: "  Add a health check  ",
      fetchImpl,
    });

    const body = bodyOf(fetchImpl);
    expect((body.prompt as { text: string }).text).toBe("Add a health check");
  });

  it("lets a caller pick a different model without dropping the default for everyone else", async () => {
    const fetchImpl = fakeFetch();

    await launchAgent({
      apiKey: "key",
      repositoryUrl: "https://github.com/o/r",
      model: { id: "composer-2.5" },
      fetchImpl,
    });

    expect(bodyOf(fetchImpl).model).toEqual({ id: "composer-2.5" });
  });
});

describe("buildLaunchPrompt", () => {
  it("names the default branch when the caller gives none", () => {
    expect(buildLaunchPrompt()).toContain("push to main directly");
  });
});
