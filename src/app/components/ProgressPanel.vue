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
import { useI18n } from "vue-i18n";

import UiIcon from "@/app/components/UiIcon.vue";
import { flowNoteText } from "@/app/flowNoteText";
import type { CreateAppResult, FlowNote, FlowStep, FlowStepId } from "@/core/createAppFlow";

const { t } = useI18n();

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

/**
 * Step ids are the translation keys, so `core/createAppFlow` stays free of display
 * text: it reports what happened, this panel says it in the reader's language.
 */
function stepLabel(id: FlowStepId): string {
  return t(`progress.steps.${id}`);
}

/**
 * Whether the repository-access remedy is already on this panel.
 *
 * Warnings accumulate across a session's phases, so a failed access check from one press
 * and a failed origin wait from the next are read together — and both used to explain the
 * same fix. Reading it off the panel's own contents rather than tracking it in the flow is
 * what makes it true: "already shown" is a question about the screen. The error line and
 * the warning list are enough to answer it — a step showing the fix always comes with one
 * of the two.
 */
const accessGrantShown = computed(
  () =>
    props.result?.error?.code === "repoAccessFix" ||
    (props.result?.warnings ?? []).some((note) => note.code === "repoAccessFix"),
);

/**
 * The same for the line underneath: the flow says what happened as a code, this says it
 * in the reader's language. Every note the run produced — per step, the reason it stopped,
 * every warning — is worded here and nowhere else.
 */
function noteText(note: FlowNote | null): string {
  return flowNoteText(t, note, { accessGrantShown: accessGrantShown.value });
}

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
  const subject = encodeURIComponent(t("progress.share.mailSubject"));
  const body = encodeURIComponent(t("progress.share.mailBody", { url }));
  return `mailto:?subject=${subject}&body=${body}`;
});
</script>

<template>
  <section v-if="running || result" class="panel">
    <header>
      <h2>{{ running ? t("progress.working") : t("progress.done") }}</h2>
    </header>

    <ol class="steps">
      <li v-for="step in steps" :key="step.id" :class="`step step--${step.status}`">
        <span class="step__mark" aria-hidden="true">{{ SYMBOLS[step.status] }}</span>
        <span class="step__body">
          <span class="step__label">{{ stepLabel(step.id) }}</span>
          <span v-if="step.detail" class="step__detail">{{ noteText(step.detail) }}</span>
        </span>
      </li>
    </ol>

    <div v-if="result" class="outcome">
      <p v-if="result.error" class="warn">{{ noteText(result.error) }}</p>

      <p v-if="canBuildNow" class="retry">
        <button type="button" :disabled="running" @click="$emit('build-now')">
          {{ t("progress.retry.button") }}
        </button>
        <span class="retry__hint">{{ t("progress.retry.hint") }}</span>
      </p>

      <div v-if="serving && result.worker" class="share">
        <span class="share__icon" aria-hidden="true">
          <UiIcon name="share" :size="18" />
        </span>
        <div class="share__body">
          <p class="share__title">{{ t("progress.share.title") }}</p>
          <p class="share__url">
            <a :href="result.worker.url" target="_blank" rel="noopener noreferrer">
              {{ result.worker.url }}
            </a>
          </p>
          <p class="share__hint">{{ t("progress.share.hint") }}</p>
          <a class="button button--ghost" :href="shareLink">
            {{ t("progress.share.button") }}
          </a>
        </div>
      </div>

      <ul class="links">
        <li v-if="result.repository">
          <a :href="result.repository.htmlUrl" target="_blank" rel="noopener noreferrer">
            {{ result.repository.fullName }}
          </a>
          {{ t("progress.links.code") }}
        </li>
        <li v-if="result.worker && !serving">
          {{ t("progress.links.reserved", { url: result.worker.url }) }}
        </li>
      </ul>

      <!-- Keyed by position: a note is an object, and two runs can warn about the same thing. -->
      <ul v-if="result.warnings.length" class="warnings">
        <li v-for="(warning, index) in result.warnings" :key="index">{{ noteText(warning) }}</li>
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
