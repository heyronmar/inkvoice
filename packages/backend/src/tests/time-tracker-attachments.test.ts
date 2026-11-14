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

const TEST_DB = "./data/test-time-tracker-attachments.db";
const BASE = "/api/v1/plugins/time-tracker";
let app: Hono;
let adminToken: string;
let aliceToken: string;
let bobToken: string;

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
  return ((await res.json()) as any).data.token as string;
}

async function addUser(username: string): Promise<string> {
  const hash = await bcrypt.hash("ttattachpass", 10);
  getDb().run(
    "INSERT INTO users (id, username, password_hash, is_admin, is_active) VALUES (?, ?, ?, 0, 1)",
    [crypto.randomBytes(16).toString("hex"), username, hash],
  );
  return login(username, "ttattachpass");
}

function req(token: string, path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (typeof opts.body === "string") headers["Content-Type"] = "application/json";
  return app.request(new Request(`http://localhost${path}`, { ...opts, headers }));
}

function upload(token: string, entryId: string, bytes: Uint8Array<ArrayBuffer>, name: string) {
  const form = new FormData();
  form.append("file", new File([bytes], name));
  return req(token, `${BASE}/entries/${entryId}/attachments`, { method: "POST", body: form });
}

async function newEntry(token: string, projectId: string): Promise<string> {
  const res = await req(token, `${BASE}/entries`, {
    method: "POST",
    body: JSON.stringify({
      project_id: projectId,
      started_at: new Date().toISOString(),
      duration_seconds: 600,
    }),
  });
  return ((await res.json()) as any).data.id as string;
}

let projectId: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "ttattachadminpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  initDatabase();
  runMigrations();
  runPluginMigrations();
  await seed();
  app = createApp();
  adminToken = await login("admin", "ttattachadminpass");
  aliceToken = await addUser("tt_alice");
  bobToken = await addUser("tt_bob");
  const project = await req(adminToken, `${BASE}/projects`, {
    method: "POST",
    body: JSON.stringify({ name: "Proof Project" }),
  });
  projectId = ((await project.json()) as any).data.id as string;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("time entry attachments", () => {
  test("upload, list, count on entries, download and delete", async () => {
    const entryId = await newEntry(aliceToken, projectId);

    const up = await upload(aliceToken, entryId, PNG, "site-photo.png");
    expect(up.status).toBe(201);
    const meta = ((await up.json()) as any).data;
    expect(meta.content_type).toBe("image/png");
    expect(meta.file_name).toBe("site-photo.png");
    expect(meta.size).toBe(PNG.length);

    expect((await upload(aliceToken, entryId, PDF, "report.pdf")).status).toBe(201);

    const list = (
      (await (await req(aliceToken, `${BASE}/entries/${entryId}/attachments`)).json()) as any
    ).data;
    expect(list.map((a: any) => a.file_name)).toEqual(["site-photo.png", "report.pdf"]);

    const entries = ((await (await req(aliceToken, `${BASE}/entries`)).json()) as any).data;
    expect(entries.find((e: any) => e.id === entryId).attachment_count).toBe(2);

    const file = await req(aliceToken, `${BASE}/entries/${entryId}/attachments/${meta.id}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toBe("image/png");
    expect(file.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);

    const del = await req(aliceToken, `${BASE}/entries/${entryId}/attachments/${meta.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const after = (
      (await (await req(aliceToken, `${BASE}/entries/${entryId}/attachments`)).json()) as any
    ).data;
    expect(after.length).toBe(1);
  });

  test("the type comes from the bytes, not the name", async () => {
    const entryId = await newEntry(aliceToken, projectId);
    const res = await upload(aliceToken, entryId, HTML, "innocent.png");
    expect(res.status).toBe(400);
  });

  test("other users cannot see or change someone else's attachments", async () => {
    const entryId = await newEntry(aliceToken, projectId);
    const meta = ((await (await upload(aliceToken, entryId, PNG, "a.png")).json()) as any).data;

    expect((await req(bobToken, `${BASE}/entries/${entryId}/attachments`)).status).toBe(404);
    expect((await upload(bobToken, entryId, PNG, "b.png")).status).toBe(404);
    expect((await req(bobToken, `${BASE}/entries/${entryId}/attachments/${meta.id}`)).status).toBe(
      404,
    );
    expect(
      (
        await req(bobToken, `${BASE}/entries/${entryId}/attachments/${meta.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);

    // Admins see everyone's.
    expect((await req(adminToken, `${BASE}/entries/${entryId}/attachments`)).status).toBe(200);
  });

  test("attachments go with their entry", async () => {
    const entryId = await newEntry(aliceToken, projectId);
    await upload(aliceToken, entryId, PNG, "a.png");
    await req(aliceToken, `${BASE}/entries/${entryId}`, { method: "DELETE" });
    const { count } = getDb()
      .query("SELECT COUNT(*) AS count FROM tt_entry_attachments WHERE entry_id = ?")
      .get(entryId) as { count: number };
    expect(count).toBe(0);
  });
});
