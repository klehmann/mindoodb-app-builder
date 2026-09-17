<script setup lang="ts">
/**
 * The illustrated badge beside a page heading.
 *
 * Each tile is a square bitmap whose own pale-blue background fills the frame, so the
 * caller only has to pick a corner radius. Unlike `UiIcon` these do not follow
 * `currentColor` — they are pictures, not glyphs.
 *
 * Two names, because there are two pages with a heading like this: the one-time setup
 * and describing an app. Adding a third means adding its artwork to `src/app/assets`.
 */
import { computed } from "vue";

import detailsArt from "@/app/assets/step-details.png";
import introArt from "@/app/assets/step-intro.png";

export type StepArtName = "intro" | "details";

const ART: Record<StepArtName, string> = {
  intro: introArt,
  details: detailsArt,
};

const props = defineProps<{
  name: StepArtName;
  /** Rendered edge length in pixels. */
  size?: number;
}>();

const source = computed(() => ART[props.name]);
const edge = computed(() => props.size ?? 32);
</script>

<template>
  <img
    class="step-art"
    :src="source"
    :width="edge"
    :height="edge"
    alt=""
    aria-hidden="true"
    draggable="false"
  />
</template>

<style scoped>
.step-art {
  display: block;
  flex: none;
  /* The tile is square and the subject centred, so a circular crop only loses corners. */
  object-fit: cover;
}
</style>
