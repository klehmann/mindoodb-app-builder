<script setup lang="ts">
import { computed } from "vue";

import { cloudflareGitHubInstallUrl } from "@/app/wizard";
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
  repositoryName: string;
  cloudflareError: string | null;
  canDeploy: boolean;
  canRegisterHaven: boolean;
  canBuildNow: boolean;
  running: boolean;
  steps: FlowStep[];
  result: CreateAppResult | null;
}>();

const emit = defineEmits<{
  save: [BuilderCredentials];
  deploy: [];
  register: [];
  buildNow: [];
}>();

const installUrl = cloudflareGitHubInstallUrl();

/**
 * One button, not two: "All repositories" and hand-picking this one are the same radio
 * group on GitHub's own page, and no URL can pre-select either. So the choice is
 * explained here and made there.
 */
const accessHint = computed(
  () =>
    "Cloudflare's GitHub App only reaches the repositories you point it at, and " +
    `${props.repositoryName || "your new project"} is not one of them yet. ` +
    "On GitHub, “All repositories” is the one-and-done choice; picking just this one works too.",
);
</script>

<template>
  <section class="panel">
    <WizardPageHeader
      icon="cloudflare"
      title="Publish your app on the web"
      purpose="Cloudflare turns your project into a real website with its own address. Every later change publishes itself automatically — that is what keeps the app alive instead of frozen."
    />

    <WizardTask
      :index="1"
      title="Connect your Cloudflare account"
      hint="Free to create. Cloudflare shows you exactly which permissions we ask for before you agree."
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
        :accounts="['cloudflare']"
        :show-header="false"
        @save="emit('save', $event)"
      />
    </WizardTask>

    <WizardTask
      :index="2"
      title="Let Cloudflare read your project"
      :hint="accessHint"
      skippable
    >
      <!-- Still a row: it keeps the link at its own width rather than the panel's. -->
      <div class="row">
        <a class="button" :href="installUrl" target="_blank" rel="noreferrer noopener">
          Allow Cloudflare on GitHub
        </a>
      </div>
    </WizardTask>

    <WizardTask
      :index="3"
      title="Publish it"
      hint="This takes a minute or two. You can watch each step below; when it is done, your app has a web address you can open."
    >
      <p v-if="cloudflareError" class="warn">{{ cloudflareError }}</p>
      <button type="button" :disabled="!canDeploy" @click="emit('deploy')">
        {{ running ? "Publishing…" : "Publish my app" }}
      </button>
    </WizardTask>

    <WizardTask
      :index="4"
      title="Add it to Haven"
      hint="Puts the finished app into your Haven workspace so you and your colleagues can actually use it."
    >
      <button type="button" class="ghost" :disabled="!canRegisterHaven" @click="emit('register')">
        Add to my Haven
      </button>
    </WizardTask>
  </section>

  <ProgressPanel
    :steps="steps"
    :result="result"
    :running="running"
    :can-build-now="canBuildNow"
    @build-now="emit('buildNow')"
  />
</template>

<style scoped>
.row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}
</style>
