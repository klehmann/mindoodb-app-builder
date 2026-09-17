<script setup lang="ts">
/**
 * Describe an app, press one button, get an app.
 *
 * Everything that used to be four pages of buttons — create the project, reserve the
 * address, wire publishing, start the build, wait, install in Haven, start the agent —
 * runs as one sequence here. The steps are still shown while it works, because a
 * two-minute wait needs to look like progress, but the user is not asked to drive any of
 * them.
 */
import { computed } from "vue";

import NewAppPanel from "@/app/components/NewAppPanel.vue";
import ProgressPanel from "@/app/components/ProgressPanel.vue";
import type { NewAppForm } from "@/app/useBuilderFlow";
import type { CreateAppResult, FlowStep } from "@/core/createAppFlow";

const props = defineProps<{
  form: NewAppForm;
  plannedRepositoryName: string;
  formError: string | null;
  createError: string | null;
  canCreate: boolean;
  running: boolean;
  steps: FlowStep[];
  result: CreateAppResult | null;
  /** True when a Cursor key is connected, so the AI step will actually run. */
  cursorReady: boolean;
  /** True when the user chose per-repository access, which needs a warning up front. */
  narrowAccess: boolean;
}>();

const emit = defineEmits<{
  labelInput: [string];
  slugInput: [string];
  create: [];
  back: [];
  openApp: [];
}>();

const started = computed(() => props.steps.some((step) => step.status !== "pending"));
const finished = computed(() => Boolean(props.result?.worker && !props.running));
</script>

<template>
  <div class="new-app">
    <div class="new-app__head">
      <button type="button" class="ghost new-app__back" @click="emit('back')">
        ← All apps
      </button>
    </div>

    <NewAppPanel
      :form="form"
      :planned-repository-name="plannedRepositoryName"
      :form-error="formError"
      @label-input="emit('labelInput', $event)"
      @slug-input="emit('slugInput', $event)"
    />

    <section class="panel">
      <button type="button" :disabled="!canCreate" @click="emit('create')">
        {{ running ? "Building your app…" : "Build my app" }}
      </button>

      <p v-if="createError" class="warn">{{ createError }}</p>
      <p v-else-if="!started" class="hint">
        This takes a couple of minutes. We create the project, publish it to the web, and
        add it to Haven
        <template v-if="cursorReady">, then set the AI developer to work on it</template
        >. You can watch each step.
        <template v-if="!cursorReady">
          What you get is the starter app, live and installed — the code is then yours to
          change, by hand or with any AI tool.
        </template>
      </p>

      <!--
        The one case the user has to act on mid-run. With per-repository access the new
        project is not covered by the existing installs, so publishing will stop and ask.
      -->
      <p v-if="narrowAccess && !started" class="hint">
        You chose to pick repositories yourself, so after the project is created you will
        need to allow Cloudflare (and Cursor) to see it on GitHub. We will stop and tell
        you when.
      </p>
    </section>

    <ProgressPanel v-if="started" :steps="steps" :result="result" :running="running" />

    <section v-if="finished" class="panel">
      <button type="button" @click="emit('openApp')">Open my new app</button>
      <p class="hint">
        Everything about this app — its address, the code, publishing, the AI developer —
        is on its own page from now on.
      </p>
    </section>
  </div>
</template>

<style scoped>
.new-app {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.new-app__head {
  display: flex;
}

.new-app__back {
  padding-inline: 0.5rem;
  font-size: 0.85rem;
}
</style>
