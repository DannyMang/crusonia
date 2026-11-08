// Notes on leads (companies), and the owner's exclusions. Owners write notes and rate picks (a thumbs-down with a
// reason is a note of kind 'thumbs_down'); agents add notes over MCP. Agents read a lead's notes in get_lead and the
// owner's recent notes across leads in get_profile, so "agency, not software" steers the next search.
// Excluding a company makes add_leads remember and skip it (as it does disqualified companies) until un-excluded.
// Every function acts on one workspace (`ws`): notes and exclusions never cross workspaces.
import { z } from "zod";
import type { Sql } from "../db.ts";
import type { Principal } from "../lib/context.ts";
import { ServiceError } from "./errors.ts";

export const NOTE_KINDS = ["note", "thumbs_down", "thumbs_up"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export type Note = { id: string; lead_id: string; author: string; kind: NoteKind; body: string; created_at: Date; updated_at: Date };

/** Note author for an /api caller: `user:<clerk user id>`, `user:owner` (MCP_TOKEN) or `user:api_key:<key id>`. */
export function noteAuthor(principal: Principal): string {
  if (principal.kind === "clerk") return `user:${principal.userId}`;
  return principal.kind === "api_key" ? `user:api_key:${principal.keyId}` : "user:owner";
}

export const noteBody = z.string().trim().min(1).max(4000);

export const addNoteInputSchema = z.object({
  lead_id: z.string().trim().min(1).max(64).describe("Lead id the note is about."),
  body: noteBody.describe("The note: what you learned or decided that the owner or the next agent should know. Plain text."),
});

async function requireLead(sql: Sql, ws: string, leadId: string) {
  const [lead] = await sql`select id from leads where workspace_id = ${ws} and id = ${leadId}`;
  if (!lead) throw new ServiceError("not_found", `No lead with id ${leadId}. Use list_leads to find lead ids.`);
}

export async function listNotes(sql: Sql, ws: string, leadId: string): Promise<Note[]> {
  await requireLead(sql, ws, leadId);
  return (await sql`select id::text, lead_id, author, kind, body, created_at, updated_at from lead_notes
                    where workspace_id = ${ws} and lead_id = ${leadId} order by id desc limit 200`) as Note[];
}

export async function addNote(sql: Sql, ws: string, input: { leadId: string; author: string; body: string; kind?: NoteKind }): Promise<Note> {
  const rows = await sql`
    with ins as (
      insert into lead_notes (workspace_id, lead_id, author, kind, body)
      select workspace_id, id, ${input.author}, ${input.kind ?? "note"}, ${input.body} from leads where workspace_id = ${ws} and id = ${input.leadId}
      returning *
    ),
    ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select workspace_id, lead_id, 'note_added', jsonb_build_object('note_id', id, 'author', author, 'kind', kind) from ins
    )
    select id::text, lead_id, author, kind, body, created_at, updated_at from ins`;
  if (!rows[0]) throw new ServiceError("not_found", `No lead with id ${input.leadId}. Use list_leads to find lead ids.`);
  return rows[0] as Note;
}

/** Edits a note. Only its author can. */
export async function editNote(sql: Sql, ws: string, input: { leadId: string; noteId: string; author: string; body: string }): Promise<Note> {
  if (!/^\d+$/.test(input.noteId)) throw new ServiceError("not_found", `No note ${input.noteId} on lead ${input.leadId}.`);
  const rows = await sql`
    update lead_notes set body = ${input.body}, updated_at = now()
    where workspace_id = ${ws} and id = ${input.noteId}::bigint and lead_id = ${input.leadId} and author = ${input.author}
    returning id::text, lead_id, author, kind, body, created_at, updated_at`;
  if (!rows[0]) throw await noteError(sql, ws, input);
  return rows[0] as Note;
}

/** Deletes a note. Only its author can. */
export async function deleteNote(sql: Sql, ws: string, input: { leadId: string; noteId: string; author: string }): Promise<void> {
  if (!/^\d+$/.test(input.noteId)) throw new ServiceError("not_found", `No note ${input.noteId} on lead ${input.leadId}.`);
  const rows = await sql`
    delete from lead_notes where workspace_id = ${ws} and id = ${input.noteId}::bigint and lead_id = ${input.leadId} and author = ${input.author}
    returning id`;
  if (!rows[0]) throw await noteError(sql, ws, input);
}

async function noteError(sql: Sql, ws: string, input: { leadId: string; noteId: string }): Promise<ServiceError> {
  const [note] = await sql`select author from lead_notes where workspace_id = ${ws} and id = ${input.noteId}::bigint and lead_id = ${input.leadId}`;
  return note
    ? new ServiceError("invalid", "Only the note's author can edit or delete it.")
    : new ServiceError("not_found", `No note ${input.noteId} on lead ${input.leadId}.`);
}

export type OwnerNote = { lead_id: string; company: string | null; domain: string | null; stage: string; kind: NoteKind; body: string; created_at: Date };

/** The owner's most recent notes across leads, newest first: what agents should steer by. */
export async function recentOwnerNotes(sql: Sql, ws: string, limit = 20): Promise<OwnerNote[]> {
  return (await sql`
    select n.lead_id, l.company, l.domain, l.stage, n.kind, n.body, n.created_at
    from lead_notes n join leads l on l.id = n.lead_id
    where n.workspace_id = ${ws} and n.author like 'user:%'
    order by n.id desc limit ${limit}`) as OwnerNote[];
}

export type ExcludedCompany = { lead_id: string; company: string | null; domain: string | null; reason: string | null };

/** Companies future runs skip (excluded by the owner, or disqualified), newest first: so searches avoid them. */
export async function excludedCompanies(sql: Sql, ws: string, limit = 50): Promise<ExcludedCompany[]> {
  return (await sql`
    select id as lead_id, company, domain,
           case when excluded_at is not null then coalesce(excluded_reason, 'excluded by the owner')
                else 'disqualified' || coalesce(': ' || left(rationale, 160), '') end as reason
    from leads
    where workspace_id = ${ws} and domain is not null and (excluded_at is not null or stage = 'disqualified')
    order by coalesce(excluded_at, updated_at) desc limit ${limit}`) as ExcludedCompany[];
}

/** The owner excludes a company: future runs skip it. A reason is also kept as a note. */
export async function excludeLead(sql: Sql, ws: string, input: { leadId: string; reason?: string | null; author: string }) {
  const reason = input.reason?.trim() || null;
  const rows = await sql`
    with up as (
      update leads set excluded_at = coalesce(excluded_at, now()), excluded_reason = coalesce(${reason}::text, excluded_reason), updated_at = now()
      where workspace_id = ${ws} and id = ${input.leadId}
      returning id, excluded_at, excluded_reason, stage
    ),
    note as (
      insert into lead_notes (workspace_id, lead_id, author, kind, body)
      select ${ws}, id, ${input.author}, 'thumbs_down', ${reason}::text from up where ${reason}::text is not null
    ),
    ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select ${ws}, id, 'lead_excluded', jsonb_build_object('reason', ${reason}::text, 'actor', ${input.author}::text) from up
    )
    select * from up`;
  if (!rows[0]) throw new ServiceError("not_found", `No lead with id ${input.leadId}.`);
  return rows[0];
}

/**
 * The owner un-excludes a company: future runs may add to it again. A disqualified lead goes back to unscored
 * (no_consent, or new with consent) so it can be researched again; its last score and rationale stay for reference.
 */
export async function unexcludeLead(sql: Sql, ws: string, input: { leadId: string; author: string }) {
  const rows = await sql`
    with up as (
      update leads set excluded_at = null, excluded_reason = null,
             stage = case when stage = 'disqualified' then (case when consent_at is null then 'no_consent' else 'new' end) else stage end,
             qualified = case when stage = 'disqualified' then null else qualified end,
             updated_at = now()
      where workspace_id = ${ws} and id = ${input.leadId}
      returning id, stage
    ),
    ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select ${ws}, id, 'lead_unexcluded', jsonb_build_object('stage', stage, 'actor', ${input.author}::text) from up
    )
    select * from up`;
  if (!rows[0]) throw new ServiceError("not_found", `No lead with id ${input.leadId}.`);
  return rows[0];
}
