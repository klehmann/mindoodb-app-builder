<script setup lang="ts">
/**
 * Five sequential pages with a progress rail.
 *
 * Install and grant-access are buttons on later pages, not gates — a user who already
 * granted All repositories can skip those and continue.
 */
import { computed, onMounted, ref } from "vue";

import WizardBanner from "@/app/components/WizardBanner.vue";
import WizardIcon, { type WizardIconName } from "@/app/components/WizardIcon.vue";
import WizardStepArt, { type WizardStepArtName } from "@/app/components/WizardStepArt.vue";
import type { WizardReadiness } from "@/app/wizard";
import {
  WIZARD_STEP_IDS,
  WIZARD_STEP_LABELS,
  canContinue,
  canEnterStep,
  resolveInitialStep,
  stepAfter,
  stepBefore,
  type WizardStepId,
} from "@/app/wizard";

const SEEN_KEY = "mindoodb-app-builder.wizard-seen";

const STEP_ICONS: Record<WizardStepId, WizardStepArtName> = {
  welcome: "intro",
  details: "details",
  github: "github",
  cloudflare: "cloudflare",
  cursor: "cursor",
};

/**
 * The three services the user needs an account with, each linked to its own free sign-up
 * page. Someone who has none of them should not have to go and search for them.
 */
const ACCOUNTS: { icon: WizardIconName; name: string; url: string; role: string }[] = [
  {
    icon: "github",
    name: "GitHub",
    url: "https://github.com/signup",
    role: "keeps your app’s code, so nothing is locked in.",
  },
  {
    icon: "cloudflare",
    name: "Cloudflare",
    url: "https://dash.cloudflare.com/sign-up",
    role: "publishes the app at its own web address.",
  },
  {
    icon: "cursor",
    name: "Cursor",
    url: "https://cursor.com/signup",
    role: "is the AI that writes and updates the code.",
  },
];

const props = defineProps<{
  readiness: WizardReadiness;
}>();

const step = ref<WizardStepId>("welcome");
const seenWelcome = ref(false);

onMounted(() => {
  seenWelcome.value = window.localStorage.getItem(SEEN_KEY) === "1";
  step.value = resolveInitialStep({
    seenWelcome: seenWelcome.value,
    readiness: props.readiness,
  });
});

function go(next: WizardStepId): void {
  if (!canEnterStep(next, props.readiness) && next !== "welcome") {
    return;
  }
  if (step.value === "welcome") {
    seenWelcome.value = true;
    window.localStorage.setItem(SEEN_KEY, "1");
  }
  step.value = next;
}

function continueWizard(): void {
  if (!canContinue(step.value, props.readiness)) {
    return;
  }
  const next = stepAfter(step.value);
  if (next) {
    go(next);
  }
}

function back(): void {
  const previous = stepBefore(step.value);
  if (previous) {
    go(previous);
  }
}

const currentIndex = computed(() => WIZARD_STEP_IDS.indexOf(step.value));
const continueEnabled = computed(() => canContinue(step.value, props.readiness));
const showContinue = computed(() => step.value !== "cursor");
const nextLabel = computed(() => {
  const next = stepAfter(step.value);
  return next ? `Continue to ${WIZARD_STEP_LABELS[next]}` : "Continue";
});

function stepState(id: WizardStepId): "done" | "current" | "todo" {
  const index = WIZARD_STEP_IDS.indexOf(id);
  if (index < currentIndex.value) {
    return "done";
  }
  return index === currentIndex.value ? "current" : "todo";
}

function stepReachable(id: WizardStepId): boolean {
  return id === "welcome" || canEnterStep(id, props.readiness);
}
</script>

