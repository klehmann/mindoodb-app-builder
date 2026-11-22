import { MindooDBAppAgentToolError, type MindooDBAppAgentTool } from "mindoodb-app-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  createBuilderAgentTools,
  type BuilderAgentDeps,
  type BuilderView,
  type NewAppFormSnapshot,
  type NewAppPrefill,
} from "@/agent/builderAgentTools";
import { EMPTY_APP_RECORD, type BuilderAppRecord, type StoredAppRecord } from "@/core/appRecords";

/**
 * The agent tools from the outside: what an agent sees, what it may change, and above
 * all what it may not — no token in any answer, nothing outward-facing started by a call.
 */

const SECRET_TOKENS = ["ghu_secret_github", "cf_secret_cloudflare", "key_secret_cursor"];

function record(overrides: Partial<BuilderAppRecord>): BuilderAppRecord {
  return {
    ...EMPTY_APP_RECORD,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

const liveApp = record({
  appId: "lunch-planner",
  label: "Lunch Planner",
  description: "Vote on where the team eats",
  task: "Everyone votes on a place; the organizer closes the poll.",
  repoOwner: "acme",
  repoName: "lunch-planner",
  repoUrl: "https://github.com/acme/lunch-planner",
  repoBranch: "main",
  repoId: 1,
  repoOwnerId: 2,
  identityCommitted: true,
  workerUrl: "https://lunch-planner.acme.workers.dev",
  workerScriptTag: "tag123",
  cloudflareAccountId: "acc42",
  wiredForBuild: true,
  originReady: true,
  cursorAgentId: "bc-agent-1",
  cursorAgentUrl: "https://cursor.com/agents?id=bc-agent-1",
  cursorRunId: "run-1",
});

const plannedApp = record({
  appId: "expense-tracker",
  label: "Expense Tracker",
  description: "Track receipts",
  createdAt: "2026-09-01T10:00:00.000Z",
});

function emptyForm(): NewAppFormSnapshot {
  return {
    mode: "new",
    name: "",
    plannedRepository: "",
    description: "",
    brief: "",
    storeDescription: "",
    publisherName: "",
    publisherUrl: "",
    private: true,
    sourceInput: "",
    source: null,
    sourceError: null,
    blockedBy: null,
  };
}

function setup(overrides: Partial<BuilderAgentDeps> = {}) {
  let apps: StoredAppRecord[] = [
    { documentId: "app_1", record: liveApp },
    { documentId: "app_2", record: plannedApp },
  ];
  let form = emptyForm();
  let view: BuilderView = "home";
  let running = false;
  let restored = 0;

  const deps: BuilderAgentDeps = {
    connections: () => ({ github: true, cloudflare: true, cursor: true, setupComplete: true }),
    canProposeApps: () => true,
    canStoreApps: () => true,
    canForgetApps: () => true,
    view: () => view,
    activeApp: () => null,
    newAppForm: () => form,
    newAppFormTouched: () => Boolean(form.name || form.brief),
    flow: () => ({ running, steps: [] }),
    listApps: vi.fn(async () => apps),
    openApp: vi.fn(() => {
      view = "app";
    }),
    prefillNewApp: vi.fn(async (input: NewAppPrefill) => {
      view = "new";
      form = {
        ...emptyForm(),
        mode: input.mode,
        name: input.name ?? "",
        plannedRepository: (input.name ?? "").toLowerCase().replace(/\s+/g, "-"),
        description: input.description ?? "",
        brief: input.brief ?? "",
        private: input.private ?? true,
        sourceInput: input.sourceUrl ?? "",
      };
    }),
    agentPanelAvailable: () => true,
    readAgentRun: vi.fn(async () => ({
      status: "FINISHED" as const,
      result: "Added the poll page.",
      branches: [{ branch: "cursor/poll", pullRequestUrl: "https://github.com/acme/lunch-planner/pull/3" }],
    })),
    prefillFollowUp: vi.fn(async () => {
      view = "app";
    }),
    forgetApp: vi.fn(async (stored: StoredAppRecord) => {
      apps = apps.filter((entry) => entry.documentId !== stored.documentId);
      return true;
    }),
    restoreApp: vi.fn(async (next: BuilderAppRecord) => {
      apps = [...apps, { documentId: `restored_${(restored += 1)}`, record: next }];
    }),
    buttonLabel: (key) => `[${key}]`,
    newStepId: () => "step-1",
    ...overrides,
  };
  const tools = createBuilderAgentTools(deps);
  const tool = (name: string): MindooDBAppAgentTool => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return {
    deps,
    tools,
    tool,
    setForm: (next: Partial<NewAppFormSnapshot>) => {
      form = { ...form, ...next };
    },
    setView: (next: BuilderView) => {
      view = next;
    },
    setRunning: (next: boolean) => {
      running = next;
    },
    apps: () => apps,
  };
}

async function expectToolError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MindooDBAppAgentToolError);
  expect((error as MindooDBAppAgentToolError).code).toBe(code);
}

