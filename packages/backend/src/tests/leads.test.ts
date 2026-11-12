import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import "../plugins"; // registers leads so its migrations run
import { getDb } from "../database/connection";
import { defaultLeadsConfig, getLeadsConfig, saveLeadsConfig } from "../plugins/leads/config";
import {
  convertLead,
  countByStage,
  createLead,
  deleteLead,
  getLead,
  listLeads,
  startQuote,
  updateLead,
} from "../plugins/leads/service";
import { runPluginMigrations } from "../plugins/runner";
import { setPluginEnabled } from "../plugins/settings";
import { getCustomer } from "../services/customer.service";
import { acceptQuote, createQuote, rejectQuote } from "../services/quote.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-leads.db";
let app: Hono;
let token: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "leadstestpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  initDatabase();
  runMigrations();
  runPluginMigrations();
  await seed();
  app = createApp();
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "leadstestpass" }),
  });
  token = ((await res.json()) as any).data.token as string;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

function call(path: string, opts: RequestInit = {}) {
  return app.request(`/api/v1/plugins/leads${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}

describe("leads service", () => {
  test("create, update, delete; blanks stored as null", () => {
    const lead = createLead({ name: "Aroha", company: "", email: "a@example.nz", value: 1200 });
    expect(lead.stage).toBe("new");
    expect(lead.company).toBeNull();
    expect(updateLead(lead.id, { stage: "contacted" })?.stage).toBe("contacted");
    expect(deleteLead(lead.id)).toBe(true);
    expect(getLead(lead.id)).toBeNull();
  });

  test("open leads sort by soonest follow-up; closed leads last", () => {
    const later = createLead({ name: "Later", next_follow_up: "2030-02-01" });
    const soon = createLead({ name: "Soon", next_follow_up: "2030-01-01" });
    const lost = createLead({ name: "Lost", stage: "lost", next_follow_up: "2029-01-01" });
    const names = listLeads().map((l) => l.name);
    expect(names.indexOf("Soon")).toBeLessThan(names.indexOf("Later"));
    expect(names.indexOf("Later")).toBeLessThan(names.indexOf("Lost"));
    expect(countByStage().lost).toBeGreaterThanOrEqual(1);
    for (const l of [later, soon, lost]) deleteLead(l.id);
  });

  test("convert creates the customer once, named after the company", () => {
    const lead = createLead({ name: "Mere", company: "Kowhai Ltd", phone: "021 123 456" });
    const first = convertLead(lead.id)!;
    const customer = getCustomer(first.customer_id)!;
    expect(customer.name).toBe("Kowhai Ltd");
    expect(customer.notes).toContain("Contact: Mere");
    expect(customer.customer_type).toBe("company");
    expect(convertLead(lead.id)!.customer_id).toBe(first.customer_id);
  });

  test("a lead without a company converts to an individual", () => {
    const lead = createLead({ name: "Wiremu" });
    const { customer_id } = convertLead(lead.id)!;
    expect(getCustomer(customer_id)!.customer_type).toBe("individual");
  });

  test("a quoted lead becomes won when its customer accepts a quote", () => {
    const lead = createLead({ name: "Tama" });
    const { customer_id } = startQuote(lead.id)!;
    expect(getLead(lead.id)!.stage).toBe("quoted");
    const quote = createQuote({
      customer_id,
      issue_date: "2026-11-12",
      items: [{ description: "Website", quantity: 1, unit_price: 500 }],
    } as any);
    acceptQuote(quote.id);
    expect(listLeads({ stage: "won" }).some((l) => l.id === lead.id)).toBe(true);
  });
});

describe("leads routes", () => {
  test("hidden while the plugin is off", async () => {
    setPluginEnabled("leads", false);
    expect((await call("/leads")).status).toBe(404);
  });

  test("create, filter, export and quote once enabled", async () => {
    setPluginEnabled("leads", true);
    const created = await call("/leads", {
      method: "POST",
      body: JSON.stringify({ name: "Hemi", source: "referral", value: 900, email: "" }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as any).data.id;

    const bad = await call("/leads", { method: "POST", body: JSON.stringify({ name: "" }) });
    expect(bad.status).toBe(400);

    const list = (await (await call("/leads?stage=new&search=Hemi")).json()) as any;
    expect(list.data.items.map((l: any) => l.id)).toContain(id);
    expect(list.data.counts.new).toBeGreaterThanOrEqual(1);

    const csv = await (await call("/leads/export")).text();
    expect(csv.split("\r\n")[0]).toContain("Next Follow-up");
    expect(csv).toContain("Hemi");

    const quote = (await (await call(`/leads/${id}/quote`, { method: "POST" })).json()) as any;
    expect(quote.data.lead.stage).toBe("quoted");
    expect(quote.data.customer_id).toBeTruthy();
  });

  test("listed in the Plugins tab with its own name", async () => {
    const res = await app.request("/api/v1/plugins/catalog", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as any;
    const items = body.data.plugins ?? body.data;
    const leads = items.find((p: any) => p.id === "leads");
    expect(leads.name).toBe("Leads");
    expect(leads.installed).toBe(true);
    expect(leads.enabled).toBe(true);
  });
});

function quoteFor(customer_id: string) {
  return createQuote({
    customer_id,
    issue_date: "2026-11-13",
    items: [{ description: "Work", quantity: 1, unit_price: 100 }],
  } as any);
}

function withAutomations(
  automations: Partial<ReturnType<typeof defaultLeadsConfig>["automations"]>,
) {
  const base = defaultLeadsConfig();
  saveLeadsConfig({ ...base, automations: { ...base.automations, ...automations } });
}

describe("leads settings", () => {
  afterAll(() => saveLeadsConfig(defaultLeadsConfig()));

  test("stages keep Won and Lost last and visible; sources are de-duplicated", () => {
    const config = saveLeadsConfig({
      stages: [
        { id: "won", label: "Signed", hidden: true },
        { id: "quoted", label: " Proposal sent ", hidden: false },
        { id: "new", label: null, hidden: false },
        { id: "contacted", label: null, hidden: true },
      ],
      sources: ["website", "Instagram", "Instagram", " "],
      follow_up_days: 3,
    });
    expect(config.stages.map((s) => s.id)).toEqual(["quoted", "new", "contacted", "won", "lost"]);
    expect(config.stages[0].label).toBe("Proposal sent");
    expect(config.stages.find((s) => s.id === "won")).toEqual({
      id: "won",
      label: "Signed",
      hidden: false,
    });
    expect(config.stages.find((s) => s.id === "contacted")?.hidden).toBe(true);
    expect(config.sources).toEqual(["website", "Instagram"]);
    expect(getLeadsConfig().follow_up_days).toBe(3);
  });

  test("won on accept can be switched off", () => {
    withAutomations({ won_on_accept: false });
    const lead = createLead({ name: "Rangi" });
    const { customer_id } = startQuote(lead.id)!;
    acceptQuote(quoteFor(customer_id).id);
    listLeads();
    expect(getLead(lead.id)!.stage).toBe("quoted");
  });

  test("lost on decline, unless another quote is still open", () => {
    withAutomations({ lost_on_decline: true });
    const lead = createLead({ name: "Anahera" });
    const { customer_id } = startQuote(lead.id)!;
    const declined = quoteFor(customer_id);
    const open = quoteFor(customer_id);
    rejectQuote(declined.id);
    listLeads();
    expect(getLead(lead.id)!.stage).toBe("quoted");
    rejectQuote(open.id);
    listLeads();
    expect(getLead(lead.id)!.stage).toBe("lost");
  });

  test("setting a follow-up on an existing New lead moves it to Contacted", () => {
    withAutomations({ contacted_on_follow_up: true });
    expect(createLead({ name: "Nikau", next_follow_up: "2030-01-01" }).stage).toBe("new");
    const lead = createLead({ name: "Ihaia" });
    expect(lead.stage).toBe("new");
    expect(updateLead(lead.id, { next_follow_up: "2030-01-02" })!.stage).toBe("contacted");
  });

  test("winning a lead creates one Time Tracking project when that plugin is on", () => {
    withAutomations({ project_on_won: true });
    setPluginEnabled("time-tracker", true);
    const lead = createLead({ name: "Mere", company: "Rata Design" });
    updateLead(lead.id, { stage: "won" });
    const won = getLead(lead.id)!;
    expect(won.customer_id).toBeTruthy();
    const project = getDb()
      .query("SELECT * FROM tt_projects WHERE id = ?")
      .get(won.project_id) as any;
    expect(project.name).toBe("Rata Design");
    expect(project.customer_id).toBe(won.customer_id);
    updateLead(lead.id, { stage: "contacted" });
    updateLead(lead.id, { stage: "won" });
    expect(getLead(lead.id)!.project_id).toBe(won.project_id);

    setPluginEnabled("time-tracker", false);
    const other = createLead({ name: "Tane" });
    updateLead(other.id, { stage: "won" });
    expect(getLead(other.id)!.project_id).toBeNull();
  });

  test("settings routes: anyone with access reads, admins save, bad input is rejected", async () => {
    setPluginEnabled("leads", true);
    const read = (await (await call("/settings")).json()) as any;
    expect(read.data.stages).toHaveLength(5);
    const bad = await call("/settings", { method: "PUT", body: JSON.stringify({ sources: "x" }) });
    expect(bad.status).toBe(400);
    const saved = await call("/settings", {
      method: "PUT",
      body: JSON.stringify({ ...read.data, sources: ["Trade show"] }),
    });
    expect(((await saved.json()) as any).data.sources).toEqual(["Trade show"]);
    const custom = await call("/leads", {
      method: "POST",
      body: JSON.stringify({ name: "Kahu", source: "Trade show" }),
    });
    expect(custom.status).toBe(201);
  });
});
