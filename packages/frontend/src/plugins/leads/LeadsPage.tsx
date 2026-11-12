// Leads page: a list view (stage tabs, table sorted by next follow-up) or a
// board view (one column per stage, drag a card to change its stage), with
// search, a date filter and a dialog to add or edit a lead. A lead can become
// a customer and a quote in one click; once it has a quote, its card opens it.
// Admins set each stage's automations from the ⚡ button on its column.

import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  Download,
  FilePlus,
  FileText,
  Kanban,
  List,
  Pencil,
  Plus,
  Search,
  Target,
  Trash2,
  UserPlus,
  Users,
  Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { DateRangeFilter } from "@/components/shared/DateRangeFilter";
import { EmptyState } from "@/components/shared/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Hint, TooltipProvider } from "@/components/ui/tooltip";
import { useCan } from "@/hooks/use-can";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useTranslation } from "@/i18n";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth.store";
import { useSettingsStore } from "@/stores/settings.store";
import { isClosed, type Lead, type LeadInput, type LeadsConfig, leadsApi } from "./api";
import { automationCount, stageStyle, useLeadLabels, useLeadsConfig } from "./config";
import { StageAutomationsDialog } from "./StageAutomations";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function LeadsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const canCreate = can("customers", "create");
  const canEdit = can("customers", "update");
  const canDelete = can("customers", "delete");
  const canQuote = canCreate && can("invoices", "create");
  const settings = useSettingsStore((s) => s.settings);
  const currency = settings.base_currency || settings.currency || "USD";
  const { config, setConfig } = useLeadsConfig();
  const { stageLabel, sourceLabel } = useLeadLabels(config);
  const isAdmin = useAuthStore((s) => !!s.user?.is_admin);
  const [automating, setAutomating] = useState<string | null>(null);

  const [view, setView] = usePersistentState<"list" | "board">("inkvoice-leads-view", "list");
  const [stage, setStage] = useState<string>("all");
  // The board shows every stage as a column, so the stage tab does not apply.
  const stageFilter = view === "board" || stage === "all" ? undefined : stage;
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<{ from?: string; to?: string }>({});
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<Lead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const filters = {
    stage: stageFilter,
    search: search || undefined,
    from: dateRange.from,
    to: dateRange.to,
  };

  const fetchLeads = useCallback(async () => {
    try {
      const res = await leadsApi.list({
        stage: stageFilter,
        search: search || undefined,
        from: dateRange.from,
        to: dateRange.to,
      });
      setLeads(res.data.items);
      setCounts(res.data.counts);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [stageFilter, search, dateRange]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const today = todayIso();
  const isDue = (l: Lead) => !!l.next_follow_up && !isClosed(l.stage) && l.next_follow_up <= today;
  const dueCount = leads.filter(isDue).length;
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  // Stages in the saved order. A hidden stage still shows while leads are in it.
  const stages = config.stages.filter((s) => !s.hidden || (counts[s.id] ?? 0) > 0).map((s) => s.id);

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (lead: Lead) => {
    setEditing(lead);
    setDialogOpen(true);
  };

  const changeStage = async (lead: Lead, next: string) => {
    // Move it straight away so a dragged card does not jump back while saving.
    // The stage's arrival actions (follow-up date, …) run on the server.
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, stage: next } : l)));
    try {
      await leadsApi.update(lead.id, { stage: next });
      fetchLeads();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const convert = async (lead: Lead) => {
    try {
      await leadsApi.convert(lead.id);
      toast.success(t("leads.converted"));
      fetchLeads();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const createQuote = async (lead: Lead) => {
    try {
      const res = await leadsApi.startQuote(lead.id);
      navigate(`/quotes/new?customer_id=${res.data.customer_id}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const saveAutomations = async (next: LeadsConfig) => {
    try {
      const res = await leadsApi.saveSettings(next);
      setConfig(res.data);
      toast.success(t("leads.settings_saved"));
      fetchLeads();
    } catch (e) {
      toast.error((e as Error).message);
      throw e;
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await leadsApi.remove(deleteId);
      toast.success(t("leads.deleted"));
      fetchLeads();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleteId(null);
    }
  };

  const renderActions = (l: Lead, compact = false) => {
    const action = (label: string, Icon: typeof FileText, onClick: () => void) => (
      <Hint label={label}>
        <Button
          variant="ghost"
          size={compact ? "icon-xs" : "icon"}
          aria-label={label}
          onClick={onClick}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </Hint>
    );
    return (
      <>
        {l.quote_id && l.quote_number
          ? // It already has a quote, so open that rather than starting another.
            action(t("leads.open_quote", { number: l.quote_number }), FileText, () =>
              navigate(`/quotes/${l.quote_id}`),
            )
          : canQuote &&
            !isClosed(l.stage) &&
            action(t("leads.create_quote"), FilePlus, () => createQuote(l))}
        {l.customer_id
          ? action(t("leads.view_customer"), Users, () => navigate(`/customers/${l.customer_id}`))
          : canCreate &&
            // A lost lead isn't worth turning into a customer; Won still can be.
            l.stage !== "lost" &&
            action(t("leads.convert"), UserPlus, () => convert(l))}
        {canEdit && action(t("common.edit"), Pencil, () => openEdit(l))}
        {canDelete && action(t("common.delete"), Trash2, () => setDeleteId(l.id))}
      </>
    );
  };

  const followUp = (l: Lead) =>
    l.next_follow_up ? (
      <span className={cn(isDue(l) && "font-medium text-destructive")}>
        {l.next_follow_up === today ? t("leads.today") : formatDate(l.next_follow_up)}
        {isDue(l) && l.next_follow_up < today && ` · ${t("leads.overdue")}`}
      </span>
    ) : null;
  const quoteChip = (l: Lead) =>
    l.quote_number ? (
      <span className="text-xs text-muted-foreground">
        {l.quote_number}
        {l.quote_status && ` · ${t(`quotes.status_${l.quote_status}`)}`}
      </span>
    ) : null;
  const colCount = 7;

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{t("leads.title")}</h1>
            {dueCount > 0 && (
              <Badge variant="destructive">{t("leads.follow_ups_due", { count: dueCount })}</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <DateRangeFilter value={dateRange} onChange={setDateRange} />
            {can("customers", "export") && (
              <Button
                variant="outline"
                onClick={() => window.open(leadsApi.exportUrl(filters), "_blank")}
              >
                <Download className="h-4 w-4 mr-2" /> {t("common.export_csv")}
              </Button>
            )}
            <div className="inline-flex h-8 items-center gap-0.5 rounded-lg border border-border bg-background p-0.5">
              {(
                [
                  ["list", List, t("leads.view_list")],
                  ["board", Kanban, t("leads.view_board")],
                ] as const
              ).map(([value, Icon, label]) => (
                <Hint key={value} label={label}>
                  <Button
                    variant={view === value ? "secondary" : "ghost"}
                    className="h-full w-8 px-0"
                    aria-label={label}
                    aria-pressed={view === value}
                    onClick={() => setView(value)}
                  >
                    <Icon />
                  </Button>
                </Hint>
              ))}
            </div>
            {canCreate && (
              <Button onClick={openNew}>
                <Plus className="h-4 w-4 mr-2" /> {t("leads.add_lead")}
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          {view === "list" && (
            <Tabs value={stage} onValueChange={(v) => setStage(v as string)}>
              <TabsList>
                <TabsTrigger value="all">
                  {t("leads.tab_all")} <span className="ml-1 text-muted-foreground">{total}</span>
                </TabsTrigger>
                {stages.map((s) => (
                  <TabsTrigger key={s} value={s}>
                    {stageLabel(s)}
                    <span className="ml-1 text-muted-foreground">{counts[s] ?? 0}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("leads.search_placeholder")}
              aria-label={t("common.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        {view === "board" ? (
          <LeadBoard
            leads={leads}
            stages={stages}
            canEdit={canEdit}
            currency={currency}
            stageLabel={stageLabel}
            stageStyle={(id) => stageStyle(config, id)}
            automations={(id) => {
              const s = config.stages.find((x) => x.id === id);
              return s ? automationCount(config, s) : 0;
            }}
            onAutomate={isAdmin ? setAutomating : undefined}
            quoteChip={quoteChip}
            followUp={followUp}
            renderActions={renderActions}
            onOpen={openEdit}
            onMove={changeStage}
          />
        ) : (
          <div className="glass-table-wrapper">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableCell className="font-medium text-sm">{t("leads.col_name")}</TableCell>
                  <TableCell className="font-medium text-sm">{t("leads.col_contact")}</TableCell>
                  <TableCell className="font-medium text-sm">{t("leads.col_source")}</TableCell>
                  <TableCell className="font-medium text-sm text-right">
                    {t("leads.col_value")}
                  </TableCell>
                  <TableCell className="font-medium text-sm">{t("leads.col_stage")}</TableCell>
                  <TableCell className="font-medium text-sm">{t("leads.col_follow_up")}</TableCell>
                  <TableCell className="w-[160px] font-medium text-sm text-muted-foreground">
                    {t("common.actions")}
                  </TableCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={colCount} className="p-0">
                      <EmptyState
                        icon={Target}
                        title={t("leads.empty_title")}
                        description={t("leads.empty_description")}
                        actionLabel={t("leads.add_lead")}
                        onAction={canCreate ? openNew : undefined}
                      />
                    </TableCell>
                  </TableRow>
                )}
                {leads.map((l) => (
                  <TableRow
                    key={l.id}
                    className={cn(
                      "transition-colors",
                      canEdit && "cursor-pointer hover:bg-accent/50",
                      l.stage === "lost" && "opacity-60",
                    )}
                    onClick={canEdit ? () => openEdit(l) : undefined}
                  >
                    <TableCell>
                      <div className="font-medium">{l.name}</div>
                      {l.company && (
                        <div className="text-xs text-muted-foreground">{l.company}</div>
                      )}
                      {quoteChip(l)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <div>{l.email || "-"}</div>
                      {l.phone && <div className="text-xs">{l.phone}</div>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {l.source ? sourceLabel(l.source) : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {l.value != null ? formatCurrency(l.value, currency) : "-"}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {canEdit ? (
                        <Select
                          value={l.stage}
                          onValueChange={(v) => v && v !== l.stage && changeStage(l, v)}
                        >
                          <SelectTrigger
                            className={cn(
                              "border-transparent font-medium",
                              stageStyle(config, l.stage),
                            )}
                            aria-label={t("leads.col_stage")}
                          >
                            <SelectValue>{stageLabel(l.stage)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {stages.map((s) => (
                              <SelectItem key={s} value={s}>
                                {stageLabel(s)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge className={stageStyle(config, l.stage)}>{stageLabel(l.stage)}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {followUp(l) ?? <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-1">{renderActions(l)}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <LeadDialog
          open={dialogOpen}
          lead={editing}
          config={config}
          stages={stages}
          onOpenChange={setDialogOpen}
          onSaved={fetchLeads}
        />

        <StageAutomationsDialog
          open={automating !== null}
          onOpenChange={(o) => !o && setAutomating(null)}
          config={config}
          stageId={automating}
          onApply={saveAutomations}
        />

        <ConfirmDialog
          open={deleteId !== null}
          onOpenChange={(open) => !open && setDeleteId(null)}
          title={t("leads.delete_title")}
          description={t("leads.delete_description")}
          confirmLabel={t("common.delete")}
          variant="destructive"
          onConfirm={handleDelete}
        />
      </div>
    </TooltipProvider>
  );
}

function LeadDialog({
  open,
  lead,
  config,
  stages,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  lead: Lead | null;
  config: LeadsConfig;
  stages: string[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { stageLabel, sourceLabel } = useLeadLabels(config);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // New leads start in the first stage; its follow-up action (if any) runs on save.
  const firstStage = stages.find((s) => !isClosed(s)) ?? stages[0] ?? "new";
  // The lead's own source stays selectable even if it was removed from the list.
  const sources =
    lead?.source && !config.sources.includes(lead.source)
      ? [...config.sources, lead.source]
      : config.sources;

  useEffect(() => {
    if (!open) return;
    setForm({
      name: lead?.name ?? "",
      company: lead?.company ?? "",
      email: lead?.email ?? "",
      phone: lead?.phone ?? "",
      source: lead?.source ?? "",
      value: lead?.value != null ? String(lead.value) : "",
      stage: lead?.stage ?? firstStage,
      next_follow_up: lead?.next_follow_up ?? "",
      notes: lead?.notes ?? "",
    });
  }, [open, lead, firstStage]);

  const set = (key: string) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    const input: LeadInput = {
      name: form.name.trim(),
      company: form.company,
      email: form.email.trim(),
      phone: form.phone,
      source: form.source || null,
      value: form.value === "" ? null : Number(form.value),
      stage: form.stage,
      next_follow_up: form.next_follow_up || null,
      notes: form.notes,
    };
    setSaving(true);
    try {
      if (lead) await leadsApi.update(lead.id, input);
      else await leadsApi.create(input);
      toast.success(t("leads.saved"));
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const text = (key: string, label: string, type = "text") => (
    <div className="space-y-1">
      <Label htmlFor={`lead-${key}`}>{label}</Label>
      <Input
        id={`lead-${key}`}
        type={type}
        value={form[key] ?? ""}
        onChange={(e) => set(key)(e.target.value)}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{lead ? t("leads.edit_lead") : t("leads.add_lead")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {text("name", t("leads.field_name"))}
          {text("company", t("leads.field_company"))}
          {text("email", t("leads.field_email"), "email")}
          {text("phone", t("leads.field_phone"), "tel")}
          <div className="space-y-1">
            <Label>{t("leads.field_source")}</Label>
            <Select
              value={form.source || "none"}
              onValueChange={(v) => set("source")(v === "none" || !v ? "" : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {form.source ? sourceLabel(form.source) : t("leads.no_source")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("leads.no_source")}</SelectItem>
                {sources.map((s) => (
                  <SelectItem key={s} value={s}>
                    {sourceLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {text("value", t("leads.field_value"), "number")}
          <div className="space-y-1">
            <Label>{t("leads.field_stage")}</Label>
            <Select value={form.stage || firstStage} onValueChange={(v) => v && set("stage")(v)}>
              <SelectTrigger className="w-full">
                <SelectValue>{stageLabel(form.stage || firstStage)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(stages.includes(form.stage) ? stages : [...stages, form.stage]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {stageLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {text("next_follow_up", t("leads.field_follow_up"), "date")}
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="lead-notes">{t("leads.field_notes")}</Label>
            <Textarea
              id="lead-notes"
              rows={3}
              value={form.notes ?? ""}
              onChange={(e) => set("notes")(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={saving || !form.name?.trim()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LeadBoard({
  leads,
  stages,
  canEdit,
  currency,
  stageLabel,
  stageStyle,
  automations,
  onAutomate,
  quoteChip,
  followUp,
  renderActions,
  onOpen,
  onMove,
}: {
  leads: Lead[];
  stages: string[];
  canEdit: boolean;
  currency: string;
  stageLabel: (s: string) => string;
  stageStyle: (s: string) => string;
  automations: (s: string) => number;
  /** Admins only: open the stage's automations. */
  onAutomate?: (s: string) => void;
  quoteChip: (l: Lead) => ReactNode;
  followUp: (l: Lead) => ReactNode;
  renderActions: (l: Lead, compact?: boolean) => ReactNode;
  onOpen: (l: Lead) => void;
  onMove: (l: Lead, stage: string) => void;
}) {
  // A small drag distance keeps a plain click opening the lead.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const lead = leads.find((l) => l.id === active.id);
    const target = over?.id as string | undefined;
    if (lead && target && target !== lead.stage) onMove(lead, target);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="grid grid-flow-col auto-cols-[minmax(15rem,1fr)] gap-3 overflow-x-auto pb-2">
        {stages.map((stage) => {
          const items = leads.filter((l) => l.stage === stage);
          const sum = items.reduce((a, l) => a + (l.value ?? 0), 0);
          return (
            <BoardColumn
              key={stage}
              stage={stage}
              title={stageLabel(stage)}
              style={stageStyle(stage)}
              count={items.length}
              total={sum > 0 ? formatCurrency(sum, currency) : null}
              automations={automations(stage)}
              onAutomate={onAutomate && (() => onAutomate(stage))}
            >
              {items.map((l) => (
                <BoardCard key={l.id} lead={l} draggable={canEdit} onOpen={() => onOpen(l)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{l.name}</div>
                      {l.company && (
                        <div className="text-xs text-muted-foreground truncate">{l.company}</div>
                      )}
                      {quoteChip(l)}
                    </div>
                    {l.value != null && (
                      <div className="text-sm tabular-nums shrink-0">
                        {formatCurrency(l.value, currency)}
                      </div>
                    )}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                    <div className="text-muted-foreground">{followUp(l)}</div>
                    <div
                      className="flex gap-0.5"
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      {renderActions(l, true)}
                    </div>
                  </div>
                </BoardCard>
              ))}
            </BoardColumn>
          );
        })}
      </div>
    </DndContext>
  );
}

function BoardColumn({
  stage,
  title,
  style,
  count,
  total,
  automations,
  onAutomate,
  children,
}: {
  stage: string;
  title: string;
  style: string;
  count: number;
  total: string | null;
  automations: number;
  onAutomate?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-[24rem] flex-col gap-2 rounded-xl border border-border bg-muted/40 p-2 transition-colors",
        isOver && "border-primary/50 bg-primary/5",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-1 py-1">
        <span className={cn("truncate rounded-md px-2 py-0.5 text-xs font-medium", style)}>
          {title} <span className="opacity-70">{count}</span>
        </span>
        <div className="flex items-center gap-1">
          {total && <span className="text-xs text-muted-foreground tabular-nums">{total}</span>}
          {onAutomate && (
            <Hint
              label={
                automations > 0
                  ? t("leads.automations_count", { count: String(automations) })
                  : t("leads.automations_set")
              }
            >
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onAutomate}
                aria-label={`${t("leads.automations")}: ${title}`}
              >
                <Zap className={cn(automations > 0 && "fill-amber-400 text-amber-500")} />
              </Button>
            </Hint>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function BoardCard({
  lead,
  draggable,
  onOpen,
  children,
}: {
  lead: Lead;
  draggable: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
    disabled: !draggable,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cn(
        "rounded-lg border border-border bg-background p-3 text-sm shadow-xs",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        isDragging && "relative z-10 shadow-lg opacity-90",
        lead.stage === "lost" && "opacity-60",
      )}
    >
      {children}
    </div>
  );
}
