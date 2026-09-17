import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commitFiles,
  findAppInstallation,
  generateRepositoryFromTemplate,
  getAuthenticatedUser,
  getFileText,
  getRepository,
  GitHubError,
  repositoryHasContent,
  waitForRepositoryContent,
} from "@/core/github";

const rawRepo = {
  id: 987,
  name: "team-notes",
  full_name: "octocat/team-notes",
  owner: { id: 4242, login: "octocat" },
  html_url: "https://github.com/octocat/team-notes",
  default_branch: "main",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: unknown, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAuthenticatedUser", () => {
  it("returns the login and the numeric id the Cloudflare connection needs", async () => {
    const spy = mockFetch(() => json({ id: 42, login: "octocat", extra: "ignored" }));

    await expect(getAuthenticatedUser("tok")).resolves.toEqual({ id: 42, login: "octocat" });
    expect(spy).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });
});

describe("getRepository", () => {
  it("maps the repository onto the fields the builder uses", async () => {
    mockFetch(() => json(rawRepo));

    await expect(getRepository("tok", "octocat", "team-notes")).resolves.toEqual({
      id: 987,
      name: "team-notes",
      fullName: "octocat/team-notes",
      owner: "octocat",
      // Kept because Cloudflare's repository connection asks for the owner's numeric
      // id, and for an organization that is not the token user's id.
      ownerId: 4242,
      htmlUrl: "https://github.com/octocat/team-notes",
      defaultBranch: "main",
    });
  });

  it("returns null for a missing repository, so a name check is just a lookup", async () => {
    mockFetch(() => json({ message: "Not Found" }, 404));

    await expect(getRepository("tok", "octocat", "free-name")).resolves.toBeNull();
  });

  it("still reports other failures", async () => {
    mockFetch(() => json({ message: "Bad credentials" }, 401));

    await expect(getRepository("tok", "octocat", "team-notes")).rejects.toThrow(
      /Bad credentials/,
    );
  });
});

describe("generateRepositoryFromTemplate", () => {
  it("posts to the starter template's generate endpoint", async () => {
    const spy = mockFetch(() => json(rawRepo, 201));

    const repo = await generateRepositoryFromTemplate({
      token: "tok",
      name: "team-notes",
      description: "Shared notes.",
    });

    expect(repo.htmlUrl).toBe("https://github.com/octocat/team-notes");
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/klehmann/mindoodb-app-starter/generate");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      name: "team-notes",
      description: "Shared notes.",
      private: false,
    });
  });

  it("only sends an owner when one was chosen, so the token's user is the default", async () => {
    const spy = mockFetch(() => json(rawRepo, 201));

    await generateRepositoryFromTemplate({ token: "tok", name: "team-notes", owner: "acme-org" });

    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.owner).toBe("acme-org");
  });

  it("surfaces GitHub's per-field errors, not just the generic message", async () => {
    mockFetch(() =>
      json(
        {
          message: "Repository creation failed.",
          errors: [{ message: "name already exists on this account" }],
        },
        422,
      ),
    );

    await expect(
      generateRepositoryFromTemplate({ token: "tok", name: "team-notes" }),
    ).rejects.toThrow(/name already exists on this account/);
  });

  it("explains GitHub's opaque 403, installation first", async () => {
    mockFetch(() => json({ message: "Resource not accessible by integration" }, 403));

    const error = await generateRepositoryFromTemplate({ token: "tok", name: "x" }).catch(
      (caught: unknown) => caught,
    );
    expect((error as GitHubError).status).toBe(403);
    // Both causes, in the order they occur: an app that was authorized but never
    // installed holds a token with no repository permissions at all, so naming the
    // permission alone would send the user to the wrong settings page.
    expect((error as GitHubError).message).toMatch(/not installed on the account/);
    expect((error as GitHubError).message).toMatch(/Administration: Read and write/);
  });

  it("reports the HTTP status on the error for callers that branch on it", async () => {
    mockFetch(() => json({ message: "Bad credentials" }, 401));

    const error = await generateRepositoryFromTemplate({ token: "tok", name: "x" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(401);
  });
});

