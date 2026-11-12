// Leads settings on the client: the stage order and names, the source list and
// the follow-up default, shared by the Leads page and the settings panel.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@/i18n";
import { LEAD_SOURCES, LEAD_STAGES, type LeadStage, type LeadsConfig, leadsApi } from "./api";

export const DEFAULT_CONFIG: LeadsConfig = {
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
  const stageLabel = (id: LeadStage) =>
    config.stages.find((s) => s.id === id)?.label || t(`leads.stage_${id}`);
  const sourceLabel = (source: string) =>
    (LEAD_SOURCES as readonly string[]).includes(source) ? t(`leads.source_${source}`) : source;
  return { stageLabel, sourceLabel };
}

/** Local date `days` from today, as YYYY-MM-DD. */
export function isoDateIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
