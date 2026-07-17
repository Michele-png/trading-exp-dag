import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { z } from "zod";

import { identifierSchema } from "@/lib/contracts";
import {
  AdminWorkspaceGateway,
  createAdminWorkspaceGateway,
  type SelectOptions,
  verifyPersonalToken,
} from "@/lib/server/admin";
import {
  createJwtSupabaseClient,
  createServerSupabaseClient,
} from "@/lib/supabase/server";
import { asRecord, asRecordArray } from "@/lib/utils";

const WORKSPACE_SCOPED_TABLES = new Set([
  "workspace_members",
  "spaces",
  "api_tokens",
  "idempotency_keys",
]);
const SPACE_SCOPED_TABLES = new Set([
  "nodes",
  "node_revisions",
  "node_lineage",
  "semantic_links",
  "runs",
  "metric_definitions",
  "metric_observations",
  "code_references",
  "data_references",
  "artifacts",
]);

export type PrincipalKind = "user" | "token";

export class AuthenticationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type FilterValue = string | number | boolean | null;

export class UserWorkspaceGateway {
  readonly workspaceId: string;
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient, workspaceId: string) {
    this.#client = client;
    this.workspaceId = workspaceId;
  }

  async select(
    table: string,
    columns = "*",
    options: SelectOptions = {},
  ): Promise<Record<string, unknown>[]> {
    let query = this.#client.from(table).select(columns);
    if (table === "workspaces") {
      query = query.eq("id", this.workspaceId);
    } else if (WORKSPACE_SCOPED_TABLES.has(table)) {
      query = query.eq("workspace_id", this.workspaceId);
    } else if (SPACE_SCOPED_TABLES.has(table)) {
      const spaceIds = await this.authorizedSpaceIds();
      if (spaceIds.length === 0) return [];
      query = query.in("space_id", spaceIds);
    } else {
      throw new Error(`Access to unscoped table "${table}" is blocked.`);
    }
    for (const [column, value] of Object.entries(options.filters ?? {})) {
      query =
        value === null ? query.is(column, null) : query.eq(column, value);
    }
    if (options.in) query = query.in(options.in.column, options.in.values);
    if (options.order) {
      query = query.order(options.order.column, {
        ascending: options.order.ascending ?? true,
      });
    }
    if (options.limit) query = query.limit(options.limit);
    const { data, error } = options.single
      ? await query.maybeSingle()
      : await query;
    if (error) throw new Error(error.message);
    return options.single
      ? data
        ? [asRecord(data)]
        : []
      : asRecordArray(data);
  }

  async insert(
    table: string,
    values:
      | Record<string, unknown>
      | readonly Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const rows = Array.isArray(values) ? [...values] : [values];
    const scoped = await Promise.all(
      rows.map(async (value) => this.scopeInsert(table, value)),
    );
    const { data, error } = await this.#client
      .from(table)
      .insert(scoped)
      .select();
    if (error) throw new Error(error.message);
    return asRecordArray(data);
  }

  async update(
    table: string,
    values: Record<string, unknown>,
    filters: Record<string, FilterValue>,
  ): Promise<Record<string, unknown>[]> {
    this.assertNoScopeMutation(table, values);
    let query = this.#client.from(table).update(values);
    if (table === "workspaces") {
      query = query.eq("id", this.workspaceId);
    } else if (WORKSPACE_SCOPED_TABLES.has(table)) {
      query = query.eq("workspace_id", this.workspaceId);
    } else if (SPACE_SCOPED_TABLES.has(table)) {
      const spaceIds = await this.authorizedSpaceIds();
      if (spaceIds.length === 0) return [];
      query = query.in("space_id", spaceIds);
    } else {
      throw new Error(`Access to unscoped table "${table}" is blocked.`);
    }
    for (const [column, value] of Object.entries(filters)) {
      query =
        value === null ? query.is(column, null) : query.eq(column, value);
    }
    const { data, error } = await query.select();
    if (error) throw new Error(error.message);
    return asRecordArray(data);
  }

  async delete(
    table: string,
    filters: Record<string, FilterValue>,
  ): Promise<Record<string, unknown>[]> {
    let query = this.#client.from(table).delete();
    if (table === "workspaces") {
      query = query.eq("id", this.workspaceId);
    } else if (WORKSPACE_SCOPED_TABLES.has(table)) {
      query = query.eq("workspace_id", this.workspaceId);
    } else if (SPACE_SCOPED_TABLES.has(table)) {
      const spaceIds = await this.authorizedSpaceIds();
      if (spaceIds.length === 0) return [];
      query = query.in("space_id", spaceIds);
    } else {
      throw new Error(`Access to unscoped table "${table}" is blocked.`);
    }
    for (const [column, value] of Object.entries(filters)) {
      query =
        value === null ? query.is(column, null) : query.eq(column, value);
    }
    const { data, error } = await query.select();
    if (error) throw new Error(error.message);
    return asRecordArray(data);
  }

  async createSignedArtifactUpload(path: string) {
    await this.assertStoragePath(path);
    const { data, error } = await this.#client.storage
      .from("evidence")
      .createSignedUploadUrl(path, { upsert: false });
    if (error) throw new Error(error.message);
    return data;
  }

  async createSignedArtifactDownload(path: string, expiresIn = 600) {
    await this.assertStoragePath(path);
    const { data, error } = await this.#client.storage
      .from("evidence")
      .createSignedUrl(path, expiresIn);
    if (error) throw new Error(error.message);
    return data;
  }

  async downloadArtifact(path: string): Promise<Blob> {
    await this.assertStoragePath(path);
    const { data, error } = await this.#client.storage
      .from("evidence")
      .download(path);
    if (error) throw new Error(error.message);
    return data;
  }

  async artifactInfo(path: string) {
    await this.assertStoragePath(path);
    const { data, error } = await this.#client.storage
      .from("evidence")
      .info(path);
    if (error) throw new Error(error.message);
    return data;
  }

  async uploadArtifact(
    path: string,
    bytes: Uint8Array,
    mediaType: string,
  ) {
    await this.assertStoragePath(path);
    const { data, error } = await this.#client.storage
      .from("evidence")
      .upload(path, bytes, {
        contentType: mediaType,
        upsert: false,
      });
    if (error) throw new Error(error.message);
    return data;
  }

  private async authorizedSpaceIds(): Promise<string[]> {
    return this.#client
      .from("spaces")
      .select("id")
      .eq("workspace_id", this.workspaceId)
      .then(({ data, error }) => {
        if (error) throw new Error(error.message);
        return asRecordArray(data).map((row) => String(row.id));
      });
  }

  private async scopeInsert(
    table: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (table === "workspaces") {
      if (value.id !== this.workspaceId) {
        throw new Error("Insert attempted to cross workspace boundary.");
      }
      return value;
    }
    if (WORKSPACE_SCOPED_TABLES.has(table)) {
      if (
        "workspace_id" in value &&
        value.workspace_id !== this.workspaceId
      ) {
        throw new Error("Insert attempted to cross workspace boundary.");
      }
      return { ...value, workspace_id: this.workspaceId };
    }
    if (SPACE_SCOPED_TABLES.has(table)) {
      const spaceId = String(value.space_id ?? "");
      if (!(await this.authorizedSpaceIds()).includes(spaceId)) {
        throw new Error("Insert attempted to cross workspace boundary.");
      }
      return value;
    }
    throw new Error(`Access to unscoped table "${table}" is blocked.`);
  }

  private assertNoScopeMutation(
    table: string,
    values: Record<string, unknown>,
  ) {
    if (
      (table === "workspaces" && "id" in values) ||
      (WORKSPACE_SCOPED_TABLES.has(table) &&
        "workspace_id" in values) ||
      (SPACE_SCOPED_TABLES.has(table) && "space_id" in values)
    ) {
      throw new Error("A tenant scope column cannot be changed.");
    }
  }

  private async assertStoragePath(path: string) {
    const [spaceId] = path.split("/");
    if (
      !(await this.authorizedSpaceIds()).includes(spaceId) ||
      path.includes("..") ||
      path.includes("\\") ||
      path.startsWith("/")
    ) {
      throw new Error("Storage path is outside the authorized workspace.");
    }
  }
}

