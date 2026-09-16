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

export type GitHubConnectStatus = "idle" | "starting" | "waiting" | "connected" | "failed";

export interface UseGitHubConnectReturn {
  status: Ref<GitHubConnectStatus>;
  /** The eight characters the user types, dash included. */
  userCode: Ref<string>;
  verificationUri: Ref<string>;
  error: Ref<string | null>;
  busy: ComputedRef<boolean>;
  start: () => Promise<void>;
  cancel: () => void;
}

export function useGitHubConnect(
  onToken: (token: string) => Promise<void> | void,
): UseGitHubConnectReturn {
  const status = ref<GitHubConnectStatus>("idle");
  const userCode = ref("");
  const verificationUri = ref("https://github.com/login/device");
  const error = ref<string | null>(null);

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

  return { status, userCode, verificationUri, error, busy, start, cancel };
}