describe("builder agent tools", () => {
  it("names follow Haven's rules and every write tool is not marked read-only", () => {
    const { tools } = setup();
    expect(tools.map((entry) => entry.name)).toEqual([
      "get_context",
      "apps_list",
      "apps_get",
      "app_open",
      "new_app_prefill",
      "agent_status",
      "agent_follow_up_prefill",
      "apps_forget",
      "undo",
    ]);
    for (const entry of tools) {
      expect(entry.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(entry.inputSchema.type).toBe("object");
    }
    const readOnly = tools.filter((entry) => entry.annotations?.readOnlyHint).map((entry) => entry.name);
    expect(readOnly).toEqual(["get_context", "apps_list", "apps_get", "agent_status"]);
    expect(tools.find((entry) => entry.name === "apps_forget")?.annotations?.consequentialHint).toBe(true);
  });

  it("descriptions of the prefill tools say the user presses the button", () => {
    const { tool } = setup();
    expect(tool("new_app_prefill").description).toMatch(/Nothing is created: the user presses/);
    expect(tool("agent_follow_up_prefill").description).toMatch(/It is not sent: the user/);
  });

  it("get_context reports connections as booleans only", async () => {
    const { tool } = setup();
    const context = (await tool("get_context").execute({})) as Record<string, unknown>;
    expect(context.connections).toEqual({ github: true, cloudflare: true, cursor: true });
    expect(context.view).toBe("home");
    expect(context).not.toHaveProperty("build");
  });

  it("get_context shows a running build and its current step", async () => {
    const { tool } = setup({
      flow: () => ({
        running: true,
        steps: [
          { step: "create-repo", status: "done" },
          { step: "create-worker", status: "running" },
          { step: "propose", status: "pending" },
        ],
      }),
      activeApp: () => ({ documentId: "app_1", record: liveApp }),
    });
    const context = (await tool("get_context").execute({})) as {
      build: { running: boolean; currentStep: string | null };
      app: { appId: string };
    };
    expect(context.build.running).toBe(true);
    expect(context.build.currentStep).toBe("create-worker");
    expect(context.app.appId).toBe("lunch-planner");
  });

  it("apps_list returns the apps with stage and next action, and filters", async () => {
    const { tool } = setup();
    const all = (await tool("apps_list").execute({})) as { total: number; apps: Array<Record<string, unknown>> };
    expect(all.total).toBe(2);
    expect(all.apps[0]).toMatchObject({
      appId: "lunch-planner",
      name: "Lunch Planner",
      stage: "live",
      nextAction: "install",
      appUrl: "https://lunch-planner.acme.workers.dev",
      repositoryUrl: "https://github.com/acme/lunch-planner",
      definitionUrl: "https://lunch-planner.acme.workers.dev/haven-app.json",
      installedInHaven: false,
      codingAgent: { url: "https://cursor.com/agents?id=bc-agent-1" },
    });
    expect(all.apps[1]).toMatchObject({ appId: "expense-tracker", stage: "planned", nextAction: "create" });

    const filtered = (await tool("apps_list").execute({ query: "receipt" })) as { apps: Array<{ appId: string }> };
    expect(filtered.apps.map((app) => app.appId)).toEqual(["expense-tracker"]);
    const byStage = (await tool("apps_list").execute({ stage: "live" })) as { apps: Array<{ appId: string }> };
    expect(byStage.apps.map((app) => app.appId)).toEqual(["lunch-planner"]);
    await expectToolError(tool("apps_list").execute({ stage: "done" }), "INVALID_INPUT");
  });

  it("apps_get returns the brief and dashboard link, and NOT_FOUND for unknown ids", async () => {
    const { tool } = setup();
    const app = (await tool("apps_get").execute({ appId: "lunch-planner" })) as Record<string, unknown>;
    expect(app.brief).toBe(liveApp.task);
    expect(app.cloudflareDashboardUrl).toContain("/acc42/workers/services/view/lunch-planner/");
    expect(app.nextActionMeaning).toMatch(/install/);
    await expectToolError(tool("apps_get").execute({ appId: "nope" }), "NOT_FOUND");
    await expectToolError(tool("apps_get").execute({}), "INVALID_INPUT");
  });

  it("app_open shows the page and names the Continue button without pressing it", async () => {
    const { tool, deps } = setup();
    const result = (await tool("app_open").execute({ appId: "lunch-planner" })) as {
      continueButton: { label: string };
    };
    expect(deps.openApp).toHaveBeenCalledOnce();
    expect(result.continueButton.label).toBe("[detail.continue.labels.install]");
  });

  it("app_open waits while a build runs", async () => {
    const { tool, setRunning } = setup();
    setRunning(true);
    await expectToolError(tool("app_open").execute({ appId: "lunch-planner" }), "INVALID_STATE");
  });

  it("new_app_prefill fills the form and creates nothing", async () => {
    const { tool, deps } = setup();
    const result = (await tool("new_app_prefill").execute({
      name: "Team Lunch",
      description: "Lunch polls",
      brief: "A poll per day.",
      private: false,
    })) as { created: boolean; readyToBuild: boolean; buildButton: { label: string }; form: NewAppFormSnapshot };
    expect(deps.prefillNewApp).toHaveBeenCalledWith({
      mode: "new",
      name: "Team Lunch",
      description: "Lunch polls",
      brief: "A poll per day.",
      private: false,
    });
    expect(result.created).toBe(false);
    expect(result.readyToBuild).toBe(true);
    expect(result.buildButton.label).toBe("[newApp.build.idle]");
    expect(result.form.plannedRepository).toBe("team-lunch");
  });

  it("new_app_prefill passes on what blocks the build", async () => {
    const blocked = setup({
      newAppForm: () => ({ ...emptyForm(), name: "X", blockedBy: "Cloudflare is not connected." }),
    });
    const result = (await blocked.tool("new_app_prefill").execute({ name: "X" })) as {
      readyToBuild: boolean;
      userAction: string;
    };
    expect(result.readyToBuild).toBe(false);
    expect(result.userAction).toContain("Cloudflare is not connected.");
  });

  it("new_app_prefill prepares a copy from a source URL", async () => {
    const { tool, deps } = setup();
    await tool("new_app_prefill").execute({
      mode: "copy",
      sourceUrl: "https://github.com/klehmann/mindoodb-app-todomanager",
      brief: "Add a weekly review page.",
    });
    expect(deps.prefillNewApp).toHaveBeenCalledWith({
      mode: "copy",
      sourceUrl: "https://github.com/klehmann/mindoodb-app-todomanager",
      brief: "Add a weekly review page.",
    });
    await expectToolError(tool("new_app_prefill").execute({ mode: "copy" }), "INVALID_INPUT");
    await expectToolError(
      tool("new_app_prefill").execute({ name: "A", sourceUrl: "https://github.com/a/b" }),
      "INVALID_INPUT",
    );
  });

  it("new_app_prefill validates its input", async () => {
    const { tool } = setup();
    await expectToolError(tool("new_app_prefill").execute({}), "INVALID_INPUT");
    await expectToolError(tool("new_app_prefill").execute({ name: "A", publisherUrl: "http://x" }), "INVALID_INPUT");
    await expectToolError(tool("new_app_prefill").execute({ name: "A", private: "yes" }), "INVALID_INPUT");
    await expectToolError(tool("new_app_prefill").execute({ name: "A", brief: "x".repeat(20_001) }), "INVALID_INPUT");
  });

  it("new_app_prefill does not overwrite what the user typed unless told to", async () => {
    const { tool, setForm, setView, deps } = setup();
    setView("new");
    setForm({ name: "My own idea" });
    await expectToolError(tool("new_app_prefill").execute({ name: "Other" }), "STATE_CHANGED");
    expect(deps.prefillNewApp).not.toHaveBeenCalled();
    await tool("new_app_prefill").execute({ name: "Other", replace: true });
    expect(deps.prefillNewApp).toHaveBeenCalledOnce();
  });

  it("new_app_prefill has no field for tokens or accounts", () => {
    const { tool } = setup();
    const properties = Object.keys(
      (tool("new_app_prefill").inputSchema as { properties: Record<string, unknown> }).properties,
    );
    expect(properties.some((name) => /token|key|secret|account|owner/i.test(name))).toBe(false);
  });

  it("agent_status reports the Cursor run", async () => {
    const { tool, deps } = setup();
    const status = (await tool("agent_status").execute({ appId: "lunch-planner" })) as {
      run: { status: string; finished: boolean; branches: unknown[] };
      codingAgentUrl: string;
    };
    expect(deps.readAgentRun).toHaveBeenCalledOnce();
    expect(status.run.status).toBe("FINISHED");
    expect(status.run.finished).toBe(true);
    expect(status.codingAgentUrl).toBe(liveApp.cursorAgentUrl);
    await expectToolError(tool("agent_status").execute({ appId: "expense-tracker" }), "INVALID_STATE");
  });

  it("agent_status needs Cursor connected", async () => {
    const { tool, deps } = setup({
      connections: () => ({ github: true, cloudflare: true, cursor: false, setupComplete: true }),
    });
    await expectToolError(tool("agent_status").execute({ appId: "lunch-planner" }), "NOT_ALLOWED");
    expect(deps.readAgentRun).not.toHaveBeenCalled();
  });

  it("agent_follow_up_prefill fills the box and sends nothing", async () => {
    const { tool, deps } = setup();
    const result = (await tool("agent_follow_up_prefill").execute({
      appId: "lunch-planner",
      instruction: "Add a CSV export.",
    })) as { sent: boolean; sendButton: string };
    expect(deps.prefillFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "app_1" }),
      "Add a CSV export.",
    );
    expect(result.sent).toBe(false);
    expect(result.sendButton).toBe("[agent.actions.send]");
    await expectToolError(
      tool("agent_follow_up_prefill").execute({ appId: "expense-tracker", instruction: "x" }),
      "INVALID_STATE",
    );
    await expectToolError(tool("agent_follow_up_prefill").execute({ appId: "lunch-planner" }), "INVALID_INPUT");
  });

  it("agent_follow_up_prefill refuses without a Cursor key", async () => {
    const { tool, deps } = setup({ agentPanelAvailable: () => false });
    await expectToolError(
      tool("agent_follow_up_prefill").execute({ appId: "lunch-planner", instruction: "x" }),
      "NOT_ALLOWED",
    );
    expect(deps.prefillFollowUp).not.toHaveBeenCalled();
  });

  it("apps_forget removes list entries and undo brings them back", async () => {
    const handle = setup();
    const forgotten = (await handle.tool("apps_forget").execute({ appIds: ["expense-tracker"] })) as {
      forgotten: Array<{ appId: string }>;
      undoStepId: string;
      stillRunning: string;
    };
    expect(forgotten.forgotten).toEqual([{ appId: "expense-tracker", name: "Expense Tracker" }]);
    expect(forgotten.undoStepId).toBe("step-1");
    expect(forgotten.stillRunning).toMatch(/not touched/);
    expect(handle.apps().map((entry) => entry.record.appId)).toEqual(["lunch-planner"]);

    const undone = (await handle.tool("undo").execute({ stepId: "step-1" })) as { restored: string[] };
    expect(undone.restored).toEqual(["expense-tracker"]);
    expect(handle.deps.restoreApp).toHaveBeenCalledWith(plannedApp);
    expect(handle.apps().map((entry) => entry.record.appId)).toEqual(["lunch-planner", "expense-tracker"]);

    await expectToolError(handle.tool("undo").execute({}), "NOT_FOUND");
  });

  it("undo refuses when the app is on the list again", async () => {
    const handle = setup();
    await handle.tool("apps_forget").execute({ appIds: ["expense-tracker"] });
    await handle.deps.restoreApp(plannedApp);
    await expectToolError(handle.tool("undo").execute({}), "STATE_CHANGED");
  });

  it("apps_forget checks ids and permission before removing anything", async () => {
    const handle = setup();
    await expectToolError(handle.tool("apps_forget").execute({ appIds: ["lunch-planner", "nope"] }), "NOT_FOUND");
    expect(handle.deps.forgetApp).not.toHaveBeenCalled();
    await expectToolError(handle.tool("apps_forget").execute({ appIds: [] }), "INVALID_INPUT");

    const readOnly = setup({ canForgetApps: () => false });
    await expectToolError(readOnly.tool("apps_forget").execute({ appIds: ["lunch-planner"] }), "NOT_ALLOWED");
  });

  it("no answer carries a token", async () => {
    const { tool } = setup();
    const answers = await Promise.all([
      tool("get_context").execute({}),
      tool("apps_list").execute({}),
      tool("apps_get").execute({ appId: "lunch-planner" }),
      tool("agent_status").execute({ appId: "lunch-planner" }),
    ]);
    const text = JSON.stringify(answers);
    for (const secret of SECRET_TOKENS) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/token/i);
  });
});
