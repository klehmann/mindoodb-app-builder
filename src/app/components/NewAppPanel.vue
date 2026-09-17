<script setup lang="ts">
/**
 * The form: a name, a repository slug, and what the app should do.
 *
 * The slug follows the name until the user edits it, because the slug is not cosmetic —
 * it becomes the repository name, the Worker name, the `appId`, and therefore the public
 * URL. Showing that URL while they type is cheaper than explaining it.
 */
import type { NewAppForm } from "@/app/useBuilderFlow";

defineProps<{
  form: NewAppForm;
  plannedRepositoryName: string;
  formError: string | null;
  canStart: boolean;
  running: boolean;
  /** Outstanding items in the setup list; each one is a build that would fail. */
  setupBlockers: number;
}>();

const emit = defineEmits<{
  labelInput: [string];
  slugInput: [string];
  start: [];
}>();
</script>

<template>
  <section class="panel">
    <header>
      <h2>New app</h2>
      <p class="muted">
        Creates a GitHub repository from the starter template, deploys it to Cloudflare
        Workers, and offers it to Haven once it is live.
      </p>
    </header>

    <div class="field">
      <label for="app-label">App name</label>
      <input
        id="app-label"
        :value="form.label"
        type="text"
        placeholder="Team Notes"
        @input="emit('labelInput', ($event.target as HTMLInputElement).value)"
      />
      <p class="hint">Shown as the app label in Haven.</p>
    </div>

    <div class="field">
      <label for="app-slug">Repository name</label>
      <input
        id="app-slug"
        :value="form.slug"
        type="text"
        placeholder="team-notes"
        spellcheck="false"
        @input="emit('slugInput', ($event.target as HTMLInputElement).value)"
      />
      <p class="hint">
        Also the Worker name, so it decides the address:
        <code>https://{{ plannedRepositoryName || "your-app" }}.&lt;your-subdomain&gt;.workers.dev</code>
      </p>
    </div>

    <div class="field">
      <label for="app-description">One-line description</label>
      <input
        id="app-description"
        v-model="form.description"
        type="text"
        placeholder="Shared notes for the team."
      />
    </div>

    <div class="field">
      <label for="app-task">What should it do?</label>
      <textarea
        id="app-task"
        v-model="form.task"
        rows="6"
        placeholder="Let people write notes, tag them, and search across them. One list screen and one editor."
      ></textarea>
      <p class="hint">
        Written into <code>TASK.md</code> and given to the coding agent as its brief. Your
        words only — no credentials or data are added.
      </p>
    </div>

    <label class="checkbox">
      <input v-model="form.private" type="checkbox" />
      Make the repository private
    </label>
    <!--
      Cloudflare's access is the setup list's job, and it is needed either way. What is
      genuinely private-only is Cursor: a public repository it can read regardless.
    -->
    <p v-if="form.private" class="hint">
      A coding agent needs its own access to a private repository — grant Cursor's GitHub
      app access to it, or to all repositories, before starting the agent.
    </p>

    <p v-if="formError" class="warn">{{ formError }}</p>
    <!--
      Refusing here rather than five steps into a build, where the same problem costs a
      half-created repository and an explanation.
    -->
    <p v-else-if="setupBlockers > 0" class="warn">
      {{ setupBlockers }} setup
      {{ setupBlockers === 1 ? "item is" : "items are" }} outstanding above. A build
      would be created and then never deploy.
    </p>

    <button type="button" :disabled="!canStart || setupBlockers > 0" @click="emit('start')">
      {{ running ? "Building…" : "Create app" }}
    </button>
  </section>
</template>
