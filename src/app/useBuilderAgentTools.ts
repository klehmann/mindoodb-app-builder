/**
 * Offers the App Builder's agent tools to Haven once a session exists, and keeps the
 * agent context (open page, open app, running build) current.
 *
 * This is the only place the tools meet the credentials, and they meet them here so they
 * do not have to: the Cursor key is read inside `readAgentRun` and never returned, and
 * the tools see the connections as booleans. Hosts that predate agent tools have no
 * `session.agent`; then nothing happens.
 */
import { watch, type ComputedRef, type Ref } from "vue";

import {
  createBuilderAgentTools,
  toAgentApp,
  type BuilderAgentDeps,
  type BuilderView,
  type NewAppFormSnapshot,
} from "@/agent/builderAgentTools";
import { flowNoteText } from "@/app/flowNoteText";
import { readCursorStatus } from "@/app/hostApi";
import type { useAppRecords } from "@/app/useAppRecords";
import type { useBuilderFlow } from "@/app/useBuilderFlow";
import type { useBuilderSession } from "@/app/useBuilderSession";
import type { StoredAppRecord } from "@/core/appRecords";
import { t } from "@/i18n";

const CONTEXT_DEBOUNCE_MS = 300;

export function useBuilderAgentTools(options: {
  session: ReturnType<typeof useBuilderSession>;
  records: ReturnType<typeof useAppRecords>;
  flow: ReturnType<typeof useBuilderFlow>;
  view: Ref<BuilderView>;
  setupComplete: ComputedRef<boolean>;
  openApp: (stored: StoredAppRecord) => void;
  startNewApp: () => void;
  startCopyApp: () => void;
  followUpDraft: Ref<{ text: string; nonce: number } | null>;
}) {
  const { session, records, flow } = options;

  function activeApp(): StoredAppRecord | null {
    const record = records.active.value;
    if (!record) {
      return null;
    }
    return { documentId: records.activeDocumentId.value ?? "", record };
  }

  function newAppForm(): NewAppFormSnapshot {
    const form = flow.form.value;
    const source = form.source;
    return {
      mode: form.mode,
      name: form.label,
      plannedRepository: flow.plannedRepositoryName.value,
      description: form.description,
      brief: form.task,
      storeDescription: form.storeDescription,
      publisherName: form.publisherName,
      publisherUrl: form.publisherUrl,
      private: form.private,
      sourceInput: form.sourceInput,
      source: source
        ? {
            repository: source.fullName,
            url: source.htmlUrl,
            commit: source.commitSha,
            files: source.files.length,
            databases: source.databases.map((database) => database.logicalDatabaseId),
          }
        : null,
      sourceError: flow.sourceError.value ? flowNoteText(t, flow.sourceError.value) : null,
      blockedBy: flow.createAppError.value,
    };
  }

  function flowSnapshot() {
    return {
      running: flow.running.value,
      steps: flow.steps.value.map((step) => {
        const note = flowNoteText(t, step.detail);
        return { step: step.id, status: step.status, ...(note ? { note } : {}) };
      }),
    };
  }

  const deps: BuilderAgentDeps = {
    connections: () => ({
      github: session.credentialsStatus.value.github,
      cloudflare: session.credentialsStatus.value.cloudflare,
      cursor: session.credentialsStatus.value.cursor,
      setupComplete: options.setupComplete.value,
    }),
    canProposeApps: () => session.canProposeApps.value,
    canStoreApps: () => records.canStore.value,
    canForgetApps: () => records.canForget.value,
    view: () => options.view.value,
    activeApp,
    newAppForm,
    newAppFormTouched: () => {
      const form = flow.form.value;
      return [form.label, form.description, form.task, form.storeDescription, form.sourceInput].some(
        (value) => value.trim() !== "",
      );
    },
    flow: flowSnapshot,
    listApps: async () => {
      await records.refresh();
      return records.records.value;
    },
    openApp: (stored) => options.openApp(stored),
    prefillNewApp: async (input) => {
      if (input.mode === "copy") {
        options.startCopyApp();
      } else {
        options.startNewApp();
      }
      if (input.sourceUrl) {
        flow.onSourceInput(input.sourceUrl);
        // A read-only GitHub lookup; it fills name and description from the source.
        await flow.loadSource();
      }
      const form = flow.form.value;
      if (input.name) flow.onLabelInput(input.name);
      if (input.slug) flow.onSlugInput(input.slug);
      if (input.description !== undefined) form.description = input.description;
      if (input.brief !== undefined) form.task = input.brief;
      if (input.storeDescription !== undefined) form.storeDescription = input.storeDescription;
      if (input.publisherName !== undefined) form.publisherName = input.publisherName;
      if (input.publisherUrl !== undefined) form.publisherUrl = input.publisherUrl;
      if (input.private !== undefined) form.private = input.private;
    },
    agentPanelAvailable: (stored) =>
      Boolean(stored.record.cursorAgentId) && Boolean(session.credentials.value.cursorToken),
    readAgentRun: async (stored) => {
      const status = await readCursorStatus({
        cursorToken: session.credentials.value.cursorToken,
        agentId: stored.record.cursorAgentId,
        runId: stored.record.cursorRunId || undefined,
      });
      const run = status.run;
      if (!run) {
        return null;
      }
      return {
        status: run.status,
        ...(run.result ? { result: run.result } : {}),
        ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
        branches: run.branches.map((branch) => ({
          branch: branch.branch,
          ...(branch.prUrl ? { pullRequestUrl: branch.prUrl } : {}),
        })),
      };
    },
    prefillFollowUp: async (stored, text) => {
      options.openApp(stored);
      options.followUpDraft.value = { text, nonce: Date.now() };
    },
    forgetApp: async (stored) => await records.forget(stored.documentId),
    restoreApp: async (record) => await records.restore(record),
    buttonLabel: (key) => t(key),
  };
  const tools = createBuilderAgentTools(deps);

  function context(): Record<string, unknown> {
    const active = activeApp();
    const view = options.view.value;
    return {
      view,
      ...(active && view === "app" ? { app: toAgentApp(active.record) } : {}),
      ...(view === "new" ? { newApp: { mode: flow.form.value.mode, name: flow.form.value.label } } : {}),
      buildRunning: flow.running.value,
    };
  }

  watch(
    session.appSession,
    (current) => {
      if (!current) {
        return;
      }
      if (!current.agent) {
        console.info("[app-builder] This Haven offers no agent tools (it predates them); the AI tools stay off.");
        return;
      }
      current.agent
        .registerTools(tools)
        .then((registration) => {
          console.info(
            registration.enabled
              ? `[app-builder] Offered ${registration.exposedNames.length} agent tools to Haven.`
              : `[app-builder] Declared ${registration.exposedNames.length} agent tools; Haven does not offer them yet.`,
            registration.exposedNames,
          );
        })
        .catch((error: unknown) => {
          console.warn("[app-builder] Could not offer agent tools to Haven.", error);
        });
      void current.agent.setContext(context()).catch(() => undefined);
    },
    { immediate: true },
  );

  let contextTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    () => JSON.stringify(context()),
    () => {
      if (contextTimer) {
        clearTimeout(contextTimer);
      }
      contextTimer = setTimeout(() => {
        contextTimer = null;
        void session.appSession.value?.agent?.setContext(context()).catch(() => undefined);
      }, CONTEXT_DEBOUNCE_MS);
    },
  );

  return { tools };
}
