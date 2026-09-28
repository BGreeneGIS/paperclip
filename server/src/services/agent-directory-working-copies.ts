import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, agentInstructionWorkingCopies as copies, type Db } from "@paperclipai/db";
import { syncDirectoryToSsh, restoreWorkspaceFromSshExecution } from "@paperclipai/adapter-utils/ssh";
import { prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget, type PreparedAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";
import { withDirectoryMergeLock, directorySnapshotSha256, parseDirectorySnapshot, serializeDirectorySnapshot, DirectoryMergeConflict } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { AGENT_FILES_CONTRACT, AgentFileLimitError, agentFileStore, snapshotAgentFiles, inspectAgentFile } from "./agent-file-store.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot } from "./agent-instructions.js";
import { instructionGitExcludeProgram } from "./agent-instruction-files.js";
import { resolveInstructionActor } from "./agent-instruction-authorization.js";
import { HttpError, conflict, notFound } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";

type Copy = typeof copies.$inferSelect;
const completed = new Set(["saved", "unchanged", "resolved"]);
const transports = new Map<string, PreparedAdapterExecutionTargetRuntime>();
const key = (row: Pick<Copy, "companyId" | "runId">) => `${row.companyId}:${row.runId}`;
export function isAgentDirectoryCopy(row: Pick<Copy, "receipt"> | null): boolean {
  return row?.receipt?.schema === AGENT_FILES_CONTRACT;
}
function baseline(row: Copy) {
  const snapshot = parseDirectorySnapshot(row.receipt?.baseline);
  if (!snapshot || directorySnapshotSha256(snapshot) !== row.baseHash) throw new Error("Agent directory baseline is invalid");
  return snapshot;
}
function actor(row: Copy): AuthorizationActor {
  return { type: "agent", companyId: row.companyId, agentId: row.agentId, runId: row.runId, onBehalfOfUserId: row.responsibleUserId };
}
export function agentDirectoryWorkingCopyService(db: Db, get: (companyId: string, runId: string) => Promise<Copy | null>, patch: (row: Copy, values: Partial<typeof copies.$inferInsert>) => Promise<Copy>) {
  const store = agentFileStore(db);
  async function transport(row: Copy, target: AdapterExecutionTarget, recovering: boolean) {
    if (target.kind !== "remote" || row.location !== `remote:${target.environmentId ?? ""}`) throw new Error("Agent directory environment changed");
    if (recovering && target.transport === "ssh") throw new Error("The original SSH collector is unavailable");
    if (target.transport === "ssh") {
      // Reuse SSH's plain directory transfer without its task-workspace suffix
      // or Git-history discovery. The registered root is the exact writable root.
      await syncDirectoryToSsh({ spec: target.spec, localDir: row.localRoot, remoteDir: row.executionRoot, exclude: [".paperclip-runtime"] });
      return { target, workspaceRemoteDir: row.executionRoot, runtimeRootDir: null,
        assetDirs: {}, additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null,
        restoreWorkspace: () => restoreWorkspaceFromSshExecution({ spec: target.spec, localDir: row.localRoot,
          remoteDir: row.executionRoot, baselineSnapshot: { ...baseline(row), exclude: [".paperclip-runtime"] }, restoreGitHistory: false }) };
    }
    return prepareAdapterExecutionTargetRuntime({ target, runId: row.runId, adapterKey: "agent-files",
      workspaceLocalDir: row.localRoot, workspaceRemoteDir: row.executionRoot,
      syncWorkspace: true, workspaceInboundMode: recovering ? "adopt_remote" : undefined,
      workspaceBaseline: baseline(row), workspaceGitSnapshot: null, workspaceFileMode: "all",
      workspaceExclude: [".paperclip-runtime", ".paperclip-runtime/**"] });
  }
  async function prepare(input: { companyId: string; agentId: string; runId: string; target?: AdapterExecutionTarget | null; cwd: string }) {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    if (!agent) throw notFound("Agent not found");
    if (agentInstructionsBundleMode(agent) !== "managed") return null;
    const bound = await resolveInstructionActor(db, { type: "agent", companyId: input.companyId, agentId: input.agentId, runId: input.runId });
    const root = resolveManagedInstructionsRoot(agent);
    const localRoot = path.join(path.dirname(root), "file-sync", "runs", input.runId, "live");
    // Local copies live outside the task cwd. Remote copies use the reserved,
    // excluded runtime area inside the provider's confined workspace. They are
    // synchronized independently; provider HOME is never reinterpreted.
    const executionRoot = input.target?.kind === "remote"
      ? path.posix.join(input.target.remoteCwd, ".paperclip-runtime", "agent-files", input.agentId, input.runId)
      : localRoot;
    const location = input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local";
    let row = await get(input.companyId, input.runId);
    if (row && (row.localRoot !== localRoot || row.executionRoot !== executionRoot || row.agentId !== input.agentId || row.location !== location)) throw conflict("Agent directory belongs to a different execution environment");
    if (row && completed.has(row.state) && row.location === "local") {
      const live = await fs.lstat(row.localRoot).catch(() => null);
      if (live && directorySnapshotSha256(await snapshotAgentFiles(row.localRoot)) !== (row.candidateHash ?? row.baseHash)) {
        // Do not rebase an unaccounted edit merely because the prior lifecycle
        // completed. Keep its original fence and collect it explicitly.
        return patch(row, { state: "prepared", candidateHash: null, processStoppedAt: null, attempts: 0 });
      }
    }
    if (row && !completed.has(row.state) && row.state !== "preparing") {
      if (["conflict", "pending_commit", "unavailable"].includes(row.state)) throw conflict("Resolve the preserved agent files before retrying this run");
      if (input.target?.kind === "remote" && !transports.has(key(row))) transports.set(key(row), await transport(row, input.target, true));
      return row;
    }
    const snapshot = await store.locked(input.companyId, input.agentId, bound, false, async (_tx, _agent, canonical) => {
      const snapshot = await snapshotAgentFiles(canonical);
      // A stopped lifecycle has already accounted for all its bytes. No live
      // or pending candidate ever enters this replacement path.
      await fs.rm(localRoot, { recursive: true, force: true });
      await fs.mkdir(path.dirname(localRoot), { recursive: true, mode: 0o700 });
      await fs.cp(canonical, localRoot, { recursive: true, preserveTimestamps: true });
      return snapshot;
    });
    const values = { entryFile: deriveBundleState(agent).entryFile, baseRevisionId: null, baseHash: directorySnapshotSha256(snapshot),
      localRoot, executionRoot, location, state: "preparing", candidateBase64: null, candidateHash: null,
      receipt: { schema: AGENT_FILES_CONTRACT, baseline: serializeDirectorySnapshot(snapshot) },
      processStoppedAt: null, attempts: 0, nextAttemptAt: null, errorCode: null, errorMessage: null };
    if (row) row = await patch(row, values);
    else {
      await db.insert(copies).values({ runId: input.runId, companyId: input.companyId, agentId: input.agentId, responsibleUserId: bound.onBehalfOfUserId!, ...values });
      row = (await get(input.companyId, input.runId))!;
    }
    if (input.target?.kind === "remote") {
      const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
      const excluded = await runAdapterExecutionTargetShellCommand(input.runId, input.target,
        `node -e ${quote(instructionGitExcludeProgram)} ${quote(input.target.remoteCwd)}`,
        { cwd: input.target.remoteCwd, env: {}, timeoutSec: 15 });
      if (excluded.exitCode !== 0 || excluded.timedOut) throw new Error("Could not exclude agent files from task Git staging");
      transports.set(key(row), await transport(row, input.target, false));
    }
    return patch(row, { state: "prepared" });
  }
  async function retrieve(row: Copy, target?: AdapterExecutionTarget | null) {
    if (row.location !== "local") {
      let runtime = transports.get(key(row));
      if (!runtime) {
        if (!target) throw new Error("Agent directory transport is unavailable");
        runtime = await transport(row, target, true);
        transports.set(key(row), runtime);
      }
      await runtime.restoreWorkspace();
    }
    return snapshotAgentFiles(row.localRoot);
  }
  async function hasChanges(_row: Copy, _target?: AdapterExecutionTarget | null) {
    // A whole-directory collector needs a quiescent provider, including its
    // child processes. Checkpoint and close at the turn boundary before reading
    // either local or remote files. The provider conversation remains resumable;
    // ordinary file edits do not change the session configuration digest.
    return true;
  }
  async function commit(row: Copy) {
    if (completed.has(row.state) || row.state === "conflict") return row;
    const captured = path.join(path.dirname(row.localRoot), "captured");
    try {
      const candidate = await snapshotAgentFiles(captured);
      if (directorySnapshotSha256(candidate) !== row.candidateHash) throw new Error("Captured agent files changed");
      await store.apply({ companyId: row.companyId, agentId: row.agentId, sourceDir: captured, baseline: baseline(row) }, actor(row));
      const saved = await patch(row, { state: "saved", errorCode: null, errorMessage: null, nextAttemptAt: null,
        receipt: { ...row.receipt, savedHash: row.candidateHash } });
      if (saved.state === "saved") await fs.rm(captured, { recursive: true, force: true });
      return saved;
    } catch (error) {
      const detail = error as { status?: number };
      const retryable = !(error instanceof DirectoryMergeConflict) && (!detail.status || detail.status >= 500);
      return patch(row, { state: retryable ? "pending_commit" : "conflict",
        errorCode: error instanceof DirectoryMergeConflict ? "AGENT_FILES_CONFLICT" : error instanceof AgentFileLimitError ? "AGENT_FILES_LIMIT_EXCEEDED" : "AGENT_FILES_SAVE_FAILED",
        errorMessage: error instanceof DirectoryMergeConflict ? "Agent files changed concurrently. The run's files were preserved for review." : error instanceof HttpError && error.status === 422 ? `${error.message}. No files were saved; the captured run files are preserved.` : "Agent files were captured but could not be saved.",
        receipt: { ...row.receipt, ...(error instanceof DirectoryMergeConflict ? { conflicts: error.paths } : {}) },
        nextAttemptAt: retryable && row.attempts < 3 ? new Date(Date.now() + 30_000) : null });
    }
  }
  async function collectStopped(row: Copy, target?: AdapterExecutionTarget | null) {
    if (completed.has(row.state) || row.state === "conflict") return row;
    row = await patch(row, { processStoppedAt: row.processStoppedAt ?? new Date(), attempts: row.attempts + 1 });
    if (row.state === "pending_commit" && row.candidateHash) return commit(row);
    try {
      const snapshot = await retrieve(row, target);
      const candidateHash = directorySnapshotSha256(snapshot);
      if (candidateHash === row.baseHash) return patch(row, { state: "unchanged", nextAttemptAt: null });
      const captured = path.join(path.dirname(row.localRoot), "captured");
      await fs.rm(captured, { recursive: true, force: true });
      await fs.cp(row.localRoot, captured, { recursive: true, preserveTimestamps: true });
      if (directorySnapshotSha256(await snapshotAgentFiles(captured)) !== candidateHash) throw new Error("Agent files changed during capture");
      row = await patch(row, { state: "pending_commit", candidateHash, nextAttemptAt: new Date() });
      return commit(row);
    } catch (error) {
      if (error instanceof AgentFileLimitError) {
        return patch(row, { state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED",
          errorMessage: `${error.message}. None of this run's agent-folder changes were saved. The previous saved folder will be used next time; the retrieved run copy is retained on the server for operator recovery.`, nextAttemptAt: null });
      }
      return patch(row, { state: row.attempts < 3 ? "pending_collection" : "unavailable", errorCode: "AGENT_FILES_COLLECTION_FAILED",
        errorMessage: "Agent files could not be retrieved safely before environment release. No save is claimed.", nextAttemptAt: row.attempts < 3 ? new Date(Date.now() + 30_000) : null });
    }
  }
  async function review(row: Copy, viewer: AuthorizationActor) {
    if (!row.candidateHash || completed.has(row.state)) throw conflict("These preserved files are no longer available for review");
    return store.locked(row.companyId, row.agentId, viewer, false, async (_tx, _agent, root) => {
      const current = await snapshotAgentFiles(root);
      const captured = path.join(path.dirname(row.localRoot), "captured");
      const candidate = await snapshotAgentFiles(captured);
      if (directorySnapshotSha256(candidate) !== row.candidateHash) throw conflict("Preserved files failed integrity verification");
      const before = baseline(row);
      const conflicts = Array.isArray(row.receipt?.conflicts) ? row.receipt.conflicts.filter((name): name is string => typeof name === "string") : [];
      const changed = [...new Set([...before.entries, ...candidate.entries].map(([name]) => name).concat(conflicts))]
        .filter(name => conflicts.includes(name) || JSON.stringify(before.entries.get(name)) !== JSON.stringify(candidate.entries.get(name)))
        .filter(name => before.entries.get(name)?.kind === "file" || candidate.entries.get(name)?.kind === "file" || current.entries.get(name)?.kind === "file").sort();
      let remainingPreviewBytes = 8 * 1024 * 1024;
      const preview = async (directory: string, name: string, exists: boolean) => {
        if (!exists) return { exists: false, text: null, hash: null };
        const file = await inspectAgentFile(directory, name, Math.min(1024 * 1024, remainingPreviewBytes));
        if (file === null) return { exists: false, text: null, hash: null };
        remainingPreviewBytes -= file.bytes?.length ?? 0;
        let text: string | null = null;
        if (file.bytes && !file.bytes.includes(0)) {
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); } catch { /* binary */ }
        }
        return { exists: true, text, hash: file.hash };
      };
      const files = [];
      for (const name of changed) files.push({ path: name,
        current: await preview(root, name, current.entries.get(name)?.kind === "file"),
        incoming: await preview(captured, name, candidate.entries.get(name)?.kind === "file"),
      });
      return { currentHash: directorySnapshotSha256(current), files };
    });
  }
  async function resolve(row: Copy, input: { decision: "keep_current" | "use_incoming"; currentHash: string }, viewer: AuthorizationActor) {
    if (row.state !== "conflict" && row.state !== "pending_commit") throw conflict("These agent files are not ready for resolution");
    if (input.decision === "use_incoming") {
      const captured = path.join(path.dirname(row.localRoot), "captured");
      if (directorySnapshotSha256(await snapshotAgentFiles(captured)) !== row.candidateHash) throw conflict("Preserved files failed integrity verification");
      await store.apply({ companyId: row.companyId, agentId: row.agentId, sourceDir: captured, baseline: baseline(row), expectedCurrentHash: input.currentHash }, viewer);
    } else {
      await store.locked(row.companyId, row.agentId, viewer, true, async (tx, agent, root, bound) => {
        if (directorySnapshotSha256(await snapshotAgentFiles(root)) !== input.currentHash) throw conflict("Agent files changed since review. Refresh before resolving.");
        await tx.insert(activityLog).values({ companyId: row.companyId, actorType: bound.type === "board" ? "user" : "agent",
          actorId: (bound.type === "board" ? bound.userId : bound.agentId)!, agentId: bound.type === "agent" ? bound.agentId : null,
          runId: bound.runId, responsibleUserId: bound.type === "board" ? bound.userId : bound.onBehalfOfUserId,
          action: "agent.files_discarded", entityType: "agent", entityId: agent.id, details: { sourceRunId: row.runId, candidateHash: row.candidateHash } });
      });
    }
    const resolved = await patch(row, { state: "resolved", errorCode: null, errorMessage: null, nextAttemptAt: null, receipt: { ...row.receipt, decision: input.decision } });
    if (resolved.state === "resolved") await release(resolved);
    return { state: resolved.state };
  }
  async function release(row: Copy) {
    const runtime = transports.get(key(row));
    transports.delete(key(row));
    await runtime?.cleanupWorkspaceSnapshot?.();
    let cleanupPending = false;
    if (row.processStoppedAt && (completed.has(row.state) || row.candidateHash) && runtime?.target.kind === "remote") {
      const expected = path.posix.join(runtime.target.remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, row.runId);
      if (row.executionRoot !== expected) throw new Error("Agent directory cleanup path changed");
      const quoted = `'${expected.replaceAll("'", `'"'"'`)}'`;
      cleanupPending = await runAdapterExecutionTargetShellCommand(row.runId, runtime.target, `rm -rf -- ${quoted}`,
        { cwd: runtime.target.remoteCwd, env: {}, timeoutSec: 15 }).then(result => result.exitCode !== 0 || result.timedOut, () => true);
    }
    if (completed.has(row.state) && row.processStoppedAt) {
      await fs.rm(path.dirname(row.localRoot), { recursive: true, force: true });
      await patch(row, { receipt: { schema: AGENT_FILES_CONTRACT, state: row.state, appliedCandidateHash: row.candidateHash, cleanupPending } });
    }
  }
  async function serial<T>(row: Copy, fn: (current: Copy) => Promise<T>): Promise<T> {
    // Duplicate stop callbacks and restart recovery must not race while moving
    // the one operational candidate. This lock is outside the writable tree.
    return withDirectoryMergeLock(path.resolve(row.localRoot, "../../.."), async () => {
      const current = await get(row.companyId, row.runId);
      if (!current) throw notFound("Agent directory copy not found");
      return fn(current);
    });
  }
  return { prepare, hasChanges,
    collectStopped: (row: Copy, target?: AdapterExecutionTarget | null) => serial(row, current => collectStopped(current, target)),
    commit: (row: Copy) => serial(row, commit),
    review: (row: Copy, viewer: AuthorizationActor) => serial(row, current => review(current, viewer)),
    resolve: (row: Copy, input: { decision: "keep_current" | "use_incoming"; currentHash: string }, viewer: AuthorizationActor) => serial(row, current => resolve(current, input, viewer)),
    release: (row: Copy) => serial(row, release),
  };
}
