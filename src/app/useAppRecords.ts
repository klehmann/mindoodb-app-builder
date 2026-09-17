/**
 * The builder's memory: the list of apps the user built, and the running record of the
 * one being built right now.
 *
 * Two jobs that look like one. The **list** is what the builder opens with, so returning
 * to it is the normal case and starting a new app is a button rather than the whole
 * screen. The **active record** is written at every phase boundary during a run, which
 * is what lets a run that died — a dead Cursor key, a Cloudflare token that expired
 * overnight — be picked up from the list instead of retyped.
 *
 * Every write is best effort. A builder database without `create` still builds apps
 * perfectly well; the user just does not get a history, which the UI says once rather
 * than failing a run over.
 */
import { computed, ref } from "vue";

import {
  applyFlowOutcome,
  appRecordFromIdentity,
  deleteAppRecord,
  listAppRecords,
  saveAppRecord,
  type BuilderAppRecord,
  type FlowOutcome,
  type StoredAppRecord,
} from "@/core/appRecords";
import type { AppIdentity } from "@/core/appIdentity";
import type { useBuilderSession } from "@/app/useBuilderSession";

type BuilderSession = ReturnType<typeof useBuilderSession>;

export function useAppRecords(session: BuilderSession) {
  const records = ref<StoredAppRecord[]>([]);
  const loading = ref(false);
  /** The app currently being built or continued, and the document it lives in. */
  const active = ref<BuilderAppRecord | null>(null);
  const activeDocumentId = ref<string | null>(null);

  const capabilities = computed(() => session.databaseInfo.value?.capabilities ?? []);
  const canStore = computed(() => capabilities.value.includes("create"));
  const canForget = computed(() => capabilities.value.includes("delete"));
  const hasRecords = computed(() => records.value.length > 0);

  async function refresh(): Promise<void> {
    const database = session.database.value;
    if (!database) {
      records.value = [];
      return;
    }
    loading.value = true;
    try {
      records.value = await listAppRecords(database);
    } finally {
      loading.value = false;
    }
  }

  /**
   * Write the active record, and remember which document it went into.
   *
   * Returns quietly when there is nothing to write to. Callers are flow checkpoints in
   * the middle of a build — none of them is a place to surface a storage problem, and
   * none of them can do anything about one.
   */
  async function persist(): Promise<void> {
    const database = session.database.value;
    const record = active.value;
    if (!database || !record || !canStore.value) {
      return;
    }
    try {
      activeDocumentId.value = await saveAppRecord(database, record, activeDocumentId.value);
      await refresh();
    } catch (error) {
      console.error("[app-builder] The app record could not be saved:", error);
    }
  }

  /** Begin a new app: write down the name and the brief before the first API call. */
  async function begin(identity: AppIdentity, options: { private: boolean }): Promise<void> {
    active.value = appRecordFromIdentity(identity, options);
    activeDocumentId.value = null;
    await persist();
  }

  /** Continue an app from the list — its record becomes the active one. */
  function resume(stored: StoredAppRecord): void {
    active.value = { ...stored.record };
    activeDocumentId.value = stored.documentId;
  }

  /**
   * Fold a finished phase into the active record and save it.
   *
   * Tolerates having no active record: a phase re-run started from the list sets one
   * through `resume` first, and a run started before this composable existed would
   * otherwise throw inside a flow that is otherwise fine.
   */
  async function recordPhase(outcome: FlowOutcome): Promise<void> {
    if (!active.value) {
      return;
    }
    active.value = applyFlowOutcome(active.value, outcome);
    await persist();
  }

  /** Drop the builder's note about an app. The app itself keeps running. */
  async function forget(documentId: string): Promise<void> {
    const database = session.database.value;
    if (!database || !canForget.value) {
      return;
    }
    try {
      await deleteAppRecord(database, documentId);
      if (activeDocumentId.value === documentId) {
        active.value = null;
        activeDocumentId.value = null;
      }
      await refresh();
    } catch (error) {
      console.error("[app-builder] The app record could not be removed:", error);
    }
  }

  function clearActive(): void {
    active.value = null;
    activeDocumentId.value = null;
  }

  return {
    active,
    activeDocumentId,
    begin,
    canForget,
    canStore,
    clearActive,
    forget,
    hasRecords,
    loading,
    recordPhase,
    records,
    refresh,
    resume,
  };
}
