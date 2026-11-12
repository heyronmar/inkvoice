// Leads settings on the client: the stages (order, names, colours, automations)
// and the source list, shared by the Leads page, the board and the settings panel.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@/i18n";
import {
  isClosed,
  LEAD_SOURCES,
  type LeadEvent,
  type LeadsConfig,
  leadsApi,
  type StageColor,
  type StageSetting,
} from "./api";

const noActions = () => ({ make_customer: false, follow_up_days: null, create_project: false });

export const DEFAULT_CONFIG: LeadsConfig = {
  stages: (
    [
      ["new", "sky"],
      ["contacted", "amber"],
      ["quoted", "violet"],
      ["won", "emerald"],
      ["lost", "slate"],
    ] as const
  ).map(([id, color]) => ({ id, label: null, color, hidden: false, actions: noActions() })),
  sources: [...LEAD_SOURCES],
  triggers: { quote_created: "quoted", quote_accepted: "won" },
};

/** Badge and column colours. */
export const STAGE_STYLES: Record<StageColor, string> = {
  sky: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  amber: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  violet: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  emerald: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  rose: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  teal: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  orange: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  slate: "bg-muted text-muted-foreground",
};

/** Solid swatches for the colour picker. */
export const STAGE_SWATCHES: Record<StageColor, string> = {
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  violet: "bg-violet-500",
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  teal: "bg-teal-500",
  orange: "bg-orange-500",
  slate: "bg-slate-400",
};

export function stageStyle(config: LeadsConfig, id: string): string {
  const color = config.stages.find((s) => s.id === id)?.color ?? "slate";
  return STAGE_STYLES[color];
}

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

/** Where a stage sits decides which automations make sense (same rules as the server). */
export type StageRole = "first" | "middle" | "won" | "lost";

export function stageRole(config: LeadsConfig, id: string): StageRole {
  if (id === "won" || id === "lost") return id;
  return config.stages.find((s) => !isClosed(s.id))?.id === id ? "first" : "middle";
}

const ROLE_EVENTS: Record<StageRole, readonly LeadEvent[]> = {
  first: [],
  middle: FORWARD_EVENTS,
  won: ["quote_accepted", "invoice_created", "invoice_paid"],
  lost: ["quote_declined"],
};

/** The stage's own trigger, if it has one. */
export function stageTrigger(config: LeadsConfig, id: string): LeadEvent | undefined {
  return (Object.entries(config.triggers) as [LeadEvent, string][]).find(([, s]) => s === id)?.[0];
}

/**
 * Events this stage can use: they fit its role, aren't used by another stage,
 * and keep the pipeline in order (after every earlier stage's event, before
 * every later stage's).
 */
export function eventsFor(config: LeadsConfig, id: string): LeadEvent[] {
  const role = stageRole(config, id);
  if (role === "lost") return [...ROLE_EVENTS.lost];
  const ordered = config.stages.filter((s) => s.id !== "lost");
  const at = ordered.findIndex((s) => s.id === id);
  const ranks = (list: typeof ordered) =>
    list
      .map((s) => stageTrigger(config, s.id))
      .filter((e): e is LeadEvent => !!e)
      .map(rank);
  const after = Math.max(-1, ...ranks(ordered.slice(0, at)));
  const before = Math.min(FORWARD_EVENTS.length, ...ranks(ordered.slice(at + 1)));
  return ROLE_EVENTS[role].filter((e) => rank(e) > after && rank(e) < before);
}

/** Drop rules that no longer fit, e.g. after stages are reordered. Same as the server. */
export function tidyTriggers(config: LeadsConfig): LeadsConfig {
  const triggers: LeadsConfig["triggers"] = {};
  let last = -1;
  for (const stage of config.stages) {
    const role = stageRole(config, stage.id);
    const pick = ROLE_EVENTS[role].find(
      (e) => config.triggers[e] === stage.id && (role === "lost" || rank(e) > last),
    );
    if (!pick) continue;
    triggers[pick] = stage.id;
    if (role !== "lost") last = rank(pick);
  }
  const stages = config.stages.map((s) => {
    const role = stageRole(config, s.id);
    return {
      ...s,
      actions: {
        make_customer: (role === "middle" || role === "won") && s.actions.make_customer,
        follow_up_days: role === "first" || role === "middle" ? s.actions.follow_up_days : null,
        create_project: role === "won" && s.actions.create_project,
      },
    };
  });
  return { ...config, stages, triggers };
}

/** How many automations a stage has, for the badge on its ⚡ button. */
export function automationCount(config: LeadsConfig, stage: StageSetting): number {
  const triggers = Object.values(config.triggers).filter((s) => s === stage.id).length;
  const { make_customer, follow_up_days, create_project } = stage.actions;
  return triggers + Number(make_customer) + Number(!!follow_up_days) + Number(create_project);
}

export function newStageId(): string {
  return `c_${Math.random().toString(36).slice(2, 10).padEnd(6, "0")}`;
}

export function useLeadsConfig() {
  const [config, setConfig] = useState<LeadsConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await leadsApi.getSettings();
      setConfig(res.data);
    } catch {
      // Keep the defaults; the page still works without saved settings.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { config, setConfig, loaded, reload };
}

/** Labels for stages and sources, honouring custom stage names. */
export function useLeadLabels(config: LeadsConfig) {
  const { t } = useTranslation();
  const stageLabel = (id: string) =>
    config.stages.find((s) => s.id === id)?.label ||
    (["new", "contacted", "quoted", "won", "lost"].includes(id) ? t(`leads.stage_${id}`) : id);
  const sourceLabel = (source: string) =>
    (LEAD_SOURCES as readonly string[]).includes(source) ? t(`leads.source_${source}`) : source;
  return { stageLabel, sourceLabel };
}
