// Leads settings, edited on the plugin's page under Settings → Plugins and on
// the board. Stored as one JSON value in the settings KV store. Reads always
// return a complete, valid config: missing or unknown parts fall back to the
// defaults, and automation rules that contradict each other are dropped.

import { getDb } from "../../database/connection";
import { getSetting, updateSettings } from "../../services/settings.service";

/** Won and Lost close a lead. They always exist, come last and can't be hidden. */
export const CLOSED_STAGES = ["won", "lost"] as const;
export type ClosedStage = (typeof CLOSED_STAGES)[number];

/** The working stages a new install starts with. Each can be renamed or removed. */
export const DEFAULT_OPEN_STAGES = ["new", "contacted", "quoted"] as const;

/** Working stages a business can have, on top of Won and Lost. */
export const MAX_OPEN_STAGES = 8;

/** Built-in sources. Their labels are translated; any other source is shown as typed. */
export const LEAD_SOURCES = ["website", "referral", "social", "phone", "email", "other"] as const;

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

/**
 * Things that happen to a lead and can move it to a stage. Each fires once per
 * lead (per quote for the quote events), at the moment it happens, so a lead
 * moved by hand afterwards is never pulled back.
 */
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

/** Events that move a deal forward, in the order they happen. */
const FORWARD_EVENTS: readonly LeadEvent[] = [
  "follow_up_set",
  "quote_created",
  "quote_sent",
  "quote_accepted",
  "invoice_created",
  "invoice_paid",
];
const rank = (e: LeadEvent) => FORWARD_EVENTS.indexOf(e);

/**
 * Where a stage sits decides what makes sense for it:
 *  - first: new leads start here, so nothing moves them in;
 *  - middle: any forward event, in pipeline order;
 *  - won: the deal going ahead (accepted, invoiced, paid);
 *  - lost: a declined or expired quote.
 */
export type StageRole = "first" | "middle" | "won" | "lost";

export function stageRole(stages: { id: string }[], id: string): StageRole {
  if (id === "won" || id === "lost") return id;
  return stages.find((s) => !isClosed(s.id))?.id === id ? "first" : "middle";
}

const ROLE_EVENTS: Record<StageRole, readonly LeadEvent[]> = {
  first: [],
  middle: FORWARD_EVENTS,
  won: ["quote_accepted", "invoice_created", "invoice_paid"],
  lost: ["quote_declined"],
};

/** What happens when a lead arrives in a stage, by automation or by hand. */
export interface StageActions {
  /** Turn the lead into a customer (once). */
  make_customer: boolean;
  /** Set the next follow-up this many days ahead; open stages only. */
  follow_up_days: number | null;
  /** Create a Time Tracking project for the lead's customer (once); not on Lost. */
  create_project: boolean;
}

export interface StageSetting {
  /** "new", "contacted", "quoted", "won", "lost", or "c_…" for a stage the business added. */
  id: string;
  /** Custom name; null shows the translated default (built-in stages only). */
  label: string | null;
  color: StageColor;
  hidden: boolean;
  actions: StageActions;
}

export interface LeadsConfig {
  /** Open stages in board order, then Won, then Lost. */
  stages: StageSetting[];
  sources: string[];
  /** Which stage each event moves a lead to. An event belongs to at most one stage. */
  triggers: Partial<Record<LeadEvent, string>>;
}

const KEY = "leads_settings";

const DEFAULT_COLORS: Record<string, StageColor> = {
  new: "sky",
  contacted: "amber",
  quoted: "violet",
  won: "emerald",
  lost: "slate",
};

/** English names for the built-in stages, for the CSV export. */
const DEFAULT_NAMES: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  quoted: "Quoted",
  won: "Won",
  lost: "Lost",
};

const CUSTOM_ID = /^c_[a-z0-9]{4,16}$/;
const BUILT_IN_OPEN: readonly string[] = DEFAULT_OPEN_STAGES;

export const isClosed = (id: string): id is ClosedStage =>
  (CLOSED_STAGES as readonly string[]).includes(id);

const isOpenId = (id: unknown): id is string =>
  typeof id === "string" && (BUILT_IN_OPEN.includes(id) || CUSTOM_ID.test(id));

const noActions = (): StageActions => ({
  make_customer: false,
  follow_up_days: null,
  create_project: false,
});

export function defaultLeadsConfig(): LeadsConfig {
  return {
    stages: [...DEFAULT_OPEN_STAGES, ...CLOSED_STAGES].map((id) => ({
      id,
      label: null,
      color: DEFAULT_COLORS[id],
      hidden: false,
      actions: noActions(),
    })),
    sources: [...LEAD_SOURCES],
    // An invoice made from a quote counts as accepted too, so this covers both.
    triggers: { quote_created: "quoted", quote_accepted: "won" },
  };
}

/**
 * Each stage gets at most one trigger, and triggers follow the pipeline: a
 * later stage's event always happens after an earlier stage's. Rules that
 * don't fit (e.g. after reordering stages) are dropped.
 */
