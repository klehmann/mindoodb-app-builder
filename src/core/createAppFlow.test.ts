import { describe, expect, it, vi } from "vitest";

import type { AppIdentity } from "@/core/appIdentity";
import {
  createApp,
  createInitialSteps,
  deployNow,
  type CreateAppDependencies,
  type DeployNowDependencies,
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
      startBuild: vi.fn(async () => ({ detail: "Cloudflare is building main." })),
      checkRepoReadable: vi.fn(async () => ({
        state: "readable" as const,
        detail: "Cloudflare can read the repository.",
      })),
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
    onPhase: overrides.onPhase,
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
      "create-repo",
      "commit-identity",
      "check-repo-access",
      "create-worker",
      "connect-builds",
      "start-build",
      "wait-origin",
      "propose",
      "launch-agent",
    ]);
    expect(steps.every((step) => step.status === "pending")).toBe(true);
  });
});

/**
 * The phase checkpoints are what make a run resumable: whatever the run learned is
 * handed out before the next phase can fail, so an app that died halfway is in the list
 * rather than lost with the page.
 */
describe("onPhase", () => {
  it("reports each phase with everything known so far", async () => {
    const seen: Array<{ repository: string | null; worker: string | null; agent: string | null }> =
      [];
    const deps = makeDeps({
      onPhase: (result) => {
        seen.push({
          repository: result.repository?.fullName ?? null,
          worker: result.worker?.url ?? null,
          agent: result.agent?.id ?? null,
        });
      },
    });

    await createApp({ identity, owner: "octocat" }, deps);

    expect(seen).toEqual([
      // GitHub: the repository exists, nothing else does.
      { repository: "octocat/team-notes", worker: null, agent: null },
      // Cloudflare: the live URL is known, so the app is recoverable from here on.
      {
        repository: "octocat/team-notes",
        worker: "https://team-notes.acme.workers.dev",
        agent: null,
      },
      // Cursor.
      {
        repository: "octocat/team-notes",
        worker: "https://team-notes.acme.workers.dev",
        agent: "bc-1",
      },
    ]);
  });

  it("reports the repository even when the run died right after creating it", async () => {
    // The worst case for losing a record: a real repository exists, and the user has to
    // be able to see it — to carry on, or to delete it.
    const onPhase = vi.fn();
    const deps = makeDeps({
      github: {
        commitFiles: vi.fn(async () => {
          throw new Error("token expired");
        }),
      } as unknown as CreateAppDependencies["github"],
      onPhase,
    });

    const result = await createApp({ identity, owner: "octocat" }, deps);

    expect(result.error).toMatch(/token expired/);
    expect(onPhase).toHaveBeenCalledTimes(1);
    expect(onPhase.mock.calls[0]![0].repository).toMatchObject({
      fullName: "octocat/team-notes",
    });
  });

  it("finishes the run even when writing the record fails", async () => {
    // Bookkeeping must not be able to abandon a repository that exists and a build that
    // is already running.
    const deps = makeDeps({
      onPhase: () => {
        throw new Error("database is read-only");
      },
    });

    const result = await createApp({ identity, owner: "octocat" }, deps);

    expect(result.error).toBeNull();
    expect(statusOf(result.steps, "wait-origin")).toBe("done");
    expect(statusOf(result.steps, "propose")).toBe("done");
  });

  it("is optional — a caller that stores nothing still runs", async () => {
    const result = await createApp({ identity, owner: "octocat" }, makeDeps());

    expect(result.error).toBeNull();
  });
});

