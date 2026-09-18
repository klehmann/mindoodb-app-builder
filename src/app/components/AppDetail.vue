<script setup lang="ts">
/**
 * One app, and everything you can do with it afterwards.
 *
 * The list gets you here; this page is why the records exist. Open it, copy its address,
 * add it to Haven again, save its definition, jump to the code or to Cloudflare, start a
 * build, or hand it back to the AI. All of it from what was written down when the app was
 * built, so none of it needs a live service to render.
 *
 * Unfinished apps get one button — "Continue" — and the record decides what that means.
 * That is the deliberate opposite of the old wizard, where the user had to know which
 * phase to re-run.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import AgentPanel from "@/app/components/AgentPanel.vue";
import ProgressPanel from "@/app/components/ProgressPanel.vue";
import {
  appDefinitionUrl,
  appStage,
  nextAppAction,
  workerDashboardUrl,
  type BuilderAppRecord,
} from "@/core/appRecords";
import type { WorkerBuild } from "@/core/cloudflare";
import type { AgentHandle, CreateAppResult, FlowStep } from "@/core/createAppFlow";

const { t } = useI18n();

const props = defineProps<{
  record: BuilderAppRecord;
  /** Live flow state, for a run started from this page. */
  steps: FlowStep[];
  result: CreateAppResult | null;
  running: boolean;
  canPropose: boolean;
  canForget: boolean;
  /** The Cursor agent working on this app, and the key to ask it for more. */
  agent: AgentHandle | null;
  cursorToken: string;
  /** Cloudflare's recent builds, or null while unknown. */
  builds: WorkerBuild[] | null;
  buildsError: string | null;
  /** Set after "copy" so the button can confirm itself. */
  copied: boolean;
  statusMessage: string | null;
}>();

const emit = defineEmits<{
  back: [];
  continueApp: [];
  copyUrl: [];
  addToHaven: [];
  saveDefinition: [];
  buildNow: [];
  refreshBuilds: [];
  launchCursor: [];
  forget: [];
}>();

const stage = computed(() => appStage(props.record));
const action = computed(() => nextAppAction(props.record));
const live = computed(() => stage.value === "live" || stage.value === "installed");
const definitionUrl = computed(() => appDefinitionUrl(props.record));
const dashboardUrl = computed(() => workerDashboardUrl(props.record));

/**
 * What "Continue" is about to do, said plainly so the button is never a surprise.
 *
 * The action id is the translation key, so `core/appRecords` stays free of display text:
 * it decides what happens next, this page says it in the reader's language.
 */
const continueLabel = computed(() => t(`detail.continue.labels.${action.value}`));
const continueHint = computed(() => t(`detail.continue.hints.${action.value}`));

/** The newest build, which is the only one the page shows. */
const lastBuild = computed(() => props.builds?.[0] ?? null);

/**
 * Build states we have a sentence for. Checked against this list rather than asking
 * vue-i18n whether the key exists, so a locale that has not been translated yet still
 * gets the sentence through the English fallback instead of the raw-status wording.
 */
const KNOWN_BUILD_STATUSES = ["success", "failed", "running", "queued", "canceled"];

const buildSummary = computed(() => {
  const build = lastBuild.value;
  if (!build) {
    return "";
  }
  const words = KNOWN_BUILD_STATUSES.includes(build.status)
    ? t(`detail.builds.status.${build.status}`)
    : t("detail.builds.statusOther", { status: build.status });
  const when = formatDateTime(build.createdAt);
  return when ? `${words} ${when}` : words;
});

function formatDateTime(iso: string): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}
</script>

