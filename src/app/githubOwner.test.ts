import { describe, expect, it, vi } from "vitest";

import { resolveGitHubOwner } from "@/app/githubOwner";

describe("resolveGitHubOwner", () => {
  it("fills in the token's own login when the field was left blank", async () => {
    const lookup = vi.fn().mockResolvedValue({ login: "octocat" });

    await expect(resolveGitHubOwner({ owner: "", token: "ghp_x", lookup })).resolves.toBe(
      "octocat",
    );
    expect(lookup).toHaveBeenCalledWith("ghp_x");
  });

  it("leaves a typed owner alone, because an organization is a deliberate choice", async () => {
    const lookup = vi.fn().mockResolvedValue({ login: "octocat" });

    await expect(resolveGitHubOwner({ owner: "acme-inc", token: "ghp_x", lookup })).resolves.toBe(
      "acme-inc",
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("trims what the user typed, so a stray space is not an owner", async () => {
    const lookup = vi.fn().mockResolvedValue({ login: "octocat" });

    await expect(resolveGitHubOwner({ owner: "  acme-inc  ", token: "ghp_x", lookup })).resolves.toBe(
      "acme-inc",
    );
  });

  it("treats a whitespace-only owner as blank and resolves it", async () => {
    const lookup = vi.fn().mockResolvedValue({ login: "octocat" });

    await expect(resolveGitHubOwner({ owner: "   ", token: "ghp_x", lookup })).resolves.toBe(
      "octocat",
    );
  });

  it("does not ask when there is no token to ask with", async () => {
    const lookup = vi.fn();

    await expect(resolveGitHubOwner({ owner: "", token: "", lookup })).resolves.toBe("");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("stays blank when the lookup fails, rather than failing the save", async () => {
    // A rejected token must not cost the user the rest of what they just typed; the
    // first real GitHub call reports the problem in terms they can act on.
    const lookup = vi.fn().mockRejectedValue(new Error("Bad credentials"));

    await expect(resolveGitHubOwner({ owner: "", token: "ghp_bad", lookup })).resolves.toBe("");
  });
});
