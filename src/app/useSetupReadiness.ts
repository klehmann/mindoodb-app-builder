/**
 * The one-time setup steps, as UI state.
 *
 * Several grants have to exist before a build can work, and none can be performed
 * through an API: installing the builder's GitHub App, installing Cloudflare's GitHub
 * App on repositories it will only see later, and typing a Cursor key. They are consent,
 * and consent is given in the provider's own interface by design.
 *
 * What this composable can do is stop them from being *discovered* by a failure. Only
 * one of them is genuinely observable, and this is it: whether Cloudflare has ever built
 * from a repository on this account. Even that is indirect — see `probeGitIntegration` —
 * so its absence is reported as "unconfirmed" rather than "missing".
 *
 * Cloudflare's *repository selection* is deliberately not checked. GitHub scopes
 * `GET /user/installations` to the app the token belongs to, so this builder can only
 * ever see its own installation; asking it about Cloudflare's returns nothing and means
 * nothing. The builder's own installation is checked in `useGitHubConnect`, where the
 * token and the app do match.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from "vue";

import { probeCloudflareGitIntegration } from "@/app/hostApi";
import type { GitIntegrationState } from "@/core/cloudflare";
import type { BuilderCredentials } from "@/core/credentials";

export type CloudflareGitState = "unknown" | GitIntegrationState;

export interface UseSetupReadinessReturn {
  cloudflareGit: Ref<CloudflareGitState>;
  checking: Ref<boolean>;
  /** The account's own page in the dashboard, where the connection is made. */
  cloudflareDashboardUrl: ComputedRef<string>;
  checkCloudflare: () => Promise<void>;
}

export function useSetupReadiness(
  credentials: Ref<BuilderCredentials>,
): UseSetupReadinessReturn {
  const cloudflareGit = ref<CloudflareGitState>("unknown");
  const checking = ref(false);

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

  return {
    cloudflareGit,
    checking,
    cloudflareDashboardUrl,
    checkCloudflare,
  };
}
