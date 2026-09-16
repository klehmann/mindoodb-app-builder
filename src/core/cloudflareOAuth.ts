/**
 * Connecting Cloudflare without a pasted token.
 *
 * Cloudflare has supported self-managed OAuth clients since June 2026, so the builder no
 * longer has to walk the user through the token-creation form and hope they pick the
 * right two permissions. It asks for named scopes, Cloudflare shows them on its own
 * consent screen, and the user approves once.
 *
 * Authorization Code **with PKCE**, because the builder is a public client: it runs on
 * the user's machine (or as a Worker whose code is published) and cannot hold a client
 * secret. Cloudflare explicitly does not offer the device grant to third-party clients,
 * so a redirect URI is unavoidable — see `oauthConfig.ts` for how a loopback builder
 * borrows the deployed one.
 *
 * Where the exchange runs is deliberately flexible. If the client registration lists the
 * builder's origin in `allowed_cors_origins`, the browser can call the token endpoint
 * itself and the access token never touches a server at all — not even the user's own
 * host. If it cannot, `/api/cloudflare/oauth/token` does the same call from the host.
 * Both paths send the same body; only the code verifier's home changes, and it never
 * leaves the party that generated it in either case.
 *
 * Reference: https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
 */

const AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";

export class CloudflareOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CloudflareOAuthError";
  }
}

export interface CloudflarePkcePair {
  /** Kept by the client that starts the flow, and sent only with the code exchange. */
  verifier: string;
  /** Sent in the authorize URL, where it is safe to be seen. */
  challenge: string;
}

export interface CloudflareOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry in epoch milliseconds, so a stored token can be judged later. */
  expiresAt: number | null;
  scope: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Opaque value tying a callback to the request that started it. */
export function createOAuthNonce(): string {
  return base64Url(randomBytes(16));
}

export async function createPkcePair(): Promise<CloudflarePkcePair> {
  const verifier = base64Url(randomBytes(32));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export interface CloudflareRelayState {
  /** Origin the callback page should hand the code back to. */
  origin: string;
  nonce: string;
}

/**
 * The `state` carries the origin that started the flow, because the callback page may be
 * the deployed builder acting for a loopback one and otherwise would not know where to
 * send the code. It is not a secret and not a capability: the nonce is checked by the
 * starting client, the origin is checked against an allowlist by the callback page, and
 * the code itself is unusable without the verifier.
 */
export function encodeRelayState(state: CloudflareRelayState): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(state)));
}

export function decodeRelayState(value: string): CloudflareRelayState | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
    );
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as { origin?: unknown; nonce?: unknown };
    if (typeof record.origin !== "string" || typeof record.nonce !== "string") {
      return null;
    }
    return { origin: record.origin, nonce: record.nonce };
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function postForm(
  url: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    throw new CloudflareOAuthError(
      `Cloudflare could not be reached: ${error instanceof Error ? error.message : "network error"}`,
      0,
    );
  }

  const text = await response.text();
  let record: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      record = {};
    }
  }

  const error = typeof record.error === "string" ? record.error : "";
  if (!response.ok || error) {
    const description =
      typeof record.error_description === "string" ? record.error_description : "";
    throw new CloudflareOAuthError(
      description || error || `Cloudflare returned ${response.status}.`,
      response.status,
      error || undefined,
    );
  }
  return record;
}

function readTokens(record: Record<string, unknown>): CloudflareOAuthTokens {
  const accessToken = typeof record.access_token === "string" ? record.access_token : "";
  if (!accessToken) {
    throw new CloudflareOAuthError("Cloudflare returned no access token.", 502);
  }
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : null;
  return {
    accessToken,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : "",
    expiresAt: expiresIn === null ? null : Date.now() + expiresIn * 1000,
    scope: typeof record.scope === "string" ? record.scope : "",
  };
}

export async function exchangeAuthorizationCode(input: {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<CloudflareOAuthTokens> {
  const { clientId, redirectUri, code, codeVerifier, fetchImpl = fetch } = input;
  return readTokens(
    await postForm(
      TOKEN_URL,
      {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
      },
      fetchImpl,
    ),
  );
}

/**
 * Trade a refresh token for a new access token.
 *
 * A public client may do this without a secret, which is the only reason a stored
 * Cloudflare connection can outlive its access token. If a refresh ever fails the UI
 * asks the user to connect again rather than retrying — a rejected refresh token does
 * not become valid on the second attempt.
 */
export async function refreshAccessToken(input: {
  clientId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<CloudflareOAuthTokens> {
  const { clientId, refreshToken, fetchImpl = fetch } = input;
  const tokens = readTokens(
    await postForm(
      TOKEN_URL,
      { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken },
      fetchImpl,
    ),
  );
  // Cloudflare may or may not rotate the refresh token; keep the old one when it does not.
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}

/** Best-effort revoke, so "disconnect" in the builder also ends it at Cloudflare. */
export async function revokeToken(input: {
  clientId: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { clientId, token, fetchImpl = fetch } = input;
  await postForm(REVOKE_URL, { client_id: clientId, token }, fetchImpl);
}
