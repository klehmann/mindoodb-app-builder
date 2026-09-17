// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import AppDetail from "@/app/components/AppDetail.vue";
import { createInitialSteps } from "@/core/createAppFlow";
import { EMPTY_APP_RECORD, type BuilderAppRecord } from "@/core/appRecords";

const liveRecord: BuilderAppRecord = {
  ...EMPTY_APP_RECORD,
  appId: "team-notes",
  label: "Team Notes",
  description: "Shared notes",
  repoUrl: "https://github.com/octocat/team-notes",
  repoName: "team-notes",
  repoOwner: "octocat",
  workerUrl: "https://team-notes.acme.workers.dev",
  workerScriptTag: "tag-1",
  cloudflareAccountId: "acct-1",
  originReady: true,
  wiredForBuild: true,
};

function render(props: Partial<InstanceType<typeof AppDetail>["$props"]> = {}) {
  return mount(AppDetail, {
    props: {
      record: liveRecord,
      steps: createInitialSteps(),
      result: null,
      running: false,
      canPropose: true,
      canForget: true,
      agent: null,
      cursorToken: "",
      builds: null,
      buildsError: null,
      copied: false,
      statusMessage: null,
      ...props,
    },
    global: { stubs: { AgentPanel: true, ProgressPanel: true } },
  });
}

describe("AppDetail", () => {
  it("leads with the address of a live app", () => {
    const wrapper = render();

    expect(wrapper.find(".detail__url").attributes("href")).toBe(
      "https://team-notes.acme.workers.dev",
    );
    expect(wrapper.text()).toContain("Copy address");
  });

  it("offers no address for an app that never went live", () => {
    const wrapper = render({
      record: { ...liveRecord, workerUrl: "", originReady: false, workerScriptTag: "" },
    });

    expect(wrapper.find(".detail__address").exists()).toBe(false);
  });

  it("says what the one button will do, per stage", () => {
    const unbuilt = render({ record: { ...EMPTY_APP_RECORD, label: "Fresh" } });
    expect(unbuilt.find(".detail__continue button").text()).toBe("Build it now");

    const repoOnly = render({
      record: {
        ...EMPTY_APP_RECORD,
        label: "Code only",
        repoUrl: "https://github.com/octocat/code-only",
        repoName: "code-only",
        repoOwner: "octocat",
      },
    });
    expect(repoOnly.find(".detail__continue button").text()).toBe("Publish it");

    const notInHaven = render({ record: liveRecord });
    expect(notInHaven.find(".detail__continue button").text()).toBe("Add it to Haven");
  });

  it("drops the continue button once the app is live and in Haven", () => {
    const wrapper = render({ record: { ...liveRecord, havenInstanceId: "instance-1" } });

    expect(wrapper.find(".detail__continue").exists()).toBe(false);
  });

  it("names the repeat when the app was already installed", () => {
    const wrapper = render({ record: { ...liveRecord, havenInstanceId: "instance-1" } });

    expect(wrapper.text()).toContain("Add to Haven again");
  });

  it("hides adding to Haven when this Haven cannot install apps", () => {
    const wrapper = render({ canPropose: false });

    expect(wrapper.text()).not.toContain("Add to Haven");
    // The address is still there — the user installs it themselves from that.
    expect(wrapper.find(".detail__url").exists()).toBe(true);
  });

  it("confirms the copy on the button itself", () => {
    const wrapper = render({ copied: true });

    expect(wrapper.text()).toContain("Copied");
  });

  it("turns Cloudflare's build status into a sentence", () => {
    const wrapper = render({
      builds: [
        {
          buildUuid: "build-2",
          status: "failed",
          branch: "main",
          createdAt: "2026-02-03T10:00:00.000Z",
        },
      ],
    });

    expect(wrapper.text()).toContain("The last build failed.");
  });

  it("passes an unknown build status through rather than swallowing it", () => {
    const wrapper = render({
      builds: [
        {
          buildUuid: "build-3",
          status: "stranded",
          branch: "main",
          createdAt: "",
        },
      ],
    });

    expect(wrapper.text()).toContain("Last build: stranded.");
  });

  it("says Cloudflare has not built it yet, distinct from not having asked", () => {
    const empty = render({ builds: [] });
    expect(empty.text()).toContain("has not built this app yet");

    const unasked = render({ builds: null });
    expect(unasked.text()).not.toContain("has not built this app yet");
  });

  it("only links the places that exist for this app", () => {
    const wrapper = render({ record: { ...liveRecord, cursorAgentUrl: "" } });

    const links = wrapper.findAll(".detail__link-list a").map((link) => link.text());
    expect(links).toEqual(["The code on GitHub", "Hosting on Cloudflare"]);
  });

  it("asks for a Cursor key instead of offering a button that cannot work", () => {
    const wrapper = render({ cursorToken: "" });

    expect(wrapper.text()).toContain("Needs a Cursor key");
  });

  it("explains that removing an app from the list leaves the app alone", async () => {
    const wrapper = render();

    expect(wrapper.text()).toContain("The app keeps running");
    await wrapper.find(".detail__forget button").trigger("click");
    expect(wrapper.emitted("forget")).toHaveLength(1);
  });

  it("hides removal when the database does not allow it", () => {
    const wrapper = render({ canForget: false });

    expect(wrapper.find(".detail__forget").exists()).toBe(false);
  });

  it("locks the buttons that start work while a run is going", () => {
    const wrapper = render({ running: true, record: { ...liveRecord } });

    const blocked = wrapper
      .findAll("button")
      .filter((button) => button.attributes("disabled") !== undefined)
      .map((button) => button.text());
    expect(blocked).toContain("Working…");
    expect(blocked).toContain("Build now");
  });
});
