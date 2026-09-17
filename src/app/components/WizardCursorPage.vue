<script setup lang="ts">
import { computed } from "vue";

import { cursorGitHubInstallUrl } from "@/app/wizard";
import type { BuilderHostConfig } from "@/app/hostApi";
import type { UseCloudflareConnectReturn } from "@/app/useCloudflareConnect";
import type { UseGitHubConnectReturn } from "@/app/useGitHubConnect";
import type { CloudflareAccount } from "@/core/cloudflare";
import type { BuilderCredentials, CredentialsStatus } from "@/core/credentials";
import type { AgentHandle, CreateAppResult, FlowStep } from "@/core/createAppFlow";

import AgentPanel from "@/app/components/AgentPanel.vue";
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
  cursorError: string | null;
  canLaunchCursor: boolean;
  running: boolean;
  steps: FlowStep[];
  result: CreateAppResult | null;
  agent: AgentHandle | null;
}>();

const emit = defineEmits<{
  save: [BuilderCredentials];
  launch: [];
}>();

const installUrl = cursorGitHubInstallUrl();
const cursorUiUrl = "https://cursor.com/agents";

/** Same one-button reasoning as the Cloudflare page: GitHub owns the scope choice. */
const accessHint = computed(
  () =>
    "Cursor works through its own GitHub App, which cannot see " +
    `${props.repositoryName || "your new project"} until you allow it. ` +
    "On GitHub, “All repositories” is the one-and-done choice; picking just this one works too.",
);
</script>

<template>
  <section class="panel">
    <WizardPageHeader
      icon="cursor"
      title="Let AI build what you described"
      purpose="Cursor is the AI developer. It reads your description, writes the app, and publishes it — and it is still there whenever you want to change something later."
    />

    <WizardTask
      :index="1"
      title="Connect Cursor"
      hint="Cursor has no one-click approval yet, so you copy an API key from your Cursor dashboard. Optional: your app is already live without it."
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
        :accounts="['cursor']"
        :show-header="false"
        @save="emit('save', $event)"
      />
    </WizardTask>

    <WizardTask
      :index="2"
      title="Let Cursor read your project"
      :hint="accessHint"
      skippable
    >
      <!-- Still a row: it keeps the link at its own width rather than the panel's. -->
      <div class="row">
        <a class="button" :href="installUrl" target="_blank" rel="noreferrer noopener">
          Allow Cursor on GitHub
        </a>
      </div>
    </WizardTask>

    <WizardTask
      :index="3"
      title="Start building"
      hint="The AI gets the description you wrote and starts working. Its changes publish themselves, so your live app updates on its own."
    >
      <p v-if="cursorError" class="warn">{{ cursorError }}</p>
      <div class="row">
        <button type="button" :disabled="!canLaunchCursor" @click="emit('launch')">
          {{ running ? "Starting…" : "Start building my app" }}
        </button>
        <a class="button button--ghost" :href="cursorUiUrl" target="_blank" rel="noreferrer noopener">
          Open Cursor
        </a>
      </div>
      <p class="hint">
        Want changes later? Come back to Cursor, describe the change, and your live app
        updates itself. This is why the app is yours to keep extending.
      </p>
    </WizardTask>
  </section>

  <ProgressPanel :steps="steps" :result="result" :running="running" />
  <AgentPanel :agent="agent" :cursor-token="credentials.cursorToken" />
</template>

<style scoped>
.row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}
</style>
