<script setup lang="ts">
/**
 * One numbered thing to do on a setup page.
 *
 * Numbering matters here: each page asks for two or three separate clicks in other
 * people's websites, and without an order they read as alternatives.
 */
defineProps<{
  index: number;
  title: string;
  /** Why this click is needed, in the user's terms. Optional for obvious ones. */
  hint?: string;
  /** Marks a task the user can walk past — shown as "optional" rather than hidden. */
  skippable?: boolean;
}>();
</script>

<template>
  <section class="task">
    <span class="task__number" aria-hidden="true">{{ index }}</span>
    <div class="task__body">
      <h3 class="task__title">
        {{ title }}
        <span v-if="skippable" class="task__skip">already done? skip it</span>
      </h3>
      <p v-if="hint" class="task__hint">{{ hint }}</p>
      <div class="task__content">
        <slot />
      </div>
    </div>
  </section>
</template>

<style scoped>
.task {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}

.task__number {
  display: grid;
  place-items: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 999px;
  border: 1.5px solid var(--app-border);
  color: var(--app-muted);
  font-size: 0.8rem;
  font-weight: 650;
  flex: none;
  margin-top: 0.1rem;
}

.task__body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
  flex: 1;
}

.task__title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 650;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.task__skip {
  font-size: 0.7rem;
  font-weight: 500;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  border: 1px solid var(--app-border);
  color: var(--app-muted);
}

.task__hint {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--app-muted);
}

.task__content {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
</style>
