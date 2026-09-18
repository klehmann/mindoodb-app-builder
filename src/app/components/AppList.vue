<script setup lang="ts">
/**
 * The front page: the apps this user built, and one button to build another.
 *
 * This is the whole point of the redesign. Creating an app is five services deep, and
 * for a long time the interface showed all five. It does not have to: once the one-time
 * setup is done, building is a name and a button, and coming back to an app is a row in
 * a list. The connect pages still exist — they are just not the way in any more.
 *
 * Each row says how far its app got, taken from the record rather than from any live
 * check, so the list renders instantly and offline. An unfinished app says so and can be
 * carried on; a finished one is a link to open and share.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import UiIcon from "@/app/components/UiIcon.vue";
import { appStage, type BuilderAppStage, type StoredAppRecord } from "@/core/appRecords";

const { t } = useI18n();

const props = defineProps<{
  records: StoredAppRecord[];
  loading: boolean;
  /**
   * Whether the builder database can be written to. Without it apps still get built,
   * but nothing is remembered — which the page has to say, because an empty list would
   * otherwise look like "you never built anything".
   */
  canStore: boolean;
  /** Whether rows can be removed. False on a database this user may only read. */
  canForget: boolean;
}>();

const emit = defineEmits<{
  open: [StoredAppRecord];
  create: [];
  forget: [StoredAppRecord];
}>();

/**
 * The row waiting for a yes, by document id.
 *
 * One at a time, and asked in the row itself rather than in a modal: what needs saying
 * is *what removing does not touch*, and that sentence belongs next to the app it is
 * about. A browser `confirm()` could not carry it, and an overlay would hide the list
 * the user is deciding about.
 */
const pendingRemoval = ref<string | null>(null);

function askToRemove(documentId: string): void {
  pendingRemoval.value = documentId;
}

function cancelRemoval(): void {
  pendingRemoval.value = null;
}

function confirmRemoval(stored: StoredAppRecord): void {
  pendingRemoval.value = null;
  emit("forget", stored);
}

/**
 * Plain words for the five stages. No jargon: these are read at a glance.
 *
 * Stage ids are the translation keys, so `core/appRecords` stays free of display text.
 */
function stageLabel(stage: BuilderAppStage): string {
  return t(`list.stages.${stage}`);
}

const rows = computed(() =>
  props.records.map((stored) => {
    const stage = appStage(stored.record);
    return {
      stored,
      stage,
      label: stored.record.label || stored.record.appId || t("list.row.untitled"),
      stageLabel: stageLabel(stage),
      finished: stage === "live" || stage === "installed",
      created: formatDate(stored.record.createdAt),
    };
  }),
);

/**
 * The creation date, in the reader's own locale.
 *
 * A stored timestamp is data from a document, so it may not be a date at all — an
 * unparseable one shows nothing rather than "Invalid Date".
 */
function formatDate(iso: string): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
</script>

