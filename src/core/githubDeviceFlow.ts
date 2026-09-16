/**
 * Connecting GitHub without a pasted token.
 *
 * The device flow is the one OAuth variant that needs no client secret and no redirect
 * URI: ask GitHub for a pair of codes, show the user an eight-character code to type at
 * `github.com/login/device`, then poll until they have. That is the entire protocol, and
 * it is why the builder can ship its client id in public source.
 *
 * Why this replaces a personal access token: a PAT with `repo` scope can read and write
 * *every* repository the user has, and this one ends up in a document that syncs to
 * their other devices. A GitHub App user token is limited to the app's declared
 * permissions (Administration and Contents write, Metadata read) on the repositories the
 * user picked, and they can revoke it in one place.
 *
 * These two calls run **on the builder host**, unlike the rest of the GitHub work in
 * `github.ts`: `github.com/login/*` are not `api.github.com` and send no CORS headers,
 * so a page cannot post to them. The resulting token is handed straight back to the
 * browser and the host keeps nothing.
 *
 * Reference: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export class GitHubDeviceFlowError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GitHubDeviceFlowError";
  }
}

export interface GitHubDeviceAuthorization {
  deviceCode: string;
  /** Shown to the user. Formatted `WDJB-MJHT`; GitHub expects it typed with the dash. */
  userCode: string;
  verificationUri: string;
  /** Seconds until both codes expire. GitHub's default is 900. */
  expiresIn: number;
  /** Minimum seconds between polls. Polling faster earns a `slow_down`. */
  interval: number;
}

/**
 * The outcome of one poll.
 *
 * A user who has not finished yet, or who declined, is a normal answer rather than an
 * error — the UI has to keep waiting in the first case and stop in the second, and
 * neither is a failure of the call.
 */
export type GitHubDevicePollResult =
  | { status: "authorized"; accessToken: string; scope: string }
  | { status: "pending" }
  /** GitHub asks for a longer gap; the new interval replaces the old one. */
  | { status: "slow_down"; interval: number }
  | { status: "expired" }
  | { status: "declined" };

function readRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * GitHub answers these endpoints as form-encoded text by default and as JSON when asked,
 * and — importantly — reports protocol errors with HTTP 200 and an `error` field. So the
 * status code alone never decides anything here.
 */
async function postToGitHub(
  url: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; record: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new GitHubDeviceFlowError(
      `GitHub could not be reached: ${error instanceof Error ? error.message : "network error"}`,
      0,
    );
  }

  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
  }
  return { status: response.status, record: readRecord(payload) };
}

export async function startDeviceAuthorization(input: {
  clientId: string;
  /**
   * Only meaningful for an OAuth App. A GitHub App ignores it: its permissions come
   * from the registration and from what the user granted at install time.
   */
  scope?: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubDeviceAuthorization> {
  const { clientId, scope, fetchImpl = fetch } = input;
  if (!clientId) {
    throw new GitHubDeviceFlowError("This builder has no GitHub client id configured.", 0);
  }

  const { status, record } = await postToGitHub(
    DEVICE_CODE_URL,
    { client_id: clientId, ...(scope ? { scope } : {}) },
    fetchImpl,
  );

  const error = readString(record, "error");
  if (error) {
    throw new GitHubDeviceFlowError(
      readString(record, "error_description") ||
        (error === "device_flow_disabled"
          ? "This GitHub app does not have the device flow enabled."
          : `GitHub refused the device request (${error}).`),
      status,
      error,
    );
  }

  const deviceCode = readString(record, "device_code");
  const userCode = readString(record, "user_code");
  if (!deviceCode || !userCode) {
    throw new GitHubDeviceFlowError("GitHub did not return a device code.", status);
  }

  return {
    deviceCode,
    userCode,
    verificationUri: readString(record, "verification_uri") || "https://github.com/login/device",
    expiresIn: readNumber(record, "expires_in", 900),
    interval: readNumber(record, "interval", 5),
  };
}

export async function pollDeviceAuthorization(input: {
  clientId: string;
  deviceCode: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubDevicePollResult> {
  const { clientId, deviceCode, fetchImpl = fetch } = input;
  if (!clientId || !deviceCode) {
    throw new GitHubDeviceFlowError("The device authorization is incomplete.", 0);
  }

  const { status, record } = await postToGitHub(
    ACCESS_TOKEN_URL,
    { client_id: clientId, device_code: deviceCode, grant_type: DEVICE_CODE_GRANT },
    fetchImpl,
  );

  const error = readString(record, "error");
  switch (error) {
    case "":
      break;
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down", interval: readNumber(record, "interval", 10) };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "declined" };
    default:
      throw new GitHubDeviceFlowError(
        readString(record, "error_description") || `GitHub refused the device code (${error}).`,
        status,
        error,
      );
  }

  const accessToken = readString(record, "access_token");
  if (!accessToken) {
    throw new GitHubDeviceFlowError("GitHub authorized the device but returned no token.", status);
  }
  return { status: "authorized", accessToken, scope: readString(record, "scope") };
}
