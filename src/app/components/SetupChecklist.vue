<script setup lang="ts">
/**
 * The setup list, always visible — including when everything passes.
 *
 * A panel that appears only when something is wrong leaves the user unable to tell
 * "ready" from "not checked yet", and these steps are precisely the ones that stay
 * invisible until they bite: a missing installation reads as a 403 five steps into a
 * build, and a hand-picked repository list reads as a deploy that never happens.
 *
 * The reasoning lives in `setupChecklist.ts`, shared with the Create app button so the
 * two cannot disagree about whether a build can start.
 */
import { computed } from "vue";

import {
  buildSetupItems,
  countBlockers,
  type SetupInput,
  type SetupItem,
  type SetupItemState,
} from "@/app/setupChecklist";

const props = defineProps<SetupInput & { cloudflareChecking: boolean }>();

const emit = defineEmits<{
  recheckGitHub: [];
  recheckCloudflare: [];
}>();

const items = computed(() => buildSetupItems(props));
const blockers = computed(() => countBlockers(items.value));

/** A shape as well as a colour, so state does not depend on seeing colour. */
const SYMBOLS: Record<SetupItemState, string> = {
  done: "✓",
  todo: "!",
  unsure: "?",
  optional: "–",
};

function recheck(item: SetupItem): void {
  if (item.recheck === "github") {
    emit("recheckGitHub");
  } else if (item.recheck === "cloudflare") {
    emit("recheckCloudflare");
  }
}
</script>

<template>
  <section class="setup">
    <div class="head">
      <h3>Setup</h3>
      <span class="badge" :class="blockers === 0 ? 'badge--ready' : 'badge--todo'">
        {{ blockers === 0 ? "Ready to build" : `${blockers} to do` }}
      </span>
    </div>
    <p class="hint">
      Each of these is granted once per account, in GitHub's or Cloudflare's own
      interface — no API can grant them for you. After that, building an app is a name
      and a brief.
    </p>

    <ul class="items">
      <li v-for="item in items" :key="item.key" :class="`state-${item.state}`">
        <span class="mark" :aria-hidden="true">{{ SYMBOLS[item.state] }}</span>
        <div class="body">
          <strong>{{ item.title }}</strong>
          <span class="detail">{{ item.detail }}</span>
          <div v-if="item.actionUrl" class="row">
            <a class="button" :href="item.actionUrl" target="_blank" rel="noreferrer noopener">
              {{ item.actionLabel }}
            </a>
            <button
              v-if="item.recheck"
              type="button"
              class="ghost"
              :disabled="item.recheck === 'cloudflare' && cloudflareChecking"
              @click="recheck(item)"
            >
              {{
                item.recheck === "cloudflare" && cloudflareChecking
                  ? "Checking…"
                  : "Check again"
              }}
            </button>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--app-border);
  border-radius: 0.5rem;
}

.head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.setup h3 {
  margin: 0;
  font-size: 0.92rem;
}

.badge {
  font-size: 0.7rem;
  font-weight: 500;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
}

.badge--ready {
  background: var(--app-accent);
  color: #ffffff;
}

.badge--todo {
  background: transparent;
  color: var(--app-muted);
  border: 1px solid var(--app-border);
}

.items {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.85rem;
}

.items li {
  display: flex;
  gap: 0.55rem;
  align-items: baseline;
}

.mark {
  flex: 0 0 1rem;
  text-align: center;
  font-weight: 600;
}

.state-done .mark {
  color: var(--app-accent);
}

.state-todo .mark {
  color: #b3261e;
}

.state-unsure .mark,
.state-optional .mark {
  color: var(--app-muted);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.detail {
  color: var(--app-muted);
}

.row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 0.35rem;
}

/* Matches the primary button beside it; a real link needs no script to open a tab. */
.button {
  font: inherit;
  padding: 0.4rem 0.8rem;
  border-radius: 0.35rem;
  background: var(--app-accent);
  color: #ffffff;
  text-decoration: none;
}
</style>
