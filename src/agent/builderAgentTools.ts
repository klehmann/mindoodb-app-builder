/**
 * The App Builder's tools for AI agents (WebMCP through Haven).
 *
 * What an agent may do here is deliberately narrower than what the user may do:
 *
 * - **Read** the list of built apps, one app's details, the state of a running build and
 *   the Cursor agent's progress.
 * - **Prepare** outward-facing work, never start it. Creating a GitHub repository,
 *   deploying to Cloudflare and starting a (paid) Cursor agent run only happen when the
 *   user presses the button on the page. The tools open the right page and fill in the
 *   form or the instruction box; the result names the button the user presses.
 * - **Forget** a list entry, with undo. That only removes the builder's note about an
 *   app, never the repository, the Worker or the Haven installation.
 *
 * Tokens never reach this module: the dependencies hand in connection booleans and do
 * every authenticated call themselves. Nothing here can read or set a credential.
 */
import { MindooDBAppAgentToolError, type MindooDBAppAgentTool } from "mindoodb-app-sdk";

import {
  appDefinitionUrl,
  appStage,
  nextAppAction,
  workerDashboardUrl,
  type AppNextAction,
  type BuilderAppRecord,
  type BuilderAppStage,
  type StoredAppRecord,
} from "@/core/appRecords";
import type { CursorRunStatus } from "@/core/cursorAgents";

/** The prefix in `haven-app.json`; agents see `builder_apps_list` and so on. */
export const BUILDER_AGENT_TOOL_PREFIX = "builder";

export type BuilderView = "home" | "new" | "app" | "setup";

/** Whether each account is connected. Booleans only: no token ever leaves the app. */
export interface BuilderConnections {
  github: boolean;
  cloudflare: boolean;
  cursor: boolean;
  /** The user went through the one-time setup at least once. */
  setupComplete: boolean;
}

export interface BuilderFlowStepSnapshot {
  step: string;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  /** The step's note in the user's language, when it has one. */
  note?: string;
}

/** The New app page as the agent should see it. */
export interface NewAppFormSnapshot {
  mode: "new" | "copy";
  name: string;
  /** Repository name, Worker name and app id the app will get. Empty until named. */
  plannedRepository: string;
  description: string;
  brief: string;
  storeDescription: string;
  publisherName: string;
  publisherUrl: string;
  private: boolean;
  /** For a copy: what was pasted, and the checked source once it was looked up. */
  sourceInput: string;
  source: { repository: string; url: string; commit: string; files: number; databases: string[] } | null;
  sourceError: string | null;
  /** Why "Build my app" is disabled right now, in the user's language. Null = ready. */
  blockedBy: string | null;
}

export interface BuilderFlowSnapshot {
  running: boolean;
  steps: BuilderFlowStepSnapshot[];
}

export interface NewAppPrefill {
  mode: "new" | "copy";
  sourceUrl?: string;
  name?: string;
  slug?: string;
  description?: string;
  brief?: string;
  storeDescription?: string;
  publisherName?: string;
  publisherUrl?: string;
  private?: boolean;
}

export interface AgentRunSnapshot {
  status: CursorRunStatus;
  /** Cursor's summary once the run finished. Written by the coding agent. */
  result?: string;
  durationMs?: number;
  branches: Array<{ branch: string; pullRequestUrl?: string }>;
}

export interface BuilderAgentDeps {
  connections: () => BuilderConnections;
  /** Haven lets the builder propose apps for installation. */
  canProposeApps: () => boolean;
  /** The builder database accepts new list entries / removals. */
  canStoreApps: () => boolean;
  canForgetApps: () => boolean;
  view: () => BuilderView;
  /** The app whose page is open (view "app"), or the one a build runs for. */
  activeApp: () => StoredAppRecord | null;
  newAppForm: () => NewAppFormSnapshot;
  /** True when the user typed something into the New app form. */
  newAppFormTouched: () => boolean;
  flow: () => BuilderFlowSnapshot;
  /** The stored apps, read fresh. */
  listApps: () => Promise<StoredAppRecord[]>;
  /** Show an app's page. */
  openApp: (stored: StoredAppRecord) => void;
  /** Open the New app page and fill it in. Starts nothing. */
  prefillNewApp: (input: NewAppPrefill) => Promise<void>;
  /** Whether the app's page can show the Cursor agent box right now. */
  agentPanelAvailable: (stored: StoredAppRecord) => boolean;
  /** Ask Cursor how the app's agent is doing. The token stays inside. */
  readAgentRun: (stored: StoredAppRecord) => Promise<AgentRunSnapshot | null>;
  /** Open the app's page and put the text into the agent's instruction box. Sends nothing. */
  prefillFollowUp: (stored: StoredAppRecord, text: string) => Promise<void>;
  /** Remove the list entry. Resolves false when it could not be removed. */
  forgetApp: (stored: StoredAppRecord) => Promise<boolean>;
  /** Write a forgotten entry back. */
  restoreApp: (record: BuilderAppRecord) => Promise<void>;
  /** A button label in the user's language, by its translation key. */
  buttonLabel: (key: string) => string;
  /** Step ids for undo, injectable for tests. */
  newStepId?: () => string;
}

