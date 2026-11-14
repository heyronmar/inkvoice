import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlinkSync } from "node:fs";
import bcrypt from "bcryptjs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import "../plugins"; // registers time-tracker so its migrations run
import { runPluginMigrations } from "../plugins/runner";
import { resetEnvCache } from "../utils/env";

// Shared customer jobs: any user can resolve a customer's project, teammates
// see each other's time with scope=team, and proof files are shared per job.

type Json = { success: boolean; error?: string; data: unknown };

const TEST_DB = "./data/test-time-tracker-jobs.db";
const BASE = "/api/v1/plugins/time-tracker";
const DAY = "2026-11-14";
let app: Hono;
let adminToken: string;
let aliceToken: string;
let bobToken: string;
let customerId: string;

// Smallest valid-looking files: the server sniffs the leading bytes.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

async function login(username: string, password: string): Promise<string> {
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return ((await res.json()) as { data: { token: string } }).data.token;
}

async function addUser(username: string, displayName: string): Promise<string> {
  const hash = await bcrypt.hash("ttjobspass", 10);
  getDb().run(
    "INSERT INTO users (id, username, display_name, password_hash, is_admin, is_active) VALUES (?, ?, ?, ?, 0, 1)",
    [crypto.randomBytes(16).toString("hex"), username, displayName, hash],
  );
  return login(username, "ttjobspass");
}

function req(token: string, path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (typeof opts.body === "string") headers["Content-Type"] = "application/json";
  return app.request(new Request(`http://localhost${path}`, { ...opts, headers }));
}

async function json(res: Response | Promise<Response>): Promise<Json> {
  return (await (await res).json()) as Json;
}

function upload(token: string, projectId: string, bytes: Uint8Array<ArrayBuffer>, name: string) {
  const form = new FormData();
  form.append("file", new File([bytes], name));
  return req(token, `${BASE}/jobs/${projectId}/${DAY}/attachments`, {
    method: "POST",
    body: form,
  });
}

async function resolveJob(token: string, projectName?: string): Promise<string> {
  const res = await json(
    req(token, `${BASE}/jobs`, {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId, project_name: projectName }),
    }),
  );
  return (res.data as { id: string }).id;
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "ttjobsadminpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  initDatabase();
  runMigrations();
  runPluginMigrations();
  await seed();
  app = createApp();
  adminToken = await login("admin", "ttjobsadminpass");
  aliceToken = await addUser("tt_alice", "Alice");
  bobToken = await addUser("tt_bob", "Bob");
  customerId = crypto.randomBytes(16).toString("hex");
  getDb().run("INSERT INTO customers (id, name) VALUES (?, ?)", [customerId, "Harbour Ltd"]);
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("jobs", () => {
  test("any user resolves a customer's project, reusing it case-insensitively", async () => {
    const general = await resolveJob(aliceToken);
    expect(await resolveJob(bobToken, "  ")).toBe(general);

    const website = await resolveJob(aliceToken, "Website");
    expect(await resolveJob(bobToken, "website")).toBe(website);
    expect(website).not.toBe(general);

    const projects = await json(req(aliceToken, `${BASE}/projects`));
    const names = (projects.data as { id: string; name: string; customer_id: string }[])
      .filter((p) => p.customer_id === customerId)
      .map((p) => p.name)
      .sort();
    expect(names).toEqual(["General", "Website"]);
  });

  test("an unknown customer is a 404", async () => {
    const res = await req(aliceToken, `${BASE}/jobs`, {
      method: "POST",
      body: JSON.stringify({ customer_id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  test("scope=team shows teammates' time with names; edits stay owner-only", async () => {
    const projectId = await resolveJob(aliceToken, "Fit-out");
    for (const token of [aliceToken, bobToken]) {
      await req(token, `${BASE}/entries`, {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          started_at: `${DAY}T09:00:00.000Z`,
          duration_seconds: 3600,
        }),
      });
    }

    const own = (await json(req(aliceToken, `${BASE}/entries?project_id=${projectId}`))).data as {
      user_name: string;
    }[];
    expect(own.map((e) => e.user_name)).toEqual(["Alice"]);

    const team = (await json(req(aliceToken, `${BASE}/entries?project_id=${projectId}&scope=team`)))
      .data as { id: string; user_name: string; customer_id: string }[];
    expect(team.map((e) => e.user_name).sort()).toEqual(["Alice", "Bob"]);
    expect(team[0].customer_id).toBe(customerId);

    const bobs = team.find((e) => e.user_name === "Bob")!;
    const edit = await req(aliceToken, `${BASE}/entries/${bobs.id}`, {
      method: "PUT",
      body: JSON.stringify({ duration_seconds: 60 }),
    });
    expect(edit.status).toBe(404);
    const del = await req(aliceToken, `${BASE}/entries/${bobs.id}`, { method: "DELETE" });
    expect(del.status).toBe(404);
  });
});

describe("job attachments", () => {
  test("teammates share proof; only the uploader or an admin deletes it", async () => {
    const projectId = await resolveJob(aliceToken, "Proof");

    const up = await upload(aliceToken, projectId, PNG, "site-photo.png");
    expect(up.status).toBe(201);
    const photo = (await json(up)).data as { id: string; user_name: string; content_type: string };
    expect(photo.content_type).toBe("image/png");
    expect(photo.user_name).toBe("Alice");
    expect((await upload(bobToken, projectId, PDF, "report.pdf")).status).toBe(201);

    const list = (await json(req(bobToken, `${BASE}/jobs/${projectId}/${DAY}/attachments`)))
      .data as { file_name: string }[];
    expect(list.map((a) => a.file_name)).toEqual(["site-photo.png", "report.pdf"]);

    const file = await req(bobToken, `${BASE}/jobs/${projectId}/${DAY}/attachments/${photo.id}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);

    const path = `${BASE}/jobs/${projectId}/${DAY}/attachments/${photo.id}`;
    expect((await req(bobToken, path, { method: "DELETE" })).status).toBe(403);
    expect((await req(aliceToken, path, { method: "DELETE" })).status).toBe(200);

    const pdf = list.length; // still has Bob's PDF
    expect(pdf).toBe(2);
    const after = (await json(req(adminToken, `${BASE}/jobs/${projectId}/${DAY}/attachments`)))
      .data as { id: string }[];
    expect(after.length).toBe(1);
    const adminDelete = await req(
      adminToken,
      `${BASE}/jobs/${projectId}/${DAY}/attachments/${after[0].id}`,
      { method: "DELETE" },
    );
    expect(adminDelete.status).toBe(200);
  });

  test("the type comes from the bytes, and a job needs a real project and day", async () => {
    const projectId = await resolveJob(aliceToken, "Checks");
    expect((await upload(aliceToken, projectId, HTML, "innocent.png")).status).toBe(400);
    expect((await req(aliceToken, `${BASE}/jobs/nope/${DAY}/attachments`)).status).toBe(404);
    expect((await req(aliceToken, `${BASE}/jobs/${projectId}/14-11-2026/attachments`)).status).toBe(
      404,
    );
  });
});
