<script setup lang="ts">
/**
 * The five step glyphs, inline so they need no font, no network, and no build step.
 *
 * Drawn on a 24×24 grid and inheriting `currentColor`, so the same markup works in the
 * progress rail (small, on a coloured disc) and in a page heading (large, in text
 * colour).
 */
export type UiIconName =
  | "intro"
  | "details"
  | "github"
  | "cloudflare"
  | "cursor"
  | "share"
  | "trash"
  | "copy"
  | "check";

defineProps<{
  name: UiIconName;
  /** Pixel size of the square box. Defaults to the rail size. */
  size?: number;
}>();
</script>

<template>
  <svg
    class="wizard-icon"
    :width="size ?? 18"
    :height="size ?? 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <!-- Introduction: a spark, for "describe it and it gets built". -->
    <template v-if="name === 'intro'">
      <path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7L4.5 10.9 10.1 9z" />
      <path d="M18.5 4v3M20 5.5h-3" />
    </template>

    <!-- App details: a form. -->
    <template v-else-if="name === 'details'">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M7 9h10M7 12.5h10M7 16h5" />
    </template>

    <!-- GitHub: the mark, simplified to a single stroke path. -->
    <template v-else-if="name === 'github'">
      <path
        d="M9.5 20.2v-2.6c-2.9.6-3.6-1.3-3.6-1.3-.5-1.2-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.6 1.1 1.6 1.1 1 1.6 2.5 1.2 3.1.9.1-.7.4-1.2.7-1.5-2.3-.3-4.8-1.2-4.8-5.2 0-1.2.4-2.1 1.1-2.9-.1-.3-.5-1.4.1-2.8 0 0 .9-.3 2.9 1.1a9.9 9.9 0 0 1 5.2 0c2-1.4 2.9-1.1 2.9-1.1.6 1.4.2 2.5.1 2.8.7.8 1.1 1.7 1.1 2.9 0 4-2.5 4.9-4.8 5.2.4.3.7 1 .7 2v3"
      />
    </template>

    <!-- Cloudflare: a cloud with an upward publish arrow. -->
    <template v-else-if="name === 'cloudflare'">
      <path d="M7 18.5h9.5a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6-1.2A3.9 3.9 0 0 0 7 18.5Z" />
      <path d="M12 15.5v-4.5M10 12.8 12 10.8l2 2" />
    </template>

    <!-- Cursor: a pointer, for the agent that does the typing. -->
    <template v-else-if="name === 'cursor'">
      <path d="M5.5 3.8 19 11.3l-5.9 1.6-2.2 5.7z" />
      <path d="M13.6 13.4 19 19.6" />
    </template>

    <!-- Copy: two overlapping pages, for putting a URL on the clipboard. -->
    <template v-else-if="name === 'copy'">
      <rect x="8" y="8" width="11" height="13" rx="1.5" />
      <path d="M6.5 16H5.5A1.5 1.5 0 0 1 4 14.5v-10A1.5 1.5 0 0 1 5.5 3h8A1.5 1.5 0 0 1 15 4.5V6" />
    </template>

    <!-- Trash: removing the builder's note about an app. -->
    <template v-else-if="name === 'trash'">
      <path d="M4.5 7h15M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
      <path d="M6.5 7l.8 11.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10.5 10.5v6M13.5 10.5v6" />
    </template>

    <!-- Check: a completed step. Heavier stroke, because it is drawn very small. -->
    <template v-else-if="name === 'check'">
      <path d="m5.5 12.5 4 4 9-9" stroke-width="2.6" />
    </template>

    <!-- Share: an envelope. -->
    <template v-else>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="m4.5 8 6.6 4.6a1.6 1.6 0 0 0 1.8 0L19.5 8" />
    </template>
  </svg>
</template>

<style scoped>
.wizard-icon {
  flex: none;
  display: block;
}
</style>
