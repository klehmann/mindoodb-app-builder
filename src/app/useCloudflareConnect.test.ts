import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { CLOUDFLARE_PENDING_KEY } from "@/app/cloudflareConnectRelay";
import { canExchangeInBrowser, useCloudflareConnect } from "@/app/useCloudflareConnect";
import type { BuilderHostConfig } from "@/app/hostApi";

const hostConfig: BuilderHostConfig = {
  oauth: {
    github: true,
    cloudflare: true,
    cloudflareRedirectUri: "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
  },
  cloudflareClientId: "cf-client",
  cloudflareScopes: ["account-settings.read", "offline_access"],
  githubAppSlug: "mindoodb-app-builder",
};

describe("useCloudflareConnect", () => {
  it("keeps the verifier when the shell opens a tab but returns no window", async () => {
    // Cursor Simple Browser: window.open navigates a new tab and still returns null.
    // Treating that as "blocked" used to drop the PKCE verifier before consent finished.
    vi.stubGlobal("open", () => null);
    window.sessionStorage.clear();

    const { connect, status, error } = useCloudflareConnect(ref(hostConfig), () => {});
    await connect();

    expect(status.value).toBe("waiting");
    expect(error.value).toBeNull();
    expect(window.sessionStorage.getItem(CLOUDFLARE_PENDING_KEY)).toContain("verifier");
    vi.unstubAllGlobals();
  });
});

describe("canExchangeInBrowser", () => {
  const callback = "https://app-builder.mindoodb.com/oauth/cloudflare/callback";

  it("sends the code from the page only on the origin the callback is registered on", () => {
    expect(canExchangeInBrowser("https://app-builder.mindoodb.com", callback)).toBe(true);
  });

  it("leaves every other origin to the host, because a refused attempt still spends the code", () => {
    expect(canExchangeInBrowser("http://127.0.0.1:4401", callback)).toBe(false);
    expect(canExchangeInBrowser("https://my-builder.example.com", callback)).toBe(false);
    expect(canExchangeInBrowser("https://app-builder.mindoodb.com", "not a url")).toBe(false);
  });
});
