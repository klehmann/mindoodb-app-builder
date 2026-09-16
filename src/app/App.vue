<script setup lang="ts">
import { onMounted, ref } from "vue";

import AgentPanel from "@/app/components/AgentPanel.vue";
import ConnectPanel from "@/app/components/ConnectPanel.vue";
import NewAppPanel from "@/app/components/NewAppPanel.vue";
import ProgressPanel from "@/app/components/ProgressPanel.vue";
import { checkHostAlive, readHostConfig, type BuilderHostConfig } from "@/app/hostApi";
import { useBuilderFlow } from "@/app/useBuilderFlow";
import { useBuilderSession } from "@/app/useBuilderSession";
import { useCloudflareConnect } from "@/app/useCloudflareConnect";
import { useGitHubConnect } from "@/app/useGitHubConnect";
import { getAuthenticatedUser } from "@/core/github";

const session = useBuilderSession();
const hostConfig = ref<BuilderHostConfig | null>(null);
const flow = useBuilderFlow(session, hostConfig);
const hostAlive = ref(true);
/** Distinguishes "still asking" from "asked, and there is nothing to connect to". */
const hostConfigLoaded = ref(false);

/**
 * A completed connect flow saves immediately rather than waiting for "Save accounts".
 * The user has just approved something in another window; asking them to confirm it
 * again here would only create a way to lose it.
 */
const github = useGitHubConnect(async (token) => {
  // Ask GitHub who the token belongs to instead of making the user type it. An owner
  // they already set is left alone — it may be an organization rather than themselves.
  let owner = session.credentials.value.githubOwner;
  if (!owner) {
    try {
      owner = (await getAuthenticatedUser(token)).login;
    } catch {
      // Not worth failing the connect over; the field is still there to fill in.
    }
  }
  await session.storeCredentials({
    ...session.credentials.value,
    githubToken: token,
    githubOwner: owner,
  });
});

const cloudflare = useCloudflareConnect(hostConfig, async ({ tokens, accounts }) => {
  await session.storeCredentials({
    ...session.credentials.value,
    cloudflareToken: tokens.accessToken,
    cloudflareRefreshToken: tokens.refreshToken,
    cloudflareExpiresAt: tokens.expiresAt ?? 0,
    // One account is not a choice, so it is not presented as one.
    cloudflareAccountId:
      accounts.length === 1 ? accounts[0].id : session.credentials.value.cloudflareAccountId,
  });
});

onMounted(async () => {
  await session.connect();
  hostAlive.value = await checkHostAlive();
  hostConfig.value = await readHostConfig();
  hostConfigLoaded.value = true;
});
</script>

<template>
  <main class="app">
    <header class="head">
      <h1>App Builder</h1>
      <p v-if="session.connecting.value" class="muted">Connecting to Haven…</p>
      <p v-else-if="session.error.value" class="warn">{{ session.error.value }}</p>
      <p v-else-if="session.connected.value" class="muted">
        Signed in as {{ session.userName.value }}.
        <span v-if="!session.canProposeApps.value">
          This install did not grant app proposal, so the finished app has to be added to
          Haven by hand — the builder will show you the URL.
        </span>
      </p>
    </header>

    <p v-if="!hostAlive" class="warn banner">
      The builder host is not answering, so the Cursor agent step is unavailable. Start it
      with <code>npx mindoodb-app-builder</code>.
    </p>

    <ConnectPanel
      :credentials="session.credentials.value"
      :status="session.credentialsStatus.value"
      :can-store="session.canStoreCredentials.value"
      :saving="session.savingCredentials.value"
      :config="hostConfig"
      :config-loaded="hostConfigLoaded"
      :github="github"
      :cloudflare="cloudflare"
      :cloudflare-accounts="cloudflare.accounts.value"
      @save="session.storeCredentials"
    />

    <NewAppPanel
      :form="flow.form.value"
      :planned-repository-name="flow.plannedRepositoryName.value"
      :form-error="flow.formError.value"
      :can-start="flow.canStart.value"
      :running="flow.running.value"
      @label-input="flow.onLabelInput"
      @slug-input="flow.onSlugInput"
      @start="flow.start"
    />

    <ProgressPanel
      :steps="flow.steps.value"
      :result="flow.result.value"
      :running="flow.running.value"
    />

    <AgentPanel
      :agent="flow.agent.value"
      :cursor-token="session.credentials.value.cursorToken"
    />

    <footer class="foot">
      <p class="muted">
        Your tokens live in one document in your own database, encrypted for you. This
        builder is open source — if you would rather not use the hosted one, run it
        yourself and point Haven at your own URL.
      </p>
    </footer>
  </main>
</template>

<style>
:root {
  color-scheme: light;
  --app-background: #f6f8fb;
  --app-surface: #ffffff;
  --app-text: #0d1b2a;
  --app-muted: #5a6b7d;
  --app-border: #dde4ec;
  --app-accent: #1b5fd9;
  --app-danger: #b42318;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --app-background: #081325;
  --app-surface: #0f1e33;
  --app-text: #f6f8ff;
  --app-muted: #9fb0c4;
  --app-border: #1e3350;
  --app-accent: #7ec8ff;
  --app-danger: #ff9b8f;
}

body {
  margin: 0;
  background: var(--app-background);
  color: var(--app-text);
  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

a {
  color: var(--app-accent);
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
}

.panel {
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: 0.6rem;
  padding: 1.1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.panel header {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.panel h2 {
  margin: 0;
  font-size: 1.05rem;
}

.panel p {
  margin: 0;
}

.muted {
  color: var(--app-muted);
  font-size: 0.85rem;
}

.warn {
  color: var(--app-danger);
  font-size: 0.85rem;
}

.hint {
  color: var(--app-muted);
  font-size: 0.78rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.field label {
  font-size: 0.85rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

input[type="text"],
input[type="password"],
textarea {
  font: inherit;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--app-border);
  border-radius: 0.35rem;
  background: var(--app-background);
  color: var(--app-text);
}

textarea {
  resize: vertical;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.85rem;
}

button {
  font: inherit;
  align-self: flex-start;
  padding: 0.45rem 0.9rem;
  border: 1px solid transparent;
  border-radius: 0.35rem;
  background: var(--app-accent);
  color: #ffffff;
  cursor: pointer;
}

button:disabled {
  opacity: 0.55;
  cursor: default;
}

button.ghost {
  background: transparent;
  color: var(--app-text);
  border-color: var(--app-border);
}

.badge {
  font-size: 0.7rem;
  font-weight: 500;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  background: var(--app-accent);
  color: #ffffff;
}

.badge--soft {
  background: transparent;
  color: var(--app-muted);
  border: 1px solid var(--app-border);
}
</style>

<style scoped>
.app {
  max-width: 46rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.head h1 {
  margin: 0 0 0.3rem;
  font-size: 1.5rem;
}

.banner {
  border: 1px solid var(--app-border);
  border-radius: 0.5rem;
  padding: 0.6rem 0.8rem;
}

.foot {
  margin-top: 0.5rem;
}
</style>
