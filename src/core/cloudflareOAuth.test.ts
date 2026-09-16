import { describe, expect, it, vi } from "vitest";

import {
  buildAuthorizeUrl,
  createPkcePair,
  decodeRelayState,
  encodeRelayState,
  exchangeAuthorizationCode,
  refreshAccessToken,
  CloudflareOAuthError,
} from "./cloudflareOAuth";
import { isAllowedRelayOrigin, readOAuthConfig } from "./oauthConfig";

function stubJson(payload: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(payload), { status }),
  ) as unknown as typeof fetch;
}

describe("createPkcePair", () => {
  it("derives the challenge as base64url S256 of the verifier", async () => {
    const { verifier, challenge } = await createPkcePair();

    // Recomputing rather than hardcoding: the point is the relationship, and a fixed
    // expectation would only prove the random generator was stubbed.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(challenge).toBe(expected);
    expect(challenge).not.toContain("=");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a fresh verifier per call", async () => {
    const first = await createPkcePair();
    const second = await createPkcePair();
    expect(first.verifier).not.toBe(second.verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  it("requests a code with S256, since Cloudflare requires PKCE for public clients", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client-uuid",
        redirectUri: "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
        scopes: ["account.read", "workers-platform.write"],
        state: "state-value",
        codeChallenge: "challenge-value",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-uuid",
      redirect_uri: "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
      scope: "account.read workers-platform.write",
      state: "state-value",
      code_challenge: "challenge-value",
      code_challenge_method: "S256",
    });
  });
});

describe("relay state", () => {
  it("round-trips the origin that started the flow", () => {
    const encoded = encodeRelayState({ origin: "http://127.0.0.1:4400", nonce: "n1" });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRelayState(encoded)).toEqual({ origin: "http://127.0.0.1:4400", nonce: "n1" });
  });

  it("returns null for a state that is not ours", () => {
    expect(decodeRelayState("not-base64url!")).toBeNull();
    expect(decodeRelayState(btoa(JSON.stringify({ origin: 1 })))).toBeNull();
  });
});

describe("isAllowedRelayOrigin", () => {
  const config = readOAuthConfig({ BUILDER_PUBLIC_ORIGIN: "https://app-builder.mindoodb.com" });

  it("allows loopback on any port, because a self-run builder picks its own", () => {
    expect(isAllowedRelayOrigin("http://127.0.0.1:4400", config)).toBe(true);
    expect(isAllowedRelayOrigin("http://localhost:9999", config)).toBe(true);
  });

  it("allows the configured public origin", () => {
    expect(isAllowedRelayOrigin("https://app-builder.mindoodb.com", config)).toBe(true);
  });

  it("refuses a look-alike host and anything else", () => {
    // The whole reason the check parses instead of matching substrings.
    expect(isAllowedRelayOrigin("http://127.0.0.1.evil.test", config)).toBe(false);
    expect(isAllowedRelayOrigin("https://evil.test/?x=http://127.0.0.1", config)).toBe(false);
    expect(isAllowedRelayOrigin("https://app-builder.mindoodb.com.evil.test", config)).toBe(false);
  });
});

describe("exchangeAuthorizationCode", () => {
  it("posts the verifier form-encoded and with no client secret", async () => {
    const fetchImpl = stubJson({
      access_token: "cf-access",
      refresh_token: "cf-refresh",
      expires_in: 3600,
      scope: "account.read",
    });

    const tokens = await exchangeAuthorizationCode({
      clientId: "client-uuid",
      redirectUri: "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
      code: "code-1",
      codeVerifier: "verifier-1",
      fetchImpl,
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://dash.cloudflare.com/oauth2/token");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const sent = Object.fromEntries(new URLSearchParams(String((init as RequestInit).body)));
    expect(sent).toEqual({
      grant_type: "authorization_code",
      client_id: "client-uuid",
      redirect_uri: "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
      code: "code-1",
      code_verifier: "verifier-1",
    });
    expect(sent.client_secret).toBeUndefined();

    expect(tokens.accessToken).toBe("cf-access");
    expect(tokens.refreshToken).toBe("cf-refresh");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("surfaces Cloudflare's description when it rejects the exchange", async () => {
    const fetchImpl = stubJson(
      { error: "invalid_grant", error_description: "The code has expired." },
      400,
    );

    await expect(
      exchangeAuthorizationCode({
        clientId: "client-uuid",
        redirectUri: "https://app-builder.mindoodb.com/oauth/cloudflare/callback",
        code: "stale",
        codeVerifier: "v",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant", message: "The code has expired." });
  });

  it("treats a 200 without a token as a failure", async () => {
    await expect(
      exchangeAuthorizationCode({
        clientId: "c",
        redirectUri: "r",
        code: "c",
        codeVerifier: "v",
        fetchImpl: stubJson({ token_type: "bearer" }),
      }),
    ).rejects.toBeInstanceOf(CloudflareOAuthError);
  });

  it("records no expiry when Cloudflare does not send one", async () => {
    const tokens = await exchangeAuthorizationCode({
      clientId: "c",
      redirectUri: "r",
      code: "c",
      codeVerifier: "v",
      fetchImpl: stubJson({ access_token: "a" }),
    });
    expect(tokens.expiresAt).toBeNull();
  });
});

describe("refreshAccessToken", () => {
  it("keeps the existing refresh token when the response does not rotate it", async () => {
    const tokens = await refreshAccessToken({
      clientId: "c",
      refreshToken: "old-refresh",
      fetchImpl: stubJson({ access_token: "new-access", expires_in: 3600 }),
    });

    expect(tokens.accessToken).toBe("new-access");
    expect(tokens.refreshToken).toBe("old-refresh");
  });

  it("takes the rotated refresh token when there is one", async () => {
    const tokens = await refreshAccessToken({
      clientId: "c",
      refreshToken: "old-refresh",
      fetchImpl: stubJson({ access_token: "new-access", refresh_token: "new-refresh" }),
    });

    expect(tokens.refreshToken).toBe("new-refresh");
  });
});
