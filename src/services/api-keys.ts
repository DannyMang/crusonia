// Per-user API keys ("Connect your agent"): `crs_live_` + 32 random bytes as hex. Only the SHA-256 of a
// key is stored; the full key is returned once, at creation. Keys authenticate /mcp and /api exactly like
// MCP_TOKEN (single workspace for now).
// TODO(workspaces): scope keys to a Clerk workspace once multi-tenancy lands.
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

export type ApiKeyIdentity = { id: string; name: string };
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

export async function listApiKeys(sql: Sql): Promise<ApiKey[]> {
  return (await sql`select ${COLUMNS(sql)} from api_keys order by created_at desc, id desc limit 200`) as ApiKey[];
}

/** Creates a key and returns it in full exactly once. The audit event records the prefix, never the key. */
export async function createApiKey(sql: Sql, name: string, actor: string): Promise<{ api_key: ApiKey; key: string }> {
  const { key, prefix, hash } = await generateApiKey();
  const rows = await sql`
    with ins as (
      insert into api_keys (id, name, prefix, hash) values (${newId("key")}, ${name}, ${prefix}, ${hash})
      returning *
    ), ev as (
      insert into events (lead_id, kind, data)
      select null, 'api_key_created', jsonb_build_object('key_id', id, 'name', name, 'prefix', prefix, 'actor', ${actor}::text) from ins
    )
    select ${COLUMNS(sql)} from ins`;
  return { api_key: rows[0] as ApiKey, key };
}

/** Revokes a key (idempotent: revoking twice keeps the first revoked_at). */
export async function revokeApiKey(sql: Sql, id: string, actor: string): Promise<ApiKey> {
  const rows = await sql`
    with up as (
      update api_keys set revoked_at = coalesce(revoked_at, now()) where id = ${id}
      returning *
    ), ev as (
      insert into events (lead_id, kind, data)
      select null, 'api_key_revoked', jsonb_build_object('key_id', id, 'prefix', prefix, 'actor', ${actor}::text) from up
    )
    select ${COLUMNS(sql)} from up`;
  if (!rows[0]) throw new ServiceError("not_found", `No API key with id ${id}`);
  return rows[0] as ApiKey;
}

/**
 * Looks an API key up by its hash. Returns the key's id and name if it exists and is not revoked, else null.
 * Bumps last_used_at (at most once a minute) in the same statement.
 */
export async function verifyApiKey(sql: Sql, token: string): Promise<ApiKeyIdentity | null> {
  if (!isApiKey(token)) return null;
  const hash = await hashApiKey(token);
  const rows = await sql`
    with k as (select id, name from api_keys where hash = ${hash} and revoked_at is null),
    touch as (
      update api_keys set last_used_at = now()
      where id in (select id from k)
        and (last_used_at is null or last_used_at < now() - make_interval(secs => ${LAST_USED_RESOLUTION_SECONDS}))
    )
    select id, name from k`;
  return (rows[0] as ApiKeyIdentity | undefined) ?? null;
}
