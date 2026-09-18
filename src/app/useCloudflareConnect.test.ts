import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { CLOUDFLARE_PENDING_KEY } from "@/app/cloudflareConnectRelay";
import { useCloudflareConnect } from "@/app/useCloudflareConnect";
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
