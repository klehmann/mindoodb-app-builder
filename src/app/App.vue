<script setup lang="ts">
/**
 * The builder's shell: four views, and the wiring between them.
 *
 * The shape of this file is the redesign. It used to hand a five-page wizard everything
 * it knew; now it opens on the list of apps the user already built, and the technical
 * pages are one link in the footer. What changed is not the work — the same phases run —
 * but who has to press the buttons.
 *
 * - `home` — the apps you built. Opening one is the normal case.
 * - `new` — a name, a brief, one button.
 * - `app` — one app afterwards: its address, publishing, the code, the AI.
 * - `setup` — the one-time connections. Shown unasked on a first launch, and reachable
 *   from the footer forever after, because a token that expires is the one thing that
 *   sends a user back.
 */
import { computed, onMounted, ref } from "vue";

import AppDetail from "@/app/components/AppDetail.vue";
import AppList from "@/app/components/AppList.vue";
import NewAppView from "@/app/components/NewAppView.vue";
import SetupView from "@/app/components/SetupView.vue";
import { resolveGitHubOwner } from "@/app/githubOwner";
import { listCloudflareBuilds, readHostConfig, type BuilderHostConfig } from "@/app/hostApi";
import { saveAppDefinition } from "@/app/saveDefinition";
import { useAppRecords } from "@/app/useAppRecords";
import { useBuilderFlow } from "@/app/useBuilderFlow";
import { useBuilderSession } from "@/app/useBuilderSession";
import { useCloudflareConnect } from "@/app/useCloudflareConnect";
import { useGitHubConnect } from "@/app/useGitHubConnect";
import { appDefinitionUrl, type StoredAppRecord } from "@/core/appRecords";
import type { WorkerBuild } from "@/core/cloudflare";
import { isSetupComplete, type BuilderCredentials } from "@/core/credentials";
import { getAuthenticatedUser } from "@/core/github";

type BuilderViewId = "home" | "new" | "app" | "setup";

const session = useBuilderSession();
const records = useAppRecords(session);
const hostConfig = ref<BuilderHostConfig | null>(null);
const flow = useBuilderFlow(session, hostConfig, records);
/** Distinguishes "still asking" from "asked, and there is nothing to connect to". */
const hostConfigLoaded = ref(false);

const view = ref<BuilderViewId>("home");
const setupComplete = computed(() => isSetupComplete(session.credentials.value));

/** Cloudflare's builds for the open app, fetched when asked rather than polled. */
const builds = ref<WorkerBuild[] | null>(null);
const buildsError = ref<string | null>(null);
/** One line of feedback for actions that otherwise leave no trace, like a download. */
const statusMessage = ref<string | null>(null);
const copied = ref(false);

/**
 * A completed connect flow saves immediately rather than waiting for "Save accounts".
 * The user has just approved something in another window; asking them to confirm it
 * again here would only create a way to lose it.
 */
const github = useGitHubConnect(
  async (token) => {
    // Ask GitHub who the token belongs to instead of making the user type it. An owner
    // they already set is left alone — it may be an organization, not themselves.
    await session.storeCredentials({
      ...session.credentials.value,
      githubToken: token,
      githubOwner: await resolveGitHubOwner({
        owner: session.credentials.value.githubOwner,
        token,
        lookup: getAuthenticatedUser,
      }),
    });
  },
  {
    appSlug: () => hostConfig.value?.githubAppSlug ?? "",
    token: () => session.credentials.value.githubToken,
  },
);

/** A pasted token gets its owner resolved the same way a connected one does. */
async function saveCredentials(next: BuilderCredentials): Promise<void> {
  await session.storeCredentials({
    ...next,
    githubOwner: await resolveGitHubOwner({
      owner: next.githubOwner,
      token: next.githubToken,
      lookup: getAuthenticatedUser,
    }),
  });
}

const cloudflare = useCloudflareConnect(
  hostConfig,
  async ({ tokens, accounts }) => {
    await session.storeCredentials({
      ...session.credentials.value,
      cloudflareToken: tokens.accessToken,
      cloudflareRefreshToken: tokens.refreshToken,
      cloudflareExpiresAt: tokens.expiresAt ?? 0,
      // One account is not a choice, so it is not presented as one.
      cloudflareAccountId:
        accounts.length === 1
          ? accounts[0].id
          : session.credentials.value.cloudflareAccountId,
    });
  },
);

