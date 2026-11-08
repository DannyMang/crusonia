// /api/leads/:id/notes and /api/leads/:id/exclude: the owner's notes on a company (including a thumbs-down or
// thumbs-up with a reason), and excluding a company so future runs skip it. Authors edit and delete only their own.
import { Hono } from "hono";
import { z } from "zod";
import { parseJson, sqlFor, wsOf, type AppEnv } from "../lib/context.ts";
import { addNote, deleteNote, editNote, excludeLead, listNotes, NOTE_KINDS, noteAuthor, noteBody, unexcludeLead } from "../services/notes.ts";

export const notes = new Hono<AppEnv>();

notes.get("/:id/notes", async (c) => c.json({ data: await listNotes(sqlFor(c.env), wsOf(c), c.req.param("id")) }));

// kind thumbs_down / thumbs_up: the owner's rating of the pick; the body is the reason ("agency, not software").
const AddBody = z.object({ body: noteBody, kind: z.enum(NOTE_KINDS).default("note") }).strict();

notes.post("/:id/notes", async (c) => {
  const body = await parseJson(c, AddBody);
  const note = await addNote(sqlFor(c.env), wsOf(c), { leadId: c.req.param("id"), author: noteAuthor(c.get("principal")), body: body.body, kind: body.kind });
  return c.json({ note }, 201);
});

const EditBody = z.object({ body: noteBody }).strict();

notes.patch("/:id/notes/:note_id", async (c) => {
  const body = await parseJson(c, EditBody);
  const note = await editNote(sqlFor(c.env), wsOf(c), { leadId: c.req.param("id"), noteId: c.req.param("note_id"), author: noteAuthor(c.get("principal")), body: body.body });
  return c.json({ note });
});

notes.delete("/:id/notes/:note_id", async (c) => {
  await deleteNote(sqlFor(c.env), wsOf(c), { leadId: c.req.param("id"), noteId: c.req.param("note_id"), author: noteAuthor(c.get("principal")) });
  return c.body(null, 204);
});

// Excluded companies are remembered: add_leads skips them (like disqualified ones) until they are un-excluded.
const ExcludeBody = z.object({ reason: z.string().trim().min(1).max(2000).optional() }).strict();

notes.post("/:id/exclude", async (c) => {
  const body = await parseJson(c, ExcludeBody);
  return c.json({ lead: await excludeLead(sqlFor(c.env), wsOf(c), { leadId: c.req.param("id"), reason: body.reason, author: noteAuthor(c.get("principal")) }) });
});

notes.delete("/:id/exclude", async (c) =>
  c.json({ lead: await unexcludeLead(sqlFor(c.env), wsOf(c), { leadId: c.req.param("id"), author: noteAuthor(c.get("principal")) }) }),
);