export type WorkspaceGateway =
  | UserWorkspaceGateway
  | AdminWorkspaceGateway;

export interface AuthenticatedPrincipal {
  kind: PrincipalKind;
  actorId: string;
  tokenId?: string;
  workspaceId: string;
  scopes: string[];
  gateway: WorkspaceGateway;
}

export type AuthorizationCredential =
  | { type: "personal_token"; value: string }
  | { type: "user_jwt"; value: string }
  | { type: "cookie" };

export function classifyAuthorizationHeader(
  authorization: string | null,
): AuthorizationCredential {
  if (!authorization) return { type: "cookie" };
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) {
    throw new AuthenticationError(
      "invalid_authorization",
      "Authorization must use the Bearer scheme.",
    );
  }
  return match[1].startsWith("qdag_")
    ? { type: "personal_token", value: match[1] }
    : { type: "user_jwt", value: match[1] };
}

async function requireWorkspaceMembership(
  client: SupabaseClient,
  user: User,
  workspaceId: string,
): Promise<void> {
  const { data, error } = await client
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .is("removed_at", null)
    .maybeSingle();
  if (error) {
    throw new AuthenticationError(
      "membership_check_failed",
      "Workspace membership could not be verified.",
      503,
    );
  }
  if (!data) {
    throw new AuthenticationError(
      "workspace_forbidden",
      "You are not a member of this workspace.",
      403,
    );
  }
}

