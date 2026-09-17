// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { describe, expect, it } from "vitest";

import ConnectPanel from "@/app/components/ConnectPanel.vue";
import type { BuilderHostConfig } from "@/app/hostApi";
import type { UseCloudflareConnectReturn } from "@/app/useCloudflareConnect";
import type { UseGitHubConnectReturn } from "@/app/useGitHubConnect";
import { EMPTY_CREDENTIALS, readCredentialsStatus } from "@/core/credentials";

function githubConnect(
  overrides: Partial<UseGitHubConnectReturn> = {},
): UseGitHubConnectReturn {
  const status = ref<"idle">("idle");
  return {
    status,
    userCode: ref(""),
    verificationUri: ref("https://github.com/login/device"),
    error: ref(null),
    busy: computed(() => false),
    start: async () => {},
    cancel: () => {},
    installation: ref("unknown"),
    installUrl: computed(() => "https://github.com/apps/mindoodb-app-builder/installations/new"),
    checkInstallation: async () => {},
    ...overrides,
  };
}

function cloudflareConnect(): UseCloudflareConnectReturn {
  return {
    status: ref("idle"),
    error: ref(null),
    accounts: ref([]),
    busy: computed(() => false),
    connect: async () => {},
    cancel: () => {},
  };
}

function config(overrides: Partial<BuilderHostConfig> = {}): BuilderHostConfig {
  return {
    oauth: {
      github: true,
      cloudflare: true,
      cloudflareRedirectUri: "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
    },
    cloudflareClientId: "cf-client",
    cloudflareScopes: ["account.read"],
    githubAppSlug: "mindoodb-app-builder",
    ...overrides,
  };
}

function render(props: {
  config: BuilderHostConfig | null;
  configLoaded: boolean;
  github?: UseGitHubConnectReturn;
}) {
  return mount(ConnectPanel, {
    props: {
      credentials: { ...EMPTY_CREDENTIALS },
      status: readCredentialsStatus(EMPTY_CREDENTIALS),
      canStore: true,
      saving: false,
      github: props.github ?? githubConnect(),
      cloudflare: cloudflareConnect(),
      cloudflareAccounts: [],
      ...props,
    },
  });
}

describe("ConnectPanel", () => {
  it("offers both connect buttons when the builder is registered", () => {
    const panel = render({ config: config(), configLoaded: true });
    const labels = panel.findAll("button").map((button) => button.text());

    expect(labels).toContain("Connect GitHub");
    expect(labels).toContain("Connect Cloudflare");
  });

  it("falls back to token fields when nothing is registered", () => {
    // The bug this pins: with no client ids, the sections used to render as bare
    // headings — no button, no field, no explanation. A deployment before its
    // applications exist is a normal state and has to be usable.
    const unregistered = config({
      oauth: {
        github: false,
        cloudflare: false,
        cloudflareRedirectUri: "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
      },
      cloudflareClientId: "",
    });
    const panel = render({ config: unregistered, configLoaded: true });

    expect(panel.find("#github-token").exists()).toBe(true);
    expect(panel.find("#cf-token").exists()).toBe(true);
    expect(panel.find("#cf-account").exists()).toBe(true);
    expect(panel.text()).toContain("no GitHub application registered");
    expect(panel.text()).toContain("no Cloudflare OAuth client registered");
  });

  it("says nothing about registration until the config has been read", () => {
    // An unreachable host and a host that has not answered yet look identical from
    // here, so neither may be reported as "nothing is registered".
    const panel = render({ config: null, configLoaded: false });

    expect(panel.text()).not.toContain("no GitHub application registered");
    expect(panel.find("#github-token").exists()).toBe(false);
    expect(panel.text()).toContain("Checking what this builder can connect to");
  });

  it("still shows the token fields when a host cannot be reached at all", () => {
    const panel = render({ config: null, configLoaded: true });

    expect(panel.find("#github-token").exists()).toBe(true);
    expect(panel.find("#cf-token").exists()).toBe(true);
  });

  it("leaves the missing installation to the setup list below it", () => {
    // A GitHub App user token with no installation has no repository permissions, which
    // GitHub reports as "Resource not accessible by integration" once a build is already
    // underway — worth catching early, but in one place. `SetupChecklist` owns it, and a
    // second warning here would make one install look like two chores.
    const panel = render({
      config: config(),
      configLoaded: true,
      github: githubConnect({ installation: ref("missing") }),
    });

    expect(panel.find("a.button").exists()).toBe(false);
    expect(panel.text()).not.toContain("not installed");
  });

  it("stays quiet about the installation while it is unknown", () => {
    // "Not asked yet" and "the lookup failed" share this state, and neither is grounds
    // for telling the user something is wrong.
    const panel = render({ config: config(), configLoaded: true });

    expect(panel.find("a.button").exists()).toBe(false);
  });

  it("keeps the owner field visible when GitHub can be connected", () => {
    // It is filled in automatically after connecting, but choosing an organization is
    // something only the user can do.
    const panel = render({ config: config(), configLoaded: true });

    expect(panel.find("#github-owner").exists()).toBe(true);
    expect(panel.find("#github-token").exists()).toBe(false);
  });
});
