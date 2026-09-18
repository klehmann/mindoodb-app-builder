<script setup lang="ts">
/**
 * What the app is called and what it should do. Creating it is the next page's job.
 *
 * The slug follows the name until the user edits it, because the slug is not cosmetic —
 * it becomes the repository name, the Worker name, the `appId`, and therefore the public
 * URL. Showing that URL while they type is cheaper than explaining it.
 */
import { useI18n } from "vue-i18n";

import type { NewAppForm } from "@/app/useBuilderFlow";

import PageHeader from "@/app/components/PageHeader.vue";

const { t } = useI18n();

defineProps<{
  form: NewAppForm;
  plannedRepositoryName: string;
  formError: string | null;
}>();

const emit = defineEmits<{
  labelInput: [string];
  slugInput: [string];
}>();
</script>

<template>
  <section class="panel">
    <PageHeader icon="details" :title="t('newAppForm.title')" :purpose="t('newAppForm.purpose')" />

    <div class="field">
      <label for="app-label">{{ t("newAppForm.name.label") }}</label>
      <input
        id="app-label"
        :value="form.label"
        type="text"
        :placeholder="t('newAppForm.name.placeholder')"
        @input="emit('labelInput', ($event.target as HTMLInputElement).value)"
      />
      <p class="hint">{{ t("newAppForm.name.hint") }}</p>
    </div>

    <div class="field">
      <label for="app-description">{{ t("newAppForm.description.label") }}</label>
      <input
        id="app-description"
        v-model="form.description"
        type="text"
        :placeholder="t('newAppForm.description.placeholder')"
      />
    </div>

    <div class="field">
      <label for="app-task">{{ t("newAppForm.task.label") }}</label>
      <textarea
        id="app-task"
        v-model="form.task"
        rows="6"
        :placeholder="t('newAppForm.task.placeholder')"
      ></textarea>
      <p class="hint">
        {{ t("newAppForm.task.hint") }}
      </p>
    </div>

    <details class="advanced">
      <summary>{{ t("newAppForm.advanced.summary") }}</summary>
      <div class="advanced__body">
        <div class="field">
          <label for="app-slug">{{ t("newAppForm.slug.label") }}</label>
          <input
            id="app-slug"
            :value="form.slug"
            type="text"
            :placeholder="t('newAppForm.slug.placeholder')"
            spellcheck="false"
            @input="emit('slugInput', ($event.target as HTMLInputElement).value)"
          />
          <!-- The sentence wraps the live URL, so it is translated in two halves
               around the <code> element rather than smuggling markup into a phrase. -->
          <p class="hint">
            {{ t("newAppForm.slug.hintBefore") }}
            <code>https://{{ plannedRepositoryName || "your-app" }}.…workers.dev</code>
            {{ t("newAppForm.slug.hintAfter") }}
          </p>
        </div>

        <label class="checkbox">
          <input v-model="form.private" type="checkbox" />
          {{ t("newAppForm.privateCode.label") }}
        </label>
        <p class="hint">
          {{ t("newAppForm.privateCode.hint") }}
        </p>
      </div>
    </details>

    <p v-if="formError" class="warn">{{ formError }}</p>
  </section>
</template>

<style scoped>
.advanced {
  border: 1px solid var(--app-border);
  border-radius: 0.6rem;
  padding: 0.6rem 0.85rem;
}

.advanced summary {
  cursor: pointer;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--app-muted);
}

.advanced__body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding-top: 0.75rem;
}
</style>
