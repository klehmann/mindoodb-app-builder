<script setup lang="ts">
/**
 * The wide illustration that opens a page.
 *
 * Every banner is decorative: whatever it depicts is spelled out in the text right below
 * it, so a reader who never sees the image loses nothing. Hence the empty alt throughout.
 *
 * The artwork carries its own pale-blue background, which would read as a mistake sitting
 * on a white panel, so it is framed as a tinted media block instead.
 */
import { computed } from "vue";

import detailsBanner from "@/app/assets/banner-details.jpg";
import introBanner from "@/app/assets/banner-intro.jpg";
import type { StepArtName } from "@/app/components/StepArt.vue";

/** Same keys as the heading badges, so a page cannot get art in one place and not the other. */
const BANNERS: Record<StepArtName, string> = {
  intro: introBanner,
  details: detailsBanner,
};

const props = defineProps<{
  name: StepArtName;
  /**
   * Hold the artwork to a smaller width, for pages that want the reader at the first
   * control quickly. The art fills its frame, so this scales it down rather than
   * cropping, which would cut the subject.
   */
  compact?: boolean;
}>();

const source = computed(() => BANNERS[props.name]);
</script>

<template>
  <img
    class="banner"
    :class="{ 'banner--compact': compact }"
    :src="source"
    alt=""
    aria-hidden="true"
    width="1280"
    height="400"
    draggable="false"
  />
</template>

<style scoped>
.banner {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 0.7rem;
  background: var(--app-background);
}

.banner--compact {
  max-width: 34rem;
  margin: 0 auto;
}
</style>
