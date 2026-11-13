// Leads business logic: a sales pipeline the business shapes itself (its own
// working stages, then Won and Lost), follow-up dates, conversion into a real
// customer, and per-stage automations.
//
// How automations stay predictable:
//  - Events (a quote sent, accepted, …) fire once, when they happen. Moving a
//    lead by hand afterwards is never undone by an old event.
//  - Each event moves a lead to at most one stage (see config.triggers).
//  - Arrival actions (make a customer, set a follow-up, create a project)
//    never move a lead, so one automation can't set off a chain of moves.

import crypto from "node:crypto";
import { getDb } from "../../database/connection";
import { createCustomer, getCustomer } from "../../services/customer.service";
import { todayIso } from "../../utils/date";
import { isPluginEnabled } from "../settings";
import { createProject, getProject } from "../time-tracker/service";
import {
  getLeadsConfig,
  getStage,
  isClosed,
  LEAD_EVENTS,
  type LeadEvent,
  type LeadsConfig,
} from "./config";

export { LEAD_SOURCES } from "./config";

export interface Lead {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  value: number | null;
  stage: string;
  next_follow_up: string | null;
  notes: string | null;
  customer_id: string | null;
  converted_at: string | null;
  /** Time Tracking project made by a stage's create_project action. */
  project_id: string | null;
  /** The quote this lead is following (its first quote, or the one that replaced a declined one). */
  quote_id: string | null;
  quote_number: string | null;
  quote_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadInput {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  value?: number | null;
  stage?: string;
  next_follow_up?: string | null;
  notes?: string | null;
}

export interface LeadFilters {
  stage?: string;
  search?: string;
  from?: string;
  to?: string;
}

/** The user's local date (YYYY-MM-DD) for follow-up actions; the server's UTC date if not given. */
export interface Context {
  today?: string;
}

const FIELDS = [
  "name",
  "company",
  "email",
  "phone",
  "source",
  "value",
  "stage",
  "next_follow_up",
  "notes",
] as const;

const SELECT = `SELECT l.*, q.quote_number, q.status AS quote_status
                  FROM ld_leads l
                  LEFT JOIN quotes q ON q.id = l.quote_id AND q.deleted_at IS NULL`;

/** Blank strings are stored as NULL so "no email" and "" never differ. */
function clean(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  return v as number;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Events already handled for a lead; null on leads from before automations were tracked. */
function seenEvents(raw: string | null): LeadEvent[] | null {
  if (raw === null) return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((e) => LEAD_EVENTS.includes(e)) : [];
  } catch {
    return [];
  }
}

export function firstOpenStage(config: LeadsConfig = getLeadsConfig()): string {
  return config.stages.find((s) => !isClosed(s.id))?.id ?? "won";
}

export function stageExists(id: string, config: LeadsConfig = getLeadsConfig()): boolean {
  return config.stages.some((s) => s.id === id);
}

// ── Arrival actions ─────────────────────────────────────────────────────────

/**
 * Run the arrival actions of the lead's stage. `followUpGiven` is true when
 * the user set the follow-up date in the same change, which then wins.
 */
function arrive(id: string, stageId: string, ctx: Context, followUpGiven: boolean): void {
  const stage = getStage(getLeadsConfig(), stageId);
  if (!stage) return;
  const { make_customer, follow_up_days, create_project } = stage.actions;
  if (make_customer) convertLead(id);
  if (create_project) ensureProject(id);
  if (follow_up_days && !followUpGiven) {
    getDb().run("UPDATE ld_leads SET next_follow_up = ? WHERE id = ?", [
      addDays(ctx.today ?? todayIso(), follow_up_days),
      id,
    ]);
  }
}

function moveLead(id: string, stage: string, ctx: Context, followUpGiven = false): void {
  getDb().run("UPDATE ld_leads SET stage = ?, updated_at = datetime('now') WHERE id = ?", [
    stage,
    id,
  ]);
  arrive(id, stage, ctx, followUpGiven);
}

/**
 * A Time Tracking project for the lead's customer, named after the company,
 * made once per lead and only while Time Tracking is switched on.
 */
function ensureProject(id: string): void {
  if (!isPluginEnabled("time-tracker")) return;
  const lead = getLead(id);
  if (!lead) return;
  // Through Time Tracking's own service, not its tables.
  if (lead.project_id && getProject(lead.project_id)) return;
  const converted = convertLead(id);
  if (!converted) return;
  const project = createProject({
    name: lead.company || lead.name,
    customer_id: converted.customer_id,
  });
  getDb().run("UPDATE ld_leads SET project_id = ? WHERE id = ?", [project.id, id]);
}

// ── Quote events ────────────────────────────────────────────────────────────

interface QuoteRow {
  id: string;
  status: string;
  converted_invoice_id: string | null;
  created_at: string;
}

/** Quote events reached so far, in pipeline order; null if the quote is gone. */
function quoteEvents(quote: QuoteRow | null): LeadEvent[] | null {
  if (!quote) return null;
  const s = quote.status;
  const events: LeadEvent[] = ["quote_created"];
  if (s !== "draft") events.push("quote_sent");
  if (s === "accepted" || s === "converted") events.push("quote_accepted");
  if (s === "rejected" || s === "expired") events.push("quote_declined");
  if (s === "converted") {
    events.push("invoice_created");
    // Paid once every invoice made from the quote (one, or one per instalment) is paid.
    const statuses = getDb()
      .query(
        `SELECT i.status FROM invoices i
          WHERE i.id = ? OR i.id IN (SELECT invoice_id FROM quote_instalments WHERE quote_id = ?)`,
      )
      .all(quote.converted_invoice_id, quote.id) as { status: string }[];
    if (statuses.length > 0 && statuses.every((r) => r.status === "paid")) {
      events.push("invoice_paid");
    }
  }
  return events;
}

function getQuoteRow(id: string | null): QuoteRow | null {
  if (!id) return null;
  return getDb()
    .query(
      `SELECT id, status, converted_invoice_id, created_at FROM quotes
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as QuoteRow | null;
}

/** The customer's next quote made since `since` that no other lead follows. */
function nextQuote(leadId: string, customerId: string, since: string, skip: string | null) {
  return getDb()
    .query(
      `SELECT id, status, converted_invoice_id, created_at FROM quotes q
        WHERE q.customer_id = ? AND q.deleted_at IS NULL AND q.created_at >= ?
          AND q.id IS NOT ?
          AND NOT EXISTS (SELECT 1 FROM ld_leads o WHERE o.quote_id = q.id AND o.id != ?)
        ORDER BY q.created_at, q.rowid LIMIT 1`,
    )
    .get(customerId, since, skip, leadId) as QuoteRow | null;
}

interface SyncRow {
  id: string;
  stage: string;
  customer_id: string;
  converted_at: string | null;
  quote_id: string | null;
  events_seen: string | null;
}

/**
 * Link leads to their quotes and apply quote events. Checked when leads are
 * read, so the core quote flow needs no hook.
 *
 * A lead follows the first quote its customer gets after becoming a customer.
 * If that quote is declined, expires or is deleted, a newer quote takes its
 * place (a revised quote revives the lead), unless the lead is already won.
 */
export function syncLeads(ctx: Context = {}): void {
  const config = getLeadsConfig();
  const db = getDb();
  const rows = db
    .query(
      `SELECT id, stage, customer_id, converted_at, quote_id, events_seen
         FROM ld_leads WHERE customer_id IS NOT NULL`,
    )
    .all() as SyncRow[];

  for (const lead of rows) {
    let seen = seenEvents(lead.events_seen);
    let quote = getQuoteRow(lead.quote_id);
    let events = quoteEvents(quote);

    const replaceable = lead.quote_id
      ? (events === null || events.includes("quote_declined")) && lead.stage !== "won"
      : !isClosed(lead.stage);
    if (replaceable && lead.converted_at) {
      const next = nextQuote(
        lead.id,
        lead.customer_id,
        quote?.created_at ?? lead.converted_at,
        lead.quote_id,
      );
      if (next || (lead.quote_id && !quote)) {
        quote = next;
        events = quoteEvents(next);
        // A new quote starts its own events; the follow-up event stays used.
        if (seen) seen = seen.filter((e) => e === "follow_up_set");
      }
    }

    const quoteId = quote?.id ?? null;
    let target: string | undefined;
    if (seen === null) {
      // Leads from before automations were tracked: take today's state as the
      // starting point without moving anything.
      seen = events ?? [];
    } else if (events) {
      for (const e of events) {
        if (seen.includes(e)) continue;
        seen.push(e);
        target = config.triggers[e] ?? target;
      }
    }

    const seenJson = JSON.stringify(seen);
    if (quoteId !== lead.quote_id || seenJson !== lead.events_seen) {
      db.run("UPDATE ld_leads SET quote_id = ?, events_seen = ? WHERE id = ?", [
        quoteId,
        seenJson,
        lead.id,
      ]);
    }
    if (target && target !== lead.stage && stageExists(target, config)) {
      moveLead(lead.id, target, ctx);
    }
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

function whereClause(filters: Omit<LeadFilters, "stage">) {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.search) {
    const q = `%${filters.search}%`;
    conditions.push("(l.name LIKE ? OR l.company LIKE ? OR l.email LIKE ? OR l.phone LIKE ?)");
    params.push(q, q, q, q);
  }
  if (filters.from) {
    conditions.push("date(l.created_at) >= date(?)");
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push("date(l.created_at) <= date(?)");
    params.push(filters.to);
  }
  return { conditions, params };
}

export function listLeads(filters: LeadFilters = {}, ctx: Context = {}): Lead[] {
  syncLeads(ctx);
  const { conditions, params } = whereClause(filters);
  if (filters.stage) {
    conditions.push("l.stage = ?");
    params.push(filters.stage);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // Open leads with a follow-up date first (soonest first), then the rest.
  return getDb()
    .query(
      `${SELECT} ${where}
        ORDER BY (l.stage IN ('won', 'lost')),
                 (l.next_follow_up IS NULL), l.next_follow_up ASC, l.created_at DESC`,
    )
    .all(...params) as Lead[];
}

/** Lead count per stage for the tab badges, honouring search and dates. */
export function countByStage(filters: Omit<LeadFilters, "stage"> = {}): Record<string, number> {
  const { conditions, params } = whereClause(filters);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .query(`SELECT l.stage, COUNT(*) AS n FROM ld_leads l ${where} GROUP BY l.stage`)
    .all(...params) as { stage: string; n: number }[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.stage] = r.n;
  return counts;
}

export function getLead(id: string): Lead | null {
  return (getDb().query(`${SELECT} WHERE l.id = ?`).get(id) as Lead | null) ?? null;
}

export function createLead(input: LeadInput, ctx: Context = {}): Lead {
  const id = crypto.randomBytes(16).toString("hex");
  const stage = input.stage ?? firstOpenStage();
  getDb().run(
    `INSERT INTO ld_leads (id, ${FIELDS.join(", ")}, events_seen)
     VALUES (?, ${FIELDS.map(() => "?").join(", ")}, '[]')`,
    [id, ...FIELDS.map((f) => (f === "stage" ? stage : clean(input[f])))],
  );
  arrive(id, stage, ctx, Boolean(clean(input.next_follow_up)));
  return getLead(id)!;
}

export function updateLead(id: string, input: Partial<LeadInput>, ctx: Context = {}): Lead | null {
  const existing = getLead(id);
  if (!existing) return null;
  const db = getDb();
  const followUp = clean(input.next_follow_up);
  const followUpChanged =
    input.next_follow_up !== undefined && followUp !== existing.next_follow_up;
  const stageChanged = input.stage !== undefined && input.stage !== existing.stage;

  const keys = FIELDS.filter((f) => input[f] !== undefined);
  if (keys.length > 0) {
    db.run(
      `UPDATE ld_leads SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now')
        WHERE id = ?`,
      [...keys.map((k) => clean(input[k])), id],
    );
  }

  if (stageChanged) {
    // A stage picked by hand wins over the follow-up event in the same change.
    arrive(id, input.stage!, ctx, followUpChanged);
  } else if (followUpChanged && followUp && !isClosed(existing.stage)) {
    followUpEvent(id, ctx);
  }
  return getLead(id);
}

/** The first time the user sets a follow-up on an open lead (e.g. "we've been in touch"). */
function followUpEvent(id: string, ctx: Context): void {
  const db = getDb();
  const row = db.query("SELECT stage, events_seen FROM ld_leads WHERE id = ?").get(id) as {
    stage: string;
    events_seen: string | null;
  };
  const seen = seenEvents(row.events_seen) ?? [];
  if (seen.includes("follow_up_set")) return;
  db.run("UPDATE ld_leads SET events_seen = ? WHERE id = ?", [
    JSON.stringify([...seen, "follow_up_set"]),
    id,
  ]);
  const target = getLeadsConfig().triggers.follow_up_set;
  if (target && target !== row.stage && stageExists(target)) moveLead(id, target, ctx, true);
}

export function deleteLead(id: string): boolean {
  return getDb().run("DELETE FROM ld_leads WHERE id = ?", [id]).changes > 0;
}

/**
 * Make the lead a customer (or reuse the one it already became). The customer
 * is named after the company when there is one, otherwise the person.
 */
export function convertLead(id: string): { lead: Lead; customer_id: string } | null {
  const lead = getLead(id);
  if (!lead) return null;
  if (lead.customer_id && getCustomer(lead.customer_id)) {
    return { lead, customer_id: lead.customer_id };
  }
  const contact = lead.company ? `Contact: ${lead.name}` : "";
  const customer = createCustomer({
    name: lead.company || lead.name,
    customer_type: lead.company ? "company" : "individual",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    notes: [contact, lead.notes ?? ""].filter(Boolean).join("\n"),
  });
  getDb().run(
    `UPDATE ld_leads SET customer_id = ?, converted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`,
    [customer.id, id],
  );
  return { lead: getLead(id)!, customer_id: customer.id };
}

/**
 * Get a lead ready for its quote: make it a customer if needed. The lead moves
 * (by the quote_created trigger) once the quote is actually saved, not before.
 */
export function startQuote(id: string): { lead: Lead; customer_id: string } | null {
  return convertLead(id);
}