function parseWorkspaceHeader(request: Request): string {
  const parsed = identifierSchema.safeParse(
    request.headers.get("x-workspace-id"),
  );
  if (!parsed.success) {
    throw new AuthenticationError(
      "workspace_required",
      "Browser requests require X-Workspace-Id with a workspace UUID.",
      400,
    );
  }
  return parsed.data;
}

export async function authenticateRequest(
  request: Request,
): Promise<AuthenticatedPrincipal> {
  const credential = classifyAuthorizationHeader(
    request.headers.get("authorization"),
  );
  if (credential.type === "personal_token") {
    const verified = await verifyPersonalToken(credential.value);
    const requestedWorkspace = request.headers.get("x-workspace-id");
    if (
      requestedWorkspace &&
      requestedWorkspace !== verified.workspaceId
    ) {
      throw new AuthenticationError(
        "workspace_forbidden",
        "The personal token is scoped to a different workspace.",
        403,
      );
    }
    return {
      kind: "token",
      actorId: verified.actorId,
      tokenId: verified.tokenId,
      workspaceId: verified.workspaceId,
      scopes: verified.scopes,
      gateway: createAdminWorkspaceGateway(verified.workspaceId),
    };
  }

  const workspaceId = parseWorkspaceHeader(request);
  const client =
    credential.type === "user_jwt"
      ? createJwtSupabaseClient(credential.value)
      : await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } =
    credential.type === "user_jwt"
      ? await client.auth.getUser(credential.value)
      : await client.auth.getUser();
  if (error || !user) {
    throw new AuthenticationError(
      "unauthenticated",
      "A valid Supabase session or personal token is required.",
    );
  }
  await requireWorkspaceMembership(client, user, workspaceId);
  return {
    kind: "user",
    actorId: user.id,
    workspaceId,
    scopes: ["*"],
    gateway: new UserWorkspaceGateway(client, workspaceId),
  };
}

export function requireScope(
  principal: AuthenticatedPrincipal,
  scope: string,
) {
  if (
    principal.kind === "token" &&
    !principal.scopes.includes(scope) &&
    !principal.scopes.includes("*")
  ) {
    throw new AuthenticationError(
      "insufficient_scope",
      `This operation requires the ${scope} scope.`,
      403,
    );
  }
}

export function assertPrincipalBoundary(
  principal: Pick<AuthenticatedPrincipal, "workspaceId">,
  requestedWorkspaceId: string,
) {
  const parsed = z.uuid().safeParse(requestedWorkspaceId);
  if (!parsed.success || parsed.data !== principal.workspaceId) {
    throw new AuthenticationError(
      "workspace_forbidden",
      "The requested resource is outside the authenticated workspace.",
      403,
    );
  }
}
