import { describe, expect, it } from "vitest";

import {
  BUILDER_CLOUDFLARE_CLIENT_ID,
  BUILDER_GITHUB_CLIENT_ID,
  readOAuthAvailability,
  readOAuthConfig,
  UNREGISTERED_OAUTH_ENV,
} from "./oauthConfig";

describe("readOAuthConfig", () => {
  it("uses the committed Mindoo client ids when the environment is unset", () => {
    // A local `pnpm run dev:host` has no wrangler vars. Without these defaults the
    // page would hide Connect and ask for a PAT, which is what 127.0.0.1:4401 did
    // before the host carried the same identities as the Worker.
    const config = readOAuthConfig({});
    expect(config.githubClientId).toBe(BUILDER_GITHUB_CLIENT_ID);
    expect(config.cloudflareClientId).toBe(BUILDER_CLOUDFLARE_CLIENT_ID);
    expect(readOAuthAvailability(config)).toMatchObject({ github: true, cloudflare: true });
  });

  it("treats an explicitly empty id as unregistered, not as the default", () => {
    const config = readOAuthConfig(UNREGISTERED_OAUTH_ENV);
    expect(config.githubClientId).toBe("");
    expect(config.cloudflareClientId).toBe("");
    expect(readOAuthAvailability(config)).toMatchObject({ github: false, cloudflare: false });
  });

  it("lets a fork override a single client without clearing the other", () => {
    const config = readOAuthConfig({ BUILDER_GITHUB_CLIENT_ID: "Iv23.fork" });
    expect(config.githubClientId).toBe("Iv23.fork");
    expect(config.cloudflareClientId).toBe(BUILDER_CLOUDFLARE_CLIENT_ID);
  });
});