<template>
  <section class="panel">
    <header class="apps__head">
      <div>
        <h2>{{ t("list.heading") }}</h2>
        <p class="muted">{{ t("list.intro") }}</p>
      </div>
      <!--
        Only alongside a list. With nothing built yet the empty state below carries its
        own "Describe an app", and two buttons doing the same thing read as a choice.
      -->
      <button v-if="rows.length > 0" type="button" class="apps__new" @click="emit('create')">
        {{ t("list.actions.new") }}
      </button>
    </header>

    <p v-if="loading" class="muted">{{ t("list.loading") }}</p>

    <!--
      The empty state carries the pitch, because on a first visit it is the whole page.
      Once there is a list, the list speaks for itself.
    -->
    <div v-else-if="rows.length === 0" class="apps__empty">
      <UiIcon name="intro" :size="34" />
      <p class="apps__empty-title">{{ t("list.empty.title") }}</p>
      <p class="muted">{{ t("list.empty.body") }}</p>
      <button type="button" @click="emit('create')">{{ t("list.empty.action") }}</button>
    </div>

    <ul v-else class="apps__list">
      <li v-for="row in rows" :key="row.stored.documentId" class="apps__item">
        <div class="apps__item-row">
          <button type="button" class="apps__row" @click="emit('open', row.stored)">
            <span class="apps__row-main">
              <span class="apps__row-title">{{ row.label }}</span>
              <span v-if="row.stored.record.description" class="apps__row-sub">
                {{ row.stored.record.description }}
              </span>
              <span v-else-if="row.created" class="apps__row-sub">
                {{ t("list.row.started", { date: row.created }) }}
              </span>
            </span>
            <span class="apps__row-side">
              <span :class="['badge', row.finished ? 'badge--live' : 'badge--soft']">
                {{ row.stageLabel }}
              </span>
            </span>
          </button>
          <!--
            Outside the row button, because the row is itself a button and nesting one
            inside another is invalid and unclickable.
          -->
          <button
            v-if="canForget"
            type="button"
            class="ghost apps__remove"
            :aria-label="t('list.row.remove', { label: row.label })"
            :title="t('list.row.remove', { label: row.label })"
            @click="askToRemove(row.stored.documentId)"
          >
            <UiIcon name="trash" :size="17" />
          </button>
        </div>

        <div v-if="pendingRemoval === row.stored.documentId" class="apps__confirm">
          <p class="apps__confirm-title">
            {{ t("list.confirm.title", { label: row.label }) }}
          </p>
          <p class="hint">{{ t("list.confirm.hint") }}</p>
          <div class="apps__confirm-actions">
            <button type="button" class="danger" @click="confirmRemoval(row.stored)">
              {{ t("list.confirm.remove") }}
            </button>
            <button type="button" class="ghost" @click="cancelRemoval">
              {{ t("list.confirm.keep") }}
            </button>
          </div>
        </div>
      </li>
    </ul>

    <p v-if="!canStore" class="hint">{{ t("list.readOnly") }}</p>
  </section>
</template>

<style scoped>
.apps__head {
  flex-direction: row !important;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.apps__head > div {
  flex: 1 1 auto;
  min-width: 0;
}

.apps__head h2 {
  margin: 0;
  font-size: 1.05rem;
}

.apps__new {
  flex: none;
  white-space: nowrap;
}

.apps__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.5rem;
  padding: 1.5rem 1rem 1.75rem;
  color: var(--app-accent);
}

.apps__empty .muted {
  max-width: 30rem;
}

.apps__empty-title {
  margin: 0.25rem 0 0;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--app-text);
}

.apps__empty button {
  align-self: center;
  margin-top: 0.4rem;
}

.apps__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.apps__item {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.apps__item-row {
  display: flex;
  align-items: stretch;
  gap: 0.4rem;
}

/* Icon-only, so it stays quiet next to the row it can destroy. */
.apps__remove {
  flex: none;
  align-self: stretch;
  display: flex;
  align-items: center;
  padding-inline: 0.6rem;
  color: var(--app-muted);
}

.apps__remove:hover:not(:disabled) {
  filter: none;
  color: var(--app-danger);
  border-color: var(--app-danger);
}

.apps__confirm {
  border: 1px solid var(--app-danger);
  border-radius: 0.5rem;
  padding: 0.7rem 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.apps__confirm-title {
  margin: 0;
  font-weight: 600;
}

.apps__confirm .hint {
  margin: 0;
}

.apps__confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.15rem;
}

/*
 * The row is a button so the whole card is one target for pointer and keyboard alike,
 * rather than a div with a link somewhere inside it.
 */
.apps__row {
  /* Takes the width the remove button leaves, and is allowed to shrink below its
     content so a long description ellipsises instead of pushing the button out.
     `align-self` overrides the global `flex-start` on buttons, which would otherwise
     leave the two side by side at different heights. */
  flex: 1 1 auto;
  min-width: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  text-align: left;
  font-weight: 400;
  padding: 0.7rem 0.85rem;
  background: var(--app-background);
  border: 1px solid var(--app-border);
  color: var(--app-text);
}

.apps__row:hover:not(:disabled) {
  filter: none;
  border-color: var(--app-accent);
}

.apps__row-main {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.apps__row-title {
  font-weight: 600;
}

.apps__row-sub {
  font-size: 0.82rem;
  color: var(--app-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.apps__row-side {
  flex: none;
}

.badge--live {
  background: var(--app-accent);
}
</style>
