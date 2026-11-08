// Workspace API keys ("Connect your agent"): `crs_live_` + 32 random bytes as hex. Only the SHA-256 of a
// key is stored; the full key is returned once, at creation. A key authenticates /mcp and /api for its own
// workspace only. Kind 'user' keys are listed and revoked in the app; the 'agent' key of a workspace's Naive agent
// lives only in the Naive vault (src/services/naive-agents.ts) and is managed by Crusonia.
import type { Sql } from "../db.ts";
import { newId } from "../ids.ts";
import { sha256, toHex } from "../lib/crypto.ts";
import { ServiceError } from "./errors.ts";

export const API_KEY_PREFIX = "crs_live_";
const API_KEY_RE = /^crs_live_[0-9a-f]{64}$/;
/** Characters of the key kept for display: `crs_live_` plus the first 8 hex characters. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;
/** last_used_at is written at most this often per key, so a busy agent does not write on every call. */
const LAST_USED_RESOLUTION_SECONDS = 60;

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  status: "active" | "revoked";
};

/** 'agent': a workspace's research agent. 'operator': its Operator agent (src/mcp/toolsets.ts). Both live in the Naive vault. */
export type ApiKeyKind = "user" | "agent" | "operator";
export type ApiKeyIdentity = { id: string; name: string; workspace_id: string; kind: ApiKeyKind };
export type ApiKeyLookup = (token: string) => Promise<ApiKeyIdentity | null>;

export const isApiKey = (token: string) => API_KEY_RE.test(token);

export async function hashApiKey(key: string): Promise<string> {
  return toHex(await sha256(key));
}

export async function generateApiKey(): Promise<{ key: string; prefix: string; hash: string }> {
  const key = API_KEY_PREFIX + toHex(crypto.getRandomValues(new Uint8Array(32)));
  return { key, prefix: key.slice(0, DISPLAY_PREFIX_LENGTH), hash: await hashApiKey(key) };
}

const COLUMNS = (sql: Sql) => sql`id, name, prefix, created_at, last_used_at, revoked_at,
  case when revoked_at is null then 'active' else 'revoked' end as status`;

/** The workspace's user keys (the Naive agent's key is not listed: Crusonia manages it). */
export async function listApiKeys(sql: Sql, ws: string): Promise<ApiKey[]> {
  return (await sql`select ${COLUMNS(sql)} from api_keys where workspace_id = ${ws} and kind = 'user'
                    order by created_at desc, id desc limit 200`) as ApiKey[];
}

/** Creates a key and returns it in full exactly once. The audit event records the prefix, never the key. */
export async function createApiKey(
  sql: Sql,
  ws: string,
  name: string,
  actor: string,
  kind: ApiKeyKind = "user",
): Promise<{ api_key: ApiKey; key: string }> {
  const { key, prefix, hash } = await generateApiKey();
  const rows = await sql`
    with ins as (
      insert into api_keys (id, workspace_id, name, prefix, hash, kind) values (${newId("key")}, ${ws}, ${name}, ${prefix}, ${hash}, ${kind})
      returning *
    ), ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select workspace_id, null, 'api_key_created',
             jsonb_build_object('key_id', id, 'name', name, 'prefix', prefix, 'kind', kind, 'actor', ${actor}::text) from ins
    )
    select ${COLUMNS(sql)} from ins`;
  return { api_key: rows[0] as ApiKey, key };
}

/** Revokes one of the workspace's keys (idempotent: revoking twice keeps the first revoked_at). */
export async function revokeApiKey(sql: Sql, ws: string, id: string, actor: string, kind: ApiKeyKind = "user"): Promise<ApiKey> {
  const rows = await sql`
    with up as (
      update api_keys set revoked_at = coalesce(revoked_at, now()) where workspace_id = ${ws} and id = ${id} and kind = ${kind}
      returning *
    ), ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select workspace_id, null, 'api_key_revoked', jsonb_build_object('key_id', id, 'prefix', prefix, 'actor', ${actor}::text) from up
    )
    select ${COLUMNS(sql)} from up`;
  if (!rows[0]) throw new ServiceError("not_found", `No API key with id ${id}`);
  return rows[0] as ApiKey;
}

/**
 * Looks an API key up by its hash. Returns the key's id, name, workspace and kind if it exists and is not revoked,
 * else null. Bumps last_used_at (at most once a minute) in the same statement.
 */
export async function verifyApiKey(sql: Sql, token: string): Promise<ApiKeyIdentity | null> {
  if (!isApiKey(token)) return null;
  const hash = await hashApiKey(token);
  const rows = await sql`
    with k as (select id, name, workspace_id, kind from api_keys where hash = ${hash} and revoked_at is null),
    touch as (
      update api_keys set last_used_at = now()
      where id in (select id from k)
        and (last_used_at is null or last_used_at < now() - make_interval(secs => ${LAST_USED_RESOLUTION_SECONDS}))
    )
    select id, name, workspace_id, kind from k`;
  return (rows[0] as ApiKeyIdentity | undefined) ?? null;
}
