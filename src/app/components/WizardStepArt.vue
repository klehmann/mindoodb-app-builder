<script setup lang="ts">
/**
 * The illustrated tile for a setup step, used in the progress rail and in page headings.
 *
 * Each tile is a square bitmap whose own pale-blue background fills the frame, so the
 * caller only has to pick a corner radius: `999px` for the rail disc, a soft radius for
 * a heading badge. Unlike `WizardIcon` these do not follow `currentColor`, so callers
 * signal state around the tile (ring, greyscale) rather than by recolouring it.
 */
import { computed } from "vue";

import cloudflareArt from "@/app/assets/step-cloudflare.png";
import cursorArt from "@/app/assets/step-cursor.png";
import detailsArt from "@/app/assets/step-details.png";
import githubArt from "@/app/assets/step-github.png";
import introArt from "@/app/assets/step-intro.png";

export type WizardStepArtName = "intro" | "details" | "github" | "cloudflare" | "cursor";

const ART: Record<WizardStepArtName, string> = {
  intro: introArt,
  details: detailsArt,
  github: githubArt,
  cloudflare: cloudflareArt,
  cursor: cursorArt,
};

const props = defineProps<{
  name: WizardStepArtName;
  /** Rendered edge length in pixels. Defaults to the rail size. */
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
