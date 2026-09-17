<script setup lang="ts">
/**
 * What the app is called and what it should do. Creating it is the next page's job.
 *
 * The slug follows the name until the user edits it, because the slug is not cosmetic —
 * it becomes the repository name, the Worker name, the `appId`, and therefore the public
 * URL. Showing that URL while they type is cheaper than explaining it.
 */
import type { NewAppForm } from "@/app/useBuilderFlow";

import WizardPageHeader from "@/app/components/WizardPageHeader.vue";

defineProps<{
  form: NewAppForm;
  plannedRepositoryName: string;
  formError: string | null;
}>();

const emit = defineEmits<{
  labelInput: [string];
  slugInput: [string];
}>();
</script>

<template>
  <section class="panel">
    <WizardPageHeader
      icon="details"
      title="What do you want to build?"
      purpose="Describe your app the way you would explain it to a colleague. The AI turns this into working software — no technical wording needed."
    />

    <div class="field">
      <label for="app-label">Name your app</label>
      <input
        id="app-label"
        :value="form.label"
        type="text"
        placeholder="Team Notes"
        @input="emit('labelInput', ($event.target as HTMLInputElement).value)"
      />
      <p class="hint">This is the name you will see in Haven.</p>
    </div>

    <div class="field">
      <label for="app-description">In one sentence, what is it for?</label>
      <input
        id="app-description"
        v-model="form.description"
        type="text"
        placeholder="Shared notes for the team."
      />
    </div>

    <div class="field">
      <label for="app-task">Describe what it should do</label>
      <textarea
        id="app-task"
        v-model="form.task"
        rows="6"
        placeholder="Let people write notes, tag them, and search across them. One screen with the list of notes, one for writing. Everyone on the team can see and edit them."
      ></textarea>
      <p class="hint">
        This is the brief the AI works from — the more concrete, the better. Think about
        who uses it, what they see on screen, and what they can do. You can always ask
        for changes afterwards.
      </p>
    </div>

    <details class="advanced">
      <summary>Web address and privacy</summary>
      <div class="advanced__body">
        <div class="field">
          <label for="app-slug">Short name for the web address</label>
          <input
            id="app-slug"
            :value="form.slug"
            type="text"
            placeholder="team-notes"
            spellcheck="false"
            @input="emit('slugInput', ($event.target as HTMLInputElement).value)"
          />
          <p class="hint">
            Your app will live at
            <code>https://{{ plannedRepositoryName || "your-app" }}.…workers.dev</code> —
            this is the link you email to colleagues so they can add it to their Haven.
          </p>
        </div>

        <label class="checkbox">
          <input v-model="form.private" type="checkbox" />
          Keep the code private
        </label>
        <p class="hint">
          Recommended. The app itself is still reachable by anyone with the link; this
          only hides the source code from strangers.
        </p>
      </div>
    </details>

    <p v-if="formError" class="warn">{{ formError }}</p>
  </section>
</template>

<style scoped>
.advanced {
  border: 1px solid var(--app-border);
  border-radius: 0.6rem;
  padding: 0.6rem 0.85rem;
}

.advanced summary {
  cursor: pointer;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--app-muted);
}

.advanced__body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding-top: 0.75rem;
}
</style>
