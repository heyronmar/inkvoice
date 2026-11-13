// One stage's automations: which events move leads into it, and what happens
// when a lead arrives. Opened from the ⚡ button on a board column or a stage
// row in Leads settings. Rules that would contradict each other can't be set.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/i18n";
import { usePluginsStore } from "../use-plugins.store";
import { isClosed, LEAD_EVENTS, type LeadEvent, type LeadsConfig, type StageActions } from "./api";
import { triggerAllowed, useLeadLabels } from "./config";

export function StageAutomationsDialog({
  open,
  onOpenChange,
  config,
  stageId,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: LeadsConfig;
  stageId: string | null;
  /** Receives the whole config with this stage's rules changed. */
  onApply: (config: LeadsConfig) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const { stageLabel } = useLeadLabels(config);
  const timeTrackingOn = usePluginsStore((s) => s.isEnabled("time-tracker"));
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDraft(config);
  }, [open, config]);

  const stage = draft.stages.find((s) => s.id === stageId);
  if (!stage || !stageId) return null;
  const name = stageLabel(stageId);
  const closed = isClosed(stageId);
  const isLost = stageId === "lost";

  const toggleTrigger = (event: LeadEvent, on: boolean) =>
    setDraft((d) => {
      const triggers = { ...d.triggers };
      // An event belongs to one stage, so turning it on here takes it from another.
      if (on) triggers[event] = stageId;
      else delete triggers[event];
      return { ...d, triggers };
    });

  const setAction = (patch: Partial<StageActions>) =>
    setDraft((d) => ({
      ...d,
      stages: d.stages.map((s) =>
        s.id === stageId ? { ...s, actions: { ...s.actions, ...patch } } : s,
      ),
    }));

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const apply = async () => {
    setSaving(true);
    try {
      await onApply(draft);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const eventHint = (event: LeadEvent) => {
    if (!triggerAllowed(event, stageId)) {
      return t(isLost ? "leads.event_not_for_lost" : "leads.event_not_for_won");
    }
    const elsewhere = draft.triggers[event];
    if (elsewhere && elsewhere !== stageId) {
      return t("leads.event_elsewhere", { stage: stageLabel(elsewhere) });
    }
    return t(`leads.event_${event}_hint`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Only the middle scrolls, so the title and Save stay in view. */}
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("leads.auto_title", { stage: name })}</DialogTitle>
          <DialogDescription>{t("leads.auto_intro")}</DialogDescription>
        </DialogHeader>

        <div className="-mx-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-4">
          <div className="grid gap-6 md:grid-cols-2">
            <section className="space-y-3">
              <h3 className="text-sm font-medium">{t("leads.auto_move_here", { stage: name })}</h3>
              {LEAD_EVENTS.map((event) => {
                const allowed = triggerAllowed(event, stageId);
                const on = draft.triggers[event] === stageId;
                return (
                  <div key={event} className="flex items-start gap-3">
                    <Switch
                      id={`trigger-${event}`}
                      className="mt-0.5"
                      checked={on}
                      disabled={!allowed}
                      onCheckedChange={(v) => toggleTrigger(event, v)}
                    />
                    <div className={allowed ? undefined : "opacity-60"}>
                      <Label htmlFor={`trigger-${event}`}>{t(`leads.event_${event}`)}</Label>
                      <p className="text-xs text-muted-foreground">{eventHint(event)}</p>
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="space-y-3 border-t pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-6">
              <h3 className="text-sm font-medium">{t("leads.auto_on_arrival", { stage: name })}</h3>
              {isLost ? (
                <p className="text-xs text-muted-foreground">{t("leads.auto_lost_no_actions")}</p>
              ) : (
                <>
                  <ActionSwitch
                    id="action-customer"
                    checked={stage.actions.make_customer}
                    onChange={(v) => setAction({ make_customer: v })}
                    label={t("leads.action_make_customer")}
                    hint={t("leads.action_make_customer_hint")}
                  />
                  {!closed && (
                    <div className="flex items-start gap-3">
                      <Switch
                        id="action-follow-up"
                        className="mt-0.5"
                        checked={stage.actions.follow_up_days !== null}
                        onCheckedChange={(v) => setAction({ follow_up_days: v ? 3 : null })}
                      />
                      <div className="space-y-2">
                        <Label htmlFor="action-follow-up">{t("leads.action_follow_up")}</Label>
                        {stage.actions.follow_up_days !== null && (
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={1}
                              max={365}
                              className="w-20"
                              aria-label={t("leads.settings_follow_up_days")}
                              value={stage.actions.follow_up_days}
                              onChange={(e) =>
                                setAction({
                                  follow_up_days: Math.min(
                                    365,
                                    Math.max(1, Number(e.target.value) || 1),
                                  ),
                                })
                              }
                            />
                            <span className="text-sm text-muted-foreground">
                              {t("leads.settings_follow_up_days")}
                            </span>
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t("leads.action_follow_up_hint")}
                        </p>
                      </div>
                    </div>
                  )}
                  <ActionSwitch
                    id="action-project"
                    checked={stage.actions.create_project}
                    onChange={(v) => setAction({ create_project: v })}
                    label={t("leads.action_create_project")}
                    hint={`${t("leads.action_create_project_hint")}${
                      timeTrackingOn ? "" : ` ${t("leads.auto_needs_time_tracking")}`
                    }`}
                  />
                </>
              )}
            </section>
          </div>
          <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
            {t("leads.auto_rules_note")}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={apply} disabled={!dirty || saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActionSwitch({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} className="mt-0.5" checked={checked} onCheckedChange={onChange} />
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}
