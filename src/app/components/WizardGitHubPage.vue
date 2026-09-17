<script setup lang="ts">
import { computed } from "vue";

import { GITHUB_INSTALLATIONS_URL } from "@/app/wizard";
import type { BuilderHostConfig } from "@/app/hostApi";
import type { UseCloudflareConnectReturn } from "@/app/useCloudflareConnect";
import type { UseGitHubConnectReturn } from "@/app/useGitHubConnect";
import type { CloudflareAccount } from "@/core/cloudflare";
import type { BuilderCredentials, CredentialsStatus } from "@/core/credentials";
import type { CreateAppResult, FlowStep } from "@/core/createAppFlow";

import ConnectPanel from "@/app/components/ConnectPanel.vue";
import ProgressPanel from "@/app/components/ProgressPanel.vue";
import WizardPageHeader from "@/app/components/WizardPageHeader.vue";
import WizardTask from "@/app/components/WizardTask.vue";

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
  installUrl: string;
  repositoryName: string;
  githubError: string | null;
  canCreateRepo: boolean;
  running: boolean;
  steps: FlowStep[];
  result: CreateAppResult | null;
}>();

const emit = defineEmits<{
  save: [BuilderCredentials];
  initialize: [];
}>();

/**
 * Installing belongs to the "Connect GitHub" path alone, and is not a second thing to do
 * alongside the token.
 *
 * The device flow issues a user-to-server token, and such a token draws its *repository*
 * permissions from an installation — authorize without installing and every call answers
 * "Resource not accessible by integration". A personal access token carries its own
 * permissions instead, so it needs no installation at all. And when this deployment has
 * no GitHub App registered, `installUrl` is empty: there is then nothing to install, and
 * showing the step anyway leaves a chore on screen that cannot be completed.
 */
const showInstallTask = computed(() => props.installUrl !== "");
const createTaskIndex = computed(() => (showInstallTask.value ? 3 : 2));

/** Known-missing is the one case where this is not optional. */
const installMissing = computed(() => props.github.installation.value === "missing");
const installHint = computed(() =>
  installMissing.value
    ? "Needed now: you connected with the button above, and that connection cannot" +
      " touch your repositories until the app is installed. Choosing “All repositories”" +
      " means you never have to repeat this for your next app."
    : "Only needed if you used Connect GitHub above — a token you pasted yourself" +
      " already carries its own permissions. Choosing “All repositories” means you never" +
      " have to repeat this for your next app.",
);
</script>

<template>
  <section class="panel">
    <WizardPageHeader
      icon="github"
      title="Give your app a home on GitHub"
      purpose="GitHub stores your app's code. Because the code is yours, the app can keep growing later — and you are never locked in to us."
    />

    <WizardTask
      :index="1"
      title="Connect your GitHub account"
      hint="You approve this on GitHub. We only ever get what you grant, and you can withdraw it there at any time."
    >
      <ConnectPanel
        :credentials="credentials"
        :status="status"
        :can-store="canStore"
        :saving="saving"
        :config="config"
        :config-loaded="configLoaded"
        :github="github"
        :cloudflare="cloudflare"
        :cloudflare-accounts="cloudflareAccounts"
        :accounts="['github']"
        :show-header="false"
        @save="emit('save', $event)"
      />
    </WizardTask>

    <WizardTask
      v-if="showInstallTask"
      :index="2"
      title="Install the MindooDB app on GitHub"
      :hint="installHint"
      :skippable="!installMissing"
    >
      <div class="row">
        <a class="button" :href="installUrl" target="_blank" rel="noreferrer noopener">
          Install on GitHub
        </a>
        <a class="button button--ghost" :href="GITHUB_INSTALLATIONS_URL" target="_blank" rel="noreferrer noopener">
          Review what I granted
        </a>
      </div>
    </WizardTask>

    <WizardTask
      :index="createTaskIndex"
      title="Create the project"
      hint="We copy a working starter app into a new GitHub project named after your app. Nothing is published yet — that happens on the next page."
    >
      <p v-if="githubError" class="warn">{{ githubError }}</p>
      <button type="button" :disabled="!canCreateRepo" @click="emit('initialize')">
        {{ running ? "Creating your project…" : "Create my project" }}
      </button>
      <!-- The name is only set in monospace when it is a real one, never the placeholder. -->
      <p class="hint">
        <template v-if="repositoryName">
          Already created <code>{{ repositoryName }}</code> earlier?
        </template>
        <template v-else>Already created this project earlier?</template>
        Skip this and continue — the next page picks up where you left off.
      </p>
    </WizardTask>
  </section>

  <ProgressPanel :steps="steps" :result="result" :running="running" />
</template>

<style scoped>
.row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}
</style>