describe("findAppInstallation", () => {
  it("finds this app's installation", async () => {
    // The response carries only this app's installations, whatever else the account has
    // installed: GitHub scopes `GET /user/installations` to the app the token belongs
    // to. Anything built on the assumption that another vendor's app would appear here
    // reads its absence as "not installed" and is wrong for every user.
    mockFetch(() =>
      json({
        installations: [
          { id: 42, app_slug: "mindoodb-app-builder", repository_selection: "selected" },
        ],
      }),
    );

    await expect(
      findAppInstallation({ token: "tok", appSlug: "mindoodb-app-builder" }),
    ).resolves.toEqual({ id: 42, repositorySelection: "selected" });
  });

  it("returns null when the app was authorized but never installed", async () => {
    mockFetch(() => json({ installations: [] }));

    await expect(
      findAppInstallation({ token: "tok", appSlug: "mindoodb-app-builder" }),
    ).resolves.toBeNull();
  });

  it("returns null for a token that has no installations to list", async () => {
    // A pasted personal access token: the lookup is refused, and that is not a problem
    // to report — it has no installation and needs none.
    mockFetch(() => json({ message: "Bad credentials" }, 403));

    await expect(
      findAppInstallation({ token: "pat", appSlug: "mindoodb-app-builder" }),
    ).resolves.toBeNull();
  });
});

describe("getFileText", () => {
  it("asks for the raw media type and returns the text", async () => {
    const spy = mockFetch(() => new Response('{"name":"mindoodb-app-starter"}'));

    await expect(
      getFileText({ token: "tok", owner: "octocat", repo: "team-notes", path: "package.json" }),
    ).resolves.toBe('{"name":"mindoodb-app-starter"}');

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/octocat/team-notes/contents/package.json");
    expect((init as RequestInit).headers).toMatchObject({
      Accept: "application/vnd.github.raw+json",
    });
  });

  it("keeps nested paths as path segments rather than escaping the slash", async () => {
    const spy = mockFetch(() => new Response("{}"));

    await getFileText({
      token: "tok",
      owner: "octocat",
      repo: "team-notes",
      path: "public/haven-app.json",
    });

    expect(spy.mock.calls[0]![0]).toBe(
      "https://api.github.com/repos/octocat/team-notes/contents/public/haven-app.json",
    );
  });

  it("returns null for a file the template does not have", async () => {
    mockFetch(() => new Response("", { status: 404 }));

    await expect(
      getFileText({ token: "tok", owner: "octocat", repo: "team-notes", path: "nope.txt" }),
    ).resolves.toBeNull();
  });
});

describe("repositoryHasContent", () => {
  it("reads the root listing of the default branch", async () => {
    const spy = mockFetch(() => json([{ name: "package.json" }]));

    await expect(
      repositoryHasContent({ token: "tok", owner: "octocat", repo: "team-notes", ref: "main" }),
    ).resolves.toBe(true);

    expect(spy.mock.calls[0]![0]).toBe(
      "https://api.github.com/repos/octocat/team-notes/contents?ref=main",
    );
  });

  it("reports a repository GitHub has not filled in yet", async () => {
    // GitHub's actual answer to a repository without a commit, verbatim.
    mockFetch(() => json({ message: "This repository is empty.", status: "404" }, 404));

    await expect(
      repositoryHasContent({ token: "tok", owner: "octocat", repo: "team-notes" }),
    ).resolves.toBe(false);
  });

  it("throws on anything that is not an answer to the question", async () => {
    mockFetch(() => json({ message: "Bad credentials" }, 401));

    await expect(
      repositoryHasContent({ token: "tok", owner: "octocat", repo: "team-notes" }),
    ).rejects.toThrow(/Bad credentials/);
  });
});

/**
 * The bug these pin: `generate` answers 201 before the template is copied, the flow read
 * `package.json` 200ms later, got a 404, and told the user the template was broken.
 */
