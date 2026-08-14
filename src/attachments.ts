// src/attachments.ts — files a Discord message carries, handed to the run as
// local paths.
//
// A mention's own attachments plus (when the mention is a reply) the direct
// reply target's are downloaded into <workspaceDir>/attachments/<runId8>/ before
// the harness spawns, and listed in the prompt's "Attached files" section. Caps
// are constants, not config: at most MAX_FILES files of MAX_BYTES each. Anything
// skipped is noted in the prompt rather than failing the run — a broken CDN URL
// must never cost someone their run.
//
// Lifecycle mirrors worktrees: a successful run's directory is deleted, a failed
// one's is kept for inspection and reaped by sweep() on worktreeTtlHours.

import fs from "node:fs";
import path from "node:path";
import type { Message } from "discord.js";
import { log } from "./log";

export const MAX_FILES = 5;
export const MAX_BYTES = 10 * 1024 * 1024;

// The bits of discord.js's Attachment we use (tests pass plain objects).
export interface AttachmentLike {
  url: string;
  name: string;
  size: number;
  contentType?: string | null;
}

export interface SavedFile {
  path: string;
  name: string;
  contentType?: string | null;
}

export function attachmentsDir(workspaceDir: string, runId: string) {
  return path.join(workspaceDir, "attachments", runId.slice(0, 8));
}

// Filenames come from whoever uploaded the file: keep the basename only, and
// nothing the filesystem (Windows, here) chokes on.
export function safeName(raw: string) {
  const base = path.basename(String(raw ?? "").replaceAll("\\", "/")).replace(/[<>:"|?*]/g, "_");
  const clean = [...base].map((c) => (c < " " ? "_" : c)).join(""); // control chars, without a control-char regex
  return !clean || clean === "." || clean === ".." ? "file" : clean;
}

function uniqueIn(dir: string, name: string) {
  const { name: stem, ext } = path.parse(name);
  let out = name;
  for (let i = 2; fs.existsSync(path.join(dir, out)); i++) out = `${stem}-${i}${ext}`;
  return out;
}

// The triggering message's files, plus the direct reply target's — a mention
// that replies to "here's the screenshot" means that screenshot. Backscroll is
// deliberately not included: it is ambient context, not the request.
export async function collect(message: Message): Promise<AttachmentLike[]> {
  const out = [...((message.attachments?.values?.() ?? []) as Iterable<AttachmentLike>)];
  const refId = message.reference?.messageId;
  if (refId) {
    try {
      const target = await message.channel.messages.fetch(refId);
      out.push(...((target.attachments?.values?.() ?? []) as Iterable<AttachmentLike>));
    } catch {}
  }
  return out;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

// Never throws: every failure becomes a note the prompt carries.
export async function save(list: AttachmentLike[], dir: string): Promise<{ files: SavedFile[]; notes: string[] }> {
  const files: SavedFile[] = [];
  const notes: string[] = [];
  for (const a of list.slice(0, MAX_FILES)) {
    const label = safeName(a.name);
    if (a.size > MAX_BYTES) {
      notes.push(`skipped ${label}: ${mb(a.size)} > ${mb(MAX_BYTES)} cap`);
      continue;
    }
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) {
        notes.push(`skipped ${label}: ${mb(buf.byteLength)} > ${mb(MAX_BYTES)} cap`);
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      const full = path.join(dir, uniqueIn(dir, label));
      fs.writeFileSync(full, buf);
      files.push({ path: full, name: a.name, contentType: a.contentType });
    } catch (e: any) {
      notes.push(`skipped ${label}: download failed (${e?.message || e})`);
    }
  }
  if (list.length > MAX_FILES) notes.push(`skipped ${list.length - MAX_FILES} more file(s): ${MAX_FILES}-file cap`);
  if (files.length || notes.length) log(`Attachments in ${dir}: ${files.length} saved, ${notes.length} skipped`);
  return { files, notes };
}

// The prompt's {ATTACHMENTS} body; empty string when the message carried none.
export function render({ files, notes }: { files: SavedFile[]; notes: string[] }) {
  const lines = [
    ...files.map((f) => `- ${f.path} — original name "${f.name}"${f.contentType ? ` (${f.contentType})` : ""}`),
    ...notes.map((n) => `- ${n}`),
  ];
  if (!lines.length) return "";
  return `The message carried files, saved locally for you (read them with Read):\n${lines.join("\n")}`;
}

// Success deletes the run's files; failure keeps them for inspection (sweep()
// reaps them on worktreeTtlHours).
export function cleanup(dir: string, ok: boolean) {
  if (!ok) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (e: any) {
    log(`Attachment cleanup failed for ${dir}: ${e?.message || e}`);
  }
}
