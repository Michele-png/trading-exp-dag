import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnvironment } from "@/lib/env";
import { asRecord, asRecordArray } from "@/lib/utils";

const TOKEN_PATTERN =
  /^qdag_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{32,})$/i;

const WORKSPACE_SCOPED_TABLES = new Set([
  "workspace_members",
  "spaces",
  "api_tokens",
  "idempotency_keys",
  "audit_events",
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

export interface ApiTokenRecord {
  id: string;
  workspaceId: string;
  userId: string;
  tokenDigest: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface VerifiedApiToken {
  tokenId: string;
  workspaceId: string;
  actorId: string;
  scopes: string[];
}

export class TokenAuthenticationError extends Error {
  readonly code:
    | "invalid_token"
    | "expired_token"
    | "revoked_token"
    | "token_configuration_error";

  constructor(
    code: TokenAuthenticationError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

export function digestApiToken(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token, "utf8").digest("hex");
}

export function parseApiToken(
  token: string,
): { workspaceId: string; prefix: string } | null {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  return {
    workspaceId: match[1].toLowerCase(),
    prefix: `qdag_${match[1].toLowerCase()}_${match[2].slice(0, 10)}`,
  };
}

export function verifyTokenRecord(
  token: string,
  record: ApiTokenRecord,
  pepper: string,
  now = new Date(),
): VerifiedApiToken {
  const expected = Buffer.from(record.tokenDigest, "hex");
  const actual = Buffer.from(digestApiToken(token, pepper), "hex");
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new TokenAuthenticationError(
      "invalid_token",
      "The personal token is invalid.",
    );
  }
  if (record.revokedAt) {
    throw new TokenAuthenticationError(
      "revoked_token",
      "The personal token has been revoked.",
    );
  }
  if (record.expiresAt && new Date(record.expiresAt) <= now) {
    throw new TokenAuthenticationError(
      "expired_token",
      "The personal token has expired.",
    );
  }
  return {
    tokenId: record.id,
    workspaceId: record.workspaceId,
    actorId: record.userId,
    scopes: record.scopes,
  };
}

function createAdminClient(): SupabaseClient {
  const environment = getServerEnvironment();
  return createClient(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.SUPABASE_SECRET_KEY,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );
}

function byteaHex(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.startsWith("\\x") ? value.slice(2) : value;
}

function mapTokenRecord(value: unknown, prefix: string): ApiTokenRecord {
  const record = asRecord(value);
  return {
    id: String(record.id ?? ""),
    workspaceId: String(record.workspace_id ?? ""),
    userId: String(record.user_id ?? ""),
    tokenDigest: byteaHex(record.token_hash),
    tokenPrefix: prefix,
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter(
          (scope): scope is string => typeof scope === "string",
        )
      : [],
    expiresAt:
      typeof record.expires_at === "string" ? record.expires_at : null,
    revokedAt:
      typeof record.revoked_at === "string" ? record.revoked_at : null,
  };
}

export async function verifyPersonalToken(
  token: string,
): Promise<VerifiedApiToken> {
  const parsed = parseApiToken(token);
  if (!parsed) {
    throw new TokenAuthenticationError(
      "invalid_token",
      "The personal token format is invalid.",
    );
  }
  const environment = getServerEnvironment();
  const admin = createAdminClient();
  const tokenDigest = digestApiToken(token, environment.API_TOKEN_PEPPER);
  const { data, error } = await admin
    .from("api_tokens")
    .select(
      "id, workspace_id, user_id, token_hash, scopes, expires_at, revoked_at",
    )
    .eq("workspace_id", parsed.workspaceId)
    .eq("token_hash", `\\x${tokenDigest}`)
    .limit(1);
  if (error) {
    throw new TokenAuthenticationError(
      "token_configuration_error",
      "Personal-token verification is unavailable.",
    );
  }

  for (const candidate of asRecordArray(data)) {
    try {
      const verified = verifyTokenRecord(
        token,
        mapTokenRecord(candidate, parsed.prefix),
        environment.API_TOKEN_PEPPER,
      );
      await admin
        .from("api_tokens")
        .update({ last_used_at: new Date().toISOString() })
        .eq("workspace_id", verified.workspaceId)
        .eq("id", verified.tokenId);
      return verified;
    } catch (verificationError) {
      if (
        verificationError instanceof TokenAuthenticationError &&
        verificationError.code !== "invalid_token"
      ) {
        throw verificationError;
      }
    }
  }
  throw new TokenAuthenticationError(
    "invalid_token",
    "The personal token is invalid.",
  );
}

export async function issuePersonalToken(input: {
  workspaceId: string;
  actorId: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
}): Promise<{ id: string; token: string; prefix: string }> {
  const environment = getServerEnvironment();
  const admin = createAdminClient();
  const secret = randomBytes(32).toString("base64url");
  const token = `qdag_${input.workspaceId}_${secret}`;
  const prefix = `qdag_${input.workspaceId}_${secret.slice(0, 10)}`;
  const id = randomUUID();
  const tokenHash = digestApiToken(token, environment.API_TOKEN_PEPPER);
  const { error } = await admin.from("api_tokens").insert({
    id,
    workspace_id: input.workspaceId,
    user_id: input.actorId,
    name: input.name,
    token_hash: `\\x${tokenHash}`,
    scopes: input.scopes,
    expires_at: input.expiresAt,
  });
  if (error) {
    throw new Error(`Could not create the personal token: ${error.message}`);
  }
  return { id, token, prefix };
}

export async function revokePersonalToken(input: {
  workspaceId: string;
  actorId: string;
  tokenId: string;
}): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.actorId)
    .eq("id", input.tokenId)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    throw new Error(`Could not revoke the personal token: ${error.message}`);
  }
  if (asRecordArray(data).length === 0) {
    throw new Error("Personal token not found or already revoked.");
  }
}

