import { describe, expect, it, vi } from "vitest";

import type { AppIdentity } from "@/core/appIdentity";
import {
  createApp,
  createInitialSteps,
  type CreateAppDependencies,
  type FlowStep,
  type FlowStepId,
} from "@/core/createAppFlow";
import type { GitHubRepository } from "@/core/github";

const identity: AppIdentity = {
  label: "Team Notes",
  slug: "team-notes",
  description: "Shared notes.",
  task: "Notes with search.",
};

const repository: GitHubRepository = {
  id: 987,
  name: "team-notes",
  fullName: "octocat/team-notes",
  owner: "octocat",
  ownerId: 4242,
  htmlUrl: "https://github.com/octocat/team-notes",
  defaultBranch: "main",
};

const templateSources = {
  packageJson: '{\n  "name": "mindoodb-app-starter"\n}\n',
  wranglerConfig: '{\n  "name": "mindoodb-app-starter"\n}\n',
  appDefinition:
    '{\n  "format": "mindoodb.haven.app",\n  "formatVersion": 1,\n  "appId": "mindoodb-app-starter",\n  "label": "Starter"\n}\n',
};

const worker = {
  url: "https://team-notes.acme.workers.dev",
  scriptTag: "tag-1",
  reused: false,
};

function makeDeps(overrides: Partial<CreateAppDependencies> = {}): CreateAppDependencies {
  return {
    github: {
      getRepository: vi.fn(async () => null),
      generateFromTemplate: vi.fn(async () => repository),
      readTemplateSources: vi.fn(async () => templateSources),
      commitFiles: vi.fn(async () => "commit-sha"),
      ...overrides.github,
    },
    cloudflare: {
      ensureWorker: vi.fn(async () => worker),
      connectPushToDeploy: vi.fn(async () => ({ detail: "Pushes to main deploy." })),
      ...overrides.cloudflare,
    },
    waitForOrigin:
      overrides.waitForOrigin
      ?? vi.fn(async () => ({
        state: "ready" as const,
        definition: null,
        detail: "",
      })),
    // Presence, not value: `{ cursor: undefined }` is how a test says "no Cursor key
    // connected", which is different from not overriding it at all.
    cursor: "cursor" in overrides
      ? overrides.cursor
      : {
          launchAgent: vi.fn(async () => ({
            id: "bc-1",
            url: "https://cursor.com/agents/bc-1",
            runId: "run-1",
          })),
        },
    haven: "haven" in overrides
      ? overrides.haven
      : {
          proposeApp: vi.fn(async () => ({
            ok: true as const,
            appId: "team-notes",
            appInstanceId: "instance-1",
            label: "Team Notes",
            warnings: [],
          })),
        },
    onStep: overrides.onStep,
  };
}

function statusOf(steps: FlowStep[], id: FlowStepId): string {
  return steps.find((step) => step.id === id)!.status;
}

describe("createInitialSteps", () => {
  it("starts with every step pending, in order", () => {
    const steps = createInitialSteps();
    expect(steps.map((step) => step.id)).toEqual([
      "check-name",
      "check-deploy-access",
      "create-repo",
      "create-worker",
      "connect-builds",
      "commit-identity",
      "wait-origin",
      "launch-agent",
      "propose",
    ]);
    expect(steps.every((step) => step.status === "pending")).toBe(true);
  });
});

