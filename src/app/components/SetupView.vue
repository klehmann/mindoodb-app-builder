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
import { useI18n } from "vue-i18n";

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

const { t } = useI18n();

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
          ← {{ t("setup.back") }}
        </button>
      </header>

      <PageHeader
        icon="intro"
        :title="t('setup.header.title')"
        :purpose="t('setup.header.purpose')"
      />

      <p class="hint">{{ t("setup.intro") }}</p>
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
        <h2>{{ t("setup.access.title") }}</h2>
        <p class="muted">{{ t("setup.access.purpose") }}</p>
      </header>

      <label class="setup__choice">
        <input
          type="radio"
          name="repo-access"
          :checked="grantAll"
          @change="emit('repoAccess', 'all')"
        />
        <span>
          <strong>{{ t("setup.access.all.label") }}</strong>
          <span class="hint">{{ t("setup.access.all.hint") }}</span>
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
          <strong>{{ t("setup.access.selected.label") }}</strong>
          <span class="hint">{{ t("setup.access.selected.hint") }}</span>
        </span>
      </label>
    </section>

    <section class="panel">
      <header>
        <h2>{{ t("setup.installs.title") }}</h2>
        <p class="muted">
          {{ t("setup.installs.intro.lead") }}
          <!--
            Split around the <strong>, rather than carrying markup in a phrase: the
            emphasis is on the option's own name, which is the one part a translator
            must render exactly as GitHub labels it.
          -->
          <template v-if="grantAll">
            {{ t("setup.installs.intro.allBefore") }}
            <strong>{{ t("setup.installs.intro.allOption") }}</strong>
            {{ t("setup.installs.intro.allAfter") }}
          </template>
          <template v-else>
            {{ t("setup.installs.intro.selected") }}
          </template>
        </p>
      </header>

      <ol class="setup__installs">
        <li v-if="installUrl">
          <a class="button button--ghost" :href="installUrl" target="_blank" rel="noopener noreferrer">
            {{ t("setup.installs.builder.link") }}
          </a>
          <span class="hint">{{ t("setup.installs.builder.hint") }}</span>
        </li>
        <li>
          <a
            class="button button--ghost"
            :href="cloudflareInstallUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t("setup.installs.cloudflare.link") }}
          </a>
          <span class="hint">{{ t("setup.installs.cloudflare.hint") }}</span>
        </li>
        <li>
          <a
            class="button button--ghost"
            :href="cursorInstallUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t("setup.installs.cursor.link") }}
          </a>
          <span class="hint">{{ t("setup.installs.cursor.hint") }}</span>
        </li>
      </ol>

      <p class="hint">{{ t("setup.installs.note") }}</p>
    </section>

    <section class="panel">
      <button type="button" :disabled="!canFinish" @click="emit('finish')">
        {{ alreadyDone ? t("setup.finish.save") : t("setup.finish.start") }}
      </button>
      <p v-if="!canFinish" class="hint">{{ t("setup.finish.blocked") }}</p>
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
