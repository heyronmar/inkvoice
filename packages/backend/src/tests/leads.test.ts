import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import "../plugins"; // registers leads so its migrations run
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
import { acceptQuote, createQuote } from "../services/quote.service";
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
