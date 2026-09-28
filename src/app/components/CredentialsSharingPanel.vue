<script setup lang="ts">
/**
 * Sharing the connected accounts with colleagues, so a team builds from one GitHub,
 * Cloudflare and Cursor setup instead of each person connecting their own.
 *
 * The credential document is sealed to named people. This list is that document's
 * readers besides the user, picked from the tenant directory the way TeamEdit picks the
 * readers of a document. Nothing changes until "Save sharing" is pressed, because each
 * change re-encrypts the document and taking someone off rotates its key.
 *
 * What sharing means is said plainly next to the list: everyone on it can read the
 * tokens and act with them, and someone taken off keeps the tokens they already had.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { displayRecipient, recipientDiff, recipientNamesEqual } from "@/core/sealedRecipients";

const props = defineProps<{
  /** Whether the builder database may be written; sharing changes a document. */
  canStore: boolean;
  /** Whether Haven granted `directory` on the builder database. */
  canReadDirectory: boolean;
  currentUser: string;
  sharedWith: string[];
  directoryUsers: string[];
  busy: boolean;
}>();

const emit = defineEmits<{
  share: [string[]];
  loadUsers: [];
}>();

const { t } = useI18n();

const draft = ref<string[]>([...props.sharedWith]);
const pick = ref("");

watch(
  () => props.sharedWith,
  (next) => {
    draft.value = [...next];
  },
);

onMounted(() => {
  if (props.canReadDirectory) {
    emit("loadUsers");
  }
});

const available = computed(() =>
  props.directoryUsers.filter(
    (name) =>
      !recipientNamesEqual(name, props.currentUser) &&
      !draft.value.some((existing) => recipientNamesEqual(existing, name)),
  ),
);

const changes = computed(() => recipientDiff(props.sharedWith, draft.value));
const dirty = computed(() => changes.value.added.length > 0 || changes.value.removed.length > 0);

function label(name: string): string {
  return displayRecipient(name, props.directoryUsers);
}

function add(): void {
  if (pick.value) {
    draft.value = [...draft.value, pick.value];
    pick.value = "";
  }
}

function remove(name: string): void {
  draft.value = draft.value.filter((existing) => existing !== name);
}
</script>

<template>
  <section class="panel">
    <header>
      <h2>{{ t("setup.sharing.title") }}</h2>
      <p class="muted">{{ t("setup.sharing.purpose") }}</p>
    </header>

    <p v-if="!canStore" class="hint">{{ t("setup.sharing.cannotStore") }}</p>
    <p v-else-if="!canReadDirectory" class="hint">{{ t("setup.sharing.needsDirectory") }}</p>

    <template v-else>
      <div class="sharing__chips">
        <span class="sharing__chip sharing__chip--you">
          {{ label(currentUser) || t("setup.sharing.you") }}
          <em>{{ t("setup.sharing.you") }}</em>
        </span>
        <button
          v-for="name in draft"
          :key="name"
          type="button"
          class="ghost sharing__chip"
          :disabled="busy"
          :aria-label="t('setup.sharing.remove', { name: label(name) })"
          :title="t('setup.sharing.remove', { name: label(name) })"
          @click="remove(name)"
        >
          {{ label(name) }} <span aria-hidden="true">×</span>
        </button>
      </div>

      <form class="sharing__add" @submit.prevent="add">
        <select v-model="pick" :disabled="busy || available.length === 0">
          <option value="">
            {{ available.length === 0 ? t("setup.sharing.noMoreUsers") : t("setup.sharing.pick") }}
          </option>
          <option v-for="name in available" :key="name" :value="name">{{ label(name) }}</option>
        </select>
        <button type="submit" class="ghost" :disabled="busy || !pick">
          {{ t("setup.sharing.add") }}
        </button>
      </form>

      <p class="hint">{{ t("setup.sharing.warning") }}</p>
      <p v-if="changes.removed.length > 0" class="warn">{{ t("setup.sharing.removeWarning") }}</p>

      <button type="button" :disabled="busy || !dirty" @click="emit('share', [...draft])">
        {{ busy ? t("setup.sharing.saving") : t("setup.sharing.save") }}
      </button>
    </template>
  </section>
</template>

<style scoped>
.sharing__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.sharing__chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.65rem;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 500;
}

.sharing__chip--you {
  border: 1px solid var(--app-border);
  color: var(--app-muted);
}

.sharing__chip--you em {
  font-style: normal;
  font-size: 0.75rem;
}

.sharing__add {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.sharing__add select {
  flex: 1 1 14rem;
  min-width: 0;
}
</style>
