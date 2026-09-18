import { describe, expect, it } from "vitest";

import { readOAuthConfig } from "@/core/oauthConfig";
import { renderCloudflareCallbackPage } from "@/host/oauthCallback";

describe("renderCloudflareCallbackPage", () => {
  const html = renderCloudflareCallbackPage(
    readOAuthConfig({ BUILDER_PUBLIC_ORIGIN: "https://app-builder.mindoodb.com" }),
  );

  it("sends a tab without opener back to any allowlisted builder, including loopback", () => {
    // Cursor's Simple Browser opens a tab and strips opener. The previous same-origin
    // guard left a local builder (127.0.0.1) staring at "Return to the builder".
    expect(html).toContain('state.origin + "/#cloudflare-oauth="');
    expect(html).not.toContain("state.origin === window.location.origin");
    expect(html).not.toContain("Return to the builder window");
  });

  it("still prefers postMessage when the popup kept its opener", () => {
    expect(html).toContain("window.opener.postMessage(message, state.origin)");
  });
});
