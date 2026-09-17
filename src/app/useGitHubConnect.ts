/**
 * "Connect GitHub" — the device flow, as UI state.
 *
 * Ask the host for a pair of codes, show the user the short one to type at
 * `github.com/login/device`, poll until they have. The polling interval is GitHub's to
 * decide: it tells us the minimum in the first response and can raise it mid-flow with
 * `slow_down`, and ignoring either earns a rate limit that looks like a hang.
 *
 * The resulting token goes straight to `onToken`, which stores it in the sealed
 * credential document. Nothing is kept here.
 */
import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from "vue";

import { pollGitHubDeviceFlow, startGitHubDeviceFlow } from "@/app/hostApi";
import {
  findAppInstallation,
  getAuthenticatedUser,
  githubAppInstallUrl,
  GitHubError,
} from "@/core/github";

export type GitHubConnectStatus = "idle" | "starting" | "waiting" | "connected" | "failed";

/**
 * Whether the app that issued the token is installed anywhere.
 *
 * `"unknown"` covers both "not asked yet" and "asking failed", because a lookup that
 * did not answer must not accuse the user of a missing installation.
 */
export type GitHubInstallationState = "unknown" | "installed" | "missing";

export interface UseGitHubConnectReturn {
  status: Ref<GitHubConnectStatus>;
  /** The eight characters the user types, dash included. */
  userCode: Ref<string>;
  verificationUri: Ref<string>;
  error: Ref<string | null>;
  busy: ComputedRef<boolean>;
  start: () => Promise<void>;
  cancel: () => void;
  installation: Ref<GitHubInstallationState>;
  /** Where to install, empty when this builder has no app of its own. */
  installUrl: ComputedRef<string>;
  /** Re-run the lookup after the user says they have installed it. */
  checkInstallation: () => Promise<void>;
  /**
   * Who a pasted token belongs to. Returns the login, or `""` with {@link identifyError}
   * set — never throws, because this runs on blur and must not interrupt typing.
   */
  identifyToken: (token: string) => Promise<string>;
  identifying: Ref<boolean>;
  identifyError: Ref<string | null>;
}

export function useGitHubConnect(
  onToken: (token: string) => Promise<void> | void,
  /**
   * The app slug and the stored token, read lazily: both arrive after this composable is
   * created — the slug with the host config, the token with the flow that has yet to run.
   */
  context: {
    appSlug: () => string;
    token: () => string;
  } = { appSlug: () => "", token: () => "" },
): UseGitHubConnectReturn {
  const status = ref<GitHubConnectStatus>("idle");
  const userCode = ref("");
  const verificationUri = ref("https://github.com/login/device");
  const error = ref<string | null>(null);
  const installation = ref<GitHubInstallationState>("unknown");

  const installUrl = computed(() => {
    const slug = context.appSlug();
    return slug ? githubAppInstallUrl(slug) : "";
  });

  /**
   * Ask GitHub whether the app is installed, using the token we were just handed.
   *
   * Reported, not thrown: a connect that worked must not be turned into a failure by a
   * follow-up question about it, and a pasted personal access token legitimately has no
   * installation to find.
   */
  async function checkInstallationWith(token: string): Promise<void> {
    const appSlug = context.appSlug();
    if (!appSlug || !token) {
      installation.value = "unknown";
      return;
    }
    try {
      installation.value = (await findAppInstallation({ token, appSlug }))
        ? "installed"
        : "missing";
    } catch {
      installation.value = "unknown";
    }
  }

  async function checkInstallation(): Promise<void> {
    await checkInstallationWith(context.token());
  }

  const identifying = ref(false);
  const identifyError = ref<string | null>(null);

  /**
   * Ask `GET /user` who a pasted token belongs to.
   *
   * Two jobs in one call. It saves the user typing their own login, and it is the first
   * moment anything can tell them the token is usable at all — every other GitHub call
   * happens after they have already committed to creating a project.
   *
   * 401 is worth its own wording: it is nearly always a truncated paste or an expired
   * token, and "Bad credentials" does not say either.
   */
  async function identifyToken(token: string): Promise<string> {
    const trimmed = token.trim();
    identifyError.value = null;
    if (!trimmed) {
      return "";
    }

    identifying.value = true;
    try {
      return (await getAuthenticatedUser(trimmed)).login;
    } catch (error) {
      identifyError.value =
        error instanceof GitHubError && error.status === 401
          ? "GitHub did not accept this token. Check that the whole value was copied, and that it has not expired."
          : error instanceof Error
            ? error.message
            : "The token could not be checked with GitHub.";
      return "";
    } finally {
      identifying.value = false;
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on cancel and on restart, so a poll in flight cannot revive a dead flow. */
  let generation = 0;

  const busy = computed(() => status.value === "starting" || status.value === "waiting");

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function cancel(): void {
    generation += 1;
    clearTimer();
    userCode.value = "";
    status.value = "idle";
    error.value = null;
  }

  function fail(message: string): void {
    clearTimer();
    status.value = "failed";
    error.value = message;
  }

  async function start(): Promise<void> {
    generation += 1;
    const mine = generation;
    clearTimer();
    error.value = null;
    status.value = "starting";

    let authorization;
    try {
      authorization = await startGitHubDeviceFlow();
    } catch (startError) {
      fail(startError instanceof Error ? startError.message : "GitHub could not be reached.");
      return;
    }
    if (mine !== generation) {
      return;
    }

    userCode.value = authorization.userCode;
    verificationUri.value = authorization.verificationUri;
    status.value = "waiting";

    const deadline = Date.now() + authorization.expiresIn * 1000;
    let interval = Math.max(authorization.interval, 1) * 1000;

    const poll = async (): Promise<void> => {
      if (mine !== generation) {
        return;
      }
      if (Date.now() > deadline) {
        fail("The code expired. Start again to get a new one.");
        return;
      }

      let result;
      try {
        result = await pollGitHubDeviceFlow(authorization.deviceCode);
      } catch (pollError) {
        fail(pollError instanceof Error ? pollError.message : "GitHub could not be reached.");
        return;
      }
      if (mine !== generation) {
        return;
      }

      switch (result.status) {
        case "authorized":
          clearTimer();
          userCode.value = "";
          status.value = "connected";
          await onToken(result.accessToken);
          // Straight after authorizing is the moment to find a missing installation:
          // the alternative is a 403 several steps into a build, once a repository name
          // has already been taken.
          await checkInstallationWith(result.accessToken);
          return;
        case "slow_down":
          interval = Math.max(result.interval, 1) * 1000;
          break;
        case "pending":
          break;
        case "expired":
          fail("The code expired. Start again to get a new one.");
          return;
        case "declined":
          fail("The authorization was declined in GitHub.");
          return;
      }

      timer = setTimeout(() => void poll(), interval);
    };

    timer = setTimeout(() => void poll(), interval);
  }

  onBeforeUnmount(clearTimer);

  return {
    status,
    userCode,
    verificationUri,
    error,
    busy,
    start,
    cancel,
    installation,
    installUrl,
    checkInstallation,
    identifyToken,
    identifying,
    identifyError,
  };
}
