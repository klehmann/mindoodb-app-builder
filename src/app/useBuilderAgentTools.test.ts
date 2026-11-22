import { describe, expect, it, vi } from "vitest";
import { computed, nextTick, ref } from "vue";

import type { useAppRecords } from "@/app/useAppRecords";
import { useBuilderAgentTools } from "@/app/useBuilderAgentTools";
import { useBuilderFlow } from "@/app/useBuilderFlow";
import type { useBuilderSession } from "@/app/useBuilderSession";
import { EMPTY_APP_RECORD, type StoredAppRecord } from "@/core/appRecords";
import { EMPTY_CREDENTIALS, readCredentialsStatus } from "@/core/credentials";

vi.mock("@/app/hostApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/hostApi")>()),
  readCursorStatus: vi.fn(async () => ({
    agent: { id: "bc-1", name: "x", status: "RUNNING", url: "https://cursor.com/agents?id=bc-1" },
    run: { id: "run-1", agentId: "bc-1", status: "RUNNING", branches: [] },
  })),
}));

const { readCursorStatus } = await import("@/app/hostApi");

/**
 * The wiring: the tools reach the real form and the real credentials, and still hand
 * agents nothing secret.
 */
const credentials = {
  ...EMPTY_CREDENTIALS,
  githubToken: "ghu_secret_github",
  githubOwner: "acme",
  cloudflareToken: "cf_secret_cloudflare",
  cloudflareAccountId: "acc42",
  cursorToken: "key_secret_cursor",
};

const app: StoredAppRecord = {
  documentId: "app_1",
  record: {
    ...EMPTY_APP_RECORD,
    appId: "lunch-planner",
    label: "Lunch Planner",
    repoUrl: "https://github.com/acme/lunch-planner",
    cursorAgentId: "bc-1",
    cursorAgentUrl: "https://cursor.com/agents?id=bc-1",
    cursorRunId: "run-1",
  },
};

function setup() {
  const registerTools = vi.fn(async (tools: unknown[]) => ({ enabled: true, exposedNames: tools.map(() => "x") }));
  const setContext = vi.fn(async () => undefined);
  const credentialsRef = ref({ ...credentials });
  const session = {
    appSession: ref({ agent: { registerTools, setContext } }),
    credentials: credentialsRef,
    credentialsStatus: computed(() => readCredentialsStatus(credentialsRef.value)),
    canProposeApps: ref(true),
  } as unknown as ReturnType<typeof useBuilderSession>;
  const records = {
    records: ref([app]),
    active: ref(null),
    activeDocumentId: ref(null),
    canStore: ref(true),
    canForget: ref(true),
    refresh: vi.fn(async () => undefined),
    forget: vi.fn(async () => true),
    restore: vi.fn(async () => undefined),
  } as unknown as ReturnType<typeof useAppRecords>;
  const flow = useBuilderFlow(session);
  const view = ref<"home" | "new" | "app" | "setup">("home");
  const followUpDraft = ref<{ text: string; nonce: number } | null>(null);
  const startNewApp = vi.fn(() => {
    flow.reset();
    view.value = "new";
  });
  const openApp = vi.fn(() => {
    view.value = "app";
    followUpDraft.value = null;
  });
  const { tools } = useBuilderAgentTools({
    session,
    records,
    flow,
    view,
    setupComplete: computed(() => true),
    openApp,
    startNewApp,
    startCopyApp: vi.fn(),
    followUpDraft,
  });
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  return { registerTools, setContext, flow, view, followUpDraft, startNewApp, openApp, tool, tools };
}

describe("useBuilderAgentTools", () => {
  it("offers the tools and the context to Haven", async () => {
    const { registerTools, setContext, tools } = setup();
    await nextTick();
    expect(registerTools).toHaveBeenCalledWith(tools);
    expect(setContext).toHaveBeenCalledWith(expect.objectContaining({ view: "home", buildRunning: false }));
  });

  it("fills the real New app form and leaves the build to the user", async () => {
    const { tool, flow, view, startNewApp } = setup();
    const result = (await tool("new_app_prefill").execute({
      name: "Team Lunch",
      description: "Lunch polls",
      brief: "A poll per day.",
      private: false,
    })) as { readyToBuild: boolean; form: { plannedRepository: string } };

    expect(startNewApp).toHaveBeenCalledOnce();
    expect(view.value).toBe("new");
    expect(flow.form.value).toMatchObject({
      label: "Team Lunch",
      slug: "team-lunch",
      description: "Lunch polls",
      task: "A poll per day.",
      private: false,
    });
    expect(flow.running.value).toBe(false);
    expect(result.readyToBuild).toBe(true);
    expect(result.form.plannedRepository).toBe("team-lunch");
  });

  it("puts a follow-up into the agent's box without sending it", async () => {
    const { tool, followUpDraft, openApp } = setup();
    await tool("agent_follow_up_prefill").execute({ appId: "lunch-planner", instruction: "Add a CSV export." });
    expect(openApp).toHaveBeenCalledOnce();
    expect(followUpDraft.value?.text).toBe("Add a CSV export.");
  });

  it("uses the Cursor key for the status call but never returns a token", async () => {
    const { tool } = setup();
    const answers = [
      await tool("get_context").execute({}),
      await tool("apps_list").execute({}),
      await tool("apps_get").execute({ appId: "lunch-planner" }),
      await tool("agent_status").execute({ appId: "lunch-planner" }),
      await tool("new_app_prefill").execute({ name: "Team Lunch" }),
    ];
    expect(readCursorStatus).toHaveBeenCalledWith(
      expect.objectContaining({ cursorToken: "key_secret_cursor", agentId: "bc-1" }),
    );
    const text = JSON.stringify(answers);
    for (const secret of ["ghu_secret_github", "cf_secret_cloudflare", "key_secret_cursor"]) {
      expect(text).not.toContain(secret);
    }
  });
});
