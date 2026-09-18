// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import NewAppView from "@/app/components/NewAppView.vue";
import { createInitialSteps, type CreateAppResult } from "@/core/createAppFlow";

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

function render(props: Partial<InstanceType<typeof NewAppView>["$props"]> = {}) {
  return mount(NewAppView, {
    props: {
      form: {
        label: "Team Notes",
        slug: "team-notes",
        slugFollowsLabel: true,
        description: "",
        task: "",
        private: true,
      },
      plannedRepositoryName: "team-notes",
      formError: null,
      createError: null,
      canCreate: true,
      running: false,
      steps: createInitialSteps(),
      result: null,
      cursorReady: true,
      narrowAccess: false,
      canBuildNow: false,
      ...props,
    },
  });
}

/** The one button that replaced four pages of them. */
function buildButton(wrapper: ReturnType<typeof render>) {
  return wrapper.findAll("button").find((button) => button.text().startsWith("Build"))!;
}

describe("NewAppView", () => {
  it("creates an app from one button", async () => {
    const wrapper = render();

    await buildButton(wrapper).trigger("click");

    expect(wrapper.emitted("create")).toHaveLength(1);
  });

  it("promises the AI step only when Cursor is connected", () => {
    expect(render().text()).toContain("set the AI developer to work on it");
    expect(render({ cursorReady: false }).text()).not.toContain("set the AI developer");
  });

  it("warns up front that per-repository access will interrupt the run", () => {
    expect(render({ narrowAccess: true }).text()).toContain("allow Cloudflare");
    expect(render().text()).not.toContain("allow Cloudflare");
  });

  it("drops the upfront explanations once the run is underway", () => {
    const steps = createInitialSteps();
    steps[0]!.status = "running";

    const wrapper = render({ steps, narrowAccess: true, running: true });

    expect(wrapper.text()).not.toContain("This takes a couple of minutes");
    expect(wrapper.text()).not.toContain("allow Cloudflare");
    expect(buildButton(wrapper).text()).toBe("Building your app…");
  });

  it("blocks the button until the app has a name and the accounts are connected", () => {
    const wrapper = render({ canCreate: false });

    expect(buildButton(wrapper).attributes("disabled")).toBeDefined();
  });

  it("shows why it cannot start instead of the reassuring blurb", () => {
    const wrapper = render({ createError: "Connect Cloudflare to publish your app." });

    expect(wrapper.text()).toContain("Connect Cloudflare to publish your app.");
    expect(wrapper.text()).not.toContain("This takes a couple of minutes");
  });

  it("hands the finished app over to its own page", async () => {
    const steps = createInitialSteps();
    steps.forEach((step) => (step.status = "done"));
    const wrapper = render({
      steps,
      result: result({
        steps,
        worker: { url: "https://team-notes.acme.workers.dev", scriptTag: "tag", reused: false },
      }),
    });

    await wrapper.findAll("button").find((b) => b.text() === "Open my new app")!.trigger("click");

    expect(wrapper.emitted("openApp")).toHaveLength(1);
  });

  it("offers the retry when the app was wired but never built", async () => {
    const steps = createInitialSteps();
    steps[0]!.status = "done";
    const wrapper = render({ steps, result: result({ steps }), canBuildNow: true });

    const retry = wrapper.findAll("button").find((b) => b.text() === "Try publishing again")!;
    await retry.trigger("click");

    expect(wrapper.emitted("buildNow")).toHaveLength(1);
  });

  it("hides the retry while nothing can be built", () => {
    const steps = createInitialSteps();
    steps[0]!.status = "done";

    expect(render({ steps, result: result({ steps }) }).text()).not.toContain(
      "Try publishing again",
    );
  });

  it("does not offer the finished app while the run is still going", () => {
    const steps = createInitialSteps();
    steps[0]!.status = "done";
    const wrapper = render({
      steps,
      running: true,
      result: result({
        steps,
        worker: { url: "https://team-notes.acme.workers.dev", scriptTag: "tag", reused: false },
      }),
    });

    expect(wrapper.text()).not.toContain("Open my new app");
  });
});
