import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, activityLog, agentInstructionHeads, agentInstructionRevisions, type Db } from "@paperclipai/db";
import { captureDirectorySnapshot, mergeDirectoryWithBaseline, directorySnapshotSha256, type DirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { conflict, notFound, unprocessable } from "../errors.js";
import { authorizeInstructionCommit, authorizeInstructionRead } from "./agent-instruction-authorization.js";
import { assertInstructionPathSafe, instructionPath, instructionBytes, materializeInstructionBytes } from "./agent-instruction-files.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot } from "./agent-instructions.js";
import type { AuthorizationActor } from "./authorization.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Agent = typeof agents.$inferSelect;
export const AGENT_FILES_CONTRACT = "paperclip.agent-files.v1";
export const MAX_AGENT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_AGENT_DIRECTORY_BYTES = 64 * 1024 * 1024;
export const MAX_AGENT_DIRECTORY_ENTRIES = 10_000;
export const fileHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function agentFilePath(value: string): string {
  const relative = instructionPath(value);
  if (relative.split("/").includes(".paperclip-runtime") || relative === "promptTemplate.legacy.md") {
    throw unprocessable(`${relative} is reserved and cannot be used for agent files`);
  }
  return relative;
}

/** Compatibility ETag for clients whose old schema requires a UUID. This is a
 * content token, not a revision ID: no snapshot or history row is created. */
export function agentFileToken(bytes: Uint8Array): string {
  return agentFileTokenFromHash(fileHash(bytes));
}
export function agentFileTokenFromHash(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Call under the agent row lock. Import deployed revision heads once, then the
 * directory is authoritative. The adoption marker lives OUTSIDE agent files. */
export async function adoptAgentFiles(tx: Tx, agent: Agent): Promise<string> {
  if (agentInstructionsBundleMode(agent) === "external") throw unprocessable("External instructions must be migrated to managed storage first");
  const root = resolveManagedInstructionsRoot(agent);
  const markerRoot = path.join(path.dirname(root), "file-sync");
  const marker = "adopted.json";
  await assertInstructionPathSafe(root, deriveBundleState(agent).entryFile);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const filename = await assertInstructionPathSafe(markerRoot, marker);
  const adopted = await fs.readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (adopted !== null) {
    if (JSON.parse(adopted).schema !== AGENT_FILES_CONTRACT) throw new Error("Unsupported agent file contract");
    return root;
  }
  const legacy = await tx.select({ entryFile: agentInstructionHeads.entryFile, contentBase64: agentInstructionRevisions.contentBase64 })
    .from(agentInstructionHeads).innerJoin(agentInstructionRevisions, eq(agentInstructionHeads.revisionId, agentInstructionRevisions.id))
    .where(and(eq(agentInstructionHeads.companyId, agent.companyId), eq(agentInstructionHeads.agentId, agent.id)));
  for (const entry of legacy) await materializeInstructionBytes(root, entry.entryFile, Buffer.from(entry.contentBase64, "base64"));
  await materializeInstructionBytes(markerRoot, marker, Buffer.from(JSON.stringify({ schema: AGENT_FILES_CONTRACT })));
  return root;
}

export async function readAgentFile(root: string, relative: string): Promise<Buffer | null> {
  const filename = await assertInstructionPathSafe(root, relative);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_AGENT_FILE_BYTES) throw unprocessable("Agent files must be regular files of at most 16 MiB");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_AGENT_FILE_BYTES) throw unprocessable("Agent file exceeds 16 MiB");
    return bytes;
  } finally { await handle.close(); }
}

/** Validate before staging and again after provider stop; never follow links or
 * silently skip an unsupported file. Bounds apply to bytes, including binaries. */
export async function snapshotAgentFiles(root: string): Promise<DirectorySnapshot> {
  await assertInstructionPathSafe(root, ".path-check");
  let size = 0, count = 0;
  async function walk(dir: string) {
    for (const item of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = agentFilePath(dir ? `${dir}/${item.name}` : item.name);
      const stat = await fs.lstat(path.join(root, relative));
      if (++count > MAX_AGENT_DIRECTORY_ENTRIES) throw unprocessable("Agent directory exceeds 10,000 entries");
      if (stat.isDirectory()) await walk(relative);
      else if (stat.isFile() && stat.nlink === 1) {
        size += stat.size;
        if (stat.size > MAX_AGENT_FILE_BYTES || size > MAX_AGENT_DIRECTORY_BYTES) throw unprocessable("Agent directory exceeds its file or total byte limit");
      } else throw unprocessable("Agent directories support regular files and directories, without links or special files");
    }
  }
  await walk("");
  return captureDirectorySnapshot(root);
}