const MAX_TEXT = 20_000;
const MAX_SHORT_TEXT = 300;
const MAX_FORGET = 20;
const MAX_UNDO_STEPS = 20;

/** What each stage means, in the words agents get. */
export const STAGE_GUIDE: Record<BuilderAppStage, string> = {
  planned: "only described; nothing was created yet",
  repository: "the GitHub repository exists; not published yet",
  published: "a Cloudflare Worker exists but the app never answered on its URL",
  live: "live on its URL; not added to Haven yet",
  installed: "live and added to Haven",
};

/** What the app page's one Continue button does next, per next action. */
const NEXT_ACTION_GUIDE: Record<AppNextAction, string> = {
  create: "run the whole build (create the repository, publish, add to Haven)",
  commit: "carry on: name the starter code in the existing repository, then publish",
  publish: "publish the app to Cloudflare and add it to Haven",
  build: "start a Cloudflare build so the app goes live",
  install: "ask Haven to install the live app",
  iterate: "start a new Cursor agent run on the app (uses the user's Cursor plan)",
};

export interface AgentApp {
  appId: string;
  name: string;
  description: string;
  stage: BuilderAppStage;
  stageMeaning: string;
  nextAction: AppNextAction;
  private: boolean;
  appUrl?: string;
  repositoryUrl?: string;
  /** The `haven-app.json` Haven installs from. */
  definitionUrl?: string;
  installedInHaven: boolean;
  codingAgent: { url: string } | null;
  copiedFrom?: { repositoryUrl: string; commit: string };
  created?: string;
  updated?: string;
}

export function toAgentApp(record: BuilderAppRecord): AgentApp {
  const stage = appStage(record);
  return {
    appId: record.appId,
    name: record.label,
    description: record.description,
    stage,
    stageMeaning: STAGE_GUIDE[stage],
    nextAction: nextAppAction(record),
    private: record.private,
    ...(record.workerUrl ? { appUrl: record.workerUrl } : {}),
    ...(record.repoUrl ? { repositoryUrl: record.repoUrl } : {}),
    ...(appDefinitionUrl(record) ? { definitionUrl: appDefinitionUrl(record) } : {}),
    installedInHaven: Boolean(record.havenInstanceId),
    codingAgent: record.cursorAgentId ? { url: record.cursorAgentUrl } : null,
    ...(record.sourceRepoUrl
      ? { copiedFrom: { repositoryUrl: record.sourceRepoUrl, commit: record.sourceCommit } }
      : {}),
    ...(record.createdAt ? { created: record.createdAt } : {}),
    ...(record.updatedAt ? { updated: record.updatedAt } : {}),
  };
}

// --- input helpers -------------------------------------------------------

function invalid(message: string, requiredAction?: string): never {
  throw new MindooDBAppAgentToolError("INVALID_INPUT", message, requiredAction);
}

function optionalString(
  input: Record<string, unknown>,
  field: string,
  max = MAX_SHORT_TEXT,
): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) invalid(`${field} is too long (at most ${max} characters).`);
  return trimmed || undefined;
}

function optionalBoolean(input: Record<string, unknown>, field: string): boolean | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid(`${field} must be true or false.`);
  return value;
}

function requiredAppId(input: Record<string, unknown>): string {
  const appId = optionalString(input, "appId");
  if (!appId) invalid('Missing "appId".', "call builder_apps_list for the app ids");
  return appId;
}

interface UndoStep {
  id: string;
  label: string;
  records: BuilderAppRecord[];
}

