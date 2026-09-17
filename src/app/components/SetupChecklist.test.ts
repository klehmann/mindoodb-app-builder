// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import SetupChecklist from "@/app/components/SetupChecklist.vue";

/**
 * Rendering only — which item says what is `setupChecklist.test.ts`, since that logic is
 * shared with the Create app button and is worth testing without a DOM.
 */
function render(overrides: Partial<InstanceType<typeof SetupChecklist>["$props"]> = {}) {
  return mount(SetupChecklist, {
    props: {
      githubConnected: true,
      githubInstallation: "installed",
      githubInstallUrl: "https://github.com/apps/mindoodb-app-builder/installations/new",
      cloudflareConnected: true,
      cloudflareGit: "connected",
      cloudflareChecking: false,
      cloudflareDashboardUrl: "https://dash.cloudflare.com/acct-1/workers-and-pages",
      cloudflareRepoAccess: { state: "all" } as const,
      cursorReady: true,
      ...overrides,
    },
  });
}

describe("SetupChecklist", () => {
  it("stays visible and says so when nothing is outstanding", () => {
    const panel = render();

    expect(panel.text()).toContain("Ready to build");
    expect(panel.findAll("li")).toHaveLength(6);
    expect(panel.findAll("li.state-done")).toHaveLength(6);
  });

  it("summarises how many items would stop a build", () => {
    const panel = render({
      githubInstallation: "missing",
      cloudflareRepoAccess: {
        state: "selected",
        settingsUrl: "https://github.com/settings/installations/106039904",
      },
    });

    expect(panel.text()).toContain("2 to do");
    expect(panel.findAll("li.state-todo")).toHaveLength(2);
  });

  it("renders an item's action as a real link", () => {
    // A link opens a tab without script, which matters inside Haven's sandboxed frame.
    const panel = render({ githubInstallation: "missing" });
    const link = panel
      .findAll("li")
      .find((li) => li.text().includes("GitHub App installed"))
      ?.find("a.button");

    expect(link?.attributes("href")).toBe(
      "https://github.com/apps/mindoodb-app-builder/installations/new",
    );
    expect(link?.attributes("target")).toBe("_blank");
    expect(link?.attributes("rel")).toBe("noreferrer noopener");
  });

  it("emits a re-check for the item the button belongs to", async () => {
    const panel = render({ githubInstallation: "missing" });

    await panel
      .findAll("button")
      .find((button) => button.text().includes("Check again"))
      ?.trigger("click");

    expect(panel.emitted("recheckGitHub")).toHaveLength(1);
  });

  it("disables the re-check button while that probe runs", () => {
    const panel = render({ cloudflareGit: "unconfirmed", cloudflareChecking: true });
    const recheck = panel.findAll("button").find((button) => button.text().includes("Checking"));

    expect(recheck?.attributes("disabled")).toBeDefined();
  });
});
