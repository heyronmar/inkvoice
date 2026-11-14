// Proof-of-work attachments on time entries: photos (JPEG, PNG, HEIC) or PDFs,
// up to MAX_ATTACHMENTS_PER_ENTRY per entry, each MAX_ATTACHMENT_BYTES at most.
// Stored as BLOBs in tt_entry_attachments, like expense receipts, and the type
// is sniffed from the bytes rather than trusted from the upload.
//
// Access follows the entry: non-admins only reach attachments on their own
// entries; admins reach all. Adding or removing proof is not an edit of the
// tracked time, so it stays allowed on billed entries and is not subject to
// the edit guard.

import { getDb } from "../../database/connection";
import { type ReceiptContentType, sniffReceiptType } from "../../services/expense.service";
import { type Actor, getEntry, type TtTimeEntry } from "./service";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ENTRY = 20;

export interface TtAttachmentMeta {
  id: string;
  entry_id: string;
  file_name: string;
  content_type: ReceiptContentType;
  size: number;
  created_at: string;
}

const META_COLUMNS = "id, entry_id, file_name, content_type, size, created_at";

/** The entry when [actor] may see it, else null (missing or someone else's). */
function visibleEntry(actor: Actor, entryId: string): TtTimeEntry | null {
  const entry = getEntry(entryId);
  if (!entry) return null;
  if (!actor.isAdmin && entry.user_id !== actor.userId) return null;
  return entry;
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

export function listAttachments(actor: Actor, entryId: string): TtAttachmentMeta[] | null {
  if (!visibleEntry(actor, entryId)) return null;
  return getDb()
    .query(
      `SELECT ${META_COLUMNS} FROM tt_entry_attachments WHERE entry_id = ? ORDER BY created_at, rowid`,
    )
    .all(entryId) as TtAttachmentMeta[];
}

export function getAttachment(
  actor: Actor,
  entryId: string,
  id: string,
): (TtAttachmentMeta & { content: Uint8Array<ArrayBuffer> }) | null {
  if (!visibleEntry(actor, entryId)) return null;
  const row = getDb()
    .query(
      `SELECT ${META_COLUMNS}, content FROM tt_entry_attachments WHERE id = ? AND entry_id = ?`,
    )
    .get(id, entryId) as (TtAttachmentMeta & { content: Uint8Array }) | null;
  return row ? { ...row, content: new Uint8Array(row.content) } : null;
}

export type AddAttachmentResult =
  | { success: true; data: TtAttachmentMeta }
  | { success: false; status: 400 | 404 | 409 | 413; error: string };

export function addAttachment(
  actor: Actor,
  entryId: string,
  file: { name?: string; bytes: Uint8Array },
): AddAttachmentResult {
  if (!visibleEntry(actor, entryId)) {
    return { success: false, status: 404, error: "Entry not found" };
  }
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
    .query("SELECT COUNT(*) AS count FROM tt_entry_attachments WHERE entry_id = ?")
    .get(entryId) as { count: number };
  if (count >= MAX_ATTACHMENTS_PER_ENTRY) {
    return {
      success: false,
      status: 409,
      error: `An entry can have at most ${MAX_ATTACHMENTS_PER_ENTRY} attachments`,
    };
  }
  const id = crypto.randomUUID().replace(/-/g, "");
  db.run(
    `INSERT INTO tt_entry_attachments (id, entry_id, file_name, content_type, size, content, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, entryId, safeFileName(file.name, type), type, file.bytes.length, file.bytes, actor.userId],
  );
  return {
    success: true,
    data: db
      .query(`SELECT ${META_COLUMNS} FROM tt_entry_attachments WHERE id = ?`)
      .get(id) as TtAttachmentMeta,
  };
}

export function deleteAttachment(actor: Actor, entryId: string, id: string): boolean {
  if (!visibleEntry(actor, entryId)) return false;
  const res = getDb().run("DELETE FROM tt_entry_attachments WHERE id = ? AND entry_id = ?", [
    id,
    entryId,
  ]);
  return res.changes > 0;
}