const activeRecord = computed(() => records.active.value);

function clearTransient(): void {
  statusMessage.value = null;
  buildsError.value = null;
  builds.value = null;
  copied.value = false;
}

function showHome(): void {
  clearTransient();
  view.value = "home";
}

function startNewApp(): void {
  clearTransient();
  flow.reset();
  records.clearActive();
  view.value = "new";
}

function openApp(stored: StoredAppRecord): void {
  clearTransient();
  flow.openRecord(stored);
  view.value = "app";
  void loadBuilds();
}

/** After a run finishes on the new-app page, the app gets its own page. */
function openBuiltApp(): void {
  const documentId = records.activeDocumentId.value;
  const stored = records.records.value.find((entry) => entry.documentId === documentId);
  if (stored) {
    openApp(stored);
    return;
  }
  // No record to open — a builder database without write access. The finished run is
  // still on screen, so staying put is better than an empty page.
  view.value = "new";
}

function openSetup(): void {
  clearTransient();
  view.value = "setup";
}

async function setRepoAccess(mode: "all" | "selected"): Promise<void> {
  await session.storeCredentials({ ...session.credentials.value, repoAccess: mode });
}

/**
 * Record that setup is done and get out of the way.
 *
 * The timestamp is the user's claim, not a verification — see `credentials.ts`. Storing
 * it is what stops this page from greeting them on every launch.
 */
async function finishSetup(): Promise<void> {
  await session.storeCredentials({
    ...session.credentials.value,
    setupCompletedAt: new Date().toISOString(),
    // Answered implicitly by finishing with the default selected.
    repoAccess: session.credentials.value.repoAccess || "all",
  });
  showHome();
}

async function loadBuilds(): Promise<void> {
  const record = activeRecord.value;
  const credentials = session.credentials.value;
  if (!record?.workerScriptTag || !credentials.cloudflareToken || !credentials.cloudflareAccountId) {
    return;
  }
  buildsError.value = null;
  try {
    const result = await listCloudflareBuilds({
      cloudflareToken: credentials.cloudflareToken,
      accountId: credentials.cloudflareAccountId,
      scriptTag: record.workerScriptTag,
    });
    builds.value = result.builds;
  } catch (error) {
    builds.value = null;
    // Decoration, not a failure: the app works whether or not its build history loads.
    buildsError.value =
      error instanceof Error
        ? `Cloudflare did not report the build status: ${error.message}`
        : "Cloudflare did not report the build status.";
  }
}

async function copyAppUrl(): Promise<void> {
  const url = activeRecord.value?.workerUrl;
  if (!url) {
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    statusMessage.value = `Copying failed. The address is ${url}`;
  }
}

async function saveDefinition(): Promise<void> {
  const record = activeRecord.value;
  if (!record) {
    return;
  }
  statusMessage.value = null;
  try {
    const outcome = await saveAppDefinition(
      appDefinitionUrl(record),
      `${record.appId || "haven-app"}.haven-app.json`,
    );
    statusMessage.value =
      outcome === "saved"
        ? "Saved the app definition to your downloads."
        : "Opened the app definition in a new tab — save it from there.";
  } catch (error) {
    statusMessage.value =
      error instanceof Error ? error.message : "The app definition could not be saved.";
  }
}

async function addToHaven(): Promise<void> {
  await flow.registerHaven();
}

async function buildNow(): Promise<void> {
  await flow.continueApp();
  await loadBuilds();
}

async function forgetApp(): Promise<void> {
  const documentId = records.activeDocumentId.value;
  if (!documentId) {
    return;
  }
  await records.forget(documentId);
  showHome();
}

/**
 * Remove a row from the list without opening it first.
 *
 * Stays on the list, unlike {@link forgetApp}: the user is looking at the thing they
 * just removed disappearing, which is the confirmation. `forget` clears the active
 * record itself if it happens to be this one.
 */
