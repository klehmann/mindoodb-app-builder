// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ProgressPanel from "@/app/components/ProgressPanel.vue";
import { createInitialSteps, type CreateAppResult } from "@/core/createAppFlow";

const INSTALLATIONS_URL = "github.com/settings/installations";

function result(overrides: Partial<CreateAppResult> = {}): CreateAppResult {
  return {
    steps: createInitialSteps(),
    repository: null,
    worker: null,
    agent: null,
    installedAppInstanceId: null,
    identityCommitted: false,
    warnings: [],
    error: null,
    ...overrides,
  };
}

function render(overrides: Partial<CreateAppResult> = {}) {
  return mount(ProgressPanel, {
    props: { steps: createInitialSteps(), result: result(overrides), running: false },
  });
}

/**
 * A run's warnings accumulate across the presses it took: the access check fails on one,
 * the origin wait on the next, and both land on this panel together. They used to explain
 * the same remedy twice, in different words and with the two options in opposite orders.
 */
describe("ProgressPanel AI developer link", () => {
  it("turns the Cursor run URL into a link so the user can watch it work", () => {
    const steps = createInitialSteps();
    const launch = steps.find((step) => step.id === "launch-agent")!;
    launch.status = "done";
    launch.detail = {
      code: "agentStarted",
      params: { url: "https://cursor.com/agents/bc-1" },
    };

    const panel = mount(ProgressPanel, {
      props: { steps, result: result(), running: false },
    });

    const link = panel.find(".step__detail a");
    expect(link.attributes("href")).toBe("https://cursor.com/agents/bc-1");
    expect(link.attributes("target")).toBe("_blank");
    expect(link.text()).toContain("https://cursor.com/agents/bc-1");
    expect(link.text()).toContain("Watch it work");
  });

  it("does not link a non-http agent URL", () => {
    const steps = createInitialSteps();
    const launch = steps.find((step) => step.id === "launch-agent")!;
    launch.status = "done";
    launch.detail = {
      code: "agentStarted",
      params: { url: "javascript:alert(1)" },
    };

    const panel = mount(ProgressPanel, {
      props: { steps, result: result(), running: false },
    });

    expect(panel.find(".step__detail a").exists()).toBe(false);
  });
});

describe("ProgressPanel repeated advice", () => {
  it("gives the access remedy once when both notes are on screen", () => {
    const panel = render({
      warnings: [
        { code: "repoAccessFix", params: { fullName: "octocat/team-notes", said: "" } },
        { code: "originBuildLogHint" },
      ],
    });

    const text = panel.text();
    expect(text.split(INSTALLATIONS_URL)).toHaveLength(2);
    // The later note keeps what only it says: where to look, and which button.
    expect(text).toContain("Builds");
  });

  it("still gives the remedy when the later note is the only one carrying it", () => {
    const panel = render({ warnings: [{ code: "originBuildLogHint" }] });

    expect(panel.text()).toContain(INSTALLATIONS_URL);
  });

  it("counts the remedy as shown when it is the reason the run stopped", () => {
    // `deployNow` aborts on an unreadable repository, putting the fix on the error line
    // rather than in the warning list.
    const panel = render({
      error: { code: "repoAccessFix", params: { fullName: "octocat/team-notes", said: "" } },
      warnings: [{ code: "originBuildLogHint" }],
    });

    expect(panel.text().split(INSTALLATIONS_URL)).toHaveLength(2);
  });
});
