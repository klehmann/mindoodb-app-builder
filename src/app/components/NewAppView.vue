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
import { useI18n } from "vue-i18n";

import NewAppPanel from "@/app/components/NewAppPanel.vue";
import ProgressPanel from "@/app/components/ProgressPanel.vue";
import type { NewAppForm } from "@/app/useBuilderFlow";
import type { CreateAppResult, FlowStep } from "@/core/createAppFlow";

const { t } = useI18n();

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
  /** True when a build can be started without a push. See `canBuildNow`. */
  canBuildNow: boolean;
}>();

const emit = defineEmits<{
  labelInput: [string];
  slugInput: [string];
  databaseIdInput: [string];
  databaseLabelInput: [string];
  create: [];
  back: [];
  openApp: [];
  buildNow: [];
}>();

const started = computed(() => props.steps.some((step) => step.status !== "pending"));
const finished = computed(() => Boolean(props.result?.worker && !props.running));
</script>

<template>
  <div class="new-app">
    <div class="new-app__head">
      <button type="button" class="ghost new-app__back" @click="emit('back')">
        ← {{ t("newApp.back") }}
      </button>
    </div>

    <NewAppPanel
      :form="form"
      :planned-repository-name="plannedRepositoryName"
      :form-error="formError"
      @label-input="emit('labelInput', $event)"
      @slug-input="emit('slugInput', $event)"
      @database-id-input="emit('databaseIdInput', $event)"
      @database-label-input="emit('databaseLabelInput', $event)"
    />

    <section class="panel">
      <button type="button" :disabled="!canCreate" @click="emit('create')">
        {{ running ? t("newApp.build.running") : t("newApp.build.idle") }}
      </button>

      <p v-if="createError" class="warn">{{ createError }}</p>
      <!--
        Two whole sentences rather than one assembled from a shared head and a clause,
        so a translator can reorder the AI promise instead of being forced to keep it
        where English puts it.
      -->
      <p v-else-if="!started" class="hint">
        {{ cursorReady ? t("newApp.intro.withAi") : t("newApp.intro.withoutAi") }}
        <template v-if="!cursorReady">{{ t("newApp.intro.starterOnly") }}</template>
      </p>

      <!--
        The one case the user has to act on mid-run. With per-repository access the new
        project is not covered by the existing installs, so publishing will stop and ask.
      -->
      <p v-if="narrowAccess && !started" class="hint">
        {{ t("newApp.narrowAccess") }}
      </p>
    </section>

    <ProgressPanel
      v-if="started"
      :steps="steps"
      :result="result"
      :running="running"
      :can-build-now="canBuildNow"
      @build-now="emit('buildNow')"
    />

    <section v-if="finished" class="panel">
      <button type="button" @click="emit('openApp')">{{ t("newApp.finished.open") }}</button>
      <p class="hint">
        {{ t("newApp.finished.hint") }}
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
