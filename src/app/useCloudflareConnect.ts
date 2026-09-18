/**
 * "Connect Cloudflare" — Authorization Code with PKCE, as UI state.
 *
 * The sequence: generate a verifier, open Cloudflare's consent screen in a popup, wait
 * for the callback page to hand back the authorization code, exchange it, then ask which
 * accounts the token can act on so the user never types an account id.
 *
 * Two details are load-bearing.
 *
 * **The verifier never leaves this tab** until it is spent on the exchange. That is what
 * makes it safe for the deployed builder's callback page to relay a code to a builder
 * running on loopback: the code alone cannot be exchanged.
 *
 * **The exchange is tried in the browser first.** If the OAuth client registration lists
 * this origin in `allowed_cors_origins`, the call succeeds here and the access token
 * never exists outside the tab — not even in the user's own host process. Only when the
 * browser is refused does it fall back to `/api/cloudflare/oauth/token`. A failed direct
 * attempt is therefore normal and not worth showing.
 */
import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from "vue";

import {
  exchangeCloudflareCodeViaHost,
  listCloudflareAccounts,
  type BuilderHostConfig,
} from "@/app/hostApi";
import type { CloudflareAccount } from "@/core/cloudflare";
import {
  buildAuthorizeUrl,
  createOAuthNonce,
  createPkcePair,
  decodeRelayState,
  encodeRelayState,
  exchangeAuthorizationCode,
  type CloudflareOAuthTokens,
} from "@/core/cloudflareOAuth";
import { CLOUDFLARE_OAUTH_MESSAGE } from "@/host/oauthCallback";
import { t } from "@/i18n";

export type CloudflareConnectStatus = "idle" | "waiting" | "exchanging" | "connected" | "failed";

export interface CloudflareConnectResult {
  tokens: CloudflareOAuthTokens;
  accounts: CloudflareAccount[];
}

export interface UseCloudflareConnectReturn {
  status: Ref<CloudflareConnectStatus>;
  error: Ref<string | null>;
  accounts: Ref<CloudflareAccount[]>;
  busy: ComputedRef<boolean>;
  connect: () => Promise<void>;
  cancel: () => void;
  /** Ask a pasted token which accounts it can act on. Resolves to them, or to none. */
  identifyToken: (token: string) => Promise<CloudflareAccount[]>;
  identifying: Ref<boolean>;
  /** Why the lookup came back empty, for the one case the user has to type the id. */
  identifyError: Ref<string | null>;
}

interface CallbackMessage {
  type: string;
  code: string;
  state: string;
  error: string;
  errorDescription: string;
}

function readCallbackMessage(data: unknown): CallbackMessage | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record.type !== CLOUDFLARE_OAUTH_MESSAGE) {
    return null;
  }
  return {
    type: CLOUDFLARE_OAUTH_MESSAGE,
    code: typeof record.code === "string" ? record.code : "",
    state: typeof record.state === "string" ? record.state : "",
    error: typeof record.error === "string" ? record.error : "",
    errorDescription: typeof record.errorDescription === "string" ? record.errorDescription : "",
  };
}

