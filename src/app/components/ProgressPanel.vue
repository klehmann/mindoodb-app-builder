<script setup lang="ts">
/**
 * What the build is doing, step by step.
 *
 * Every step shows its own reason when it fails or is skipped, rather than a single
 * "something went wrong" at the end. The slow step — waiting for Cloudflare's first
 * build — reports each attempt, so a two-minute wait looks like progress instead of a
 * hang.
 *
 * "Build now" appears when the app was wired but never built, which happens when
 * Cloudflare could not read the repository at the time of the first push. By then there
 * is no push left to make, so the button starts the build directly and the run carries
 * on to the origin wait and the Haven install.
 */
import { computed } from "vue";

import type { CreateAppResult, FlowStep, FlowStepId } from "@/core/createAppFlow";

const props = defineProps<{
  steps: FlowStep[];
  result: CreateAppResult | null;
  running: boolean;
  /** True when a build can be started without a push. See `canBuildNow`. */
  canBuildNow?: boolean;
}>();

defineEmits<{ (event: "build-now"): void }>();

/** Whether the URL is worth calling live — the origin probe is what decides that. */
const serving = computed(() =>
  props.steps.some((step) => step.id === "wait-origin" && step.status === "done"),
);

const LABELS: Record<FlowStepId, string> = {
  "check-name": "Check the repository name",
  "create-repo": "Create the GitHub repository",
  "check-repo-access": "Check that Cloudflare can read it",
  "create-worker": "Create the Cloudflare Worker",
  "connect-builds": "Connect push-to-deploy",
  "commit-identity": "Name the app and write TASK.md",
  "start-build": "Start the build",
  "wait-origin": "Wait for the first deployment",
  "launch-agent": "Start the Cursor agent",
  propose: "Add the app to Haven",
};

const SYMBOLS: Record<FlowStep["status"], string> = {
  pending: "○",
  running: "◐",
  done: "●",
  skipped: "−",
  failed: "×",
};
</script>

<template>
  <section v-if="running || result" class="panel">
    <header>
      <h2>Progress</h2>
    </header>

    <ol class="steps">
      <li v-for="step in steps" :key="step.id" :class="`step step--${step.status}`">
        <span class="step__mark" aria-hidden="true">{{ SYMBOLS[step.status] }}</span>
        <span class="step__body">
          <span class="step__label">{{ LABELS[step.id] }}</span>
          <span v-if="step.detail" class="step__detail">{{ step.detail }}</span>
        </span>
      </li>
    </ol>

    <div v-if="result" class="outcome">
      <p v-if="result.error" class="warn">{{ result.error }}</p>

      <p v-if="canBuildNow" class="retry">
        <button type="button" :disabled="running" @click="$emit('build-now')">Build now</button>
        <span class="retry__hint">
          Granted access? This starts the build and finishes the setup — no push needed.
        </span>
      </p>

      <ul class="links">
        <li v-if="result.repository">
          <a :href="result.repository.htmlUrl" target="_blank" rel="noopener noreferrer">
            {{ result.repository.fullName }}
          </a>
          on GitHub
        </li>
        <li v-if="result.worker">
          <a :href="result.worker.url" target="_blank" rel="noopener noreferrer">
            {{ result.worker.url }}
          </a>
          {{ serving ? "live app" : "app URL, not serving yet" }}
        </li>
      </ul>

      <ul v-if="result.warnings.length" class="warnings">
        <li v-for="warning in result.warnings" :key="warning">{{ warning }}</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.step {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
}

.step__mark {
  width: 1rem;
  flex: none;
  text-align: center;
}

.step__body {
  display: flex;
  flex-direction: column;
}

.step__detail {
  font-size: 0.8rem;
  color: var(--app-muted);
  word-break: break-word;
}

.step--pending,
.step--skipped {
  color: var(--app-muted);
}

.step--failed {
  color: var(--app-danger);
}

.retry {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin: 0.75rem 0 0;
}

.retry__hint {
  font-size: 0.85rem;
  color: var(--app-muted);
}

.links,
.warnings {
  margin: 0.75rem 0 0;
  padding-left: 1.1rem;
  font-size: 0.9rem;
}

.warnings {
  color: var(--app-muted);
}
</style>
