<script setup lang="ts">
/**
 * The one-time setup. Everything technical about this builder lives here, once.
 *
 * Three connections and three installs, and then the user never sees this page again
 * unless something breaks or they come looking. That is the trade the whole redesign
 * rests on: front-load the awkward part, so building an app afterwards is a name and a
 * button.
 *
 * There are no verification checks, on purpose. Whether Cloudflare's GitHub App can read
 * a repository cannot be read back from any token we hold (see `githubApps.ts`), so this
 * page asks, explains what to pick, and trusts the answer. When a run later fails for a
 * missing grant, it says so and points back here — which is the honest version of a
 * check we cannot do.
 */
import { computed } from "vue";

import ConnectPanel from "@/app/components/ConnectPanel.vue";
import PageHeader from "@/app/components/PageHeader.vue";
import { cloudflareGitHubInstallUrl, cursorGitHubInstallUrl } from "@/app/githubApps";
import type { BuilderHostConfig } from "@/app/hostApi";
import type { UseCloudflareConnectReturn } from "@/app/useCloudflareConnect";
import type { UseGitHubConnectReturn } from "@/app/useGitHubConnect";
import type { CloudflareAccount } from "@/core/cloudflare";
import type { BuilderCredentials, CredentialsStatus } from "@/core/credentials";

const props = defineProps<{
  credentials: BuilderCredentials;
  status: CredentialsStatus;
  canStore: boolean;
  saving: boolean;
  config: BuilderHostConfig | null;
  configLoaded: boolean;
  github: UseGitHubConnectReturn;
  cloudflare: UseCloudflareConnectReturn;
  cloudflareAccounts: CloudflareAccount[];
  /** Where this builder's own GitHub App is installed. Empty when there is none. */
  installUrl: string;
  /** True when the user already finished setup once — then this is a revisit. */
  alreadyDone: boolean;
  /** False when there is nothing worth continuing to. */
  canFinish: boolean;
}>();

const emit = defineEmits<{
  save: [BuilderCredentials];
  repoAccess: ["all" | "selected"];
  finish: [];
  back: [];
}>();

const cloudflareInstallUrl = cloudflareGitHubInstallUrl();
const cursorInstallUrl = cursorGitHubInstallUrl();

/** Not yet answered counts as "all": it is the recommendation, and the quieter path. */
const grantAll = computed(() => props.credentials.repoAccess !== "selected");
</script>

<template>
  <div class="setup">
    <section class="panel">
      <header class="setup__head">
        <button
          v-if="alreadyDone"
          type="button"
          class="ghost setup__back"
          @click="emit('back')"
        >
          ← All apps
        </button>
      </header>

      <PageHeader
        icon="intro"
        title="Set up once, then build apps"
        purpose="Your apps need somewhere to live. Connect the three services below and approve a couple of installs — after that, creating an app is a name and a button."
      />

      <p class="hint">
        GitHub keeps the code and Cloudflare hosts it; both are free. Cursor is the AI
        developer that writes the app, and its cloud agents need a paid plan. You can
        leave Cursor out: the app is still created and published, and what you get is an
        ordinary Git repository — edit it yourself, or point Claude Code, Codex or any
        other tool at it.
      </p>
    </section>

    <!--
      Connecting the accounts. `show-header` is passed explicitly: Vue casts a missing
      boolean prop to `false`, which would put the panel in its embedded mode — no card,
      no heading — and leave this page's three sections looking like one long form.
    -->
    <ConnectPanel
      :show-header="true"
      :credentials="credentials"
      :status="status"
      :can-store="canStore"
      :saving="saving"
      :config="config"
      :config-loaded="configLoaded"
      :github="github"
      :cloudflare="cloudflare"
      :cloudflare-accounts="cloudflareAccounts"
      @save="emit('save', $event)"
    />

    <section class="panel">
      <header>
        <h2>How much access to give</h2>
        <p class="muted">
          Every app you build gets its own new GitHub project, and Cloudflare and Cursor
          have to be allowed to see it.
        </p>
      </header>

      <label class="setup__choice">
        <input
          type="radio"
          name="repo-access"
          :checked="grantAll"
          @change="emit('repoAccess', 'all')"
        />
        <span>
          <strong>All repositories — recommended</strong>
          <span class="hint">
            Approve once, and every future app is covered. Building an app becomes a
            single button. If that feels broad, use a GitHub account you keep for this.
          </span>
        </span>
      </label>

      <label class="setup__choice">
        <input
          type="radio"
          name="repo-access"
          :checked="!grantAll"
          @change="emit('repoAccess', 'selected')"
        />
        <span>
          <strong>Pick the repositories myself</strong>
          <span class="hint">
            Narrower, but every new app needs two extra approvals on GitHub before it can
            be published — the builder will tell you when.
          </span>
        </span>
      </label>
    </section>

    <section class="panel">
      <header>
        <h2>Approve the installs</h2>
        <p class="muted">
          Each link opens GitHub in a new tab.
          <template v-if="grantAll">
            Choose <strong>All repositories</strong> in every one of them.
          </template>
          <template v-else>
            Choose the repositories you want each one to see.
          </template>
        </p>
      </header>

      <ol class="setup__installs">
        <li v-if="installUrl">
          <a class="button button--ghost" :href="installUrl" target="_blank" rel="noopener noreferrer">
            Install the App Builder
          </a>
          <span class="hint">
            Lets this builder create the new project and make its first commit. Only
            needed if you connected GitHub with the button above — a token you pasted
            yourself already carries its own permissions.
          </span>
        </li>
        <li>
          <a
            class="button button--ghost"
            :href="cloudflareInstallUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            Install Cloudflare Workers and Pages
          </a>
          <span class="hint">
            Lets Cloudflare read the project so it can publish it, and re-publish on every
            change.
          </span>
        </li>
        <li>
          <a
            class="button button--ghost"
            :href="cursorInstallUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            Install Cursor
          </a>
          <span class="hint">
            Lets the AI developer read and write the project. Skip it if you would rather
            change the code yourself, or with a different tool.
          </span>
        </li>
      </ol>

      <p class="hint">
        We cannot see these installs from here, so nothing on this page will tick itself
        off. If a build later fails because something was not approved, we will say so and
        bring you back.
      </p>
    </section>

    <section class="panel">
      <button type="button" :disabled="!canFinish" @click="emit('finish')">
        {{ alreadyDone ? "Save and continue" : "I am done — start building" }}
      </button>
      <p v-if="!canFinish" class="hint">
        Connect GitHub and Cloudflare above first. Those two are what create and publish
        your app.
      </p>
    </section>
  </div>
</template>

<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.setup__head {
  flex-direction: row !important;
}

.setup__back {
  padding-inline: 0.5rem;
  font-size: 0.85rem;
}

.setup__choice {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--app-border);
  border-radius: 0.6rem;
  cursor: pointer;
}

.setup__choice:hover {
  border-color: var(--app-accent);
}

.setup__choice > span {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.setup__installs {
  margin: 0;
  padding-left: 1.2rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.setup__installs li {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
}
</style>
