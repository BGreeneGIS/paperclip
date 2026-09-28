import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, agentInstructionWorkingCopies as copies, type Db } from "@paperclipai/db";
import { syncDirectoryToSsh, restoreWorkspaceFromSshExecution } from "@paperclipai/adapter-utils/ssh";
import { prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget, type PreparedAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";
import { withDirectoryMergeLock, directorySnapshotSha256, parseDirectorySnapshot, serializeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { AGENT_FILES_CONTRACT, AgentFileLimitError, agentFileStore, snapshotAgentFiles } from "./agent-file-store.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot } from "./agent-instructions.js";
import { instructionGitExcludeProgram } from "./agent-instruction-files.js";
import { resolveInstructionActor } from "./agent-instruction-authorization.js";
import { HttpError, conflict, notFound } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";

type Copy = typeof copies.$inferSelect;
const completed = new Set(["saved", "unchanged", "resolved", "unavailable"]);
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
    if (row && !completed.has(row.state) && row.state !== "preparing") {
      if (input.target?.kind === "remote" && !transports.has(key(row))) transports.set(key(row), await transport(row, input.target, true));
      return row;
    }
    const snapshot = await store.locked(input.companyId, input.agentId, bound, false, async (_tx, _agent, canonical) => {
      const snapshot = await snapshotAgentFiles(canonical);
      // A stopped lifecycle has already accounted for all its bytes. No live
      // or pending candidate ever enters this replacement path.
      await fs.rm(localRoot, { recursive: true, force: true });
      await fs.mkdir(path.dirname(localRoot), { recursive: true, mode: 0o700 });
      try {
        await fs.cp(canonical, localRoot, { recursive: true, preserveTimestamps: true });
        return snapshot;
      } catch (error) {
        await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
        throw error;
      }
    }).catch(async error => {
      await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
      throw error;
    });
    const values = { entryFile: deriveBundleState(agent).entryFile, baseRevisionId: null, baseHash: directorySnapshotSha256(snapshot),
      localRoot, executionRoot, location, state: "preparing", candidateBase64: null, candidateHash: null,
      receipt: { schema: AGENT_FILES_CONTRACT, baseline: serializeDirectorySnapshot(snapshot) },
      processStoppedAt: null, attempts: 0, nextAttemptAt: null, errorCode: null, errorMessage: null };
    try {
      if (row) row = await patch(row, values);
      else {
        await db.insert(copies).values({ runId: input.runId, companyId: input.companyId, agentId: input.agentId, responsibleUserId: bound.onBehalfOfUserId!, ...values });
        row = (await get(input.companyId, input.runId))!;
      }
    } catch (error) {
      await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
      throw error;
    }
    try {
      if (input.target?.kind === "remote") {
        const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
        const excluded = await runAdapterExecutionTargetShellCommand(input.runId, input.target,
          `node -e ${quote(instructionGitExcludeProgram)} ${quote(input.target.remoteCwd)}`,
          { cwd: input.target.remoteCwd, env: {}, timeoutSec: 15 });
        if (excluded.exitCode !== 0 || excluded.timedOut) throw new Error("Could not exclude agent files from task Git staging");
        transports.set(key(row), await transport(row, input.target, false));
      }
      return await patch(row, { state: "prepared" });
    } catch (error) {
      // Preparation failed before a provider could start using this copy.
      row = await patch(row, { state: "unavailable", processStoppedAt: new Date(), errorCode: "AGENT_FILES_PREPARE_FAILED",
        errorMessage: "Agent files could not be staged. The temporary copy was discarded.", nextAttemptAt: null });
      await release(row, input.target);
      throw error;
    }
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
  async function collectStopped(row: Copy, target?: AdapterExecutionTarget | null) {
    if (completed.has(row.state)) { await release(row); return (await get(row.companyId, row.runId))!; }
    row = await patch(row, { processStoppedAt: row.processStoppedAt ?? new Date() });
    // The stopped working copy is the only temporary tree. Retry transient I/O
    // at this boundary, then clean it up; there are no preserved run snapshots.
    let snapshot: Awaited<ReturnType<typeof retrieve>> | undefined;
    for (;;) {
      row = await patch(row, { attempts: row.attempts + 1 });
      try {
        snapshot ??= await retrieve(row, target);
        const candidateHash = directorySnapshotSha256(snapshot);
        if (candidateHash === row.baseHash) {
          row = await patch(row, { state: "unchanged", errorCode: null, errorMessage: null, nextAttemptAt: null });
        } else {
          await store.apply({ companyId: row.companyId, agentId: row.agentId, sourceDir: row.localRoot, baseline: baseline(row) }, actor(row));
          row = await patch(row, { state: "saved", candidateHash, errorCode: null, errorMessage: null, nextAttemptAt: null });
        }
        break;
      } catch (error) {
        const retryable = !(error instanceof HttpError) || error.status >= 500;
        if (retryable && row.attempts < 3) continue;
        row = await patch(row, { state: "unavailable", nextAttemptAt: null,
          errorCode: error instanceof AgentFileLimitError ? "AGENT_FILES_LIMIT_EXCEEDED" : "AGENT_FILES_SAVE_FAILED",
          errorMessage: error instanceof HttpError && error.status === 422
            ? `${error.message}. This run's agent-folder changes were not saved; the temporary copy is discarded.`
            : "Agent-file synchronization failed. No successful save is claimed; the temporary copy is discarded.",
        });
        break;
      }
    }
    await release(row);
    return (await get(row.companyId, row.runId))!;
  }
  async function release(row: Copy, target?: AdapterExecutionTarget | null) {
    const runtime = transports.get(key(row));
    transports.delete(key(row));
    let cleanupPending = row.receipt?.cleanupPending === true;
    await runtime?.cleanupWorkspaceSnapshot?.().catch(() => { cleanupPending = true; });
    const cleanupTarget = runtime?.target ?? target;
    if (row.processStoppedAt && completed.has(row.state) && cleanupTarget?.kind === "remote") {
      const expected = path.posix.join(cleanupTarget.remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, row.runId);
      if (row.executionRoot !== expected) throw new Error("Agent directory cleanup path changed");
      const quoted = `'${expected.replaceAll("'", `'"'"'`)}'`;
      const remoteCleanupFailed = await runAdapterExecutionTargetShellCommand(row.runId, cleanupTarget, `rm -rf -- ${quoted}`,
        { cwd: cleanupTarget.remoteCwd, env: {}, timeoutSec: 15 }).then(result => result.exitCode !== 0 || result.timedOut, () => true);
      cleanupPending ||= remoteCleanupFailed;
    }
    if (completed.has(row.state) && row.processStoppedAt) {
      try { await fs.rm(path.dirname(row.localRoot), { recursive: true, force: true }); }
      catch {
        // Leave the baseline marker so restart recovery retries failed cleanup.
        await patch(row, { receipt: { ...row.receipt, cleanupPending: true } });
        return;
      }
      await patch(row, { receipt: { schema: AGENT_FILES_CONTRACT, state: row.state, appliedCandidateHash: row.candidateHash, cleanupPending } });
    }
  }
  async function serial<T>(row: Copy, fn: (current: Copy) => Promise<T>): Promise<T> {
    // Duplicate stop callbacks and restart recovery must not race while moving
    // the stopped working copy. This lock is outside the writable tree.
    return withDirectoryMergeLock(path.resolve(row.localRoot, "../../.."), async () => {
      const current = await get(row.companyId, row.runId);
      if (!current) throw notFound("Agent directory copy not found");
      return fn(current);
    });
  }
  return { prepare, hasChanges,
    collectStopped: (row: Copy, target?: AdapterExecutionTarget | null) => serial(row, current => collectStopped(current, target)),
    release: (row: Copy) => serial(row, release),
  };
}
