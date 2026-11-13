// Leads plugin: a simple sales list with stages and follow-up dates that turns
// a lead into a customer and a quote. Mounted at /api/v1/plugins/leads.
// Leads are prospective customers, so access follows the core customers
// permissions.

import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../middleware/auth";
import { buildCsv, csvHeaders } from "../../utils/csv";
import { registerBackendPlugin } from "../registry";
import {
  getLeadsConfig,
  LEAD_EVENTS,
  LeadsConfigError,
  MAX_OPEN_STAGES,
  STAGE_COLORS,
  saveLeadsConfig,
  stageName,
} from "./config";
import { leadsMigrations } from "./migrations";
import * as svc from "./service";

const routes = new Hono();

const ok = (data: unknown) => ({ success: true as const, data });

const optionalText = (max: number) => z.string().max(max).nullable().optional();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional()
  .or(z.literal(""));

const leadSchema = z.object({
  name: z.string().trim().min(1).max(255),
  company: optionalText(255),
  email: z.string().email().nullable().optional().or(z.literal("")),
  phone: optionalText(50),
  // Built-in source keys or the business's own (see Leads settings).
  source: optionalText(50),
  value: z.number().nonnegative().nullable().optional(),
  // Must be one of the business's stages (checked in the handler).
  stage: z.string().max(40).optional(),
  next_follow_up: isoDate,
  notes: optionalText(5000),
});

const configSchema = z.object({
  stages: z
    .array(
      z.object({
        id: z.string().regex(/^(new|contacted|quoted|won|lost|c_[a-z0-9]{4,16})$/),
        label: z.string().max(40).nullable(),
        color: z.enum(STAGE_COLORS),
        hidden: z.boolean(),
        actions: z.object({
          make_customer: z.boolean(),
          follow_up_days: z.number().int().min(1).max(365).nullable(),
          create_project: z.boolean(),
        }),
      }),
    )
    // Stages the business added need a name; built-in ones fall back to theirs.
    .refine((stages) => stages.every((s) => !s.id.startsWith("c_") || s.label?.trim()), {
      message: "Every stage needs a name",
    })
    .refine((stages) => stages.filter((s) => s.id !== "won" && s.id !== "lost").length >= 1, {
      message: "Keep at least one stage besides Won and Lost",
    })
    .refine(
      (stages) => stages.filter((s) => s.id !== "won" && s.id !== "lost").length <= MAX_OPEN_STAGES,
      { message: `Up to ${MAX_OPEN_STAGES} stages besides Won and Lost` },
    ),
  sources: z.array(z.string().max(50)).max(30),
  triggers: z.partialRecord(z.enum(LEAD_EVENTS), z.string()),
});

/** The user's local date, so follow-ups set by automations land on the right day. */
const todaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

function ctxFrom(today: string | undefined): svc.Context {
  const parsed = todaySchema.safeParse(today);
  return { today: parsed.success ? parsed.data : undefined };
}

// Everyone who can see leads needs the stage names and sources; only admins
// change them, the same as switching the plugin on or off.
routes.get("/settings", requirePermission("customers", "read"), (c) =>
  c.json(ok(getLeadsConfig())),
);

routes.put("/settings", async (c) => {
  const user = c.get("user") as { is_admin?: boolean } | undefined;
  if (!user?.is_admin) return c.json({ success: false, error: "Forbidden" }, 403);
  const parsed = configSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { success: false, error: parsed.error.issues[0]?.message ?? "Invalid settings" },
      400,
    );
  }
  try {
    return c.json(ok(saveLeadsConfig(parsed.data)));
  } catch (err) {
    if (err instanceof LeadsConfigError) {
      return c.json({ success: false, error: err.message }, 409);
    }
    throw err;
  }
});

function filtersFrom(c: { req: { query: (k: string) => string | undefined } }) {
  const stage = c.req.query("stage");
  return {
    stage: stage && svc.stageExists(stage) ? stage : undefined,
    search: c.req.query("search") || undefined,
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
  };
}

