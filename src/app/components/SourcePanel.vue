<script setup lang="ts">
/**
 * Which app to start from. One field for both ways people have of naming an app: its
 * GitHub repository, or the address it runs at — the second works for any app whose
 * `haven-app.json` says where its code is.
 *
 * The lookup is a button rather than a watcher on the field, because it costs several
 * GitHub calls and a half-typed URL is not worth any of them.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { flowNoteText } from "@/app/flowNoteText";
import type { AppSource } from "@/core/appSource";
import type { FlowNote } from "@/core/createAppFlow";

import PageHeader from "@/app/components/PageHeader.vue";

const { t } = useI18n();

const props = defineProps<{
  sourceInput: string;
  source: AppSource | null;
  loading: boolean;
  error: FlowNote | null;
  githubReady: boolean;
  /** Locked once the build has started: the copy is of this source, not another. */
  locked: boolean;
}>();

const emit = defineEmits<{
  sourceInput: [string];
  load: [];
}>();

const errorText = computed(() => flowNoteText(t, props.error));
</script>

<template>
  <section class="panel">
    <PageHeader icon="intro" :title="t('sourcePanel.title')" :purpose="t('sourcePanel.purpose')" />

    <form class="field" @submit.prevent="emit('load')">
      <label for="app-source">{{ t("sourcePanel.input.label") }}</label>
      <div class="source__row">
        <input
          id="app-source"
          :value="sourceInput"
          type="text"
          inputmode="url"
          spellcheck="false"
          autocomplete="off"
          :disabled="locked"
          :placeholder="t('sourcePanel.input.placeholder')"
          @input="emit('sourceInput', ($event.target as HTMLInputElement).value)"
        />
        <button
          type="submit"
          :disabled="locked || loading || !githubReady || !sourceInput.trim()"
        >
          {{ loading ? t("sourcePanel.load.running") : t("sourcePanel.load.idle") }}
        </button>
      </div>
      <p class="hint">{{ t("sourcePanel.input.hint") }}</p>
    </form>

    <p v-if="!githubReady" class="hint">{{ t("sourcePanel.needsGithub") }}</p>
    <p v-if="error" class="warn">{{ errorText }}</p>

    <div v-if="source && !error" class="source__found">
      <p>
        <a :href="source.htmlUrl" target="_blank" rel="noopener noreferrer">{{ source.fullName }}</a>
        · {{ t("sourcePanel.found.files", { count: source.files.length }) }}
        · <code>{{ source.commitSha.slice(0, 7) }}</code>
      </p>
      <p v-if="source.databases.length > 0" class="hint">
        {{ t("sourcePanel.found.databases", { ids: source.databases.map((db) => db.logicalDatabaseId).join(", ") }) }}
      </p>
      <p v-if="source.skippedPaths.length > 0" class="hint">
        {{ t("sourcePanel.found.skipped", { count: source.skippedPaths.length }) }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.source__row {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.source__row input {
  flex: 1 1 16rem;
  min-width: 0;
}

.source__row button {
  flex: none;
  align-self: stretch;
}

.source__found p {
  margin: 0.2rem 0;
  overflow-wrap: anywhere;
}
</style>
