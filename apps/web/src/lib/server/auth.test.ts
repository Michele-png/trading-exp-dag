import { describe, expect, it } from "vitest";

import {
  assertPrincipalBoundary,
  AuthenticationError,
  classifyAuthorizationHeader,
} from "@/lib/server/auth";

const workspaceId = "5ee16b48-1602-4f0c-af7b-74e040a07d9d";
const otherWorkspaceId = "a16946c3-32f0-4e2a-9d94-801e3144b16f";

describe("auth principal boundaries", () => {
  it("distinguishes personal tokens, user JWTs, and cookie sessions", () => {
    expect(classifyAuthorizationHeader(null)).toEqual({ type: "cookie" });
    expect(
      classifyAuthorizationHeader("Bearer qdag_workspace_secret"),
    ).toEqual({
      type: "personal_token",
      value: "qdag_workspace_secret",
    });
    expect(classifyAuthorizationHeader("Bearer ey.jwt.value")).toEqual({
      type: "user_jwt",
      value: "ey.jwt.value",
    });
  });

  it("rejects malformed authorization schemes", () => {
    expect(() => classifyAuthorizationHeader("Basic abc")).toThrow(
      AuthenticationError,
    );
  });

  it("prevents cross-workspace access", () => {
    expect(() =>
      assertPrincipalBoundary({ workspaceId }, otherWorkspaceId),
    ).toThrow(/outside the authenticated workspace/);
  });

  it("allows the authenticated workspace", () => {
    expect(() =>
      assertPrincipalBoundary({ workspaceId }, workspaceId),
    ).not.toThrow();
  });
});
