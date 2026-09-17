/**
 * The one-time setup steps, as UI state.
 *
 * Three grants have to exist before a build can work, and none of them can be performed
 * through an API: installing the builder's GitHub App, installing Cloudflare's GitHub
 * App, and typing a Cursor key. They are consent, and consent is given in the provider's
 * own interface by design.
 *
 * What this composable can do is stop them from being *discovered* by a failure. The
 * GitHub half is a real lookup, in `useGitHubConnect`. This half covers Cloudflare, which
 * has no endpoint that answers the question directly — see `probeGitIntegration` — so the
 * answer is evidence and its absence is reported as "unconfirmed" rather than "missing".
 */
import { computed, ref, watch, type ComputedRef, type Ref } from "vue";

import { probeCloudflareGitIntegration } from "@/app/hostApi";
import type { GitIntegrationState } from "@/core/cloudflare";
import type { BuilderCredentials } from "@/core/credentials";
import { checkCloudflareRepoAccess, type CloudflareRepoAccess } from "@/core/github";

export type CloudflareGitState = "unknown" | GitIntegrationState;

export interface UseSetupReadinessReturn {
  cloudflareGit: Ref<CloudflareGitState>;
  checking: Ref<boolean>;
  /** The account's own page in the dashboard, where the connection is made. */
  cloudflareDashboardUrl: ComputedRef<string>;
  checkCloudflare: () => Promise<void>;
  /** Whether Cloudflare's GitHub App will be able to read a repository yet to exist. */
  cloudflareRepoAccess: Ref<CloudflareRepoAccess>;
  checkRepoAccess: () => Promise<void>;
}

export function useSetupReadiness(
  credentials: Ref<BuilderCredentials>,
): UseSetupReadinessReturn {
  const cloudflareGit = ref<CloudflareGitState>("unknown");
  const checking = ref(false);
  const cloudflareRepoAccess = ref<CloudflareRepoAccess>({ state: "unknown" });

  /**
   * Read from GitHub rather than Cloudflare, because GitHub is where the answer lives:
   * an installation limited to selected repositories can never cover a repository that
   * does not exist yet. Cloudflare would accept the connection regardless and then
   * never build.
   */
  async function checkRepoAccess(): Promise<void> {
    const token = credentials.value.githubToken;
    if (!token) {
      cloudflareRepoAccess.value = { state: "unknown" };
      return;
    }
    try {
      cloudflareRepoAccess.value = await checkCloudflareRepoAccess(token);
    } catch {
      cloudflareRepoAccess.value = { state: "unknown" };
    }
  }

  const cloudflareDashboardUrl = computed(() => {
    const accountId = credentials.value.cloudflareAccountId;
    return accountId
      ? `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/workers-and-pages`
      : "https://dash.cloudflare.com/";
  });

  async function checkCloudflare(): Promise<void> {
    const { cloudflareToken, cloudflareAccountId } = credentials.value;
    if (!cloudflareToken || !cloudflareAccountId) {
      cloudflareGit.value = "unknown";
      return;
    }

    checking.value = true;
    try {
      const { state } = await probeCloudflareGitIntegration({
        cloudflareToken,
        accountId: cloudflareAccountId,
      });
      cloudflareGit.value = state;
    } catch {
      // A probe that could not run must not be reported as a missing installation: the
      // token may simply lack the permission to list Workers.
      cloudflareGit.value = "unknown";
    } finally {
      checking.value = false;
    }
  }

  // Runs when the credentials first arrive and whenever the account changes, so the
  // answer is on screen before the user fills in a name and presses Create app.
  watch(
    () => [credentials.value.cloudflareToken, credentials.value.cloudflareAccountId],
    () => void checkCloudflare(),
    { immediate: true },
  );

  watch(() => credentials.value.githubToken, () => void checkRepoAccess(), { immediate: true });

  return {
    cloudflareGit,
    checking,
    cloudflareDashboardUrl,
    checkCloudflare,
    cloudflareRepoAccess,
    checkRepoAccess,
  };
}
