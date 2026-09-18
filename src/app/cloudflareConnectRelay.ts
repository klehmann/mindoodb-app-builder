/**
 * How a Cloudflare authorization code gets back to the tab that started the flow.
 *
 * The usual path is a popup with `window.opener`. Some shells — Cursor's Simple
 * Browser among them — open a real tab instead and still return `null` from
 * `window.open`. That tab has no opener, so the callback page sends the user back
 * here with the payload in the fragment. If this tab is the one that started the
 * flow, it finishes immediately. If it is the extra tab the shell opened, it
 * publishes the payload on `localStorage` for the original tab (same origin,
 * including a Haven iframe) and leaves the verifier where it is.
 */
export const CLOUDFLARE_PENDING_KEY = "mindoodb-app-builder/cloudflare-oauth-pending";
export const CLOUDFLARE_RELAY_KEY = "mindoodb-app-builder/cloudflare-oauth-relay";
export const CLOUDFLARE_FRAGMENT_PREFIX = "#cloudflare-oauth=";

export interface CloudflarePendingFlow {
  verifier: string;
  state: string;
  redirectUri: string;
}

export function readCloudflarePending(storage: Storage): CloudflarePendingFlow | null {
  try {
    const raw = storage.getItem(CLOUDFLARE_PENDING_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.verifier !== "string" ||
      typeof record.state !== "string" ||
      typeof record.redirectUri !== "string"
    ) {
      return null;
    }
    return {
      verifier: record.verifier,
      state: record.state,
      redirectUri: record.redirectUri,
    };
  } catch {
    return null;
  }
}

export function writeCloudflarePending(storage: Storage, flow: CloudflarePendingFlow | null): void {
  try {
    if (flow) {
      storage.setItem(CLOUDFLARE_PENDING_KEY, JSON.stringify(flow));
    } else {
      storage.removeItem(CLOUDFLARE_PENDING_KEY);
    }
  } catch {
    // Private-mode storage failures are survivable: the opener path still works
    // within this page's lifetime, it just cannot outlive a reload.
  }
}

export function parseCloudflareFragment(hash: string): unknown | null {
  if (!hash.startsWith(CLOUDFLARE_FRAGMENT_PREFIX)) {
    return null;
  }
  try {
    return JSON.parse(decodeURIComponent(hash.slice(CLOUDFLARE_FRAGMENT_PREFIX.length)));
  } catch {
    return null;
  }
}

export function publishCloudflareRelay(storage: Storage, payload: unknown): void {
  try {
    storage.setItem(CLOUDFLARE_RELAY_KEY, JSON.stringify(payload));
    // Other tabs see the write. Removing it keeps the code out of durable storage.
    storage.removeItem(CLOUDFLARE_RELAY_KEY);
  } catch {
    // Same as pending: a tab that cannot write still has postMessage when opener exists.
  }
}

export function readCloudflareRelay(raw: string | null): unknown | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Recover a code from the callback tab's address bar. Needed when that tab has no
 * opener (Cursor Simple Browser) and the deployed callback page has not been updated
 * to redirect loopback builders. The code is already in the query string; this just
 * reads it. `expectedRedirectUri` is the registered callback — anything else is refused.
 */
export function parseCloudflareCallbackUrl(
  raw: string,
  expectedRedirectUri: string,
): { code: string; state: string; error: string; errorDescription: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let expected: URL;
  let url: URL;
  try {
    expected = new URL(expectedRedirectUri);
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.origin !== expected.origin && !loopback) {
    return null;
  }
  const fromQuery = {
    code: url.searchParams.get("code") || "",
    state: url.searchParams.get("state") || "",
    error: url.searchParams.get("error") || "",
    errorDescription: url.searchParams.get("error_description") || "",
  };
  if (fromQuery.code || fromQuery.state || fromQuery.error) {
    return fromQuery;
  }
  const fromHash = parseCloudflareFragment(url.hash);
  if (typeof fromHash === "object" && fromHash !== null) {
    const record = fromHash as Record<string, unknown>;
    return {
      code: typeof record.code === "string" ? record.code : "",
      state: typeof record.state === "string" ? record.state : "",
      error: typeof record.error === "string" ? record.error : "",
      errorDescription: typeof record.errorDescription === "string" ? record.errorDescription : "",
    };
  }
  return null;
}
