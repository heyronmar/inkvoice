// Leads settings, shown on the plugin's page under Settings → Plugins while the
// plugin is on: the pipeline's stages (add, remove, reorder, rename, colour,
// hide, and each stage's automations) and the source list.

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
import { GripVertical, Lock, Plus, Trash2, X, Zap } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Hint, TooltipProvider } from "@/components/ui/tooltip";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  isClosed,
  type LeadsConfig,
  leadsApi,
  MAX_OPEN_STAGES,
  STAGE_COLORS,
  type StageColor,
  type StageSetting,
} from "./api";
import {
  automationCount,
  newStageId,
  STAGE_SWATCHES,
  tidyTriggers,
  useLeadLabels,
  useLeadsConfig,
} from "./config";
import { StageAutomationsDialog } from "./StageAutomations";

export default function LeadsSettings() {
  const { t } = useTranslation();
  const { config: saved, setConfig: setSaved, loaded } = useLeadsConfig();
  const [draft, setDraft] = useState<LeadsConfig>(saved);
  const [newSource, setNewSource] = useState("");
  const [saving, setSaving] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [automating, setAutomating] = useState<string | null>(null);
  const { sourceLabel } = useLeadLabels(draft);

  useEffect(() => setDraft(saved), [saved]);
  // Lead counts per stage, refreshed after each save: a stage can only be
  // removed once it's empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the saved settings change
  useEffect(() => {
    leadsApi
      .list({})
      .then((res) => setCounts(res.data.counts))
      .catch(() => {});
  }, [saved]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const open = draft.stages.filter((s) => !isClosed(s.id));
  const closed = draft.stages.filter((s) => isClosed(s.id));
  const atLimit = open.length >= MAX_OPEN_STAGES;
  const unnamed = open.some((s) => s.id.startsWith("c_") && !s.label?.trim());

  const updateStage = (id: string, patch: Partial<StageSetting>) =>
    setDraft((d) => ({
      ...d,
      stages: d.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));

  const addStage = () => {
    if (atLimit) return;
    const used = new Set(draft.stages.map((s) => s.color));
    const color = STAGE_COLORS.find((c) => !used.has(c)) ?? "slate";
    const stage: StageSetting = {
      id: newStageId(),
      label: "",
      color,
      hidden: false,
      actions: { make_customer: false, follow_up_days: null, create_project: false },
    };
    setDraft((d) => ({ ...d, stages: [...open, stage, ...closed] }));
  };

  /**
   * Apply a change to the stage list, then drop rules that no longer fit where
   * the stages now sit (e.g. a stage moved to the front can't have a trigger).
   */
  const reshape = (stages: StageSetting[]) => {
    const next = { ...draft, stages };
    const tidy = tidyTriggers(next);
    // Rules on a removed stage go with it without a warning.
    const kept = Object.fromEntries(
      Object.entries(draft.triggers).filter(([, id]) => stages.some((s) => s.id === id)),
    );
    const changed =
      JSON.stringify(tidy.triggers) !== JSON.stringify(kept) ||
      JSON.stringify(tidy.stages.map((s) => s.actions)) !==
        JSON.stringify(stages.map((s) => s.actions));
    if (changed) toast.info(t("leads.settings_rules_adjusted"));
    setDraft(tidy);
  };

  const removeStage = (id: string) => reshape(draft.stages.filter((s) => s.id !== id));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = open.findIndex((s) => s.id === active.id);
    const to = open.findIndex((s) => s.id === over.id);
    reshape([...arrayMove(open, from, to), ...closed]);
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

  const rowProps = (s: StageSetting) => ({
    stage: s,
    leads: counts[s.id] ?? 0,
    automations: automationCount(draft, s),
    onChange: (p: Partial<StageSetting>) => updateStage(s.id, p),
    onAutomate: () => setAutomating(s.id),
  });

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <Section title={t("leads.settings_stages")} hint={t("leads.settings_stages_hint")}>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={open.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {open.map((s) => (
                  <StageRow
                    key={s.id}
                    {...rowProps(s)}
                    // Keep at least one working stage.
                    onRemove={open.length > 1 ? () => removeStage(s.id) : undefined}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={addStage} disabled={atLimit}>
              <Plus className="h-4 w-4" /> {t("leads.settings_add_stage")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t("leads.settings_stage_limit", {
                count: String(open.length),
                max: String(MAX_OPEN_STAGES),
              })}
            </span>
          </div>
          <div className="space-y-2">
            {closed.map((s) => (
              <StageRow key={s.id} {...rowProps(s)} locked />
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

        <div className="flex flex-wrap items-center justify-end gap-2">
          {unnamed && (
            <span className="text-xs text-destructive">{t("leads.settings_stage_needs_name")}</span>
          )}
          <Button variant="outline" onClick={() => setDraft(saved)} disabled={!dirty || saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={!dirty || saving || unnamed}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>

        <StageAutomationsDialog
          open={automating !== null}
          onOpenChange={(o) => !o && setAutomating(null)}
          config={draft}
          stageId={automating}
          // Changes join the draft and are saved with the rest of the page.
          onApply={setDraft}
        />
      </div>
    </TooltipProvider>
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
  leads,
  automations,
  locked = false,
  onChange,
  onAutomate,
  onRemove,
}: {
  stage: StageSetting;
  leads: number;
  automations: number;
  locked?: boolean;
  onChange: (patch: Partial<StageSetting>) => void;
  onAutomate: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.id,
    disabled: locked,
  });
  const custom = stage.id.startsWith("c_");
  const defaultName = custom ? t("leads.settings_stage_name") : t(`leads.stage_${stage.id}`);
  const name = stage.label || defaultName;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2",
        isDragging && "relative z-10 shadow-lg",
      )}
    >
      {locked ? (
        <span className="flex h-7 w-7 items-center justify-center text-muted-foreground">
          <Lock className="h-4 w-4" aria-label={t("leads.settings_stage_locked")} />
        </span>
      ) : (
        <Hint label={t("leads.settings_reorder")}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="cursor-grab touch-none active:cursor-grabbing"
            aria-label={`${t("leads.settings_reorder")}: ${name}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical />
          </Button>
        </Hint>
      )}
      <ColorPicker
        value={stage.color}
        label={`${t("leads.settings_stage_color")}: ${name}`}
        onChange={(color) => onChange({ color })}
      />
      <Input
        value={stage.label ?? ""}
        maxLength={40}
        placeholder={defaultName}
        aria-label={`${t("leads.settings_stage_name")}: ${name}`}
        aria-invalid={custom && !stage.label?.trim()}
        className="min-w-0 flex-1 sm:max-w-xs"
        onChange={(e) => onChange({ label: e.target.value || (custom ? "" : null) })}
      />
      <span className="text-xs text-muted-foreground tabular-nums">
        {t("leads.settings_stage_leads", { count: String(leads) })}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Hint
          label={
            automations > 0
              ? t("leads.automations_count", { count: String(automations) })
              : t("leads.automations_set")
          }
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={onAutomate}
            aria-label={`${t("leads.automations")}: ${name}`}
          >
            <Zap className={cn("h-4 w-4", automations > 0 && "fill-amber-400 text-amber-500")} />
            {automations > 0 && <span className="tabular-nums">{automations}</span>}
          </Button>
        </Hint>
        {locked ? (
          <span className="px-2 text-xs text-muted-foreground">
            {t("leads.settings_stage_locked")}
          </span>
        ) : (
          <>
            <Label
              htmlFor={`stage-${stage.id}`}
              className="ml-1 text-xs font-normal text-muted-foreground"
            >
              {t("leads.settings_stage_show")}
            </Label>
            <Switch
              id={`stage-${stage.id}`}
              checked={!stage.hidden}
              onCheckedChange={(on) => onChange({ hidden: !on })}
            />
            <Hint
              disabled={!onRemove || leads > 0}
              label={
                leads > 0
                  ? t("leads.settings_stage_not_empty")
                  : !onRemove
                    ? t("leads.settings_stage_keep_one")
                    : t("leads.settings_stage_delete")
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!onRemove || leads > 0}
                onClick={onRemove}
                aria-label={`${t("common.delete")}: ${name}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </Hint>
          </>
        )}
      </div>
    </div>
  );
}

function ColorPicker({
  value,
  label,
  onChange,
}: {
  value: StageColor;
  label: string;
  onChange: (color: StageColor) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label={t("leads.settings_stage_color")}>
        <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} />}>
          <span className={cn("h-4 w-4 rounded-full", STAGE_SWATCHES[value])} />
        </PopoverTrigger>
      </Hint>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="grid grid-cols-4 gap-1.5">
          {STAGE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              aria-pressed={c === value}
              className={cn(
                "h-7 w-7 rounded-full ring-offset-2 ring-offset-background",
                STAGE_SWATCHES[c],
                c === value && "ring-2 ring-ring",
              )}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