describe("waitForRepositoryContent", () => {
  it("returns as soon as the content appears", async () => {
    const check = vi
      .fn<typeof repositoryHasContent>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const waited: number[] = [];

    await expect(
      waitForRepositoryContent({
        token: "tok",
        owner: "octocat",
        repo: "team-notes",
        ref: "main",
        intervalMs: 1_000,
        timeoutMs: 30_000,
        wait: async (ms) => void waited.push(ms),
        check,
      }),
    ).resolves.toBe(true);

    expect(check).toHaveBeenCalledTimes(3);
    expect(waited).toEqual([1_000, 1_000]);
    expect(check.mock.calls[0]![0]).toMatchObject({ repo: "team-notes", ref: "main" });
  });

  it("gives up after the budget, without waiting past it", async () => {
    const check = vi.fn<typeof repositoryHasContent>().mockResolvedValue(false);
    const waited: number[] = [];

    await expect(
      waitForRepositoryContent({
        token: "tok",
        owner: "octocat",
        repo: "team-notes",
        intervalMs: 1_000,
        timeoutMs: 3_000,
        wait: async (ms) => void waited.push(ms),
        check,
      }),
    ).resolves.toBe(false);

    // Three seconds of budget: a look, three one-second waits, and a last look after
    // the budget is spent rather than a wait that overruns it.
    expect(waited).toEqual([1_000, 1_000, 1_000]);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("still looks once when told not to wait at all", async () => {
    const check = vi.fn<typeof repositoryHasContent>().mockResolvedValue(true);

    await expect(
      waitForRepositoryContent({
        token: "tok",
        owner: "octocat",
        repo: "team-notes",
        timeoutMs: 0,
        check,
      }),
    ).resolves.toBe(true);

    expect(check).toHaveBeenCalledTimes(1);
  });

  it("lets a real failure through instead of retrying it for half a minute", async () => {
    const check = vi
      .fn<typeof repositoryHasContent>()
      .mockRejectedValue(new GitHubError("Bad credentials", 401));

    await expect(
      waitForRepositoryContent({ token: "tok", owner: "octocat", repo: "team-notes", check }),
    ).rejects.toThrow(/Bad credentials/);
  });
});

describe("commitFiles", () => {
  it("writes every file in one commit and moves the branch", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    mockFetch((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      if (url.endsWith("/git/ref/heads/main")) {
        return json({ object: { sha: "head-sha" } });
      }
      if (url.endsWith("/git/commits/head-sha")) {
        return json({ tree: { sha: "base-tree" } });
      }
      if (url.endsWith("/git/trees")) {
        return json({ sha: "new-tree" }, 201);
      }
      if (url.endsWith("/git/commits")) {
        return json({ sha: "new-commit" }, 201);
      }
      if (url.endsWith("/git/refs/heads/main")) {
        return json({ object: { sha: "new-commit" } });
      }
      throw new Error(`unexpected call ${method} ${url}`);
    });

    const sha = await commitFiles({
      token: "tok",
      owner: "octocat",
      repo: "team-notes",
      branch: "main",
      message: "chore: name this app",
      files: [
        { path: "package.json", content: "{}" },
        { path: "TASK.md", content: "# Team Notes" },
      ],
    });

    expect(sha).toBe("new-commit");

    const tree = calls.find((call) => call.url.endsWith("/git/trees"))!;
    expect(tree.body).toEqual({
      base_tree: "base-tree",
      tree: [
        { path: "package.json", mode: "100644", type: "blob", content: "{}" },
        { path: "TASK.md", mode: "100644", type: "blob", content: "# Team Notes" },
      ],
    });

    const commit = calls.find(
      (call) => call.url.endsWith("/git/commits") && call.method === "POST",
    )!;
    expect(commit.body).toEqual({
      message: "chore: name this app",
      tree: "new-tree",
      parents: ["head-sha"],
    });

    const update = calls.find((call) => call.method === "PATCH")!;
    expect(update.body).toEqual({ sha: "new-commit" });
  });

  it("refuses an empty commit", async () => {
    const spy = mockFetch(() => json({}));

    await expect(
      commitFiles({
        token: "tok",
        owner: "octocat",
        repo: "team-notes",
        branch: "main",
        message: "noop",
        files: [],
      }),
    ).rejects.toThrow(/at least one file/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("says which branch was missing", async () => {
    mockFetch(() => json({ message: "Not Found" }, 404));

    await expect(
      commitFiles({
        token: "tok",
        owner: "octocat",
        repo: "team-notes",
        branch: "trunk",
        message: "x",
        files: [{ path: "a.txt", content: "a" }],
      }),
    ).rejects.toThrow(/Not Found/);
  });
});