export function agentFileStore(db: Db) {
  async function locked<T>(companyId: string, agentId: string, actor: AuthorizationActor, write: boolean,
    fn: (tx: Tx, agent: Agent, root: string, bound: AuthorizationActor) => Promise<T>) {
    return db.transaction(async tx => {
      const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("update");
      if (!agent) throw notFound("Agent not found");
      const bound = write ? await authorizeInstructionCommit(tx, actor, agent) : await authorizeInstructionRead(tx, actor, agent);
      const root = await adoptAgentFiles(tx, agent);
      return fn(tx, agent, root, bound);
    });
  }
  async function audit(tx: Tx, agent: Agent, actor: AuthorizationActor, details: Record<string, unknown>) {
    await tx.insert(activityLog).values({ companyId: agent.companyId, actorType: actor.type === "board" ? "user" : "agent",
      actorId: (actor.type === "board" ? actor.userId : actor.agentId)!, agentId: actor.type === "agent" ? actor.agentId : null,
      runId: actor.runId, responsibleUserId: actor.type === "board" ? actor.userId : actor.onBehalfOfUserId,
      action: "agent.files_updated", entityType: "agent", entityId: agent.id, details });
  }
  return {
    locked,
    read: (companyId: string, agentId: string, relative: string, actor: AuthorizationActor) =>
      locked(companyId, agentId, actor, false, (_tx, _agent, root) => readAgentFile(root, instructionPath(relative))),
    write: (input: { companyId: string; agentId: string; path: string; bytes: Buffer | null; baseHash: string | null }, actor: AuthorizationActor) =>
      locked(input.companyId, input.agentId, actor, true, async (tx, agent, root, bound) => {
        const relative = agentFilePath(input.path);
        if (input.bytes && input.bytes.length > MAX_AGENT_FILE_BYTES) throw unprocessable("Agent file exceeds 16 MiB");
        const previous = await readAgentFile(root, relative);
        const currentHash = previous === null ? null : fileHash(previous);
        const incomingHash = input.bytes === null ? null : fileHash(input.bytes);
        if (currentHash === incomingHash) return { contentHash: currentHash, changed: false };
        if (currentHash !== input.baseHash) throw conflict("This file changed since it was read. Reload before saving.", { code: "AGENT_FILE_CONFLICT", path: relative, currentHash });
        if (input.bytes === null && relative === deriveBundleState(agent).entryFile) throw unprocessable("The configured instruction entry cannot be deleted");
        if (input.bytes !== null) {
          if (relative === deriveBundleState(agent).entryFile) instructionBytes(input.bytes);
          const snapshot = await snapshotAgentFiles(root);
          let total = input.bytes.length - (previous?.length ?? 0);
          for (const [name, entry] of snapshot.entries) if (entry.kind === "file") total += (await fs.stat(path.join(root, name))).size;
          const newEntries = relative.split("/").map((_part, i, parts) => parts.slice(0, i + 1).join("/")).filter(name => !snapshot.entries.has(name)).length;
          if (total > MAX_AGENT_DIRECTORY_BYTES || snapshot.entries.size + newEntries > MAX_AGENT_DIRECTORY_ENTRIES) throw unprocessable("Agent directory exceeds its storage limit");
        }
        if (input.bytes === null) await fs.unlink(await assertInstructionPathSafe(root, relative));
        else await materializeInstructionBytes(root, relative, input.bytes);
        await audit(tx, agent, bound, { path: relative, contentHash: incomingHash });
        return { contentHash: incomingHash, changed: true };
      }),
    apply: (input: { companyId: string; agentId: string; sourceDir: string; baseline: DirectorySnapshot; expectedCurrentHash?: string }, actor: AuthorizationActor) =>
      locked(input.companyId, input.agentId, actor, true, async (tx, agent, root, bound) => {
        const incoming = await snapshotAgentFiles(input.sourceDir);
        const entry = await readAgentFile(input.sourceDir, deriveBundleState(agent).entryFile);
        if (entry === null) throw unprocessable("The configured instruction entry cannot be deleted");
        instructionBytes(entry);
        const current = await snapshotAgentFiles(root);
        if (input.expectedCurrentHash !== undefined && directorySnapshotSha256(current) !== input.expectedCurrentHash) throw conflict("Agent files changed since review. Refresh the comparison before resolving.");
        let applyBaseline = input.baseline;
        if (input.expectedCurrentHash !== undefined) {
          const entries = new Map(input.baseline.entries);
          for (const name of new Set([...input.baseline.entries, ...incoming.entries].map(([name]) => name))) {
            if (JSON.stringify(input.baseline.entries.get(name)) === JSON.stringify(incoming.entries.get(name))) continue;
            const present = current.entries.get(name);
            if (present) entries.set(name, present); else entries.delete(name);
            if (incoming.entries.get(name)?.kind !== "dir" && input.baseline.entries.get(name)?.kind === "dir") {
              for (const [child, entry] of current.entries) if (child.startsWith(`${name}/`)) entries.set(child, entry);
            }
          }
          applyBaseline = { ...input.baseline, entries };
        }
        const finalEntries = new Map([...current.entries].map(([name, value]) => [name, { value, root }]));
        for (const [name] of applyBaseline.entries) if (!incoming.entries.has(name)) finalEntries.delete(name);
        for (const [name, value] of incoming.entries) {
          if (JSON.stringify(input.baseline.entries.get(name)) === JSON.stringify(value)) continue;
          if (value.kind !== "dir") for (const child of finalEntries.keys()) if (child.startsWith(`${name}/`)) finalEntries.delete(child);
          finalEntries.set(name, { value, root: input.sourceDir });
        }
        let total = 0;
        for (const [name, item] of finalEntries) if (item.value.kind === "file") total += (await fs.stat(path.join(item.root, name))).size;
        if (finalEntries.size > MAX_AGENT_DIRECTORY_ENTRIES || total > MAX_AGENT_DIRECTORY_BYTES) throw unprocessable("Merged agent files exceed the directory limit");
        await mergeDirectoryWithBaseline({ ...input, baseline: applyBaseline, targetDir: root, conflictPolicy: input.expectedCurrentHash === undefined ? "reject" : undefined });
        await audit(tx, agent, bound, { sourceRunId: actor.runId, contract: AGENT_FILES_CONTRACT });
      }),
  };
}
