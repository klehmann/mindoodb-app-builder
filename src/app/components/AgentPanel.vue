<script setup lang="ts">
/**
 * The agent's working session: a link into Cursor, the current run's state, and a box
 * for the next instruction.
 *
 * Status is polled rather than streamed. The builder only needs "working" versus
 * "finished, here is the branch", and a poll behaves better across a tab that gets
 * backgrounded in a Haven workspace tile than a long-lived event stream would.
 *
 * Follow-ups reuse the same agent, so it still has the conversation and the workspace.
 * While a run is going, Cursor answers 409 and the UI says so instead of reporting an
 * error.
 */
import { onBeforeUnmount, ref } from "vue";

import { isTerminalRunStatus, type CursorRun } from "@/core/cursorAgents";
import { readCursorStatus, sendCursorFollowUp, HostApiError } from "@/app/hostApi";
import type { AgentHandle } from "@/core/createAppFlow";

const props = defineProps<{
  agent: AgentHandle | null;
  cursorToken: string;
}>();

const POLL_INTERVAL_MS = 8_000;

const run = ref<CursorRun | null>(null);
const followUp = ref("");
const busy = ref(false);
const message = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

function stopPolling(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function refresh(): Promise<void> {
  const agent = props.agent;
  if (!agent) {
    return;
  }
  try {
    const status = await readCursorStatus({
      cursorToken: props.cursorToken,
      agentId: agent.id,
      runId: run.value?.id ?? agent.runId,
    });
    run.value = status.run;
    message.value = null;
  } catch (error) {
    message.value = error instanceof Error ? error.message : "The agent status is unavailable.";
  }
}

/** Poll while the run is live; stop once it reaches a terminal state. */
function scheduleNext(): void {
  stopPolling();
  timer = setTimeout(async () => {
    await refresh();
    if (!run.value || !isTerminalRunStatus(run.value.status)) {
      scheduleNext();
    }
  }, POLL_INTERVAL_MS);
}

async function check(): Promise<void> {
  busy.value = true;
  try {
    await refresh();
    if (!run.value || !isTerminalRunStatus(run.value.status)) {
      scheduleNext();
    }
  } finally {
    busy.value = false;
  }
}

async function send(): Promise<void> {
  const agent = props.agent;
  const prompt = followUp.value.trim();
  if (!agent || !prompt) {
    return;
  }
  busy.value = true;
  message.value = null;
  try {
    const next = await sendCursorFollowUp({
      cursorToken: props.cursorToken,
      agentId: agent.id,
      prompt,
    });
    run.value = next.run;
    followUp.value = "";
    scheduleNext();
  } catch (error) {
    message.value =
      error instanceof HostApiError && error.code === "agent_busy"
        ? "The agent is still working on the previous instruction. Try again when it finishes."
        : error instanceof Error
          ? error.message
          : "The follow-up could not be sent.";
  } finally {
    busy.value = false;
  }
}

onBeforeUnmount(stopPolling);
</script>

<template>
  <section v-if="agent" class="panel">
    <header>
      <h2>Coding agent</h2>
      <p class="muted">
        <a :href="agent.url" target="_blank" rel="noopener noreferrer">Open in Cursor</a>
        to watch it work. Its pushes deploy themselves.
      </p>
    </header>

    <p v-if="run" class="status">
      Run {{ run.status.toLowerCase() }}<span v-if="run.result">: {{ run.result }}</span>
    </p>
    <ul v-if="run?.branches.length" class="links">
      <li v-for="branch in run.branches" :key="branch.branch">
        <code>{{ branch.branch }}</code>
        <a v-if="branch.prUrl" :href="branch.prUrl" target="_blank" rel="noopener noreferrer">
          pull request
        </a>
      </li>
    </ul>

    <div class="field">
      <label for="follow-up">Next instruction</label>
      <textarea
        id="follow-up"
        v-model="followUp"
        rows="3"
        placeholder="Add a tag filter above the list."
      ></textarea>
    </div>

    <p v-if="message" class="warn">{{ message }}</p>

    <div class="row">
      <button type="button" :disabled="busy || !followUp.trim()" @click="send">Send</button>
      <button type="button" class="ghost" :disabled="busy" @click="check">Check status</button>
    </div>
  </section>
</template>

<style scoped>
.row {
  display: flex;
  gap: 0.5rem;
}

.status {
  margin: 0;
  font-size: 0.9rem;
}

.links {
  margin: 0.4rem 0 0;
  padding-left: 1.1rem;
  font-size: 0.85rem;
}
</style>
