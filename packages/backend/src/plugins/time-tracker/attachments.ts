// Proof-of-work attachments on a job: a project on a day, shared by everyone
// who logs time on it. Photos (JPEG, PNG, HEIC) or PDFs, up to
// MAX_ATTACHMENTS_PER_JOB per job, each MAX_ATTACHMENT_BYTES at most. Stored as
// BLOBs in tt_job_attachments, like expense receipts, with the type sniffed
// from the bytes rather than trusted from the upload.
//
// Everyone with Time Tracker access can see and add proof on any job (teams
// share jobs); only the uploader or an admin can delete it. Proof is not an
// edit of tracked time, so it is allowed on billed time and is not subject to
// the entry edit guard.

import { getDb } from "../../database/connection";
import { type ReceiptContentType, sniffReceiptType } from "../../services/expense.service";
import { type Actor, getProject } from "./service";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_JOB = 50;

export interface TtJobAttachmentMeta {
  id: string;
  project_id: string;
  day: string;
  file_name: string;
  content_type: ReceiptContentType;
  size: number;
  user_id: string;
  /** Who added it: display name, else username. */
  user_name: string | null;
  created_at: string;
}

const META_SELECT = `SELECT a.id, a.project_id, a.day, a.file_name, a.content_type, a.size,
       a.user_id, COALESCE(NULLIF(u.display_name, ''), u.username) AS user_name, a.created_at
  FROM tt_job_attachments a LEFT JOIN users u ON u.id = a.user_id`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether [projectId]/[day] names a job that can hold attachments. */
function isJob(projectId: string, day: string): boolean {
  return DAY.test(day) && !Number.isNaN(Date.parse(day)) && getProject(projectId) !== null;
}

function safeFileName(name: string | undefined, type: ReceiptContentType): string {
  const ext: Record<ReceiptContentType, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/heic": "heic",
    "application/pdf": "pdf",
  };
  const last = (name || "").split(/[\\/]/).pop() ?? "";
  const base = Array.from(last)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f && ch !== '"';
    })
    .join("")
    .trim()
    .slice(0, 200);
  return base || `attachment.${ext[type]}`;
}

export function listAttachments(projectId: string, day: string): TtJobAttachmentMeta[] | null {
  if (!isJob(projectId, day)) return null;
  return getDb()
    .query(`${META_SELECT} WHERE a.project_id = ? AND a.day = ? ORDER BY a.created_at, a.rowid`)
    .all(projectId, day) as TtJobAttachmentMeta[];
}

export function getAttachment(
  projectId: string,
  day: string,
  id: string,
): (TtJobAttachmentMeta & { content: Uint8Array<ArrayBuffer> }) | null {
  const meta = getDb()
    .query(`${META_SELECT} WHERE a.id = ? AND a.project_id = ? AND a.day = ?`)
    .get(id, projectId, day) as TtJobAttachmentMeta | null;
  if (!meta) return null;
  const { content } = getDb()
    .query("SELECT content FROM tt_job_attachments WHERE id = ?")
    .get(id) as { content: Uint8Array };
  return { ...meta, content: new Uint8Array(content) };
}

export type AddAttachmentResult =
  | { success: true; data: TtJobAttachmentMeta }
  | { success: false; status: 400 | 404 | 409 | 413; error: string };

export function addAttachment(
  actor: Actor,
  projectId: string,
  day: string,
  file: { name?: string; bytes: Uint8Array },
): AddAttachmentResult {
  if (!isJob(projectId, day)) return { success: false, status: 404, error: "Job not found" };
  if (file.bytes.length === 0) return { success: false, status: 400, error: "File is empty" };
  if (file.bytes.length > MAX_ATTACHMENT_BYTES) {
    return { success: false, status: 413, error: "Attachments must be 10 MB or smaller" };
  }
  const type = sniffReceiptType(file.bytes);
  if (!type) {
    return {
      success: false,
      status: 400,
      error: "Unsupported file type. Allowed: JPEG, PNG, HEIC, PDF",
    };
  }
  const db = getDb();
  const { count } = db
    .query("SELECT COUNT(*) AS count FROM tt_job_attachments WHERE project_id = ? AND day = ?")
    .get(projectId, day) as { count: number };
  if (count >= MAX_ATTACHMENTS_PER_JOB) {
    return {
      success: false,
      status: 409,
      error: `A job can have at most ${MAX_ATTACHMENTS_PER_JOB} attachments`,
    };
  }
  const id = crypto.randomUUID().replace(/-/g, "");
  db.run(
    `INSERT INTO tt_job_attachments
       (id, project_id, day, file_name, content_type, size, content, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectId,
      day,
      safeFileName(file.name, type),
      type,
      file.bytes.length,
      file.bytes,
      actor.userId,
    ],
  );
  return {
    success: true,
    data: db.query(`${META_SELECT} WHERE a.id = ?`).get(id) as TtJobAttachmentMeta,
  };
}

export function deleteAttachment(
  actor: Actor,
  projectId: string,
  day: string,
  id: string,
): "deleted" | "not_found" | "forbidden" {
  const db = getDb();
  const row = db
    .query("SELECT user_id FROM tt_job_attachments WHERE id = ? AND project_id = ? AND day = ?")
    .get(id, projectId, day) as { user_id: string } | null;
  if (!row) return "not_found";
  if (!actor.isAdmin && row.user_id !== actor.userId) return "forbidden";
  db.run("DELETE FROM tt_job_attachments WHERE id = ?", [id]);
  return "deleted";
}