async function forgetListedApp(stored: StoredAppRecord): Promise<void> {
  await records.forget(stored.documentId);
}

onMounted(async () => {
  await session.connect();
  hostConfig.value = await readHostConfig();
  hostConfigLoaded.value = true;
  await records.refresh();
  // A first launch has nothing to list and nothing connected, so the setup is the page.
  // Every later launch opens on the apps, even if a token has since expired — the run
  // that fails is a better place to say so than a page that blocks the way in.
  if (!setupComplete.value) {
    view.value = "setup";
  }
});
</script>

<template>
  <main class="app">
    <header class="head">
      <h1>App Builder</h1>
      <p class="tagline">Describe an app. Get it into Haven.</p>
      <p v-if="session.connecting.value" class="muted">Connecting to Haven…</p>
      <p v-else-if="session.error.value" class="warn">
        {{ session.error.value }}
      </p>
      <p
        v-else-if="session.connected.value && !session.canProposeApps.value"
        class="muted"
      >
        This Haven install cannot add apps for you, so you will add the finished
        app yourself — we show you the link.
      </p>
    </header>

    <SetupView
      v-if="view === 'setup'"
      :credentials="session.credentials.value"
      :status="session.credentialsStatus.value"
      :can-store="session.canStoreCredentials.value"
      :saving="session.savingCredentials.value"
      :config="hostConfig"
      :config-loaded="hostConfigLoaded"
      :github="github"
      :cloudflare="cloudflare"
      :cloudflare-accounts="cloudflare.accounts.value"
      :install-url="github.installUrl.value"
      :already-done="setupComplete"
      :can-finish="
        session.credentialsStatus.value.github &&
        session.credentialsStatus.value.cloudflare
      "
      @save="saveCredentials"
      @repo-access="setRepoAccess"
      @finish="finishSetup"
      @back="showHome"
    />

    <NewAppView
      v-else-if="view === 'new'"
      :form="flow.form.value"
      :planned-repository-name="flow.plannedRepositoryName.value"
      :form-error="flow.formError.value"
      :create-error="flow.createAppError.value"
      :can-create="flow.canCreateApp.value"
      :running="flow.running.value"
      :steps="flow.steps.value"
      :result="flow.result.value"
      :cursor-ready="session.credentialsStatus.value.cursor"
      :narrow-access="session.credentials.value.repoAccess === 'selected'"
      @label-input="flow.onLabelInput"
      @slug-input="flow.onSlugInput"
      @create="flow.createApp"
      @back="showHome"
      @open-app="openBuiltApp"
    />

    <AppDetail
      v-else-if="view === 'app' && activeRecord"
      :record="activeRecord"
      :steps="flow.steps.value"
      :result="flow.result.value"
      :running="flow.running.value"
      :can-propose="session.canProposeApps.value"
      :can-forget="records.canForget.value"
      :agent="flow.agent.value"
      :cursor-token="session.credentials.value.cursorToken"
      :builds="builds"
      :builds-error="buildsError"
      :copied="copied"
      :status-message="statusMessage"
      @back="showHome"
      @continue-app="buildNow"
      @copy-url="copyAppUrl"
      @add-to-haven="addToHaven"
      @save-definition="saveDefinition"
      @build-now="buildNow"
      @refresh-builds="loadBuilds"
      @launch-cursor="flow.launchCursor"
      @forget="forgetApp"
    />

    <AppList
      v-else
      :records="records.records.value"
      :loading="records.loading.value"
      :can-store="records.canStore.value"
      :can-forget="records.canForget.value"
      @open="openApp"
      @create="startNewApp"
      @forget="forgetListedApp"
    />

    <footer class="foot">
      <p class="muted">
        <button type="button" class="ghost foot__setup" @click="openSetup">
          Connections and setup
        </button>
        <template v-if="session.canStoreCredentials.value">
          The tokens and keys you enter there are saved, so you do not have to
          create them again the next time you build an app. They live in one
          document in your own App Builder database, encrypted so that only you
          can read them — not even someone you share that database with.
        </template>
        <template v-else>
          The tokens and keys you enter there stay in this page only; nothing is
          saved.
        </template>
        The App Builder is
        <a
          class="foot__source"
          href="https://github.com/klehmann/mindoodb-app-builder"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg
            class="foot__mark"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
            focusable="false"
          >
            <path
              fill="currentColor"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
          open source </a
        >. If you would rather not use the copy we host, you can run your own
        and add that to Haven instead.
      </p>
    </footer>
  </main>
