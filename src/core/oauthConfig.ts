/**
 * Where the builder's OAuth identities are configured.
 *
 * Both client IDs are **public by design**. GitHub's device flow and Cloudflare's PKCE
 * flow are built for clients that cannot keep a secret, which is the only kind of client
 * an open-source tool a user runs themselves can be. So these values are committed, not
 * injected, and the builder holds no client secret anywhere — there is nothing in this
 * file that would be damaging to leak.
 *
 * Every value is overridable from the environment, because someone running their own
 * builder (or our staging copy) registers their own applications and must be able to
 * point at them without a fork. The Node host reads `process.env`; the Worker reads its
 * own `env` binding; both call {@link readOAuthConfig} with whatever they have.
 *
 * Environment:
 *   - `BUILDER_GITHUB_CLIENT_ID`      — GitHub App client id (`Iv1.…` / `Iv23…`)
 *   - `BUILDER_GITHUB_APP_SLUG`       — used to find the app's own installation
 *   - `BUILDER_CLOUDFLARE_CLIENT_ID`  — Cloudflare OAuth client id (a UUID)
 *   - `BUILDER_CLOUDFLARE_SCOPES`     — space-separated, must match the registration
 *   - `BUILDER_PUBLIC_ORIGIN`         — origin holding the registered redirect URI
 */

/**
 * The deployed builder. It matters for more than convenience: Cloudflare does not
 * support the device grant for third-party clients, so the authorization code has to
 * come back to a *pre-registered* redirect URI. A builder running on
 * `http://127.0.0.1:4400` cannot register its own, so it borrows this one and the
 * callback page hands the code back to the loopback origin that started the flow (see
 * `relayTargetFromState`). PKCE is what makes that safe: the code verifier never leaves
 * the builder that generated it, so a code in transit is useless to the relay.
 */
export const BUILDER_PUBLIC_ORIGIN = "https://app-builder.mindoodb.com";

/** Registered on both OAuth clients. Changing it means re-registering. */
export const CLOUDFLARE_CALLBACK_PATH = "/oauth/cloudflare/callback";

/**
 * Scopes requested from Cloudflare: read the user's accounts (so they never type an
 * account id), and write Workers scripts (create and deploy the Worker).
 *
 * The ids are Cloudflare **API token permission** names, dot-suffixed with the access
 * level — not wrangler's colon-separated scopes (`workers:write`), which only its own
 * first-party client accepts. `GET /oauth/scopes` returns the authoritative list.
 *
 * Every scope has to be requested explicitly: Cloudflare evaluates only the scopes in
 * the authorize request, so omitting the parameter produces a consent screen offering
 * "0 total permissions" that cannot be authorized at all. The request must also be a
 * subset of what the client is registered for — a scope the registration does not have
 * is rejected there. Hence `BUILDER_CLOUDFLARE_SCOPES` for deployments whose client is
 * registered differently; it replaces this list rather than adding to it.
 */
export const CLOUDFLARE_DEFAULT_SCOPES = [
  // Read the user's accounts, so they never type an account id.
  "account-settings.read",
  // Create and deploy the Worker.
  "workers-scripts.write",
  // Workers CI is the API name of Workers Builds: the git connection and build trigger
  // behind push-to-deploy.
  "workers-ci.write",
  // Protocol scope, and the reason a connection survives the access token's hour: the
  // token response carries a refresh token only when the request asks for this.
  "offline_access",
];

export interface BuilderOAuthConfig {
  githubClientId: string;
  githubAppSlug: string;
  cloudflareClientId: string;
  cloudflareScopes: string[];
  /** Origin whose `CLOUDFLARE_CALLBACK_PATH` is registered with Cloudflare. */
  publicOrigin: string;
}

/** What the UI needs to decide between "Connect" and "paste a token". */
export interface BuilderOAuthAvailability {
  github: boolean;
  cloudflare: boolean;
  cloudflareRedirectUri: string;
}

export type EnvLike = Record<string, string | undefined>;

function readEnv(env: EnvLike | undefined, key: string): string {
  const value = env?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function readOAuthConfig(env?: EnvLike): BuilderOAuthConfig {
  // An empty variable falls back to the defaults rather than meaning "no scopes":
  // an authorize request without scopes cannot be authorized by anyone.
  const configuredScopes = readEnv(env, "BUILDER_CLOUDFLARE_SCOPES")
    .split(/\s+/)
    .filter(Boolean);
  const scopes =
    configuredScopes.length > 0 ? configuredScopes : [...CLOUDFLARE_DEFAULT_SCOPES];

  return {
    githubClientId: readEnv(env, "BUILDER_GITHUB_CLIENT_ID"),
    githubAppSlug: readEnv(env, "BUILDER_GITHUB_APP_SLUG") || "mindoodb-app-builder",
    cloudflareClientId: readEnv(env, "BUILDER_CLOUDFLARE_CLIENT_ID"),
    cloudflareScopes: scopes,
    publicOrigin: readEnv(env, "BUILDER_PUBLIC_ORIGIN") || BUILDER_PUBLIC_ORIGIN,
  };
}

export function cloudflareRedirectUri(config: BuilderOAuthConfig): string {
  return `${config.publicOrigin.replace(/\/$/, "")}${CLOUDFLARE_CALLBACK_PATH}`;
}

/**
 * A connect button is only offered when the corresponding client id is configured.
 * An unregistered builder falls back to pasted tokens rather than showing a button that
 * leads to a Cloudflare error page.
 */
export function readOAuthAvailability(config: BuilderOAuthConfig): BuilderOAuthAvailability {
  return {
    github: config.githubClientId !== "",
    cloudflare: config.cloudflareClientId !== "",
    cloudflareRedirectUri: cloudflareRedirectUri(config),
  };
}

/**
 * Origins the callback page may hand an authorization code back to.
 *
 * Loopback with any port is allowed because that is where a self-run builder lives and
 * its port is the user's choice. Everything else must be the configured public origin.
 * Anything else — including a look-alike like `http://127.0.0.1.evil.test` — is refused,
 * which is why this compares a parsed hostname rather than matching on the string.
 */
export function isAllowedRelayOrigin(origin: string, config: BuilderOAuthConfig): boolean {
  if (origin === config.publicOrigin.replace(/\/$/, "")) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.pathname === "/"
  );
}