<template>
  <section class="panel">
    <header class="detail__head">
      <button type="button" class="ghost detail__back" @click="emit('back')">
        ← {{ t("detail.back") }}
      </button>
    </header>

    <div>
      <h2 class="detail__title">{{ record.label || record.appId }}</h2>
      <p v-if="record.description" class="muted">{{ record.description }}</p>
    </div>

    <!--
      The address first: it is what the user came for, and what they send to colleagues.
      A live app shows it as a link; one that is not live yet says so instead of offering
      a link that would answer "deploying".
    -->
    <div v-if="live" class="detail__address">
      <a class="detail__url" :href="record.workerUrl" target="_blank" rel="noopener noreferrer">
        {{ record.workerUrl }}
      </a>
      <div class="detail__row">
        <a
          class="button"
          :href="record.workerUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ t("detail.address.open") }}
        </a>
        <button type="button" class="ghost" @click="emit('copyUrl')">
          {{ copied ? t("detail.address.copied") : t("detail.address.copy") }}
        </button>
        <button
          v-if="canPropose"
          type="button"
          class="ghost"
          :disabled="running"
          @click="emit('addToHaven')"
        >
          {{
            record.havenInstanceId
              ? t("detail.address.addToHavenAgain")
              : t("detail.address.addToHaven")
          }}
        </button>
        <button
          v-if="definitionUrl"
          type="button"
          class="ghost"
          @click="emit('saveDefinition')"
        >
          {{ t("detail.address.saveAsFile") }}
        </button>
      </div>
      <p class="hint">{{ t("detail.address.hint") }}</p>
    </div>

    <!-- Unfinished: one button, and it says what it will do. -->
    <div v-if="action !== 'iterate' || !live" class="detail__continue">
      <button type="button" :disabled="running" @click="emit('continueApp')">
        {{ running ? t("detail.continue.working") : continueLabel }}
      </button>
      <p class="hint">{{ continueHint }}</p>
    </div>

    <p v-if="statusMessage" class="muted">{{ statusMessage }}</p>

    <!-- Live flow output, only once something has actually run on this page. -->
    <ProgressPanel
      v-if="steps.some((step) => step.status !== 'pending')"
      :steps="steps"
      :result="result"
      :running="running"
    />

    <div class="detail__links">
      <h3>{{ t("detail.links.heading") }}</h3>
      <ul class="detail__link-list">
        <li v-if="record.repoUrl">
          <a :href="record.repoUrl" target="_blank" rel="noopener noreferrer">
            {{ t("detail.links.repo") }}
          </a>
          <span class="hint">{{ t("detail.links.repoHint") }}</span>
        </li>
        <li v-if="dashboardUrl">
          <a :href="dashboardUrl" target="_blank" rel="noopener noreferrer">
            {{ t("detail.links.hosting") }}
          </a>
          <span class="hint">{{ t("detail.links.hostingHint") }}</span>
        </li>
        <li v-if="record.cursorAgentUrl">
          <a :href="record.cursorAgentUrl" target="_blank" rel="noopener noreferrer">
            {{ t("detail.links.agent") }}
          </a>
          <span class="hint">{{ t("detail.links.agentHint") }}</span>
        </li>
      </ul>
    </div>

    <!--
      Builds are read from Cloudflare on demand. Not polled: the answer matters when the
      user asks, and a page that polls a third-party API in the background is a page that
      fails quietly when a token expires.
    -->
    <div v-if="record.workerScriptTag" class="detail__builds">
      <h3>{{ t("detail.builds.heading") }}</h3>
      <p v-if="buildSummary" class="muted">{{ buildSummary }}</p>
      <p v-else-if="buildsError" class="hint">{{ buildsError }}</p>
      <p v-else-if="builds && builds.length === 0" class="hint">
        {{ t("detail.builds.none") }}
      </p>
      <div class="detail__row">
        <button type="button" class="ghost" :disabled="running" @click="emit('buildNow')">
          {{ t("detail.builds.buildNow") }}
        </button>
        <button type="button" class="ghost" @click="emit('refreshBuilds')">
          {{ t("detail.builds.refresh") }}
        </button>
      </div>
      <p class="hint">{{ t("detail.builds.hint") }}</p>
    </div>

    <!--
      Asking the AI for changes is the main thing you do with a finished app, so it lives
      here rather than being a trip to Cursor's own UI. The panel polls its own run.
    -->
    <AgentPanel v-if="agent && cursorToken" :agent="agent" :cursor-token="cursorToken" />

    <div v-else-if="live" class="detail__row">
      <button type="button" class="ghost" :disabled="running" @click="emit('launchCursor')">
        {{ t("detail.agent.launch") }}
      </button>
      <span v-if="!cursorToken" class="hint">{{ t("detail.agent.needsKey") }}</span>
    </div>

    <!--
      Forgetting is not deleting. Said here rather than in a confirmation dialog, because
      the sentence is the whole reassurance.
    -->
    <details v-if="canForget" class="detail__forget">
      <summary>{{ t("detail.forget.summary") }}</summary>
      <p class="hint">{{ t("detail.forget.hint") }}</p>
      <button type="button" class="ghost" @click="emit('forget')">
        {{ t("detail.forget.button") }}
      </button>
    </details>
  </section>
</template>

<style scoped>
.detail__head {
  flex-direction: row !important;
}

.detail__back {
  padding-inline: 0.5rem;
  font-size: 0.85rem;
}

.detail__title {
  margin: 0;
  font-size: 1.3rem;
  letter-spacing: -0.01em;
}

.detail__address,
.detail__continue,
.detail__links,
.detail__builds {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.detail__url {
  font-weight: 600;
  word-break: break-all;
}

.detail__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.detail__row button,
.detail__row .button {
  align-self: auto;
}

.detail__links h3,
.detail__builds h3 {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--app-muted);
}

.detail__link-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.detail__link-list li {
  display: flex;
  flex-direction: column;
}

.detail__forget {
  border-top: 1px solid var(--app-border);
  padding-top: 0.75rem;
}

.detail__forget summary {
  cursor: pointer;
  font-size: 0.82rem;
  color: var(--app-muted);
}

.detail__forget button {
  margin-top: 0.5rem;
}
</style>
