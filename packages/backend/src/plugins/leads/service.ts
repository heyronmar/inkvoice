// Leads business logic: a simple sales list (New → Contacted → Quoted → Won /
// Lost) with follow-up dates, plus conversion into a real customer.

import crypto from "node:crypto";
import { getDb } from "../../database/connection";
import { createCustomer, getCustomer } from "../../services/customer.service";
import { isPluginEnabled } from "../settings";
import { getLeadsConfig, type LeadStage } from "./config";

export { LEAD_SOURCES, LEAD_STAGES, type LeadStage } from "./config";

export interface Lead {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  value: number | null;
  stage: LeadStage;
  next_follow_up: string | null;
  notes: string | null;
  customer_id: string | null;
  converted_at: string | null;
  /** Time Tracking project created when the lead was won (see project_on_won). */
  project_id: string | null;
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
  stage?: LeadStage;
  next_follow_up?: string | null;
  notes?: string | null;
}

export interface LeadFilters {
  stage?: LeadStage;
  search?: string;
  from?: string;
  to?: string;
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

/** Blank strings are stored as NULL so "no email" and "" never differ. */
function clean(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  return v as number;
}

/**
 * Quote-driven automations, checked lazily on read so no hook into the core
 * quote flow is needed. Only quotes changed after quoting began (converted_at)
 * count.
 *  - won_on_accept: a quoted lead whose customer accepted a quote (or had one
 *    turned into an invoice) is won.
 *  - lost_on_decline: a quoted lead whose customer declined a quote, or let it
 *    expire, with no other quote still open or accepted, is lost.
 */
export function syncLeads(): void {
  const { automations } = getLeadsConfig();
  const db = getDb();
  const since = `q.customer_id = l.customer_id AND q.deleted_at IS NULL
                 AND q.updated_at >= l.converted_at`;
  if (automations.won_on_accept) {
    const won = db
      .query(
        `SELECT l.id FROM ld_leads l
          WHERE l.stage = 'quoted' AND l.customer_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM quotes q
                         WHERE ${since} AND q.status IN ('accepted', 'converted'))`,
      )
      .all() as { id: string }[];
    for (const { id } of won) {
      setStage(id, "won");
      onWon(id);
    }
  }
  if (automations.lost_on_decline) {
    db.run(
      `UPDATE ld_leads SET stage = 'lost', updated_at = datetime('now')
        WHERE stage = 'quoted' AND customer_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM quotes q, ld_leads l
                       WHERE l.id = ld_leads.id AND ${since}
                         AND q.status IN ('rejected', 'expired'))
          AND NOT EXISTS (SELECT 1 FROM quotes q, ld_leads l
                           WHERE l.id = ld_leads.id AND ${since}
                             AND q.status IN ('draft', 'sent', 'accepted', 'converted'))`,
    );
  }
}

function setStage(id: string, stage: LeadStage): void {
  getDb().run("UPDATE ld_leads SET stage = ?, updated_at = datetime('now') WHERE id = ?", [
    stage,
    id,
  ]);
}

/**
 * project_on_won: give a newly won lead a Time Tracking project for its
 * customer (converting the lead first if needed). Done once per lead, and only
 * while Time Tracking is switched on.
 */
function onWon(id: string): void {
  if (!getLeadsConfig().automations.project_on_won || !isPluginEnabled("time-tracker")) return;
  const db = getDb();
  const lead = getLead(id);
  if (!lead) return;
  if (lead.project_id && db.query("SELECT 1 FROM tt_projects WHERE id = ?").get(lead.project_id)) {
    return;
  }
  const converted = convertLead(id);
  if (!converted) return;
  const projectId = crypto.randomBytes(16).toString("hex");
  db.run("INSERT INTO tt_projects (id, name, customer_id) VALUES (?, ?, ?)", [
    projectId,
    lead.company || lead.name,
    converted.customer_id,
  ]);
  db.run("UPDATE ld_leads SET project_id = ? WHERE id = ?", [projectId, id]);
}

function whereClause(filters: Omit<LeadFilters, "stage">) {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.search) {
    const q = `%${filters.search}%`;
    conditions.push("(name LIKE ? OR company LIKE ? OR email LIKE ? OR phone LIKE ?)");
    params.push(q, q, q, q);
  }
  if (filters.from) {
    conditions.push("date(created_at) >= date(?)");
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push("date(created_at) <= date(?)");
    params.push(filters.to);
  }
  return { conditions, params };
}

