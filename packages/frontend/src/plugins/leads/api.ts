// Typed client for the Leads plugin API (/api/v1/plugins/leads).

import { pluginFetch } from "../api";

const BASE = "/plugins/leads";

/** Built-in sources (translated labels). Businesses can add their own in Leads settings. */
export const LEAD_SOURCES = ["website", "referral", "social", "phone", "email", "other"] as const;

/** Won and Lost close a lead; they always exist and come last. */
export const CLOSED_STAGES: readonly string[] = ["won", "lost"];
export const isClosed = (stage: string) => CLOSED_STAGES.includes(stage);

/** Working stages allowed on top of Won and Lost. */
export const MAX_OPEN_STAGES = 8;

export const STAGE_COLORS = [
  "sky",
  "amber",
  "violet",
  "emerald",
  "rose",
  "teal",
  "orange",
  "slate",
] as const;
export type StageColor = (typeof STAGE_COLORS)[number];

/** Things that can move a lead to a stage, in the order they usually happen. */
export const LEAD_EVENTS = [
  "follow_up_set",
  "quote_created",
  "quote_sent",
  "quote_accepted",
  "quote_declined",
  "invoice_created",
  "invoice_paid",
] as const;
export type LeadEvent = (typeof LEAD_EVENTS)[number];

export interface StageActions {
  make_customer: boolean;
  follow_up_days: number | null;
  create_project: boolean;
}

export interface StageSetting {
  /** Built-in id, or "c_…" for a stage the business added. */
  id: string;
  label: string | null;
  color: StageColor;
  hidden: boolean;
  actions: StageActions;
}

export interface LeadsConfig {
  stages: StageSetting[];
  sources: string[];
  /** Which stage each event moves a lead to; an event belongs to one stage at most. */
  triggers: Partial<Record<LeadEvent, string>>;
}

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
  project_id: string | null;
  /** The quote this lead follows, once one has been made for it. */
  quote_id: string | null;
  quote_number: string | null;
  quote_status: string | null;
  created_at: string;
  updated_at: string;
}

export type LeadInput = Partial<
  Pick<
    Lead,
    | "name"
    | "company"
    | "email"
    | "phone"
    | "source"
    | "value"
    | "stage"
    | "next_follow_up"
    | "notes"
  >
>;

export interface LeadFilters {
  stage?: string;
  search?: string;
  from?: string;
  to?: string;
}

/** The user's local date, so follow-ups set by automations land on the right day. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function query(filters: LeadFilters): string {
  const params = Object.fromEntries(
    Object.entries({ ...filters, today: localToday() }).filter(([, v]) => v),
  ) as Record<string, string>;
  const qs = new URLSearchParams(params).toString();
  return qs ? `?${qs}` : "";
}

export const leadsApi = {
  list: (filters: LeadFilters) =>
    pluginFetch<{ data: { items: Lead[]; counts: Record<string, number> } }>(
      `${BASE}/leads${query(filters)}`,
    ),
  exportUrl: (filters: LeadFilters) => `/api/v1${BASE}/leads/export${query(filters)}`,
  create: (input: LeadInput) =>
    pluginFetch<{ data: Lead }>(`${BASE}/leads`, {
      method: "POST",
      body: JSON.stringify({ ...input, today: localToday() }),
    }),
  update: (id: string, input: LeadInput) =>
    pluginFetch<{ data: Lead }>(`${BASE}/leads/${id}`, {
      method: "PUT",
      body: JSON.stringify({ ...input, today: localToday() }),
    }),
  remove: (id: string) => pluginFetch(`${BASE}/leads/${id}`, { method: "DELETE" }),
  convert: (id: string) =>
    pluginFetch<{ data: { lead: Lead; customer_id: string } }>(`${BASE}/leads/${id}/convert`, {
      method: "POST",
    }),
  getSettings: () => pluginFetch<{ data: LeadsConfig }>(`${BASE}/settings`),
  saveSettings: (config: LeadsConfig) =>
    pluginFetch<{ data: LeadsConfig }>(`${BASE}/settings`, {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  startQuote: (id: string) =>
    pluginFetch<{ data: { lead: Lead; customer_id: string } }>(`${BASE}/leads/${id}/quote`, {
      method: "POST",
    }),
};
