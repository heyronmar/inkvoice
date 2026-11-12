// Typed client for the Leads plugin API (/api/v1/plugins/leads).

import { pluginFetch } from "../api";

const BASE = "/plugins/leads";

export const LEAD_STAGES = ["new", "contacted", "quoted", "won", "lost"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Built-in sources (translated labels). Businesses can add their own in Leads settings. */
export const LEAD_SOURCES = ["website", "referral", "social", "phone", "email", "other"] as const;

export const CLOSED_STAGES: readonly LeadStage[] = ["won", "lost"];

export interface StageSetting {
  id: LeadStage;
  label: string | null;
  hidden: boolean;
}

export interface LeadsConfig {
  stages: StageSetting[];
  sources: string[];
  follow_up_days: number | null;
  automations: {
    won_on_accept: boolean;
    lost_on_decline: boolean;
    contacted_on_follow_up: boolean;
    project_on_won: boolean;
  };
}

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
  project_id: string | null;
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
  stage?: LeadStage;
  search?: string;
  from?: string;
  to?: string;
}

function query(filters: LeadFilters): string {
  const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<
    string,
    string
  >;
  const qs = new URLSearchParams(params).toString();
  return qs ? `?${qs}` : "";
}

export const leadsApi = {
  list: (filters: LeadFilters) =>
    pluginFetch<{ data: { items: Lead[]; counts: Partial<Record<LeadStage, number>> } }>(
      `${BASE}/leads${query(filters)}`,
    ),
  exportUrl: (filters: LeadFilters) => `/api/v1${BASE}/leads/export${query(filters)}`,
  create: (input: LeadInput) =>
    pluginFetch<{ data: Lead }>(`${BASE}/leads`, { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, input: LeadInput) =>
    pluginFetch<{ data: Lead }>(`${BASE}/leads/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
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
