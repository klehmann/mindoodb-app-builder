<script setup lang="ts">
/**
 * The opening a full page gets: a badge, what the page is for, why it is needed at all,
 * and the illustration. The "why" is the part end users are missing, so it is not
 * optional.
 *
 * The banner lives here rather than in each page so that it cannot drift from the badge
 * beside the title — both are picked by the same `icon` name.
 */
import HeroBanner from "@/app/components/HeroBanner.vue";
import StepArt, { type StepArtName } from "@/app/components/StepArt.vue";

defineProps<{
  icon: StepArtName;
  title: string;
  /** One sentence, in plain language, on what this service does for the user. */
  purpose: string;
}>();
</script>

<template>
  <header class="page-head">
    <span class="page-head__badge">
      <StepArt :name="icon" :size="44" />
    </span>
    <div class="page-head__text">
      <h2>{{ title }}</h2>
      <p class="page-head__purpose">{{ purpose }}</p>
    </div>
  </header>

  <!-- A second root, so the banner sits in the panel's own column flow like any section. -->
  <HeroBanner :name="icon" compact />
</template>

<style scoped>
.page-head {
  display: flex;
  /* Explicit: the global `.panel header` rule stacks headers in a column. */
  flex-direction: row;
  gap: 0.85rem;
  align-items: flex-start;
}

.page-head__badge {
  display: grid;
  place-items: center;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 0.8rem;
  /* The illustration brings its own tinted background; this only rounds it. */
  overflow: hidden;
  flex: none;
}

.page-head__text {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.page-head h2 {
  margin: 0;
  font-size: 1.2rem;
  letter-spacing: -0.012em;
}

.page-head__purpose {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.55;
  color: var(--app-muted);
}
</style>
