// Typed client for the Leads plugin API (/api/v1/plugins/leads).

import { pluginFetch } from "../api";

const BASE = "/plugins/leads";

export const LEAD_STAGES = ["new", "contacted", "quoted", "won", "lost"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_SOURCES = ["website", "referral", "social", "phone", "email", "other"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export interface Lead {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: LeadSource | null;
  value: number | null;
  stage: LeadStage;
  next_follow_up: string | null;
  notes: string | null;
  customer_id: string | null;
  converted_at: string | null;
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
  startQuote: (id: string) =>
    pluginFetch<{ data: { lead: Lead; customer_id: string } }>(`${BASE}/leads/${id}/quote`, {
      method: "POST",
    }),
};