</template>

<style>
:root {
  color-scheme: light;
  --app-background: #f5f7fb;
  --app-surface: #ffffff;
  --app-text: #101828;
  --app-muted: #5a6b7d;
  --app-border: #e2e8f0;
  --app-accent: #1b5fd9;
  /* Tinted backgrounds for badges, callouts and the live-app banner. */
  --app-accent-soft: rgba(27, 95, 217, 0.09);
  --app-danger: #b42318;
  --app-shadow:
    0 1px 2px rgba(16, 24, 40, 0.04), 0 8px 24px rgba(16, 24, 40, 0.05);
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --app-background: #081325;
  --app-surface: #0f1e33;
  --app-text: #f6f8ff;
  --app-muted: #9fb0c4;
  --app-border: #1e3350;
  --app-accent: #7ec8ff;
  --app-accent-soft: rgba(126, 200, 255, 0.14);
  --app-danger: #ff9b8f;
  --app-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.25);
}

body {
  margin: 0;
  background: var(--app-background);
  color: var(--app-text);
  /* System UI first: SF Pro / Segoe UI / Roboto are already on the machine, so the
     interface has proper type from the first paint and never fetches a font. */
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI",
    Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

a {
  color: var(--app-accent);
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
  padding: 0.05em 0.3em;
  border-radius: 0.25rem;
  background: var(--app-accent-soft);
}

:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}

.panel {
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: 0.85rem;
  padding: 1.35rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  box-shadow: var(--app-shadow);
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
  font-size: 0.88rem;
}

.warn {
  color: var(--app-danger);
  font-size: 0.88rem;
}

.hint {
  color: var(--app-muted);
  font-size: 0.82rem;
  line-height: 1.5;
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
  font-weight: 600;
  align-self: flex-start;
  padding: 0.5rem 1rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  background: var(--app-accent);
  color: #ffffff;
  cursor: pointer;
  transition:
    filter 0.15s ease,
    background 0.15s ease;
}

button:hover:not(:disabled) {
  filter: brightness(1.07);
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

button.ghost {
  background: transparent;
  color: var(--app-text);
  border-color: var(--app-border);
}

/* The confirming half of a destructive pair. Never the first click of one. */
button.danger {
  background: var(--app-danger);
  color: #ffffff;
}

/*
 * Links that look like buttons. They stay real links so a new tab opens without script —
 * the iframe allows popups, but a plain anchor needs nothing.
 */
.button {
  font: inherit;
  font-weight: 600;
  display: inline-block;
  padding: 0.5rem 1rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  background: var(--app-accent);
  color: #ffffff;
  text-decoration: none;
}

.button:hover {
  filter: brightness(1.07);
}

.button--ghost {
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
  max-width: 48rem;
  margin: 0 auto;
  padding: 2.25rem 1.25rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.head h1 {
  margin: 0;
  font-size: 1.75rem;
  letter-spacing: -0.02em;
}

.tagline {
  margin: 0.15rem 0 0.4rem;
  font-size: 1rem;
  color: var(--app-muted);
}

.foot {
  margin-top: 0.5rem;
}

/*
 * The way back into the technical pages. A button rather than a link because it switches
 * a view, and styled as inline text because it is a footnote, not an action the page is
 * asking for.
 */
.foot__setup {
  align-self: auto;
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: var(--app-accent);
  font-size: inherit;
  font-weight: 600;
  cursor: pointer;
}

.foot__setup::after {
  content: " · ";
  color: var(--app-muted);
  font-weight: 400;
}

.foot__source {
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
  font-weight: 600;
  text-decoration: none;
}

.foot__source:hover,
.foot__source:focus-visible {
  text-decoration: underline;
}

.foot__mark {
  flex: none;
  display: block;
}
</style>