<template>
  <section class="wizard">
    <nav class="rail" aria-label="Setup steps">
      <p class="rail__count">
        Step {{ currentIndex + 1 }} of {{ WIZARD_STEP_IDS.length }} ·
        {{ WIZARD_STEP_LABELS[step] }}
      </p>
      <ol class="rail__list">
        <li
          v-for="(id, index) in WIZARD_STEP_IDS"
          :key="id"
          class="rail__item"
          :class="`is-${stepState(id)}`"
        >
          <button
            type="button"
            class="rail__button"
            :disabled="!stepReachable(id)"
            :aria-current="step === id ? 'step' : undefined"
            @click="go(id)"
          >
            <span class="rail__mark">
              <span class="rail__dot">
                <WizardStepArt :name="STEP_ICONS[id]" :size="32" />
              </span>
              <span
                v-if="stepState(id) === 'done'"
                class="rail__check"
                aria-hidden="true"
              >
                <WizardIcon name="check" :size="11" />
              </span>
            </span>
            <span class="rail__label">{{ WIZARD_STEP_LABELS[id] }}</span>
          </button>
          <span v-if="index < WIZARD_STEP_IDS.length - 1" class="rail__line" aria-hidden="true" />
        </li>
      </ol>
    </nav>

    <div v-if="step === 'welcome'" class="panel intro">
      <header class="intro__head">
        <span class="intro__badge">
          <WizardStepArt name="intro" :size="44" />
        </span>
        <div>
          <h2>Add your own app to Haven</h2>
          <p class="lead">
            Haven is your collaborative workspace. This builder puts <em>any</em> app you
            can describe into it — a task board, a booking list, a shift plan, whatever
            your team is missing.
          </p>
        </div>
      </header>

      <WizardBanner name="intro" />

      <p>
        You describe what the app should do in plain language. An AI coding agent writes
        it, publishes it to the web, and Haven installs it for you.
        <strong>No programming skills are needed to get started.</strong>
      </p>

      <ul class="benefits">
        <li>
          <span class="benefits__mark" aria-hidden="true">
            <WizardIcon name="details" :size="16" />
          </span>
          <span>
            <strong>You describe it, AI builds it.</strong>
            Write a few sentences about what you need. The agent turns that into a
            working app.
          </span>
        </li>
        <li>
          <span class="benefits__mark" aria-hidden="true">
            <WizardIcon name="cloudflare" :size="16" />
          </span>
          <span>
            <strong>It is a real app, not a one-off.</strong>
            You own the code and the address it lives at, so you can keep changing and
            extending it later — next week or next year. That flexibility is the whole
            point of the slightly longer setup.
          </span>
        </li>
        <li>
          <span class="benefits__mark" aria-hidden="true">
            <WizardIcon name="share" :size="16" />
          </span>
          <span>
            <strong>Sharing is a link.</strong>
            The finished app has its own web address. Email that link to colleagues and
            they can add the same app to their Haven.
          </span>
        </li>
      </ul>

      <div class="note">
        <p>
          <strong>Heads-up: the next few pages are a little technical.</strong>
          Your app needs somewhere to live, so you will connect three free services and
          click “install” a couple of times. We are actively working on making this
          shorter — we chose flexibility over a one-click toy you could never change.
        </p>
      </div>

      <div class="accounts">
        <p class="accounts__title">You will need three free accounts:</p>
        <ul>
          <li v-for="account in ACCOUNTS" :key="account.name">
            <WizardIcon :name="account.icon" :size="17" />
            <span>
              <a
                class="accounts__link"
                :href="account.url"
                target="_blank"
                rel="noopener noreferrer"
                >{{ account.name }}</a
              >
              {{ account.role }}
            </span>
          </li>
        </ul>
        <p class="hint">
          Do not have one yet? Each name above opens that service’s free sign-up page in
          a new tab. A fresh GitHub account just for this is perfectly fine. Each service
          asks you to approve access once — we can never see more than you grant.
        </p>
      </div>

      <p class="hint">
        Done some of this before? Every install and access step can be skipped. Use
        Continue, or jump straight to a step above.
      </p>
    </div>

    <slot v-else-if="step === 'details'" name="details" />
    <slot v-else-if="step === 'github'" name="github" />
    <slot v-else-if="step === 'cloudflare'" name="cloudflare" />
    <slot v-else-if="step === 'cursor'" name="cursor" />

    <div class="nav">
      <button v-if="step !== 'welcome'" type="button" class="ghost" @click="back">
        Back
      </button>
      <button
        v-if="showContinue"
        type="button"
        class="nav__next"
        :disabled="!continueEnabled"
        @click="continueWizard"
      >
        {{ step === "welcome" ? "Let’s start" : nextLabel }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.wizard {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* Progress rail */
.rail {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.rail__count {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--app-muted);
}

.rail__list {
  display: flex;
  align-items: center;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rail__item {
  display: flex;
  align-items: center;
  min-width: 0;
}

.rail__button {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.2rem 0.3rem;
  background: transparent;
  border: none;
  border-radius: 999px;
  color: var(--app-muted);
  cursor: pointer;
  align-self: center;
}

.rail__button:disabled {
  opacity: 0.45;
  cursor: default;
}

.rail__mark {
  position: relative;
  display: grid;
  flex: none;
}

/*
 * A finished step and the current step both carry the accent ring, so completion gets its
 * own badge rather than relying on the ring glow alone.
 */
.rail__check {
  position: absolute;
  right: -0.15rem;
  bottom: -0.15rem;
  display: grid;
  place-items: center;
  width: 0.95rem;
  height: 0.95rem;
  border-radius: 999px;
  background: var(--app-accent);
  color: #ffffff;
  border: 1.5px solid var(--app-surface);
}

.rail__dot {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 999px;
  border: 1.5px solid var(--app-border);
  background: var(--app-surface);
  /* Clips the square illustration into the disc. */
  overflow: hidden;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.rail__label {
  font-size: 0.82rem;
  font-weight: 500;
  white-space: nowrap;
}

.rail__line {
  width: 1.4rem;
  height: 1.5px;
  margin: 0 0.15rem;
  background: var(--app-border);
  flex: none;
}

/*
 * The illustrations are full-colour bitmaps, so they cannot invert to white on an accent
 * disc the way the old single-colour glyphs did. State is carried by the ring around the
 * tile and by draining the colour out of steps not yet reached — which also keeps the
 * current step the only saturated thing in the rail.
 */
.is-current .rail__dot {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 4px var(--app-accent-soft);
}

.is-current .rail__button,
.is-done .rail__button {
  color: var(--app-text);
}

.is-current .rail__label {
  font-weight: 650;
}

.is-done .rail__dot {
  border-color: var(--app-accent);
}

/* Not fully drained: at 32px a flat grey tile loses the shape that identifies the step. */
.is-todo .rail__dot :deep(.step-art) {
  filter: grayscale(0.8);
  opacity: 0.7;
}

@media (prefers-reduced-motion: reduce) {
  .rail__dot {
    transition: none;
  }
}

/* Introduction */
.intro__head {
  display: flex;
  /* Explicit: the global `.panel header` rule stacks headers in a column. */
  flex-direction: row;
  gap: 0.85rem;
  align-items: flex-start;
}

.intro__badge {
  display: grid;
  place-items: center;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 0.8rem;
  /* The illustration brings its own tinted background; this only rounds it. */
  overflow: hidden;
  flex: none;
}

.intro h2 {
  margin: 0 0 0.3rem;
  font-size: 1.35rem;
  letter-spacing: -0.015em;
}

.lead {
  margin: 0;
  font-size: 0.98rem;
  line-height: 1.55;
  color: var(--app-muted);
}

.benefits {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.benefits li {
  display: flex;
  gap: 0.65rem;
  align-items: flex-start;
  line-height: 1.5;
}

.benefits__mark {
  display: grid;
  place-items: center;
  width: 1.7rem;
  height: 1.7rem;
  border-radius: 0.5rem;
  background: var(--app-accent-soft);
  color: var(--app-accent);
  flex: none;
  margin-top: 0.1rem;
}

.note {
  border-left: 3px solid var(--app-accent);
  background: var(--app-accent-soft);
  border-radius: 0 0.5rem 0.5rem 0;
  padding: 0.75rem 0.9rem;
}

.note p {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.55;
}

.accounts {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--app-border);
  border-radius: 0.6rem;
}

.accounts__title {
  margin: 0;
  font-weight: 600;
  font-size: 0.9rem;
}

.accounts ul {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.accounts li {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.9rem;
  color: var(--app-text);
}

.accounts li svg {
  color: var(--app-muted);
}

/* Carries the weight the plain <strong> had, so the line still reads name-first. */
.accounts__link {
  font-weight: 600;
  text-decoration: none;
}

.accounts__link:hover,
.accounts__link:focus-visible {
  text-decoration: underline;
}

/* Navigation */
.nav {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.nav__next {
  margin-left: auto;
}

@media (max-width: 34rem) {
  .rail__label {
    display: none;
  }

  .rail__list {
    justify-content: space-between;
  }

  .rail__line {
    width: auto;
    flex: 1;
  }

  .rail__item {
    flex: 1;
  }

  .rail__item:last-child {
    flex: none;
  }
}
</style>