export function listLeads(filters: LeadFilters = {}): Lead[] {
  syncLeads();
  const { conditions, params } = whereClause(filters);
  if (filters.stage) {
    conditions.push("stage = ?");
    params.push(filters.stage);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // Open leads with a follow-up date first (soonest first), then the rest.
  return getDb()
    .query(
      `SELECT * FROM ld_leads ${where}
        ORDER BY (stage IN ('won', 'lost')),
                 (next_follow_up IS NULL), next_follow_up ASC, created_at DESC`,
    )
    .all(...params) as Lead[];
}

/** Lead count per stage for the tab badges, honouring search and dates. */
export function countByStage(filters: Omit<LeadFilters, "stage"> = {}): Record<string, number> {
  const { conditions, params } = whereClause(filters);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .query(`SELECT stage, COUNT(*) AS n FROM ld_leads ${where} GROUP BY stage`)
    .all(...params) as { stage: string; n: number }[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.stage] = r.n;
  return counts;
}

export function getLead(id: string): Lead | null {
  return (getDb().query("SELECT * FROM ld_leads WHERE id = ?").get(id) as Lead | null) ?? null;
}

/**
 * contacted_on_follow_up: setting a follow-up date on an existing New lead
 * means you've been in touch, so it moves to Contacted. Adding a lead with a
 * date doesn't count, so the automatic follow-up date for new leads can't
 * trigger it.
 */
function contactedStage(stage: LeadStage, followUp: unknown): LeadStage {
  return stage === "new" && clean(followUp) && getLeadsConfig().automations.contacted_on_follow_up
    ? "contacted"
    : stage;
}

export function createLead(input: LeadInput): Lead {
  const id = crypto.randomBytes(16).toString("hex");
  const stage = input.stage ?? "new";
  getDb().run(
    `INSERT INTO ld_leads (id, ${FIELDS.join(", ")}) VALUES (?, ${FIELDS.map(() => "?").join(", ")})`,
    [id, ...FIELDS.map((f) => (f === "stage" ? stage : clean(input[f])))],
  );
  if (stage === "won") onWon(id);
  return getLead(id)!;
}

export function updateLead(id: string, input: Partial<LeadInput>): Lead | null {
  const existing = getLead(id);
  if (!existing) return null;
  const data = { ...input };
  if (data.next_follow_up !== undefined && clean(data.next_follow_up) !== existing.next_follow_up) {
    data.stage = contactedStage(data.stage ?? existing.stage, data.next_follow_up);
  }
  const keys = FIELDS.filter((f) => data[f] !== undefined);
  if (keys.length > 0) {
    getDb().run(
      `UPDATE ld_leads SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now')
        WHERE id = ?`,
      [...keys.map((k) => clean(data[k])), id],
    );
  }
  if (data.stage === "won" && existing.stage !== "won") onWon(id);
  return getLead(id);
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

/** Convert if needed and move the lead to Quoted, ready for a new quote. */
export function startQuote(id: string): { lead: Lead; customer_id: string } | null {
  const converted = convertLead(id);
  if (!converted) return null;
  if (converted.lead.stage === "new" || converted.lead.stage === "contacted") {
    getDb().run(
      // converted_at marks when quoting began, so only quotes accepted from
      // here on can mark this lead won.
      `UPDATE ld_leads SET stage = 'quoted', converted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`,
      [id],
    );
  }
  return { lead: getLead(id)!, customer_id: converted.customer_id };
}
