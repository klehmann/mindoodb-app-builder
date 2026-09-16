<script setup lang="ts">
/**
 * Where the three credentials are entered.
 *
 * The text on this panel matters as much as the fields: a user is being asked to paste
 * live API tokens into a page, and they deserve to know exactly where those go. They go
 * into one document in their own Haven database, encrypted for them personally, and —
 * for the two calls a browser cannot make — into a single request to the builder host,
 * which stores nothing.
 */
import { reactive, watch } from "vue";

import type { BuilderCredentials, CredentialsStatus } from "@/core/credentials";

const props = defineProps<{
  credentials: BuilderCredentials;
  status: CredentialsStatus;
  canStore: boolean;
  saving: boolean;
}>();

const emit = defineEmits<{ save: [BuilderCredentials] }>();

const draft = reactive<BuilderCredentials>({ ...props.credentials });

watch(
  () => props.credentials,
  (next) => Object.assign(draft, next),
  { deep: true },
);

function save(): void {
  emit("save", { ...draft });
}
</script>

<template>
  <section class="panel">
    <header>
      <h2>Accounts</h2>
      <p class="muted">
        Stored in one document in your App Builder database, encrypted for you personally.
        Nobody else can read it, not even someone you share that database with.
      </p>
      <p v-if="!canStore" class="warn">
        The <code>appbuilder</code> database is not available, so the tokens are kept for
        this session only. To have them remembered, create that database in Haven — or
        add this builder again through Haven's "From URL" install, which creates it for
        you.
      </p>
    </header>

    <div class="field">
      <label for="github-token">
        GitHub token
        <span v-if="status.github" class="badge">connected</span>
      </label>
      <input
        id="github-token"
        v-model="draft.githubToken"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="github_pat_…"
      />
      <p class="hint">
        Needs permission to create repositories. Used only by this page — GitHub allows
        browser calls, so it never reaches the builder host.
      </p>
    </div>

    <div class="field">
      <label for="github-owner">GitHub owner</label>
      <input
        id="github-owner"
        v-model="draft.githubOwner"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="your-user-or-org"
      />
      <p class="hint">Leave blank to create repositories under the token's own account.</p>
    </div>

    <div class="field">
      <label for="cf-token">
        Cloudflare token
        <span v-if="status.cloudflare" class="badge">connected</span>
      </label>
      <input
        id="cf-token"
        v-model="draft.cloudflareToken"
        type="password"
        autocomplete="off"
        spellcheck="false"
      />
      <p class="hint">
        Must be a <strong>user</strong> token, not an account token — the Workers Builds
        API rejects account tokens. Needs Workers Scripts&nbsp;Edit and Workers Builds
        Configuration&nbsp;Edit.
      </p>
    </div>

    <div class="field">
      <label for="cf-account">Cloudflare account ID</label>
      <input
        id="cf-account"
        v-model="draft.cloudflareAccountId"
        type="text"
        autocomplete="off"
        spellcheck="false"
      />
    </div>

    <div class="field">
      <label for="cursor-token">
        Cursor API key
        <span v-if="status.cursor" class="badge">connected</span>
        <span v-else class="badge badge--soft">optional</span>
      </label>
      <input
        id="cursor-token"
        v-model="draft.cursorToken"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="crsr_…"
      />
      <p class="hint">
        Used to start a cloud agent on the new repository. Cursor's API cannot be called
        from a browser, so this one key is sent to the builder host for that single call.
        It is never given to the agent itself.
      </p>
    </div>

    <button type="button" :disabled="saving" @click="save">
      {{ saving ? "Saving…" : "Save accounts" }}
    </button>
  </section>
</template>
