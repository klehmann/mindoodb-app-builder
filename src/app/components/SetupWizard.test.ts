// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { VueWrapper } from "@vue/test-utils";

import SetupWizard from "@/app/components/SetupWizard.vue";
import type { WizardReadiness } from "@/app/wizard";

function readiness(overrides: Partial<WizardReadiness> = {}): WizardReadiness {
  return {
    githubConnected: false,
    githubInstallation: "unknown",
    cloudflareConnected: false,
    cloudflareGit: "unknown",
    cursorReady: false,
    identityValid: false,
    hasRepository: false,
    hasLiveOrigin: false,
    ...overrides,
  };
}

function render(state: WizardReadiness = readiness()) {
  window.localStorage.clear();
  return mount(SetupWizard, {
    props: { readiness: state },
    slots: {
      details: "<p>details-slot</p>",
      github: "<p>github-slot</p>",
      cloudflare: "<p>cloudflare-slot</p>",
      cursor: "<p>cursor-slot</p>",
    },
  });
}

/** The forward button is the last one in the nav; its label changes per page. */
function forward(panel: VueWrapper) {
  return panel.find(".nav__next");
}

describe("SetupWizard", () => {
  it("opens on an introduction that says what the builder is for", () => {
    const panel = render();

    expect(panel.text()).toContain("Add your own app to Haven");
    expect(panel.text()).toContain("collaborative workspace");
    expect(panel.text()).toContain("No programming skills are needed");
    // The two promises end users care about: it keeps growing, and sharing is a link.
    expect(panel.text()).toContain("not a one-off");
    expect(panel.text()).toContain("Email that link");
    expect(panel.text()).toContain("three free accounts");
  });

  it("admits the next pages are technical and says why", () => {
    const panel = render();

    expect(panel.text()).toContain("a little technical");
    expect(panel.text()).toContain("working on making this shorter");
  });

  it("requires a name before leaving app details, not an install we cannot see", async () => {
    const panel = render();

    await forward(panel).trigger("click");
    expect(panel.text()).toContain("details-slot");
    expect(forward(panel).attributes("disabled")).toBeDefined();
  });

  it("lets the user skip GitHub App grants once a name exists", async () => {
    const panel = render(
      readiness({
        identityValid: true,
        githubInstallation: "missing",
        cloudflareGit: "unconfirmed",
      }),
    );

    await forward(panel).trigger("click");
    expect(panel.text()).toContain("details-slot");

    await forward(panel).trigger("click");
    expect(panel.text()).toContain("github-slot");

    await forward(panel).trigger("click");
    expect(panel.text()).toContain("cloudflare-slot");

    await forward(panel).trigger("click");
    expect(panel.text()).toContain("cursor-slot");
  });

  it("names the page the user is going to next", async () => {
    const panel = render(readiness({ identityValid: true }));

    expect(forward(panel).text()).toContain("start");

    await forward(panel).trigger("click");
    expect(forward(panel).text()).toBe("Continue to GitHub");
  });

  it("skips the pitch when the app is already live", async () => {
    window.localStorage.clear();
    window.localStorage.setItem("mindoodb-app-builder.wizard-seen", "1");

    const panel = mount(SetupWizard, {
      props: {
        readiness: readiness({
          identityValid: true,
          hasRepository: true,
          hasLiveOrigin: true,
        }),
      },
      slots: { cursor: "<p>cursor-slot</p>" },
    });
    await panel.vm.$nextTick();

    expect(panel.text()).toContain("cursor-slot");
    expect(panel.text()).not.toContain("Add your own app to Haven");
  });
});