export function createBuilderAgentTools(deps: BuilderAgentDeps): MindooDBAppAgentTool[] {
  /** Forgotten entries, newest last. Lives as long as the page: undo is for this session. */
  const undoSteps: UndoStep[] = [];
  let stepCounter = 0;
  const newStepId = () => deps.newStepId?.() ?? `forget-${Date.now().toString(36)}-${++stepCounter}`;

  async function findApp(appId: string): Promise<StoredAppRecord> {
    const apps = await deps.listApps();
    const match = apps.find((entry) => entry.record.appId === appId);
    if (!match) {
      throw new MindooDBAppAgentToolError(
        "NOT_FOUND",
        `There is no app "${appId}" in the builder's list.`,
        "call builder_apps_list for the app ids",
      );
    }
    return match;
  }

  function requireIdle(): void {
    if (deps.flow().running) {
      throw new MindooDBAppAgentToolError(
        "INVALID_STATE",
        "A build is running in the App Builder right now.",
        "wait until builder_get_context reports build.running false",
      );
    }
  }

  const getContext: MindooDBAppAgentTool = {
    name: "get_context",
    description:
      "What the App Builder shows right now: which accounts are connected (GitHub, Cloudflare, Cursor; " +
      "true/false only), the open page (home = list of apps, new = New app form, app = one app, setup = " +
      "connections), the open app, the New app form, and a running build with its steps. Call it first, " +
      "and again to follow a build the user started.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute() {
      const view = deps.view();
      const active = deps.activeApp();
      const flow = deps.flow();
      const connections = deps.connections();
      const current = flow.steps.find((step) => step.status === "running") ?? null;
      const started = flow.running || flow.steps.some((step) => step.status !== "pending");
      return {
        connections: {
          github: connections.github,
          cloudflare: connections.cloudflare,
          cursor: connections.cursor,
        },
        setupComplete: connections.setupComplete,
        canAddToHaven: deps.canProposeApps(),
        canStoreApps: deps.canStoreApps(),
        view,
        ...(active && (view === "app" || flow.running) ? { app: toAgentApp(active.record) } : {}),
        ...(view === "new" ? { newApp: deps.newAppForm() } : {}),
        ...(started
          ? {
              build: {
                running: flow.running,
                currentStep: current?.step ?? null,
                failed: flow.steps.some((step) => step.status === "failed"),
                steps: flow.steps,
              },
            }
          : {}),
        stages: STAGE_GUIDE,
      };
    },
  };

  const appsList: MindooDBAppAgentTool = {
    name: "apps_list",
    description:
      "Lists the apps built with the App Builder, newest first: appId, name, description, stage (planned, " +
      "repository, published, live, installed), nextAction, app URL, GitHub repository URL, whether it is in " +
      "Haven and whether a Cursor coding agent works on it. Use the appId with the other builder tools.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the name, app id or description." },
        stage: {
          type: "string",
          enum: ["planned", "repository", "published", "live", "installed"],
        },
      },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input) {
      const query = optionalString(input, "query")?.toLowerCase();
      const stage = optionalString(input, "stage");
      if (stage && !(stage in STAGE_GUIDE)) {
        invalid("stage must be planned, repository, published, live or installed.");
      }
      const apps = (await deps.listApps())
        .map((stored) => toAgentApp(stored.record))
        .filter((app) => !stage || app.stage === stage)
        .filter(
          (app) =>
            !query ||
            [app.name, app.appId, app.description].some((text) => text.toLowerCase().includes(query)),
        );
      return { total: apps.length, apps };
    },
  };

  const appsGet: MindooDBAppAgentTool = {
    name: "apps_get",
    description:
      "One app with everything the builder knows about it: the brief the coding agent got, the store " +
      "description, publisher, URLs (app, repository, haven-app.json, Cloudflare dashboard), stage and what " +
      "the app page's Continue button would do next.",
    inputSchema: {
      type: "object",
      required: ["appId"],
      properties: { appId: { type: "string", description: "From builder_apps_list." } },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input) {
      const { record } = await findApp(requiredAppId(input));
      const app = toAgentApp(record);
      return {
        ...app,
        nextActionMeaning: NEXT_ACTION_GUIDE[app.nextAction],
        brief: record.task,
        ...(record.storeDescription ? { storeDescription: record.storeDescription } : {}),
        ...(record.publisherName ? { publisherName: record.publisherName } : {}),
        ...(record.publisherUrl ? { publisherUrl: record.publisherUrl } : {}),
        ...(workerDashboardUrl(record) ? { cloudflareDashboardUrl: workerDashboardUrl(record) } : {}),
        ...(record.databaseId ? { databaseId: record.databaseId } : {}),
      };
    },
  };

  const appOpen: MindooDBAppAgentTool = {
    name: "app_open",
    description:
      "Shows an app's page in the App Builder. Returns the app and the button the user presses there to " +
      "carry on (publish, add to Haven, hand it to the AI again). The tools never press it: building, " +
      "publishing and starting a Cursor agent always need the user's click.",
    inputSchema: {
      type: "object",
      required: ["appId"],
      properties: { appId: { type: "string", description: "From builder_apps_list." } },
    },
    async execute(input) {
      requireIdle();
      const stored = await findApp(requiredAppId(input));
      deps.openApp(stored);
      const app = toAgentApp(stored.record);
      return {
        view: "app",
        app,
        continueButton: {
          label: deps.buttonLabel(`detail.continue.labels.${app.nextAction}`),
          does: NEXT_ACTION_GUIDE[app.nextAction],
        },
      };
    },
  };

  const newAppPrefill: MindooDBAppAgentTool = {
    name: "new_app_prefill",
    description:
      "Opens the New app page and fills it in for the user to review: name, one-line description, the brief " +
      "for the Cursor coding agent (what the app should do, in plain language), and optionally the store " +
      "description and publisher. With mode copy and sourceUrl (a GitHub repository or the URL of a running " +
      "Haven app) it prepares a copy of that app instead. Nothing is created: the user presses the build " +
      "button, which creates a GitHub repository, publishes to Cloudflare and starts a Cursor agent. Returns " +
      "the filled form and blockedBy (why the button is disabled, e.g. an account is not connected).",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["new", "copy"],
          description: "new = from the starter template (default); copy = from an existing app (needs sourceUrl).",
        },
        sourceUrl: {
          type: "string",
          description: "For copy: https://github.com/owner/repo or the app's own URL.",
        },
        name: { type: "string", description: "The app's name, e.g. \"Team Lunch Planner\"." },
        slug: {
          type: "string",
          description: "Repository / app id (lower case, digits, hyphens). Default: derived from the name.",
        },
        description: { type: "string", description: "One line shown in Haven." },
        brief: {
          type: "string",
          description: "What the app should do, for the coding agent: features, data, screens. Plain language.",
        },
        storeDescription: { type: "string", description: "Markdown people read before installing." },
        publisherName: { type: "string" },
        publisherUrl: { type: "string", description: "https URL." },
        private: { type: "boolean", description: "Private GitHub repository. Default true." },
        replace: {
          type: "boolean",
          description: "Overwrite a New app form the user already started typing in. Ask the user first.",
        },
      },
    },
    async execute(input) {
      requireIdle();
      const mode = (optionalString(input, "mode") ?? "new") as "new" | "copy";
      if (mode !== "new" && mode !== "copy") invalid("mode must be new or copy.");
      const sourceUrl = optionalString(input, "sourceUrl", 500);
      if (mode === "copy" && !sourceUrl) invalid("mode copy needs sourceUrl.");
      if (mode === "new" && sourceUrl) invalid("sourceUrl only goes with mode copy.");
      const name = optionalString(input, "name", 100);
      if (mode === "new" && !name) invalid('Missing "name".');
      const publisherUrl = optionalString(input, "publisherUrl", 500);
      if (publisherUrl && !/^https:\/\//i.test(publisherUrl)) invalid("publisherUrl must start with https://.");
      if (deps.view() === "new" && deps.newAppFormTouched() && optionalBoolean(input, "replace") !== true) {
        throw new MindooDBAppAgentToolError(
          "STATE_CHANGED",
          "The user has already started filling in the New app form.",
          "ask the user whether to replace it, then call again with replace: true",
        );
      }
      const prefill: NewAppPrefill = {
        mode,
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(name ? { name } : {}),
        ...(optionalString(input, "slug", 100) ? { slug: optionalString(input, "slug", 100) } : {}),
        ...(optionalString(input, "description", 500) !== undefined
          ? { description: optionalString(input, "description", 500) }
          : {}),
        ...(optionalString(input, "brief", MAX_TEXT) !== undefined
          ? { brief: optionalString(input, "brief", MAX_TEXT) }
          : {}),
        ...(optionalString(input, "storeDescription", MAX_TEXT) !== undefined
          ? { storeDescription: optionalString(input, "storeDescription", MAX_TEXT) }
          : {}),
        ...(optionalString(input, "publisherName", 100) !== undefined
          ? { publisherName: optionalString(input, "publisherName", 100) }
          : {}),
        ...(publisherUrl ? { publisherUrl } : {}),
        ...(optionalBoolean(input, "private") !== undefined ? { private: optionalBoolean(input, "private") } : {}),
      };
      await deps.prefillNewApp(prefill);
      const form = deps.newAppForm();
      return {
        view: "new",
        created: false,
        form,
        readyToBuild: form.blockedBy === null,
        buildButton: {
          label: deps.buttonLabel("newApp.build.idle"),
          does:
            "creates the GitHub repository, publishes it to Cloudflare, adds it to Haven and, when Cursor is " +
            "connected, starts a Cursor agent on the brief",
        },
        userAction: form.blockedBy
          ? `Tell the user what blocks the build: ${form.blockedBy}`
          : "Ask the user to review the form and press the build button. Follow the build with builder_get_context.",
      };
    },
  };

  const agentStatus: MindooDBAppAgentTool = {
    name: "agent_status",
    description:
      "How the Cursor coding agent working on an app is doing: run status (CREATING, RUNNING, FINISHED, " +
      "ERROR, CANCELLED, EXPIRED), its summary once finished, the branches and pull requests it made, and " +
      "the link to watch it in Cursor.",
    inputSchema: {
      type: "object",
      required: ["appId"],
      properties: { appId: { type: "string", description: "From builder_apps_list." } },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input) {
      const stored = await findApp(requiredAppId(input));
      if (!stored.record.cursorAgentId) {
        throw new MindooDBAppAgentToolError(
          "INVALID_STATE",
          `No Cursor agent has worked on "${stored.record.appId}" yet.`,
          "call builder_app_open; the user can start one from the app's page",
        );
      }
      if (!deps.connections().cursor) {
        throw new MindooDBAppAgentToolError(
          "NOT_ALLOWED",
          "Cursor is not connected in the App Builder.",
          "ask the user to add their Cursor API key under Connections and setup",
        );
      }
      const run = await deps.readAgentRun(stored);
      return {
        appId: stored.record.appId,
        codingAgentUrl: stored.record.cursorAgentUrl,
        run: run
          ? {
              ...run,
              finished: ["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(run.status),
            }
          : null,
      };
    },
  };

  const agentFollowUpPrefill: MindooDBAppAgentTool = {
    name: "agent_follow_up_prefill",
    description:
      "Prepares the next instruction for an app's Cursor coding agent: opens the app's page and writes the " +
      "text into the agent's instruction box. It is not sent: the user reviews it and presses Send, which " +
      "starts a new agent run on their Cursor plan. Check builder_agent_status first; while a run is still " +
      "going Cursor refuses a new instruction.",
    inputSchema: {
      type: "object",
      required: ["appId", "instruction"],
      properties: {
        appId: { type: "string", description: "From builder_apps_list." },
        instruction: { type: "string", description: "What the coding agent should change next." },
      },
    },
    async execute(input) {
      requireIdle();
      const stored = await findApp(requiredAppId(input));
      const instruction = optionalString(input, "instruction", MAX_TEXT);
      if (!instruction) invalid('Missing "instruction".');
      if (!stored.record.cursorAgentId) {
        throw new MindooDBAppAgentToolError(
          "INVALID_STATE",
          `No Cursor agent has worked on "${stored.record.appId}" yet.`,
          "call builder_app_open; the user can start one with the button the result names",
        );
      }
      if (!deps.agentPanelAvailable(stored)) {
        throw new MindooDBAppAgentToolError(
          "NOT_ALLOWED",
          "Cursor is not connected in the App Builder.",
          "ask the user to add their Cursor API key under Connections and setup",
        );
      }
      await deps.prefillFollowUp(stored, instruction);
      return {
        appId: stored.record.appId,
        view: "app",
        sent: false,
        sendButton: deps.buttonLabel("agent.actions.send"),
        userAction: "Ask the user to review the instruction and press the send button.",
      };
    },
  };

  const appsForget: MindooDBAppAgentTool = {
    name: "apps_forget",
    description:
      "Removes apps from the builder's list (one undo step, see builder_undo). Only the list entry goes: " +
      "the GitHub repository, the Cloudflare Worker and the Haven installation stay and keep running. Say " +
      "so to the user.",
    inputSchema: {
      type: "object",
      required: ["appIds"],
      properties: {
        appIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FORGET,
          items: { type: "string" },
          description: "From builder_apps_list.",
        },
      },
    },
    annotations: { consequentialHint: true },
    async execute(input) {
      requireIdle();
      const appIds = input.appIds;
      if (
        !Array.isArray(appIds) ||
        !appIds.length ||
        !appIds.every((entry) => typeof entry === "string" && entry.trim())
      ) {
        invalid("appIds must be a non-empty list of app ids.");
      }
      if (appIds.length > MAX_FORGET) invalid(`At most ${MAX_FORGET} apps per call.`);
      if (!deps.canForgetApps()) {
        throw new MindooDBAppAgentToolError(
          "NOT_ALLOWED",
          "The App Builder may not remove entries from its database.",
        );
      }
      const all = await deps.listApps();
      const targets = (appIds as string[]).map((appId) => {
        const match = all.find((entry) => entry.record.appId === appId.trim());
        if (!match) {
          throw new MindooDBAppAgentToolError(
            "NOT_FOUND",
            `There is no app "${appId}" in the builder's list.`,
            "call builder_apps_list for the app ids",
          );
        }
        return match;
      });
      const forgotten: BuilderAppRecord[] = [];
      for (const stored of targets) {
        if (await deps.forgetApp(stored)) forgotten.push({ ...stored.record });
      }
      if (!forgotten.length) {
        throw new MindooDBAppAgentToolError("FAILED", "The entries could not be removed.");
      }
      const step: UndoStep = {
        id: newStepId(),
        label:
          forgotten.length === 1 ? `Forget "${forgotten[0].label || forgotten[0].appId}"` : `Forget ${forgotten.length} apps`,
        records: forgotten,
      };
      undoSteps.push(step);
      if (undoSteps.length > MAX_UNDO_STEPS) undoSteps.shift();
      const failed = targets.map((entry) => entry.record.appId).filter((id) => !forgotten.some((r) => r.appId === id));
      return {
        forgotten: forgotten.map((record) => ({ appId: record.appId, name: record.label })),
        ...(failed.length ? { notRemoved: failed } : {}),
        undoStepId: step.id,
        stillRunning: "The repositories, Workers and Haven installations of these apps were not touched.",
      };
    },
  };

  const undo: MindooDBAppAgentTool = {
    name: "undo",
    description:
      "Puts apps removed with builder_apps_forget back on the list. Pass the undoStepId it returned; " +
      "without one the newest step is undone. Works while the App Builder stays open.",
    inputSchema: { type: "object", properties: { stepId: { type: "string" } } },
    async execute(input) {
      if (!deps.canStoreApps()) {
        throw new MindooDBAppAgentToolError("NOT_ALLOWED", "The App Builder may not write to its database.");
      }
      const stepId = optionalString(input, "stepId");
      const index = stepId ? undoSteps.findIndex((step) => step.id === stepId) : undoSteps.length - 1;
      if (index < 0) {
        throw new MindooDBAppAgentToolError(
          "NOT_FOUND",
          stepId ? `There is no undo step "${stepId}".` : "There is nothing to undo.",
        );
      }
      const step = undoSteps[index];
      const current = await deps.listApps();
      const clash = step.records.find((record) => current.some((entry) => entry.record.appId === record.appId));
      if (clash) {
        throw new MindooDBAppAgentToolError(
          "STATE_CHANGED",
          `The list already has an app "${clash.appId}" again.`,
          "call builder_apps_list",
        );
      }
      for (const record of step.records) {
        await deps.restoreApp(record);
      }
      undoSteps.splice(index, 1);
      return { undone: step.label, restored: step.records.map((record) => record.appId) };
    },
  };

  return [
    getContext,
    appsList,
    appsGet,
    appOpen,
    newAppPrefill,
    agentStatus,
    agentFollowUpPrefill,
    appsForget,
    undo,
  ];
}