function orderTriggers(
  stages: StageSetting[],
  raw: Partial<Record<string, unknown>>,
): LeadsConfig["triggers"] {
  const triggers: LeadsConfig["triggers"] = {};
  let last = -1;
  for (const stage of stages) {
    const role = stageRole(stages, stage.id);
    const pick = ROLE_EVENTS[role].find(
      (e) => raw[e] === stage.id && (role === "lost" || rank(e) > last),
    );
    if (!pick) continue;
    triggers[pick] = stage.id;
    if (role !== "lost") last = rank(pick);
  }
  return triggers;
}

function cleanDays(days: unknown): number | null {
  return typeof days === "number" && days > 0 ? Math.min(Math.round(days), 365) : null;
}

/**
 * Arrival actions that fit the stage: a follow-up while the lead is still
 * being worked on, a customer once past the first stage, a project once won.
 */
function cleanActions(input: Partial<StageActions> | undefined, role: StageRole): StageActions {
  return {
    make_customer: (role === "middle" || role === "won") && Boolean(input?.make_customer),
    follow_up_days: role === "first" || role === "middle" ? cleanDays(input?.follow_up_days) : null,
    create_project: role === "won" && Boolean(input?.create_project),
  };
}

/** Settings saved before stages were customisable: follow_up_days + four switches. */
interface LegacyConfig {
  follow_up_days?: number | null;
  automations?: {
    won_on_accept?: boolean;
    lost_on_decline?: boolean;
    contacted_on_follow_up?: boolean;
    project_on_won?: boolean;
  };
}

function fromLegacy(input: LegacyConfig, stages: StageSetting[]): LeadsConfig["triggers"] {
  const a = input.automations ?? {};
  const days = cleanDays(input.follow_up_days);
  for (const s of stages) {
    // The old follow-up default applied on moving to any open stage but New.
    if (days && !isClosed(s.id) && s.id !== "new") s.actions.follow_up_days = days;
    if (s.id === "won" && a.project_on_won) s.actions.create_project = true;
  }
  const triggers: LeadsConfig["triggers"] = { quote_created: "quoted" };
  if (a.won_on_accept !== false) triggers.quote_accepted = "won";
  if (a.lost_on_decline) triggers.quote_declined = "lost";
  if (a.contacted_on_follow_up) triggers.follow_up_set = "contacted";
  return triggers;
}

export function normalise(input: Partial<LeadsConfig> & LegacyConfig): LeadsConfig {
  const base = defaultLeadsConfig();
  const saved = new Map(
    (Array.isArray(input.stages) ? input.stages : base.stages).map((s) => [s.id, s]),
  );

  let open = [...saved.keys()].filter(isOpenId).slice(0, MAX_OPEN_STAGES);
  if (open.length === 0) open = ["new"];
  const order = [...open, ...CLOSED_STAGES].map((id) => ({ id }));
  const stages: StageSetting[] = order.map(({ id }) => {
    const s = saved.get(id);
    const label = typeof s?.label === "string" ? s.label.trim().slice(0, 40) : "";
    return {
      id,
      // A stage the business added has no translated default, so it keeps a name.
      label: label || (CUSTOM_ID.test(id) ? "Stage" : null),
      color: STAGE_COLORS.includes(s?.color as StageColor)
        ? (s?.color as StageColor)
        : (DEFAULT_COLORS[id] ?? "slate"),
      hidden: !isClosed(id) && Boolean(s?.hidden),
      actions: cleanActions(s?.actions, stageRole(order, id)),
    };
  });

  const rawTriggers =
    input.triggers && typeof input.triggers === "object"
      ? input.triggers
      : input.automations || input.follow_up_days !== undefined
        ? fromLegacy(input, stages)
        : base.triggers;
  const triggers = orderTriggers(stages, rawTriggers);

  const sources = (Array.isArray(input.sources) ? input.sources : base.sources)
    .map((s) => String(s).trim())
    .filter((s, i, all) => s && all.indexOf(s) === i);

  return { stages, sources, triggers };
}

export function getLeadsConfig(): LeadsConfig {
  const raw = getSetting(KEY);
  if (!raw) return defaultLeadsConfig();
  try {
    return normalise(JSON.parse(raw));
  } catch {
    return defaultLeadsConfig();
  }
}

export class LeadsConfigError extends Error {}

/**
 * Save the settings. A stage can only be removed once it's empty, so no lead
 * is ever left in a stage that no longer exists.
 */
export function saveLeadsConfig(input: Partial<LeadsConfig>): LeadsConfig {
  const config = normalise(input);
  const kept = new Set(config.stages.map((s) => s.id));
  const orphans = getDb()
    .query("SELECT stage, COUNT(*) AS n FROM ld_leads GROUP BY stage")
    .all() as { stage: string; n: number }[];
  const blocked = orphans.filter((o) => !kept.has(o.stage));
  if (blocked.length > 0) {
    const current = getLeadsConfig();
    const names = blocked.map((o) => `${stageName(current, o.stage)} (${o.n})`);
    throw new LeadsConfigError(
      `Move the leads out of these stages before removing them: ${names.join(", ")}`,
    );
  }
  updateSettings({ [KEY]: JSON.stringify(config) });
  return config;
}

export function stageName(config: LeadsConfig, id: string): string {
  return config.stages.find((s) => s.id === id)?.label || DEFAULT_NAMES[id] || id;
}

export function getStage(config: LeadsConfig, id: string): StageSetting | undefined {
  return config.stages.find((s) => s.id === id);
}