routes.get("/leads", requirePermission("customers", "read"), (c) => {
  const filters = filtersFrom(c);
  const { stage: _stage, ...countFilters } = filters;
  const items = svc.listLeads(filters, ctxFrom(c.req.query("today")));
  return c.json(ok({ items, counts: svc.countByStage(countFilters) }));
});

routes.get("/leads/export", requirePermission("customers", "export"), (c) => {
  const config = getLeadsConfig();
  const rows = svc
    .listLeads(filtersFrom(c), ctxFrom(c.req.query("today")))
    .map((l) => ({ ...l, stage: stageName(config, l.stage) }));
  const csv = buildCsv(rows, [
    { header: "Name", key: "name" },
    { header: "Company", key: "company" },
    { header: "Email", key: "email" },
    { header: "Phone", key: "phone" },
    { header: "Source", key: "source" },
    { header: "Value", key: "value" },
    { header: "Stage", key: "stage" },
    { header: "Next Follow-up", key: "next_follow_up" },
    { header: "Notes", key: "notes" },
    { header: "Created", key: "created_at" },
  ]);
  const date = new Date().toISOString().slice(0, 10);
  return c.body(csv, 200, csvHeaders(`leads-${date}.csv`));
});

routes.get("/leads/:id", requirePermission("customers", "read"), (c) => {
  const lead = svc.getLead(c.req.param("id"));
  if (!lead) return c.json({ success: false, error: "Lead not found" }, 404);
  return c.json(ok(lead));
});

const unknownStage = (stage: string | undefined) => stage !== undefined && !svc.stageExists(stage);

routes.post("/leads", requirePermission("customers", "create"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = leadSchema.safeParse(body);
  if (!parsed.success || unknownStage(parsed.data.stage)) {
    return c.json({ success: false, error: "Invalid lead" }, 400);
  }
  return c.json(ok(svc.createLead(parsed.data as svc.LeadInput, ctxFrom(body?.today))), 201);
});

routes.put("/leads/:id", requirePermission("customers", "update"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = leadSchema.partial().safeParse(body);
  if (!parsed.success || unknownStage(parsed.data.stage)) {
    return c.json({ success: false, error: "Invalid lead" }, 400);
  }
  const updated = svc.updateLead(
    c.req.param("id"),
    parsed.data as Partial<svc.LeadInput>,
    ctxFrom(body?.today),
  );
  if (!updated) return c.json({ success: false, error: "Lead not found" }, 404);
  return c.json(ok(updated));
});

routes.delete("/leads/:id", requirePermission("customers", "delete"), (c) => {
  if (!svc.deleteLead(c.req.param("id"))) {
    return c.json({ success: false, error: "Lead not found" }, 404);
  }
  return c.json(ok({ id: c.req.param("id") }));
});

routes.post("/leads/:id/convert", requirePermission("customers", "create"), (c) => {
  const result = svc.convertLead(c.req.param("id"));
  if (!result) return c.json({ success: false, error: "Lead not found" }, 404);
  return c.json(ok(result));
});

routes.post(
  "/leads/:id/quote",
  requirePermission("customers", "create"),
  requirePermission("invoices", "create"),
  (c) => {
    const result = svc.startQuote(c.req.param("id"));
    if (!result) return c.json({ success: false, error: "Lead not found" }, 404);
    return c.json(ok(result));
  },
);

registerBackendPlugin({
  id: "leads",
  version: "1.2.0",
  routes,
  migrations: leadsMigrations,
  listing: {
    name: "Leads",
    tagline: "Track potential customers from first contact to a won quote.",
    description:
      "Keep a list of leads with where they came from, an estimated value and a next\nfollow-up date. Shape the pipeline with your own stages, let quotes and invoices\nmove leads along, and turn a lead into a customer and a quote in one click.\n",
    icon: "Target",
    category: "productivity",
  },
});
