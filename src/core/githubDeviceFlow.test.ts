import { describe, expect, it, vi } from "vitest";

import {
  pollDeviceAuthorization,
  startDeviceAuthorization,
  GitHubDeviceFlowError,
} from "./githubDeviceFlow";

/**
 * GitHub answers the device endpoints with HTTP 200 even when it is refusing, so every
 * test here returns 200 unless it is specifically about a transport failure.
 */
function stubJson(payload: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(payload), { status }),
  ) as unknown as typeof fetch;
}

describe("startDeviceAuthorization", () => {
  it("returns the codes and the polling interval GitHub asked for", async () => {
    const fetchImpl = stubJson({
      device_code: "device-abc",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });

    await expect(startDeviceAuthorization({ clientId: "Iv23.abc", fetchImpl })).resolves.toEqual({
      deviceCode: "device-abc",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });
  });

  it("asks for JSON, because the endpoint answers form-encoded by default", async () => {
    const fetchImpl = stubJson({ device_code: "d", user_code: "U-1" });
    await startDeviceAuthorization({ clientId: "Iv23.abc", fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ Accept: "application/json" });
  });

  it("names the setting to change when the app has the device flow switched off", async () => {
    // The default GitHub App registration does *not* enable the device flow, so this is
    // the first error a new deployment hits and a generic message would waste an hour.
    const fetchImpl = stubJson({ error: "device_flow_disabled" });

    await expect(startDeviceAuthorization({ clientId: "Iv23.abc", fetchImpl })).rejects.toThrow(
      /device flow enabled/i,
    );
  });

  it("refuses to start when no client id is configured", async () => {
    const fetchImpl = stubJson({});
    await expect(startDeviceAuthorization({ clientId: "", fetchImpl })).rejects.toBeInstanceOf(
      GitHubDeviceFlowError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("pollDeviceAuthorization", () => {
  const base = { clientId: "Iv23.abc", deviceCode: "device-abc" };

  it("sends the device code grant type", async () => {
    const fetchImpl = stubJson({ access_token: "ghu_1", scope: "" });
    await pollDeviceAuthorization({ ...base, fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      client_id: "Iv23.abc",
      device_code: "device-abc",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  it("reports the token once the user has typed the code", async () => {
    const fetchImpl = stubJson({ access_token: "ghu_token", scope: "repo" });

    await expect(pollDeviceAuthorization({ ...base, fetchImpl })).resolves.toEqual({
      status: "authorized",
      accessToken: "ghu_token",
      scope: "repo",
    });
  });

  it("treats a user who has not finished yet as pending, not as an error", async () => {
    const fetchImpl = stubJson({ error: "authorization_pending" });

    await expect(pollDeviceAuthorization({ ...base, fetchImpl })).resolves.toEqual({
      status: "pending",
    });
  });

  it("passes on the longer interval when GitHub says slow down", async () => {
    const fetchImpl = stubJson({ error: "slow_down", interval: 12 });

    await expect(pollDeviceAuthorization({ ...base, fetchImpl })).resolves.toEqual({
      status: "slow_down",
      interval: 12,
    });
  });

  it("distinguishes an expired code from a declined one", async () => {
    await expect(
      pollDeviceAuthorization({ ...base, fetchImpl: stubJson({ error: "expired_token" }) }),
    ).resolves.toEqual({ status: "expired" });

    await expect(
      pollDeviceAuthorization({ ...base, fetchImpl: stubJson({ error: "access_denied" }) }),
    ).resolves.toEqual({ status: "declined" });
  });

  it("throws on an error it cannot act on, carrying GitHub's code", async () => {
    const fetchImpl = stubJson({
      error: "incorrect_client_credentials",
      error_description: "The client_id is not valid.",
    });

    await expect(pollDeviceAuthorization({ ...base, fetchImpl })).rejects.toMatchObject({
      code: "incorrect_client_credentials",
      message: "The client_id is not valid.",
    });
  });

  it("reports an unreachable GitHub as a flow error rather than letting fetch escape", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;

    await expect(pollDeviceAuthorization({ ...base, fetchImpl })).rejects.toThrow(
      /could not be reached/i,
    );
  });
});
