// Leads settings, edited on the plugin's page under Settings → Plugins and
// stored as one JSON value in the settings KV store. Reads always return a
// complete, valid config: missing or unknown parts fall back to the defaults.

import { getSetting, updateSettings } from "../../services/settings.service";

export const LEAD_STAGES = ["new", "contacted", "quoted", "won", "lost"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Won and Lost close a lead. They always come last and can't be hidden. */
export const CLOSED_STAGES: readonly LeadStage[] = ["won", "lost"];

/** Built-in sources. Their labels are translated; any other source is shown as typed. */
export const LEAD_SOURCES = ["website", "referral", "social", "phone", "email", "other"] as const;

export interface StageSetting {
  id: LeadStage;
  /** Custom name; null shows the translated default. */
  label: string | null;
  hidden: boolean;
}

export interface LeadsConfig {
  stages: StageSetting[];
  sources: string[];
  /** Days after a lead is added or moved to an open stage to set the next follow-up; null is off. */
  follow_up_days: number | null;
  automations: {
    won_on_accept: boolean;
    lost_on_decline: boolean;
    contacted_on_follow_up: boolean;
    project_on_won: boolean;
  };
}

const KEY = "leads_settings";

export function defaultLeadsConfig(): LeadsConfig {
  return {
    stages: LEAD_STAGES.map((id) => ({ id, label: null, hidden: false })),
    sources: [...LEAD_SOURCES],
    follow_up_days: null,
    automations: {
      won_on_accept: true,
      lost_on_decline: false,
      contacted_on_follow_up: false,
      project_on_won: false,
    },
  };
}

/** Every stage exactly once, open stages in the saved order, then Won and Lost. */
function normalise(input: Partial<LeadsConfig>): LeadsConfig {
  const base = defaultLeadsConfig();
  const saved = new Map((input.stages ?? []).map((s) => [s.id, s]));
  const isOpen = (id: LeadStage) => LEAD_STAGES.includes(id) && !CLOSED_STAGES.includes(id);
  const open = [...saved.keys(), ...LEAD_STAGES].filter(isOpen);
  const order = [...new Set(open), ...CLOSED_STAGES];
  const stages: StageSetting[] = order.map((id) => {
    const s = saved.get(id);
    return {
      id,
      label: s?.label?.trim() || null,
      hidden: isOpen(id) && Boolean(s?.hidden),
    };
  });

  const sources = (input.sources ?? base.sources)
    .map((s) => s.trim())
    .filter((s, i, all) => s && all.indexOf(s) === i);

  const days = input.follow_up_days;
  return {
    stages,
    sources,
    follow_up_days: typeof days === "number" && days > 0 ? Math.min(Math.round(days), 365) : null,
    automations: { ...base.automations, ...(input.automations ?? {}) },
  };
}

export function getLeadsConfig(): LeadsConfig {
  const raw = getSetting(KEY);
  if (!raw) return defaultLeadsConfig();
  try {
    return normalise(JSON.parse(raw) as Partial<LeadsConfig>);
  } catch {
    return defaultLeadsConfig();
  }
}

export function saveLeadsConfig(input: Partial<LeadsConfig>): LeadsConfig {
  const config = normalise(input);
  updateSettings({ [KEY]: JSON.stringify(config) });
  return config;
}
