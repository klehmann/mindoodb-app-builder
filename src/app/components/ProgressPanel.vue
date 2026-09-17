<script setup lang="ts">
/**
 * What is happening right now, step by step.
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
 *
 * Labels are written for someone who does not know what a Worker or a commit is; the
 * technical detail stays in the per-step `detail` line underneath.
 */
import { computed } from "vue";

import UiIcon from "@/app/components/UiIcon.vue";
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
  "check-name": "Check the name is still free",
  "create-repo": "Create your project on GitHub",
  "commit-identity": "Write in your app’s name and brief",
  "check-repo-access": "Check Cloudflare can see the project",
  "create-worker": "Reserve your web address",
  "connect-builds": "Set up automatic publishing",
  "start-build": "Publish the app",
  "wait-origin": "Wait for the app to go live",
  propose: "Add the app to Haven",
  "launch-agent": "Start the AI developer",
};

const SYMBOLS: Record<FlowStep["status"], string> = {
  pending: "○",
  running: "◐",
  done: "●",
  skipped: "−",
  failed: "×",
};

/** A ready-to-send invitation, so "share it" is one click rather than an instruction. */
const shareLink = computed(() => {
  const url = props.result?.worker?.url;
  if (!url) {
    return "";
  }
  const subject = encodeURIComponent("An app for our Haven workspace");
  const body = encodeURIComponent(
    `I built an app for us. Add it to your Haven workspace with this link:\n\n${url}\n`,
  );
  return `mailto:?subject=${subject}&body=${body}`;
});
</script>

<template>
  <section v-if="running || result" class="panel">
    <header>
      <h2>{{ running ? "Working on it…" : "What happened" }}</h2>
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
        <button type="button" :disabled="running" @click="$emit('build-now')">
          Try publishing again
        </button>
        <span class="retry__hint">
          Just granted access? This publishes straight away — no other step needed.
        </span>
      </p>

      <div v-if="serving && result.worker" class="share">
        <span class="share__icon" aria-hidden="true">
          <UiIcon name="share" :size="18" />
        </span>
        <div class="share__body">
          <p class="share__title">Your app is live</p>
          <p class="share__url">
            <a :href="result.worker.url" target="_blank" rel="noopener noreferrer">
              {{ result.worker.url }}
            </a>
          </p>
          <p class="share__hint">
            Email this link to colleagues — they can add the same app to their own Haven.
          </p>
          <a class="button button--ghost" :href="shareLink">Share by email</a>
        </div>
      </div>

      <ul class="links">
        <li v-if="result.repository">
          <a :href="result.repository.htmlUrl" target="_blank" rel="noopener noreferrer">
            {{ result.repository.fullName }}
          </a>
          — your code on GitHub
        </li>
        <li v-if="result.worker && !serving">
          {{ result.worker.url }} — reserved, not live yet
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

.step--running .step__label {
  font-weight: 650;
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

.share {
  display: flex;
  gap: 0.7rem;
  align-items: flex-start;
  margin-top: 0.85rem;
  padding: 0.85rem 0.95rem;
  border-radius: 0.6rem;
  background: var(--app-accent-soft);
}

.share__icon {
  display: grid;
  place-items: center;
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 0.5rem;
  background: var(--app-surface);
  color: var(--app-accent);
  flex: none;
}

.share__body {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
  align-items: flex-start;
}

.share__title {
  margin: 0;
  font-weight: 650;
}

.share__url {
  margin: 0;
  word-break: break-all;
}

.share__hint {
  margin: 0;
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
