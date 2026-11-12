// Leads settings, shown on the plugin's page under Settings → Plugins while the
// plugin is on: stage order, names and visibility, the source list, the
// automatic follow-up date and the stage automations.

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Lock, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { usePluginsStore } from "../use-plugins.store";
import { CLOSED_STAGES, type LeadsConfig, leadsApi, type StageSetting } from "./api";
import { useLeadLabels, useLeadsConfig } from "./config";

type Automation = keyof LeadsConfig["automations"];
const AUTOMATIONS: Automation[] = [
  "won_on_accept",
  "lost_on_decline",
  "contacted_on_follow_up",
  "project_on_won",
];

export default function LeadsSettings() {
  const { t } = useTranslation();
  const { config: saved, setConfig: setSaved, loaded } = useLeadsConfig();
  const [draft, setDraft] = useState<LeadsConfig>(saved);
  const [newSource, setNewSource] = useState("");
  const [saving, setSaving] = useState(false);
  const { sourceLabel } = useLeadLabels(draft);
  const timeTrackingOn = usePluginsStore((s) => s.isEnabled("time-tracker"));

  useEffect(() => setDraft(saved), [saved]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const open = draft.stages.filter((s) => !CLOSED_STAGES.includes(s.id));
  const closed = draft.stages.filter((s) => CLOSED_STAGES.includes(s.id));

  const updateStage = (id: string, patch: Partial<StageSetting>) =>
    setDraft((d) => ({
      ...d,
      stages: d.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = open.findIndex((s) => s.id === active.id);
    const to = open.findIndex((s) => s.id === over.id);
    setDraft((d) => ({ ...d, stages: [...arrayMove(open, from, to), ...closed] }));
  };

  const addSource = () => {
    const value = newSource.trim();
    if (!value || draft.sources.includes(value)) return;
    setDraft((d) => ({ ...d, sources: [...d.sources, value] }));
    setNewSource("");
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await leadsApi.saveSettings(draft);
      setSaved(res.data);
      toast.success(t("leads.settings_saved"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  return (
    <div className="space-y-6">
      <Section title={t("leads.settings_stages")} hint={t("leads.settings_stages_hint")}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={open.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {open.map((s) => (
                <StageRow key={s.id} stage={s} onChange={(p) => updateStage(s.id, p)} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <div className="space-y-2">
          {closed.map((s) => (
            <StageRow key={s.id} stage={s} locked onChange={(p) => updateStage(s.id, p)} />
          ))}
        </div>
      </Section>

      <Section title={t("leads.settings_sources")} hint={t("leads.settings_sources_hint")}>
        <div className="flex flex-wrap gap-2">
          {draft.sources.map((s) => (
            <Badge key={s} variant="secondary" className="h-7 gap-1 pr-1 text-sm font-normal">
              {sourceLabel(s)}
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                aria-label={`${t("common.delete")}: ${sourceLabel(s)}`}
                onClick={() =>
                  setDraft((d) => ({ ...d, sources: d.sources.filter((x) => x !== s) }))
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex max-w-sm gap-2">
          <Input
            value={newSource}
            maxLength={50}
            placeholder={t("leads.settings_source_placeholder")}
            aria-label={t("leads.settings_source_placeholder")}
            onChange={(e) => setNewSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addSource();
              }
            }}
          />
          <Button variant="outline" onClick={addSource} disabled={!newSource.trim()}>
            <Plus className="h-4 w-4" /> {t("leads.settings_add")}
          </Button>
        </div>
      </Section>

      <Section title={t("leads.settings_follow_up")}>
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            id="leads-follow-up"
            checked={draft.follow_up_days !== null}
            onCheckedChange={(on) => setDraft((d) => ({ ...d, follow_up_days: on ? 3 : null }))}
          />
          <Label htmlFor="leads-follow-up" className="font-normal">
            {t("leads.settings_follow_up_label")}
          </Label>
          {draft.follow_up_days !== null && (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={365}
                className="w-20"
                aria-label={t("leads.settings_follow_up_days")}
                value={draft.follow_up_days}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    follow_up_days: Math.min(365, Math.max(1, Number(e.target.value) || 1)),
                  }))
                }
              />
              <span className="text-sm text-muted-foreground">
                {t("leads.settings_follow_up_days")}
              </span>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("leads.settings_follow_up_hint")}</p>
      </Section>

      <Section title={t("leads.settings_automations")}>
        <div className="space-y-3">
          {AUTOMATIONS.map((key) => (
            <div key={key} className="flex items-start gap-3">
              <Switch
                id={`leads-${key}`}
                className="mt-0.5"
                checked={draft.automations[key]}
                onCheckedChange={(on) =>
                  setDraft((d) => ({ ...d, automations: { ...d.automations, [key]: on } }))
                }
              />
              <div>
                <Label htmlFor={`leads-${key}`}>{t(`leads.auto_${key}`)}</Label>
                <p className="text-xs text-muted-foreground">
                  {t(`leads.auto_${key}_hint`)}
                  {key === "project_on_won" && !timeTrackingOn && (
                    <> {t("leads.auto_needs_time_tracking")}</>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => setDraft(saved)} disabled={!dirty || saving}>
          {t("common.cancel")}
        </Button>
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function StageRow({
  stage,
  locked = false,
  onChange,
}: {
  stage: StageSetting;
  locked?: boolean;
  onChange: (patch: Partial<StageSetting>) => void;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.id,
    disabled: locked,
  });
  const defaultName = t(`leads.stage_${stage.id}`);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-background p-2",
        isDragging && "relative z-10 shadow-lg",
      )}
    >
      {locked ? (
        <span className="flex h-7 w-7 items-center justify-center text-muted-foreground">
          <Lock className="h-4 w-4" aria-label={t("leads.settings_stage_locked")} />
        </span>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          className="cursor-grab touch-none active:cursor-grabbing"
          aria-label={`${t("leads.settings_reorder")}: ${stage.label || defaultName}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical />
        </Button>
      )}
      <Input
        value={stage.label ?? ""}
        maxLength={40}
        placeholder={defaultName}
        aria-label={`${t("leads.settings_stage_name")}: ${defaultName}`}
        className="max-w-xs"
        onChange={(e) => onChange({ label: e.target.value || null })}
      />
      <div className="ml-auto flex items-center gap-2">
        {locked ? (
          <span className="text-xs text-muted-foreground">{t("leads.settings_stage_locked")}</span>
        ) : (
          <>
            <Label
              htmlFor={`stage-${stage.id}`}
              className="text-xs font-normal text-muted-foreground"
            >
              {t("leads.settings_stage_show")}
            </Label>
            <Switch
              id={`stage-${stage.id}`}
              checked={!stage.hidden}
              onCheckedChange={(on) => onChange({ hidden: !on })}
            />
          </>
        )}
      </div>
    </div>
  );
}
