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
      "cursor",
      "cursor-github",
    ]);
    expect(items.filter((entry) => entry.key !== "cursor-github").every((entry) => entry.state === "done")).toBe(true);
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

  it('states the "All repositories" requirement without claiming to have checked it', () => {
    // This replaced a check that could not exist. `GET /user/installations` lists only
    // installations of the app the token belongs to, so asking it about Cloudflare's app
    // always came back empty, and the checklist told every user — including ones who had
    // just granted access to all their repositories — to go and install it. The
    // requirement is real, so it is stated; it is not observable, so it never blocks.
    const items = buildSetupItems(ready());

    expect(items.some((entry) => entry.key === "cloudflare-repo-access")).toBe(false);
    expect(item(ready(), "cloudflare-git").detail).toContain("All repositories");
    expect(item(ready({ cloudflareGit: "unconfirmed" }), "cloudflare-git").detail).toContain(
      "All repositories",
    );
    expect(countBlockers(buildSetupItems(ready({ cloudflareGit: "unconfirmed" })))).toBe(0);
  });

  it("offers the dashboard while Cloudflare's own connection is unconfirmed", () => {
    // No endpoint lists Git connections, so this stays a question, never an accusation.
    const entry = item(ready({ cloudflareGit: "unconfirmed" }), "cloudflare-git");

    expect(entry.state).toBe("unsure");
    expect(entry.actionUrl).toBe(
      "https://github.com/apps/cloudflare-workers-and-pages/installations/new",
    );
  });

  it("marks a missing Cursor key optional", () => {
    const entry = item(ready({ cursorReady: false }), "cursor");

    expect(entry.state).toBe("optional");
  });

  it("states that Cursor needs its own GitHub App for private repositories", () => {
    // Same reason Cloudflare does: GitHub grants automatic access only to
    // repositories an app creates itself, and this builder never gives Cursor a
    // token. The item never blocks — nothing here can see Cursor's installation.
    const entry = item(ready(), "cursor-github");

    expect(entry.state).toBe("optional");
    expect(entry.actionUrl).toBe("https://github.com/apps/cursor/installations/new");
    expect(entry.detail).toContain("All repositories");
    expect(countBlockers(buildSetupItems(ready()))).toBe(0);
  });

  it("on the precise path, points Cloudflare and Cursor at adding the new repository", () => {
    const input = ready({ accessPath: "precise", cloudflareGit: "unconfirmed" });

    expect(item(input, "cloudflare-git").actionUrl).toBe(
      "https://github.com/apps/cloudflare-workers-and-pages/installations/new",
    );
    expect(item(input, "cloudflare-git").detail).toContain("settings/installations");
    expect(item(ready({ accessPath: "precise" }), "cursor-github").actionLabel).toBe(
      "Add a repository",
    );
  });

  it("asks for the accounts themselves before anything else", () => {
    const items = buildSetupItems(ready({ githubConnected: false, cloudflareConnected: false }));

    expect(countBlockers(items)).toBe(2);
    expect(item(ready({ githubConnected: false }), "github-account").detail).toContain(
      "Connect GitHub",
    );
  });
});
