// Leads business logic: a simple sales list (New → Contacted → Quoted → Won /
// Lost) with follow-up dates, plus conversion into a real customer.

import crypto from "node:crypto";
import { getDb } from "../../database/connection";
import { createCustomer, getCustomer } from "../../services/customer.service";

export const LEAD_STAGES = ["new", "contacted", "quoted", "won", "lost"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_SOURCES = ["website", "referral", "social", "phone", "email", "other"] as const;

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
 * A quoted lead whose customer has since accepted a quote (or had one turned
 * into an invoice) is won. Checked lazily on read, so no hook into the core
 * quote flow is needed.
 */
export function syncWonLeads(): void {
  getDb().run(
    `UPDATE ld_leads SET stage = 'won', updated_at = datetime('now')
      WHERE stage = 'quoted' AND customer_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM quotes q
           WHERE q.customer_id = ld_leads.customer_id
             AND q.deleted_at IS NULL
             AND q.status IN ('accepted', 'converted')
             AND q.updated_at >= ld_leads.converted_at
        )`,
  );
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
  syncWonLeads();
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

export function createLead(input: LeadInput): Lead {
  const id = crypto.randomBytes(16).toString("hex");
  getDb().run(
    `INSERT INTO ld_leads (id, ${FIELDS.join(", ")}) VALUES (?, ${FIELDS.map(() => "?").join(", ")})`,
    [id, ...FIELDS.map((f) => (f === "stage" ? (input.stage ?? "new") : clean(input[f])))],
  );
  return getLead(id)!;
}

export function updateLead(id: string, input: Partial<LeadInput>): Lead | null {
  if (!getLead(id)) return null;
  const keys = FIELDS.filter((f) => input[f] !== undefined);
  if (keys.length > 0) {
    getDb().run(
      `UPDATE ld_leads SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now')
        WHERE id = ?`,
      [...keys.map((k) => clean(input[k])), id],
    );
  }
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
