import { describe, expect, it } from "vitest";

import { buildSetupItems, countBlockers, type SetupInput } from "@/app/setupChecklist";

/** Everything granted: the state a first-time user is working towards. */
function ready(overrides: Partial<SetupInput> = {}): SetupInput {
  return {
    githubConnected: true,
    githubInstallation: "installed",
    githubInstallUrl: "https://github.com/apps/mindoodb-app-builder/installations/new",
    cloudflareConnected: true,
    cloudflareGit: "connected",
    cloudflareDashboardUrl: "https://dash.cloudflare.com/acct-1/workers-and-pages",
    cloudflareRepoAccess: { state: "all" },
    cursorReady: true,
    ...overrides,
  };
}

function item(input: SetupInput, key: string) {
  const found = buildSetupItems(input).find((entry) => entry.key === key);
  if (!found) {
    throw new Error(`no checklist item ${key}`);
  }
  return found;
}

describe("buildSetupItems", () => {
  it("reports every item, not only the outstanding ones", () => {
    // "Ready" and "not checked yet" have to be distinguishable, which a list that
    // vanishes when it passes cannot do.
    const items = buildSetupItems(ready());

    expect(items.map((entry) => entry.key)).toEqual([
      "github-account",
      "github-app",
      "cloudflare-account",
      "cloudflare-git",
      "cloudflare-repo-access",
      "cursor",
    ]);
    expect(items.every((entry) => entry.state === "done")).toBe(true);
    expect(countBlockers(items)).toBe(0);
  });

  it("counts only what would actually stop a build", () => {
    // An unanswered probe and a missing Cursor key are both fine to build without.
    const items = buildSetupItems(
      ready({ cursorReady: false, cloudflareGit: "unconfirmed", githubInstallation: "unknown" }),
    );

    expect(countBlockers(items)).toBe(0);
  });

  it("sends the user to the install page when the builder's app is missing", () => {
    const entry = item(ready({ githubInstallation: "missing" }), "github-app");

    expect(entry.state).toBe("todo");
    expect(entry.actionUrl).toBe(
      "https://github.com/apps/mindoodb-app-builder/installations/new",
    );
    expect(entry.recheck).toBe("github");
  });

  it("treats an unanswerable GitHub lookup as unsure rather than missing", () => {
    // A pasted personal access token has no installation to find, and blocking on that
    // would break a setup that works.
    const entry = item(ready({ githubInstallation: "unknown" }), "github-app");

    expect(entry.state).toBe("unsure");
    expect(entry.actionUrl).toBeUndefined();
  });

  it("blocks on a hand-picked Cloudflare repository list", () => {
    // The one certainty among these checks: the repository does not exist yet, so it
    // cannot be on the list, so the build would connect and never run.
    const entry = item(
      ready({
        cloudflareRepoAccess: {
          state: "selected",
          settingsUrl: "https://github.com/settings/installations/106039904",
        },
      }),
      "cloudflare-repo-access",
    );

    expect(entry.state).toBe("todo");
    expect(entry.actionUrl).toBe("https://github.com/settings/installations/106039904");
  });

  it("asks once, not twice, when Cloudflare's GitHub app is absent altogether", () => {
    // Its absence answers both Cloudflare questions, and one install fixes both.
    const input = ready({
      cloudflareRepoAccess: {
        state: "missing",
        installUrl: "https://github.com/apps/cloudflare-workers-and-pages/installations/new",
      },
    });
    const items = buildSetupItems(input);

    expect(items.some((entry) => entry.key === "cloudflare-repo-access")).toBe(false);
    expect(countBlockers(items)).toBe(1);
    expect(item(input, "cloudflare-git")).toMatchObject({
      state: "todo",
      actionUrl: "https://github.com/apps/cloudflare-workers-and-pages/installations/new",
      recheck: "repoAccess",
    });
  });

  it("prefers GitHub's answer over the build-trigger guess", () => {
    // An account that has never built looks "unconfirmed", but the installation listing
    // proves the connection exists — so the weaker signal must not raise a to-do.
    const items = buildSetupItems(ready({ cloudflareGit: "unconfirmed" }));

    expect(countBlockers(items)).toBe(0);
  });

  it("offers the dashboard while Cloudflare's own connection is unconfirmed", () => {
    // No endpoint lists Git connections, so this stays a question, never an accusation.
    const entry = item(ready({ cloudflareGit: "unconfirmed" }), "cloudflare-git");

    expect(entry.state).toBe("unsure");
    expect(entry.actionUrl).toBe("https://dash.cloudflare.com/acct-1/workers-and-pages");
  });

  it("marks a missing Cursor key optional", () => {
    const entry = item(ready({ cursorReady: false }), "cursor");

    expect(entry.state).toBe("optional");
  });

  it("asks for the accounts themselves before anything else", () => {
    const items = buildSetupItems(ready({ githubConnected: false, cloudflareConnected: false }));

    expect(countBlockers(items)).toBe(2);
    expect(item(ready({ githubConnected: false }), "github-account").detail).toContain(
      "Connect GitHub",
    );
  });
});