export function useCloudflareConnect(
  config: Ref<BuilderHostConfig | null>,
  onConnected: (result: CloudflareConnectResult) => Promise<void> | void,
): UseCloudflareConnectReturn {
  const status = ref<CloudflareConnectStatus>("idle");
  const error = ref<string | null>(null);
  const accounts = ref<CloudflareAccount[]>([]);
  const identifying = ref(false);
  const identifyError = ref<string | null>(null);

  let popup: Window | null = null;

  /**
   * The in-flight flow: the verifier is the half that must not leak, so it is held in
   * `sessionStorage` rather than anywhere durable — same origin only, gone when the tab
   * closes, and deleted the moment it is spent.
   *
   * It has to survive a reload at all because of the same-tab fallback: if the popup was
   * blocked and Cloudflare sent the user through a full-page redirect, the tab that
   * generated the verifier is the tab that comes back, but its JavaScript state is not.
   */
  const PENDING_KEY = "mindoodb-app-builder/cloudflare-oauth-pending";

  interface PendingFlow {
    verifier: string;
    state: string;
    redirectUri: string;
  }

  function readPending(): PendingFlow | null {
    try {
      const raw = window.sessionStorage.getItem(PENDING_KEY);
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

  function writePending(flow: PendingFlow | null): void {
    try {
      if (flow) {
        window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(flow));
      } else {
        window.sessionStorage.removeItem(PENDING_KEY);
      }
    } catch {
      // Private-mode storage failures are survivable: the popup path still works within
      // this page's lifetime, it just cannot outlive a reload.
    }
  }

  const busy = computed(() => status.value === "waiting" || status.value === "exchanging");

  function cancel(): void {
    writePending(null);
    popup?.close();
    popup = null;
    status.value = "idle";
    error.value = null;
  }

  function fail(message: string): void {
    writePending(null);
    status.value = "failed";
    error.value = message;
  }

  async function finish(message: CallbackMessage): Promise<void> {
    const current = readPending();
    if (!current) {
      return;
    }
    // A state that is not the one we sent is either a stale popup or someone else's
    // message. Either way it is not this flow's code.
    if (message.state !== current.state) {
      return;
    }
    writePending(null);
    popup?.close();
    popup = null;

    if (message.error) {
      fail(
        message.errorDescription ||
          (message.error === "access_denied"
            ? t("cloudflareConnect.declined")
            : t("cloudflareConnect.refused", { error: message.error })),
      );
      return;
    }
    if (!message.code) {
      fail(t("cloudflareConnect.noCode"));
      return;
    }

    const clientId = config.value?.cloudflareClientId ?? "";
    status.value = "exchanging";

    let tokens: CloudflareOAuthTokens;
    try {
      tokens = await exchangeAuthorizationCode({
        clientId,
        redirectUri: current.redirectUri,
        code: message.code,
        codeVerifier: current.verifier,
      });
    } catch {
      // Expected whenever this origin is not in the client's CORS allowlist.
      try {
        tokens = await exchangeCloudflareCodeViaHost({
          code: message.code,
          codeVerifier: current.verifier,
          redirectUri: current.redirectUri,
        });
      } catch (hostError) {
        fail(
          hostError instanceof Error
            ? hostError.message
            : t("cloudflareConnect.exchangeFailed"),
        );
        return;
      }
    }

    try {
      const listed = await listCloudflareAccounts(tokens.accessToken);
      accounts.value = listed.accounts;
    } catch {
      // Not fatal: the connection works, the user picks the account by hand.
      accounts.value = [];
    }

    status.value = "connected";
    await onConnected({ tokens, accounts: accounts.value });
  }

  function onMessage(event: MessageEvent): void {
    const current = readPending();
    if (!current) {
      return;
    }
    // Only the callback page's own origin may deliver a code.
    if (event.origin !== new URL(current.redirectUri).origin) {
      return;
    }
    const message = readCallbackMessage(event.data);
    if (message) {
      void finish(message);
    }
  }

  async function connect(): Promise<void> {
    const hostConfig = config.value;
    if (!hostConfig?.cloudflareClientId) {
      fail(t("cloudflareConnect.noClient"));
      return;
    }

    error.value = null;
    const { verifier, challenge } = await createPkcePair();
    const redirectUri = hostConfig.oauth.cloudflareRedirectUri;
    const state = encodeRelayState({
      origin: window.location.origin,
      nonce: createOAuthNonce(),
    });
    writePending({ verifier, state, redirectUri });

    let url: string;
    try {
      url = buildAuthorizeUrl({
        clientId: hostConfig.cloudflareClientId,
        redirectUri,
        scopes: hostConfig.cloudflareScopes,
        state,
        codeChallenge: challenge,
      });
    } catch (buildError) {
      fail(
        buildError instanceof Error
          ? buildError.message
          : t("cloudflareConnect.urlBuildFailed"),
      );
      return;
    }

    status.value = "waiting";
    popup = window.open(url, "cloudflare-oauth", "width=620,height=780,noopener=no");
    if (!popup) {
      fail(t("cloudflareConnect.popupBlocked"));
    }
  }

  /**
   * The same question the OAuth flow asks after the exchange, asked for a token the user
   * pasted: which accounts can this act on?
   *
   * Every Cloudflare call the builder makes needs an account id, and that id is a
   * 32-character hex string nobody knows by heart. The token already knows it, so
   * reading it here is the difference between one paste and a trip to the dashboard.
   * It is also the first thing that can confirm the token works at all.
   */
  async function identifyToken(token: string): Promise<CloudflareAccount[]> {
    const value = token.trim();
    if (!value) {
      return [];
    }
    identifying.value = true;
    identifyError.value = null;
    try {
      const listed = await listCloudflareAccounts(value);
      accounts.value = listed.accounts;
      if (listed.accounts.length === 0) {
        // A token that can edit Workers but cannot list accounts is possible, so this is
        // a reason to show the id field again — not a reason to refuse the token.
        identifyError.value = t("cloudflareConnect.noAccounts");
      }
      return listed.accounts;
    } catch (lookupError) {
      accounts.value = [];
      identifyError.value =
        lookupError instanceof Error
          ? lookupError.message
          : t("cloudflareConnect.accountLookupFailed");
      return [];
    } finally {
      identifying.value = false;
    }
  }

  /**
   * Same-tab fallback. When the popup was replaced by a full-page redirect the callback
   * page sends the user back with the payload in the fragment, which never reaches a
   * server. Reading it here and clearing it keeps it out of the history entry.
   */
  function readFragmentCallback(): void {
    const marker = "#cloudflare-oauth=";
    const hash = window.location.hash;
    if (!hash.startsWith(marker)) {
      return;
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const raw = decodeURIComponent(hash.slice(marker.length));
    try {
      const message = readCallbackMessage(JSON.parse(raw));
      if (message && decodeRelayState(message.state)) {
        void finish(message);
      }
    } catch {
      // A fragment we cannot parse is not worth an error: the user can just connect again.
    }
  }

  onMounted(() => {
    window.addEventListener("message", onMessage);
    readFragmentCallback();
  });

  onBeforeUnmount(() => {
    window.removeEventListener("message", onMessage);
    popup?.close();
  });

  return {
    status,
    error,
    accounts,
    busy,
    connect,
    cancel,
    identifyToken,
    identifying,
    identifyError,
  };
}
