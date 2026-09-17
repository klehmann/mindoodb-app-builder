// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

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
    identifyToken: async () => "octocat",
    identifying: ref(false),
    identifyError: ref(null),
    ...overrides,
  };
}

/** No GitHub App registered, which is what forces the token fields open. */
function unregistered(): BuilderHostConfig {
  return config({
    oauth: {
      github: false,
      cloudflare: false,
      cloudflareRedirectUri: "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
    },
    cloudflareClientId: "",
  });
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
    const panel = render({ config: unregistered(), configLoaded: true });

    expect(panel.find("#github-token").exists()).toBe(true);
    expect(panel.find("#cf-token").exists()).toBe(true);
    expect(panel.find("#cf-account").exists()).toBe(true);
    // Usable means the instructions are there, not that the state is explained: how this
    // deployment is configured is not the user's concern.
    expect(panel.text()).toContain("Create a token on GitHub");
    expect(panel.text()).toContain("Create a token on Cloudflare");
    expect(panel.text()).not.toContain("registered");
    expect(panel.text()).not.toContain("OAuth client");
  });

  it("offers nothing until the config has been read", () => {
    // An unreachable host and a host that has not answered yet look identical from
    // here, so neither may be turned into a token field the user did not need.
    const panel = render({ config: null, configLoaded: false });

    expect(panel.find("#github-token").exists()).toBe(false);
    expect(panel.text()).toContain("Checking how you can connect");
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

  it("names the token's account as soon as the token is pasted", async () => {
    // Nobody should have to type their own login, and this is the earliest moment
    // anything can tell the user the token works at all.
    const panel = render({ config: unregistered(), configLoaded: true });

    await panel.find("#github-token").setValue("ghp_x");
    await panel.find("#github-token").trigger("blur");
    await flushPromises();

    expect((panel.find("#github-owner").element as HTMLInputElement).value).toBe("octocat");
  });

  it("does not overwrite an organization the user typed", async () => {
    const identifyToken = vi.fn(async () => "octocat");
    const panel = render({
      config: unregistered(),
      configLoaded: true,
      github: githubConnect({ identifyToken }),
    });

    await panel.find("#github-owner").setValue("acme-inc");
    await panel.find("#github-token").setValue("ghp_x");
    await panel.find("#github-token").trigger("blur");
    await flushPromises();

    expect(identifyToken).not.toHaveBeenCalled();
    expect((panel.find("#github-owner").element as HTMLInputElement).value).toBe("acme-inc");
  });

  it("does not call GitHub on an empty token field", async () => {
    const identifyToken = vi.fn(async () => "octocat");
    const panel = render({
      config: unregistered(),
      configLoaded: true,
      github: githubConnect({ identifyToken }),
    });

    await panel.find("#github-token").trigger("blur");
    await flushPromises();

    expect(identifyToken).not.toHaveBeenCalled();
  });

  it("shows why a rejected token was rejected, and leaves the owner alone", async () => {
    const panel = render({
      config: unregistered(),
      configLoaded: true,
      github: githubConnect({
        identifyToken: async () => "",
        identifyError: ref("GitHub did not accept this token."),
      }),
    });

    await panel.find("#github-token").setValue("ghp_bad");
    await panel.find("#github-token").trigger("blur");
    await flushPromises();

    expect(panel.text()).toContain("GitHub did not accept this token.");
    expect((panel.find("#github-owner").element as HTMLInputElement).value).toBe("");
  });
});
