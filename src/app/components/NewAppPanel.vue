<script setup lang="ts">
/**
 * What the app is called and what it should do. Creating it is the next page's job.
 *
 * The slug follows the name until the user edits it, because the slug is not cosmetic —
 * it becomes the repository name, the Worker name, the `appId`, and therefore the public
 * URL. Showing that URL while they type is cheaper than explaining it.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { APP_DATABASE_PERMISSIONS, type NewAppForm } from "@/app/useBuilderFlow";
import {
  MAX_PUBLISHER_NAME_LENGTH,
  MAX_STORE_DESCRIPTION_LENGTH,
  MAX_SUMMARY_LENGTH,
} from "@/core/appIdentity";

import PageHeader from "@/app/components/PageHeader.vue";

const { t } = useI18n();

const props = defineProps<{
  form: NewAppForm;
  plannedRepositoryName: string;
}>();

/**
 * A copy asks a different question — what should change, not what to build — and has no
 * database to design: the source's databases come along, each with a new id of its own.
 */
const copying = computed(() => props.form.mode === "copy" && Boolean(props.form.source));
const copiedDatabases = computed(() => props.form.source?.databases ?? []);

const emit = defineEmits<{
  labelInput: [string];
  slugInput: [string];
  databaseIdInput: [string];
  databaseLabelInput: [string];
}>();
</script>

<template>
  <section class="panel">
    <PageHeader
      icon="details"
      :title="copying ? t('newAppForm.copy.title') : t('newAppForm.title')"
      :purpose="copying ? t('newAppForm.copy.purpose') : t('newAppForm.purpose')"
    />

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
      <label for="app-task">
        {{ copying ? t("newAppForm.copy.task.label") : t("newAppForm.task.label") }}
      </label>
      <textarea
        id="app-task"
        v-model="form.task"
        rows="6"
        :placeholder="copying ? t('newAppForm.copy.task.placeholder') : t('newAppForm.task.placeholder')"
      ></textarea>
      <p class="hint">
        {{ copying ? t("newAppForm.copy.task.hint") : t("newAppForm.task.hint") }}
      </p>
    </div>

    <!-- Everything in here is copied into haven-app.json and shown to strangers, which
         is the one thing the form must not let the user miss. -->
    <details class="advanced" open>
      <summary>{{ t("newAppForm.listing.summary") }}</summary>
      <div class="advanced__body">
        <p class="hint hint--public">{{ t("newAppForm.listing.publicNote") }}</p>
        <div class="field">
          <label for="app-description">{{ t("newAppForm.description.label") }}</label>
          <input
            id="app-description"
            v-model="form.description"
            type="text"
            :maxlength="MAX_SUMMARY_LENGTH"
            :placeholder="t('newAppForm.description.placeholder')"
          />
          <p class="hint">{{ t("newAppForm.description.hint") }}</p>
        </div>
        <div class="field">
          <label for="app-store-description">{{ t("newAppForm.listing.description.label") }}</label>
          <textarea
            id="app-store-description"
            v-model="form.storeDescription"
            rows="6"
            :maxlength="MAX_STORE_DESCRIPTION_LENGTH"
            :placeholder="t('newAppForm.listing.description.placeholder')"
          ></textarea>
          <p class="hint">{{ t("newAppForm.listing.description.hint") }}</p>
        </div>
        <div class="field">
          <label for="app-publisher-name">{{ t("newAppForm.listing.publisherName.label") }}</label>
          <input
            id="app-publisher-name"
            v-model="form.publisherName"
            type="text"
            :maxlength="MAX_PUBLISHER_NAME_LENGTH"
            :placeholder="t('newAppForm.listing.publisherName.placeholder')"
          />
        </div>
        <div class="field">
          <label for="app-publisher-url">{{ t("newAppForm.listing.publisherUrl.label") }}</label>
          <input
            id="app-publisher-url"
            v-model="form.publisherUrl"
            type="url"
            inputmode="url"
            spellcheck="false"
            autocomplete="url"
            :placeholder="t('newAppForm.listing.publisherUrl.placeholder')"
          />
          <p class="hint">{{ t("newAppForm.listing.publisherUrl.hint") }}</p>
        </div>
      </div>
    </details>

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

    <details v-if="copying" class="advanced">
      <summary>{{ t("newAppForm.database.summary") }}</summary>
      <div class="advanced__body">
        <p class="hint">{{ t("newAppForm.copy.database.hint") }}</p>
        <ul v-if="copiedDatabases.length > 0" class="copied-databases">
          <li v-for="database in copiedDatabases" :key="database.logicalDatabaseId">
            <code>{{ database.logicalDatabaseId }}</code>
            <span v-if="database.label !== database.logicalDatabaseId"> · {{ database.label }}</span>
          </li>
        </ul>
      </div>
    </details>

    <details v-else class="advanced">
      <summary>{{ t("newAppForm.database.summary") }}</summary>
      <div class="advanced__body">
        <div class="field">
          <label for="app-database-id">{{ t("newAppForm.database.id.label") }}</label>
          <input
            id="app-database-id"
            :value="form.databaseId"
            type="text"
            :placeholder="t('newAppForm.database.id.placeholder')"
            spellcheck="false"
            autocomplete="off"
            @input="emit('databaseIdInput', ($event.target as HTMLInputElement).value)"
          />
          <p class="hint">{{ t("newAppForm.database.id.hint") }}</p>
        </div>

        <div class="field">
          <label for="app-database-label">{{ t("newAppForm.database.label.label") }}</label>
          <input
            id="app-database-label"
            :value="form.databaseLabel"
            type="text"
            :placeholder="t('newAppForm.database.label.placeholder')"
            @input="emit('databaseLabelInput', ($event.target as HTMLInputElement).value)"
          />
          <p class="hint">{{ t("newAppForm.database.label.hint") }}</p>
        </div>

        <fieldset class="permissions">
          <legend>{{ t("newAppForm.database.permissions.label") }}</legend>
          <p class="hint">{{ t("newAppForm.database.permissions.hint") }}</p>
          <div class="permissions__grid">
            <label v-for="permission in APP_DATABASE_PERMISSIONS" :key="permission" class="checkbox">
              <input v-model="form.permissions" type="checkbox" :value="permission" />
              {{ t(`newAppForm.database.permissions.${permission}`) }}
            </label>
          </div>
        </fieldset>
      </div>
    </details>
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

.hint--public {
  margin: 0;
  font-weight: 600;
  color: var(--app-text, inherit);
}

.copied-databases {
  margin: 0;
  padding-left: 1.1rem;
}

.permissions {
  margin: 0;
  padding: 0;
  border: 0;
}

.permissions legend {
  font-size: 0.88rem;
  font-weight: 600;
}

.permissions__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
  gap: 0.35rem 0.85rem;
}
</style>
