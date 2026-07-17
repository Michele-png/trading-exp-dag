import { describe, expect, it } from "vitest";

import {
  digestApiToken,
  parseApiToken,
  TokenAuthenticationError,
  verifyTokenRecord,
  type ApiTokenRecord,
} from "@/lib/server/admin";

const workspaceId = "5ee16b48-1602-4f0c-af7b-74e040a07d9d";
const secret = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN1234";
const token = `qdag_${workspaceId}_${secret}`;
const pepper = "a-test-pepper-that-is-at-least-thirty-two-bytes";

function record(
  overrides: Partial<ApiTokenRecord> = {},
): ApiTokenRecord {
  return {
    id: "7857b76e-bc0c-4d9d-8a2f-a13791cdf72b",
    workspaceId,
    userId: "f4630ba6-ffed-411c-b605-974eedc7b765",
    tokenDigest: digestApiToken(token, pepper),
    tokenPrefix: `qdag_${workspaceId}_${secret.slice(0, 10)}`,
    scopes: ["nodes:read"],
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("personal-token verification", () => {
  it("parses the embedded workspace and verifies the keyed digest", () => {
    expect(parseApiToken(token)).toEqual({
      workspaceId,
      prefix: `qdag_${workspaceId}_${secret.slice(0, 10)}`,
    });
    expect(verifyTokenRecord(token, record(), pepper)).toMatchObject({
      workspaceId,
      scopes: ["nodes:read"],
    });
  });

  it("rejects a different token using constant-time digest comparison", () => {
    const changed = `${token}changed`;
    expect(() => verifyTokenRecord(changed, record(), pepper)).toThrow(
      TokenAuthenticationError,
    );
  });

  it("enforces revocation before accepting a valid digest", () => {
    expect(() =>
      verifyTokenRecord(
        token,
        record({ revokedAt: "2026-07-10T18:00:00.000Z" }),
        pepper,
      ),
    ).toThrowError(expect.objectContaining({ code: "revoked_token" }));
  });

  it("enforces token expiry", () => {
    expect(() =>
      verifyTokenRecord(
        token,
        record({ expiresAt: "2026-07-10T18:00:00.000Z" }),
        pepper,
        new Date("2026-07-10T19:00:00.000Z"),
      ),
    ).toThrowError(expect.objectContaining({ code: "expired_token" }));
  });
});
