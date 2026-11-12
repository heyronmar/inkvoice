import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-customer-type.db";
let app: Hono;
let token: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "typetestpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  initDatabase();
  runMigrations();
  runMigrations(); // idempotent on a second boot
  await seed();
  app = createApp();
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "typetestpass" }),
  });
  token = ((await res.json()) as { data: { token: string } }).data.token;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

type Body = { data: { id: string; customer_type: string } };

async function call(method: string, path: string, body?: unknown) {
  return app.request(`/api/v1/customers${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("customer type", () => {
  test("defaults to company", async () => {
    const res = await call("POST", "", { name: "Kowhai Ltd" });
    expect(((await res.json()) as Body).data.customer_type).toBe("company");
  });

  test("individual is kept when an update leaves the field out", async () => {
    const created = (await (
      await call("POST", "", { name: "Aroha", customer_type: "individual" })
    ).json()) as Body;
    expect(created.data.customer_type).toBe("individual");

    const updated = (await (
      await call("PUT", `/${created.data.id}`, { name: "Aroha Smith" })
    ).json()) as Body;
    expect(updated.data.customer_type).toBe("individual");

    const changed = (await (
      await call("PUT", `/${created.data.id}`, { name: "Aroha Smith", customer_type: "company" })
    ).json()) as Body;
    expect(changed.data.customer_type).toBe("company");
  });

  test("rejects unknown types", async () => {
    const res = await call("POST", "", { name: "Bad", customer_type: "partnership" });
    expect(res.status).toBe(400);
  });
});