type FilterValue = string | number | boolean | null;

export interface SelectOptions {
  filters?: Record<string, FilterValue>;
  in?: { column: string; values: string[] };
  order?: { column: string; ascending?: boolean };
  limit?: number;
  single?: boolean;
}

export class AdminWorkspaceGateway {
  readonly workspaceId: string;
  readonly #client: SupabaseClient;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
    this.#client = createAdminClient();
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
      throw new Error(`Admin access to unscoped table "${table}" is blocked.`);
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
      throw new Error(`Admin access to unscoped table "${table}" is blocked.`);
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
      throw new Error(`Admin access to unscoped table "${table}" is blocked.`);
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
        throw new Error("Admin insert attempted to cross workspace boundary.");
      }
      return value;
    }
    if (WORKSPACE_SCOPED_TABLES.has(table)) {
      if (
        "workspace_id" in value &&
        value.workspace_id !== this.workspaceId
      ) {
        throw new Error("Admin insert attempted to cross workspace boundary.");
      }
      return { ...value, workspace_id: this.workspaceId };
    }
    if (SPACE_SCOPED_TABLES.has(table)) {
      const spaceId = String(value.space_id ?? "");
      if (!(await this.authorizedSpaceIds()).includes(spaceId)) {
        throw new Error("Admin insert attempted to cross workspace boundary.");
      }
      return value;
    }
    throw new Error(`Admin access to unscoped table "${table}" is blocked.`);
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
      throw new Error("Admin update cannot mutate a tenant scope column.");
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

export async function recordAuditEvent(input: {
  workspaceId: string;
  actorId: string;
  tokenId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  requestId?: string;
  details?: Record<string, unknown>;
}) {
  const admin = createAdminClient();
  const { error } = await admin.from("audit_events").insert({
    workspace_id: input.workspaceId,
    actor_user_id: input.tokenId ? null : input.actorId,
    actor_api_token_id: input.tokenId ?? null,
    action: input.action,
    resource_type: input.resourceType,
    resource_id: input.resourceId ?? null,
    request_id: input.requestId ?? null,
    details: input.details ?? {},
  });
  if (error) throw new Error(error.message);
}

export function checksumBytes(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

export function createAdminWorkspaceGateway(
  workspaceId: string,
): AdminWorkspaceGateway {
  return new AdminWorkspaceGateway(workspaceId);
}
