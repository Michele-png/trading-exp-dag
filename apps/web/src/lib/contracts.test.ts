import { describe, expect, it } from "vitest";

import {
  artifactPrepareSchema,
  createNodeSchema,
  failRunSchema,
  revisionContentSchema,
  sha256Schema,
} from "@/lib/contracts";

const workspaceId = "5ee16b48-1602-4f0c-af7b-74e040a07d9d";
const spaceId = "a16946c3-32f0-4e2a-9d94-801e3144b16f";
const nodeId = "7857b76e-bc0c-4d9d-8a2f-a13791cdf72b";

describe("API contracts", () => {
  it("accepts a complete draft node", () => {
    const parsed = createNodeSchema.parse({
      workspaceId,
      spaceId,
      kind: "experiment",
      revision: {
        title: "Test volatility hypothesis",
        hypothesis: "A lower threshold improves recall.",
        method: "Run a fixed-seed benchmark.",
        successCriteria: "Recall increases by at least 2%.",
        preregistrationState: "preregistered",
      },
      lineageParentIds: [nodeId],
    });

    expect(parsed.revision.preregistrationState).toBe("preregistered");
  });

  it("rejects objective creation through the node endpoint", () => {
    const result = createNodeSchema.safeParse({
      workspaceId,
      spaceId,
      kind: "objective",
      revision: { title: "Objective" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsafe artifact names and oversized uploads", () => {
    const result = artifactPrepareSchema.safeParse({
      workspaceId,
      nodeId,
      fileName: "../secrets.txt",
      mimeType: "text/plain",
      sizeBytes: 11 * 1024 * 1024,
      sha256: "a".repeat(64),
    });

    expect(result.success).toBe(false);
  });

  it("normalizes checksums and validates failed runs", () => {
    expect(sha256Schema.parse("A".repeat(64))).toBe("a".repeat(64));
    expect(
      failRunSchema.parse({
        workspaceId,
        errorMessage: "Process exited unexpectedly.",
      }).errorMessage,
    ).toContain("unexpectedly");
  });

  it("caps untrusted scientific text", () => {
    const result = revisionContentSchema.safeParse({
      title: "Node",
      hypothesis: "x".repeat(20_001),
    });
    expect(result.success).toBe(false);
  });
});
