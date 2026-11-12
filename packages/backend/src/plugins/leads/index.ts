// Leads plugin: a simple sales list with stages and follow-up dates that turns
// a lead into a customer and a quote. Mounted at /api/v1/plugins/leads.
// Leads are prospective customers, so access follows the core customers
// permissions.

import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../middleware/auth";
import { buildCsv, csvHeaders } from "../../utils/csv";
import { registerBackendPlugin } from "../registry";
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
  source: z.enum(svc.LEAD_SOURCES).nullable().optional().or(z.literal("")),
  value: z.number().nonnegative().nullable().optional(),
  stage: z.enum(svc.LEAD_STAGES).optional(),
  next_follow_up: isoDate,
  notes: optionalText(5000),
});

function filtersFrom(c: { req: { query: (k: string) => string | undefined } }) {
  const stage = c.req.query("stage");
  return {
    stage: (svc.LEAD_STAGES as readonly string[]).includes(stage ?? "")
      ? (stage as svc.LeadStage)
      : undefined,
    search: c.req.query("search") || undefined,
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
  };
}

routes.get("/leads", requirePermission("customers", "read"), (c) => {
  const filters = filtersFrom(c);
  const { stage: _stage, ...countFilters } = filters;
  return c.json(ok({ items: svc.listLeads(filters), counts: svc.countByStage(countFilters) }));
});

routes.get("/leads/export", requirePermission("customers", "export"), (c) => {
  const csv = buildCsv(svc.listLeads(filtersFrom(c)), [
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

routes.post("/leads", requirePermission("customers", "create"), async (c) => {
  const parsed = leadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid lead" }, 400);
  return c.json(ok(svc.createLead(parsed.data as svc.LeadInput)), 201);
});

routes.put("/leads/:id", requirePermission("customers", "update"), async (c) => {
  const parsed = leadSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid lead" }, 400);
  const updated = svc.updateLead(c.req.param("id"), parsed.data as Partial<svc.LeadInput>);
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
  version: "1.0.0",
  routes,
  migrations: leadsMigrations,
  listing: {
    name: "Leads",
    tagline: "Track potential customers from first contact to a won quote.",
    description:
      "Keep a simple list of leads with where they came from, an estimated value and\na next follow-up date. Move them through New, Contacted, Quoted, Won or Lost,\nand turn a lead into a customer and a quote in one click.\n",
    icon: "Target",
    category: "productivity",
  },
});
