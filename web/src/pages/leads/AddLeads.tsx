// "Add leads": a menu with "Find leads with your agent" (paid, confirm first) and "Add a contact" (an
// opted-in person the owner enters by hand).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { isApiError, type CreateLeadInput } from "../../api.ts";
import { useApi } from "../../auth.tsx";
import { Dialog, Dropdown, Field, inputClass, MenuItem, textareaClass } from "../../components/leads/Overlay.tsx";
import { Button, ButtonLink, QueryError } from "../../components/ui.tsx";
import { cx } from "../../lib/format.ts";

export function AddLeadsButton() {
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<"find" | "contact" | null>(null);
  return (
    <>
      <Dropdown
        open={menu}
        onClose={() => setMenu(false)}
        align="right"
        className="w-72"
        trigger={
          <Button size="md" className="gap-1.5" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            <span className="text-base/4">+</span>
            Add leads
          </Button>
        }
      >
        <div role="menu" aria-label="Add leads" className="flex flex-col">
          <MenuItem
            onSelect={() => {
              setMenu(false);
              setDialog("find");
            }}
            hint="Researches companies that fit your ICP. Paid run, asks first."
          >
            Find leads with your agent
          </MenuItem>
          <MenuItem
            onSelect={() => {
              setMenu(false);
              setDialog("contact");
            }}
            hint="Someone who opted in to hear from you."
          >
            Add a contact
          </MenuItem>
        </div>
      </Dropdown>
      <FindLeadsDialog open={dialog === "find"} onClose={() => setDialog(null)} />
      <AddContactDialog open={dialog === "contact"} onClose={() => setDialog(null)} />
    </>
  );
}

const COUNTS = [10, 25, 50] as const;

export function FindLeadsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [count, setCount] = useState<number>(25);
  const find = useMutation({
    mutationFn: () => api.findLeads(count),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workflows"] });
      void qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
  const close = () => {
    onClose();
    find.reset();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={find.isSuccess ? "Your agent is finding leads" : "Find leads with your agent"}
      description={
        find.isSuccess
          ? "New leads show up in the list as the agent adds them, each with sources for every claim."
          : "Your agent searches for companies that match your ideal customer profile, researches each one and adds them here."
      }
      footer={
        find.isSuccess ? (
          <>
            <Button variant="soft" onClick={close}>
              Close
            </Button>
            <ButtonLink to={`/app/workflows/runs/${encodeURIComponent(find.data.session_id)}`} onClick={close}>
              Watch the run
            </ButtonLink>
          </>
        ) : (
          <>
            <Button variant="soft" onClick={close}>
              Cancel
            </Button>
            <Button loading={find.isPending} onClick={() => find.mutate()} disabled={find.isError}>
              Start the run
            </Button>
          </>
        )
      }
    >
      {find.isSuccess ? null : (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="text-[13px]/4 font-medium text-ink">How many leads</div>
            <div className="flex gap-1.5" role="radiogroup" aria-label="How many leads">
              {COUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={count === n}
                  onClick={() => {
                    setCount(n);
                    find.reset();
                  }}
                  className={cx(
                    "h-8 rounded-full px-3.5 text-[13px]/4 font-medium tabular-nums",
                    count === n ? "bg-lime text-ink" : "border border-[#200D0D24] bg-white text-ink hover:bg-[#200D0D08]",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-2.5 rounded-[10px] border border-[#200D0D1A] bg-pill px-3.5 py-3 text-[13px]/5 font-medium text-ink">
            <span className="mt-1.75 size-1.5 shrink-0 rounded-full bg-ink" />
            <span>
              This starts a paid agent run (search, scraping and research) billed to your workspace. Nothing is emailed: every draft still
              waits for your approval.
            </span>
          </div>
          {find.isError ? <FindError error={find.error} onNavigate={close} /> : null}
        </>
      )}
    </Dialog>
  );
}

/** 409 profile_missing: the agent needs a saved ideal-customer profile before it can search. */
function FindError({ error, onNavigate }: { error: unknown; onNavigate: () => void }) {
  if (isApiError(error) && error.code === "profile_missing") {
    return (
      <div role="status" className="flex items-start gap-3 rounded-[10px] border border-panel-line bg-panel px-4 py-3.5 text-[13px]/5">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-green" />
        <div className="flex grow flex-col gap-2">
          <div>
            <div className="font-semibold text-ink">Set up your ideal customer first</div>
            <div className="font-medium text-[#200D0D99]">Your agent searches against your saved profile. Onboarding builds it from your website in a few minutes.</div>
          </div>
          <ButtonLink to="/onboarding/1" onClick={onNavigate} className="self-start">
            Start onboarding
          </ButtonLink>
        </div>
      </div>
    );
  }
  return <QueryError error={error} what="finding leads" />;
}

const empty = { email: "", name: "", title: "", company: "", consent: "" };

export function AddContactDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [form, setForm] = useState(empty);
  const add = useMutation({
    mutationFn: (input: CreateLeadInput) => api.createLead(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["leads"] });
      void qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
  const close = () => {
    onClose();
    setForm(empty);
    add.reset();
  };
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const opt = (v: string) => v.trim() || undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    const consent = form.consent.trim();
    add.mutate({
      email: form.email.trim(),
      name: opt(form.name),
      title: opt(form.title),
      company: opt(form.company),
      source: "manual",
      consent: consent ? { text: consent } : undefined,
    });
  }

  if (add.isSuccess) {
    const lead = add.data.lead;
    return (
      <Dialog
        open={open}
        onClose={close}
        title="Contact added"
        description={
          lead.has_consent
            ? `${lead.email ?? "They"} can be emailed once you approve a draft.`
            : `${lead.email ?? "They"} was saved without consent, so Crusonia will never email them.`
        }
        footer={
          <>
            <Button
              variant="soft"
              onClick={() => {
                setForm(empty);
                add.reset();
              }}
            >
              Add another
            </Button>
            <ButtonLink to={`/app/leads/${encodeURIComponent(lead.id)}`} onClick={close}>
              Open lead
            </ButtonLink>
          </>
        }
      />
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a contact"
      description="Add someone who asked to hear from you. Your agent researches them before drafting anything."
    >
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Email" required>
          <input type="email" required autoFocus value={form.email} onChange={set("email")} placeholder="maya@company.com" className={inputClass} />
        </Field>
        <div className="flex gap-3">
          <div className="grow basis-0">
            <Field label="Name">
              <input value={form.name} onChange={set("name")} placeholder="Full name" className={inputClass} />
            </Field>
          </div>
          <div className="grow basis-0">
            <Field label="Company">
              <input value={form.company} onChange={set("company")} placeholder="Company name" className={inputClass} />
            </Field>
          </div>
        </div>
        <Field label="Title">
          <input value={form.title} onChange={set("title")} placeholder="Head of Sales" className={inputClass} />
        </Field>
        <Field
          label="How they opted in"
          hint="Required before Crusonia will email them. Leave it empty to save the contact without ever emailing them."
        >
          <textarea
            rows={2}
            value={form.consent}
            onChange={set("consent")}
            placeholder="Signed up on our waitlist, Nov 3"
            className={textareaClass}
          />
        </Field>
        {add.isError ? <QueryError error={add.error} what="adding contacts" /> : null}
        <div className="-mx-5 -mb-4 flex items-center justify-end gap-2 border-t border-t-[#200D0D14] bg-[#200D0D06] px-5 py-3">
          <Button variant="soft" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={add.isPending} disabled={!form.email.trim()}>
            Add contact
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
