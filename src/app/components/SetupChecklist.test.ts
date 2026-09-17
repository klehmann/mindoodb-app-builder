// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import SetupChecklist from "@/app/components/SetupChecklist.vue";

function render(overrides: Partial<InstanceType<typeof SetupChecklist>["$props"]> = {}) {
  return mount(SetupChecklist, {
    props: {
      githubInstallation: "installed",
      githubInstallUrl: "https://github.com/apps/mindoodb-app-builder/installations/new",
      cloudflareGit: "connected",
      cloudflareChecking: false,
      cloudflareDashboardUrl: "https://dash.cloudflare.com/acct-1/workers-and-pages",
      cursorReady: true,
      ...overrides,
    },
  });
}

describe("SetupChecklist", () => {
  it("stays out of the way when every grant is in place", () => {
    expect(render().text()).toBe("");
  });

  it("asks for the GitHub installation when it is missing", () => {
    const panel = render({ githubInstallation: "missing" });

    expect(panel.text()).toContain("Install the builder's GitHub App");
    expect(panel.find("a.button").attributes("href")).toBe(
      "https://github.com/apps/mindoodb-app-builder/installations/new",
    );
  });

  it("says nothing about GitHub while the lookup is inconclusive", () => {
    // "unknown" is both "not asked" and "the lookup failed", and a pasted personal
    // access token has no installation to find. None of those is a missing step.
    expect(render({ githubInstallation: "unknown" }).text()).toBe("");
  });

  it("points at the account's own dashboard page for the Cloudflare step", () => {
    const panel = render({ cloudflareGit: "unconfirmed" });

    expect(panel.text()).toContain("Connect Cloudflare to GitHub");
    expect(panel.find("a.button").attributes("href")).toBe(
      "https://dash.cloudflare.com/acct-1/workers-and-pages",
    );
    // The probe reads evidence, not a record, so the copy has to admit it cannot tell
    // the difference between "not done" and "done before there were any Workers".
    expect(panel.text()).toContain("nothing here could confirm it");
  });

  it("keeps the re-check button quiet while a probe is running", () => {
    const panel = render({ cloudflareGit: "unconfirmed", cloudflareChecking: true });
    const recheck = panel.findAll("button").find((button) => button.text().includes("Checking"));

    expect(recheck?.attributes("disabled")).toBeDefined();
  });

  it("names the Cursor key as optional, since an app is still built without it", () => {
    const panel = render({ cursorReady: false });

    expect(panel.text()).toContain("Add a Cursor API key");
    expect(panel.text()).toContain("Optional");
  });
});