describe("createApp", () => {
  it("runs the whole sequence and reports what it built", async () => {
    const deps = makeDeps();

    const result = await createApp({ identity, owner: "octocat" }, deps);

    expect(result.error).toBeNull();
    expect(result.steps.map((step) => step.status)).toEqual([
      "done",
      // The default deps wire no Cloudflare access check, and an unmade check is
      // skipped rather than failed.
      "skipped",
      "done",
      "done",
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(result.repository?.fullName).toBe("octocat/team-notes");
    expect(result.worker?.url).toBe("https://team-notes.acme.workers.dev");
    expect(result.agent?.url).toBe("https://cursor.com/agents/bc-1");
    expect(result.installedAppInstanceId).toBe("instance-1");
    expect(result.warnings).toEqual([]);
  });

  it("wires push-to-deploy before the first commit, so that commit is the first deploy", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      cloudflare: {
        ensureWorker: vi.fn(async () => {
          order.push("ensureWorker");
          return worker;
        }),
        connectPushToDeploy: vi.fn(async () => {
          order.push("connectPushToDeploy");
          return { detail: "ok" };
        }),
      },
      github: {
        getRepository: vi.fn(async () => null),
        generateFromTemplate: vi.fn(async () => {
          order.push("generateFromTemplate");
          return repository;
        }),
        readTemplateSources: vi.fn(async () => templateSources),
        commitFiles: vi.fn(async () => {
          order.push("commitFiles");
          return "sha";
        }),
      },
    });

    await createApp({ identity, owner: "octocat" }, deps);

    expect(order).toEqual([
      "generateFromTemplate",
      "ensureWorker",
      "connectPushToDeploy",
      "commitFiles",
    ]);
  });

  it("commits the identity files built from the template's own sources", async () => {
    const commitFiles = vi.fn(async () => "sha");
    const deps = makeDeps({
      github: {
        getRepository: vi.fn(async () => null),
        generateFromTemplate: vi.fn(async () => repository),
        readTemplateSources: vi.fn(async () => templateSources),
        commitFiles,
      },
    });

    await createApp({ identity, owner: "octocat" }, deps);

    const call = (
      commitFiles.mock.calls as unknown as Array<
        [{ message: string; files: Array<{ path: string; content: string }> }]
      >
    )[0]![0];
    expect(call.message).toContain("Team Notes");
    expect(call.files.map((file) => file.path)).toEqual([
      "package.json",
      "wrangler.jsonc",
      "public/haven-app.json",
      "TASK.md",
    ]);
    expect(call.files.find((file) => file.path === "TASK.md")!.content).toContain(
      "Notes with search.",
    );
    expect(call.files.find((file) => file.path === "public/haven-app.json")!.content).toContain(
      '"appId": "team-notes"',
    );
  });

  it("waits for the expected app on the Worker URL", async () => {
    const waitForOrigin = vi.fn(async () => ({
      state: "ready" as const,
      definition: null,
      detail: "",
    }));

    await createApp({ identity, owner: "octocat" }, makeDeps({ waitForOrigin }));

    expect(waitForOrigin).toHaveBeenCalledWith({
      url: "https://team-notes.acme.workers.dev",
      expectedAppId: "team-notes",
    });
  });

  it("reports progress after every transition", async () => {
    const seen: Array<[FlowStepId, string]> = [];
    const deps = makeDeps({
      onStep: (steps) => {
        const active = steps.find((step) => step.status === "running");
        if (active) {
          seen.push([active.id, active.status]);
        }
      },
    });

    await createApp({ identity, owner: "octocat" }, deps);

    // `check-deploy-access` is absent because these deps wire no checker: a skipped
    // step never becomes the running one.
    expect(seen.map(([id]) => id)).toEqual([
      "check-name",
      "create-repo",
      "create-worker",
      "connect-builds",
      "commit-identity",
      "wait-origin",
      "launch-agent",
      "propose",
    ]);
  });

  describe("stopping early", () => {
    it("refuses a name that is taken, before creating anything", async () => {
      const ensureWorker = vi.fn();
      const generateFromTemplate = vi.fn();
      const deps = makeDeps({
        github: {
          getRepository: vi.fn(async () => repository),
          generateFromTemplate,
          readTemplateSources: vi.fn(async () => templateSources),
          commitFiles: vi.fn(async () => "sha"),
        },
        cloudflare: {
          ensureWorker,
          connectPushToDeploy: vi.fn(async () => ({ detail: "" })),
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(result.error).toContain("already exists");
      expect(statusOf(result.steps, "check-name")).toBe("failed");
      expect(statusOf(result.steps, "create-repo")).toBe("skipped");
      expect(generateFromTemplate).not.toHaveBeenCalled();
      expect(ensureWorker).not.toHaveBeenCalled();
    });

    it("refuses when Cloudflare's app cannot read repositories yet to exist", async () => {
      // The bug this pins: Cloudflare's `PUT /builds/repos/connections` succeeds for a
      // repository its GitHub App cannot see, so push-to-deploy reported success, no
      // build ever ran, and the only symptom was `wait-origin` timing out five steps
      // later — with the repository created and its name taken.
      const generateFromTemplate = vi.fn();
      const ensureWorker = vi.fn();
      const deps = makeDeps({
        github: {
          getRepository: vi.fn(async () => null),
          generateFromTemplate,
          checkCloudflareRepoAccess: vi.fn(async () => ({
            state: "selected" as const,
            settingsUrl: "https://github.com/settings/installations/106039904",
          })),
          readTemplateSources: vi.fn(async () => templateSources),
          commitFiles: vi.fn(async () => "sha"),
        },
        cloudflare: {
          ensureWorker,
          connectPushToDeploy: vi.fn(async () => ({ detail: "" })),
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(statusOf(result.steps, "check-deploy-access")).toBe("failed");
      expect(result.error).toContain("installations/106039904");
      expect(generateFromTemplate).not.toHaveBeenCalled();
      expect(ensureWorker).not.toHaveBeenCalled();
    });

    it("continues when the access check itself cannot answer", async () => {
      // A token that may not list installations says nothing about whether the build
      // would work, so it must not stop one.
      const deps = makeDeps({
        github: {
          getRepository: vi.fn(async () => null),
          generateFromTemplate: vi.fn(async () => repository),
          checkCloudflareRepoAccess: vi.fn(async () => {
            throw new Error("Bad credentials");
          }),
          readTemplateSources: vi.fn(async () => templateSources),
          commitFiles: vi.fn(async () => "sha"),
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(result.error).toBeNull();
      expect(statusOf(result.steps, "check-deploy-access")).toBe("done");
    });

    it("keeps the repository it already created when the Worker fails", async () => {
      const deps = makeDeps({
        cloudflare: {
          ensureWorker: vi.fn(async () => {
            throw new Error("Invalid Cloudflare API token");
          }),
          connectPushToDeploy: vi.fn(async () => ({ detail: "" })),
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(result.error).toBe("Invalid Cloudflare API token");
      expect(result.repository?.fullName).toBe("octocat/team-notes");
      expect(statusOf(result.steps, "create-worker")).toBe("failed");
      expect(statusOf(result.steps, "commit-identity")).toBe("skipped");
    });

    it("stops when push-to-deploy cannot be configured, because nothing would deploy", async () => {
      const commitFiles = vi.fn(async () => "sha");
      const deps = makeDeps({
        cloudflare: {
          ensureWorker: vi.fn(async () => worker),
          connectPushToDeploy: vi.fn(async () => {
            throw new Error("The Cloudflare GitHub App is not installed.");
          }),
        },
        github: {
          getRepository: vi.fn(async () => null),
          generateFromTemplate: vi.fn(async () => repository),
          readTemplateSources: vi.fn(async () => templateSources),
          commitFiles,
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(result.error).toContain("GitHub App");
      expect(commitFiles).not.toHaveBeenCalled();
    });

    it("reports the probe's own reason when the app never comes live", async () => {
      const deps = makeDeps({
        waitForOrigin: vi.fn(async () => ({
          state: "not-published" as const,
          definition: null,
          detail: "haven-app.json answered HTTP 404.",
        })),
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      // The probe's own wording comes first, then where to look: a quiet origin means
      // the build did not publish, and only Cloudflare's build log says why.
      expect(result.error).toContain("haven-app.json answered HTTP 404.");
      expect(result.error).toContain("Settings, Builds");
      expect(statusOf(result.steps, "wait-origin")).toBe("failed");
      expect(statusOf(result.steps, "propose")).toBe("skipped");
    });
  });

  describe("optional steps", () => {
    it("skips the agent when no Cursor key is connected, and still installs", async () => {
      const result = await createApp({ identity, owner: "octocat" }, makeDeps({ cursor: undefined }));

      expect(statusOf(result.steps, "launch-agent")).toBe("skipped");
      expect(statusOf(result.steps, "propose")).toBe("done");
      expect(result.error).toBeNull();
    });

    it("treats a failed agent launch as a warning, not a failed build", async () => {
      const deps = makeDeps({
        cursor: {
          launchAgent: vi.fn(async () => {
            throw new Error("Cursor rate limit reached");
          }),
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(result.error).toBeNull();
      expect(statusOf(result.steps, "launch-agent")).toBe("failed");
      expect(statusOf(result.steps, "propose")).toBe("done");
      expect(result.warnings).toContain("Cursor rate limit reached");
    });

    it("tells the user the URL to paste when app proposal was not granted", async () => {
      const result = await createApp({ identity, owner: "octocat" }, makeDeps({ haven: undefined }));

      expect(statusOf(result.steps, "propose")).toBe("skipped");
      expect(result.error).toBeNull();
      expect(result.warnings).toContain(
        "Add the app manually in Haven using https://team-notes.acme.workers.dev",
      );
    });

    it("keeps the deployed app when the user declines the install", async () => {
      const deps = makeDeps({
        haven: {
          proposeApp: vi.fn(async () => ({ ok: false as const, reason: "declined" as const })),
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(result.error).toBeNull();
      expect(statusOf(result.steps, "propose")).toBe("skipped");
      expect(result.installedAppInstanceId).toBeNull();
      expect(result.warnings.join(" ")).toContain("team-notes.acme.workers.dev");
    });

    it("surfaces install warnings, such as a database that could not be created", async () => {
      const deps = makeDeps({
        haven: {
          proposeApp: vi.fn(async () => ({
            ok: true as const,
            appId: "team-notes",
            appInstanceId: "instance-1",
            label: "Team Notes",
            warnings: ["The database main could not be created."],
          })),
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(result.installedAppInstanceId).toBe("instance-1");
      expect(result.warnings).toContain("The database main could not be created.");
    });
  });
});
