<script setup lang="ts">
/**
 * The wide illustration that opens a setup page.
 *
 * Every banner is decorative: whatever it depicts is spelled out in the text right below
 * it, so a reader who never sees the image loses nothing. Hence the empty alt throughout.
 *
 * The artwork carries its own pale-blue background, which would read as a mistake sitting
 * on a white panel, so it is framed as a tinted media block instead.
 */
import { computed } from "vue";

import cloudflareBanner from "@/app/assets/banner-cloudflare.jpg";
import cursorBanner from "@/app/assets/banner-cursor.jpg";
import detailsBanner from "@/app/assets/banner-details.jpg";
import githubBanner from "@/app/assets/banner-github.jpg";
import introBanner from "@/app/assets/banner-intro.jpg";
import type { WizardStepArtName } from "@/app/components/WizardStepArt.vue";

/** Same keys as the rail tiles, so a new step cannot get art in one place and not the other. */
const BANNERS: Record<WizardStepArtName, string> = {
  intro: introBanner,
  details: detailsBanner,
  github: githubBanner,
  cloudflare: cloudflareBanner,
  cursor: cursorBanner,
};

const props = defineProps<{
  name: WizardStepArtName;
  /**
   * Hold the artwork to a smaller width. Task pages want the reader at the first control
   * quickly, so they trade size for height. The art fills its frame, so this scales it
   * down rather than cropping, which would cut the subject.
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
