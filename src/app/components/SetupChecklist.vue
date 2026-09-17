<script setup lang="ts">
/**
 * The three grants a build needs that the builder cannot make for you.
 *
 * Deliberately not a gate: every item can be "not confirmed" for innocent reasons, and
 * a checklist that refuses to let you continue on a guess is worse than a build that
 * explains itself when it stops. It disappears once each item is either satisfied or
 * knowably irrelevant.
 */
import { computed } from "vue";

import type { GitHubInstallationState } from "@/app/useGitHubConnect";
import type { CloudflareGitState } from "@/app/useSetupReadiness";

const props = defineProps<{
  githubInstallation: GitHubInstallationState;
  githubInstallUrl: string;
  cloudflareGit: CloudflareGitState;
  cloudflareChecking: boolean;
  cloudflareDashboardUrl: string;
  cursorReady: boolean;
}>();

const emit = defineEmits<{ recheckGitHub: []; recheckCloudflare: [] }>();

const githubPending = computed(() => props.githubInstallation === "missing");
/**
 * "unknown" means the probe could not run, which is not something to ask the user about
 * — only a confirmed absence of evidence is worth a line here.
 */
const cloudflarePending = computed(() => props.cloudflareGit === "unconfirmed");
const visible = computed(
  () => githubPending.value || cloudflarePending.value || !props.cursorReady,
);
</script>

<template>
  <section v-if="visible" class="setup">
    <h3>One-time setup</h3>
    <p class="hint">
      These three grants are given in GitHub's, Cloudflare's and Cursor's own interfaces —
      no API can make them for you. Each is needed once per account, not once per app.
    </p>

    <ul class="items">
      <li v-if="githubPending">
        <strong>Install the builder's GitHub App.</strong>
        Authorizing it proved who you are; installing it is what lets it create a
        repository. "Only select repositories" with nothing selected is enough.
        <div class="row">
          <a class="button" :href="githubInstallUrl" target="_blank" rel="noreferrer noopener">
            Install
          </a>
          <button type="button" class="ghost" @click="emit('recheckGitHub')">
            Check again
          </button>
        </div>
      </li>

      <li v-if="cloudflarePending">
        <strong>Connect Cloudflare to GitHub.</strong>
        Open any Worker, then Settings, Builds, Connect. This is Cloudflare's own GitHub
        app, and it is the only step of a build with no API at all. If you have connected
        a repository on this account before, it is already done — nothing here could
        confirm it.
        <div class="row">
          <a
            class="button"
            :href="cloudflareDashboardUrl"
            target="_blank"
            rel="noreferrer noopener"
          >
            Open the dashboard
          </a>
          <button
            type="button"
            class="ghost"
            :disabled="cloudflareChecking"
            @click="emit('recheckCloudflare')"
          >
            {{ cloudflareChecking ? "Checking…" : "Check again" }}
          </button>
        </div>
      </li>

      <li v-if="!cursorReady">
        <strong>Add a Cursor API key.</strong>
        Optional: without it the app is still created and deployed, just not worked on by
        an agent. Cursor has no consent flow, so this one is typed.
      </li>
    </ul>
  </section>
</template>

<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--app-border);
  border-radius: 0.5rem;
}

.setup h3 {
  margin: 0;
  font-size: 0.92rem;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.85rem;
}

.row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 0.4rem;
}

/* Matches the primary button beside it; a real link needs no script to open a tab. */
.button {
  font: inherit;
  padding: 0.45rem 0.9rem;
  border-radius: 0.35rem;
  background: var(--app-accent);
  color: #ffffff;
  text-decoration: none;
}
</style>