describe("createApp", () => {
  it("runs the whole sequence and reports what it built", async () => {
    const deps = makeDeps();

    const result = await createApp({ identity, owner: "octocat" }, deps);

    expect(result.error).toBeNull();
    expect(result.steps.map((step) => step.status)).toEqual([
      "done",
      "done",
      "done",
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

  it("commits the identity on GitHub before Cloudflare starts the first build", async () => {
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
        startBuild: vi.fn(async () => {
          order.push("startBuild");
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
      "commitFiles",
      "ensureWorker",
      "connectPushToDeploy",
      "startBuild",
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

    expect(seen.map(([id]) => id)).toEqual([
      "check-name",
      "create-repo",
      "commit-identity",
      "check-repo-access",
      "create-worker",
      "connect-builds",
      "start-build",
      "wait-origin",
      "propose",
      "launch-agent",
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

    /**
     * The second attempt at an app whose first attempt created the repository and then
     * failed — which is what GitHub's asynchronous template copy produces: the identity
     * commit reads `package.json` seconds before GitHub puts it there.
     *
     * Without adopting that repository the app is stuck forever: creating it again
     * collides with itself, and the name check is the thing that would collide.
     */
    it("adopts the repository an earlier attempt created instead of refusing its name", async () => {
      const getRepository = vi.fn(async () => repository);
      const generateFromTemplate = vi.fn(async () => repository);
      const commitFiles = vi.fn(async () => "sha");
      const deps = makeDeps({
        github: {
          getRepository,
          generateFromTemplate,
          readTemplateSources: vi.fn(async () => templateSources),
          commitFiles,
        },
      });

      const result = await createApp(
        { identity, owner: "octocat", existingRepository: repository },
        deps,
      );

      expect(result.error).toBeNull();
      expect(statusOf(result.steps, "check-name")).toBe("skipped");
      expect(statusOf(result.steps, "create-repo")).toBe("skipped");
      expect(getRepository).not.toHaveBeenCalled();
      expect(generateFromTemplate).not.toHaveBeenCalled();
      // The point of the resume: the identity the first attempt never committed.
      expect(commitFiles).toHaveBeenCalledOnce();
      expect(result.repository).toEqual(repository);
      expect(result.identityCommitted).toBe(true);
      expect(result.worker).toEqual(worker);
    });

    it("reports an unnamed repository as unnamed, so a resume starts at the commit", async () => {
      const deps = makeDeps({
        github: {
          getRepository: vi.fn(async () => null),
          generateFromTemplate: vi.fn(async () => repository),
          // GitHub answering for a repository it has not filled in yet.
          readTemplateSources: vi.fn(async () => {
            throw new Error("GitHub has not finished copying the template.");
          }),
          commitFiles: vi.fn(async () => "sha"),
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(statusOf(result.steps, "commit-identity")).toBe("failed");
      expect(result.repository).toEqual(repository);
      expect(result.identityCommitted).toBe(false);
    });

    it("reports a repository Cloudflare cannot read, and wires the rest anyway", async () => {
      // The failure with no other symptom: `PUT /builds/repos/connections` accepts a
      // repository Cloudflare's GitHub App cannot see, so the push reaches nobody and
      // the only evidence is an origin that never answers.
      //
      // Deliberately not an abort. The repository exists by now, so stopping here would
      // take its name with it and the retry after granting access would fail the name
      // check. Wiring the Worker, the connection and the identity commit means one grant
      // plus one push finishes the app.
      const ensureWorker = vi.fn(async () => worker);
      const connectPushToDeploy = vi.fn(async () => ({ detail: "Pushes to main deploy." }));
      const commitFiles = vi.fn(async () => "commit-sha");
      const waitForOrigin = vi.fn();
      const deps = makeDeps({
        github: {
          getRepository: vi.fn(async () => null),
          generateFromTemplate: vi.fn(async () => repository),
          readTemplateSources: vi.fn(async () => templateSources),
          commitFiles,
        },
        cloudflare: {
          ensureWorker,
          connectPushToDeploy,
          checkRepoReadable: vi.fn(async () => ({
            state: "unreadable" as const,
            detail: "Repository not found",
          })),
        },
        waitForOrigin,
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(statusOf(result.steps, "check-repo-access")).toBe("failed");
      expect(ensureWorker).toHaveBeenCalled();
      expect(connectPushToDeploy).toHaveBeenCalled();
      expect(commitFiles).toHaveBeenCalled();

      // Waiting for a build that was never triggered is the one thing worth skipping,
      // and Haven cannot read a definition from a URL that is not serving yet.
      expect(waitForOrigin).not.toHaveBeenCalled();
      expect(statusOf(result.steps, "start-build")).toBe("skipped");
      expect(statusOf(result.steps, "wait-origin")).toBe("skipped");
      expect(statusOf(result.steps, "propose")).toBe("skipped");

      // The agent is not skipped: it works on the repository, which exists.
      expect(statusOf(result.steps, "launch-agent")).toBe("done");
      expect(result.error).toContain("settings/installations");
      expect(result.error).toContain("Repository not found");
      expect(result.repository?.fullName).toBe("octocat/team-notes");
      expect(result.worker?.url).toBe("https://team-notes.acme.workers.dev");
    });

    it("carries on when the readability check cannot answer", async () => {
      // `unknown` is not a refusal. A token that may not ask, or an endpoint Cloudflare
      // has since moved, must not colour a build that would have worked.
      const deps = makeDeps({
        cloudflare: {
          ensureWorker: vi.fn(async () => worker),
          connectPushToDeploy: vi.fn(async () => ({ detail: "Pushes to main deploy." })),
          checkRepoReadable: vi.fn(async () => ({
            state: "unknown" as const,
            detail: "No route for that URI",
          })),
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(result.error).toBeNull();
      expect(statusOf(result.steps, "check-repo-access")).toBe("done");
      expect(statusOf(result.steps, "wait-origin")).toBe("done");
    });

    it("skips the check when there is no Cloudflare account to ask", async () => {
      const deps = makeDeps({
        cloudflare: {
          ensureWorker: vi.fn(async () => worker),
          connectPushToDeploy: vi.fn(async () => ({ detail: "Pushes to main deploy." })),
          checkRepoReadable: undefined,
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(result.error).toBeNull();
      expect(statusOf(result.steps, "check-repo-access")).toBe("skipped");
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
      expect(statusOf(result.steps, "commit-identity")).toBe("done");
      expect(statusOf(result.steps, "launch-agent")).toBe("done");
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
      expect(commitFiles).toHaveBeenCalled();
      expect(statusOf(result.steps, "commit-identity")).toBe("done");
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
      expect(statusOf(result.steps, "launch-agent")).toBe("done");
    });
  });

  describe("optional steps", () => {
    it("skips the agent when no Cursor key is connected, and still installs", async () => {
      const result = await createApp({ identity, owner: "octocat" }, makeDeps({ cursor: undefined }));

      expect(statusOf(result.steps, "propose")).toBe("done");
      expect(statusOf(result.steps, "launch-agent")).toBe("skipped");
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
      expect(statusOf(result.steps, "propose")).toBe("done");
      expect(statusOf(result.steps, "launch-agent")).toBe("failed");
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

    it("surfaces install warnings that the user can still act on", async () => {
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

    it("drops Haven's implicit-create warning", async () => {
      // The server has never seen the id because nothing has been written yet.
      // The registration already maps it; repeating that here looks like the
      // builder failed to create a database it was never meant to create.
      const deps = makeDeps({
        haven: {
          proposeApp: vi.fn(async () => ({
            ok: true as const,
            appId: "team-notes",
            appInstanceId: "instance-1",
            label: "Team Notes",
            warnings: ['Could not create the database "main": Not found'],
          })),
        },
      });

      const result = await createApp({ identity, owner: "octocat" }, deps);

      expect(result.installedAppInstanceId).toBe("instance-1");
      expect(result.warnings).toEqual([]);
    });
  });
});

describe("deployNow", () => {
  function makeDeployDeps(overrides: Partial<CreateAppDependencies> = {}): DeployNowDependencies {
    const base = makeDeps(overrides);
    return {
      ...base,
      cloudflare: {
        ...base.cloudflare,
        startBuild: vi.fn(async () => ({ detail: "Cloudflare is building main." })),
        ...(overrides.cloudflare ?? {}),
      },
    } as DeployNowDependencies;
  }

  const input = { repository, worker, appId: "team-notes" };

  it("builds without a push and finishes the setup", async () => {
    // The whole point: after access is granted there is no commit left to make, so the
    // build is started directly and the original sequence resumes from the origin wait.
    const startBuild = vi.fn(async () => ({ detail: "Cloudflare is building main." }));
    const proposeApp = vi.fn(async () => ({
      ok: true as const,
      appId: "team-notes",
      appInstanceId: "instance-1",
      label: "Team Notes",
      warnings: [],
    }));
    const deps = makeDeployDeps({ haven: { proposeApp } });
    deps.cloudflare.startBuild = startBuild;

    const result = await deployNow(input, deps);

    expect(startBuild).toHaveBeenCalledWith({ worker, branch: "main" });
    expect(result.error).toBeNull();
    expect(result.steps.map((step) => step.id)).toEqual([
      "check-repo-access",
      "start-build",
      "wait-origin",
      "propose",
    ]);
    expect(result.steps.every((step) => step.status === "done")).toBe(true);
    expect(result.installedAppInstanceId).toBe("instance-1");

    // The links stay in the outcome, and the agent the first run started is not lost.
    expect(result.repository).toBe(repository);
    expect(result.worker).toBe(worker);
  });

  it("carries the agent from the first run into the result", async () => {
    const agent = { id: "bc-1", url: "https://cursor.com/agents/bc-1", runId: "run-1" };

    const result = await deployNow({ ...input, agent }, makeDeployDeps());

    expect(result.agent).toBe(agent);
  });

  it("refuses to build when Cloudflare still cannot read the repository", async () => {
    // Fatal here, unlike during creation: nothing has been created, so stopping costs
    // nothing, and a build Cloudflare cannot clone would replace a clear answer with a
    // failed build log.
    const startBuild = vi.fn(async () => ({ detail: "" }));
    const deps = makeDeployDeps({
      cloudflare: {
        ensureWorker: vi.fn(async () => worker),
        connectPushToDeploy: vi.fn(async () => ({ detail: "" })),
        checkRepoReadable: vi.fn(async () => ({
          state: "unreadable" as const,
          detail: "Repository not found",
        })),
      },
    });
    deps.cloudflare.startBuild = startBuild;

    const result = await deployNow(input, deps);

    expect(startBuild).not.toHaveBeenCalled();
    expect(statusOf(result.steps, "check-repo-access")).toBe("failed");
    expect(statusOf(result.steps, "start-build")).toBe("skipped");
    expect(result.error).toContain("settings/installations");
  });

  it("stops with Cloudflare's reason when the build cannot be started", async () => {
    const deps = makeDeployDeps();
    deps.cloudflare.startBuild = vi.fn(async () => {
      throw new Error("This Worker has no build trigger for main.");
    });

    const result = await deployNow(input, deps);

    expect(statusOf(result.steps, "start-build")).toBe("failed");
    expect(statusOf(result.steps, "wait-origin")).toBe("skipped");
    expect(result.error).toBe("This Worker has no build trigger for main.");
  });

  it("does not offer Haven an origin that never came up", async () => {
    const deps = makeDeployDeps({
      waitForOrigin: vi.fn(async () => ({
        state: "not-published" as const,
        definition: null,
        detail: "The app did not answer.",
      })),
    });

    const result = await deployNow(input, deps);

    expect(statusOf(result.steps, "wait-origin")).toBe("failed");
    expect(statusOf(result.steps, "propose")).toBe("skipped");
  });
});
