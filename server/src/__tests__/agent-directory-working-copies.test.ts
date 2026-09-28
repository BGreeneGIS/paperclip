import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as executionTargetTools from "@paperclipai/adapter-utils/execution-target";
import * as ssh from "@paperclipai/adapter-utils/ssh";
const execFile = promisify(execFileCallback);
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentFileStore, fileHash } from "../services/agent-file-store.js";
import { agents, companies, authUsers, companyMemberships, principalPermissionGrants, heartbeatRuns, agentInstructionWorkingCopies, agentInstructionRevisions, agentInstructionHeads, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { buildNativeRuntimeContext } from "../services/native-runtime/runtime-context.js";

describe("persistent agent directories", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  let revisions: ReturnType<typeof agentInstructionRevisionService>;
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let companyId: string, agentId: string, userId: string, root: string;
  const entryFile = "policy/INSTRUCTIONS.txt";
  const initial = "\uFEFF# Original\r\n☃\n";
  const target = () => ({ companyId, agentId });
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  async function run() {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    return (await copies.prepare({ ...target(), runId, cwd: home }))!;
  }
  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-working-copies-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("instruction-copies-db-");
    db = createDb(database.connectionString);
    copies = agentInstructionWorkingCopyService(db);
    revisions = agentInstructionRevisionService(db);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) {
      const writable = async (dir: string) => {
        await fs.chmod(dir, 0o700);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
      };
      await writable(home);
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Instruction tests", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ ...target(), id: agentId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), initial);
  });

  it.each([".paperclip-runtime/state", "notes/.paperclip-runtime/state", "promptTemplate.legacy.md"])("rejects reserved board path %s before mutation", async (reserved) => {
    await expect(agentFileStore(db).write({ ...target(), path: reserved, bytes: Buffer.from("reserved"), baseHash: null }, board())).rejects.toMatchObject({ status: 422 });
    await expect(fs.stat(path.join(root, reserved))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await run()).toBeTruthy();
  });

  it("round trips nested text, empty directories and binary bytes independently of task files", async () => {
    const first = await run();
    expect(first.localRoot.startsWith(path.join(home, ".paperclip-runtime"))).toBe(false);
    await fs.mkdir(path.join(first.localRoot, "notes", "empty"), { recursive: true });
    await fs.writeFile(path.join(first.localRoot, "notes", "fact.txt"), "remember me");
    const bytes = Buffer.from([0, 255, 17, 128, 9]);
    await fs.writeFile(path.join(first.localRoot, "image.bin"), bytes);
    await fs.writeFile(path.join(home, "task-only.txt"), "not personal");
    expect((await copies.collectStopped({ companyId, runId: first.runId }))?.state).toBe("saved");
    copies = agentInstructionWorkingCopyService(db);
    const next = await run();
    expect(await fs.readFile(path.join(next.localRoot, "notes", "fact.txt"), "utf8")).toBe("remember me");
    expect(await fs.readFile(path.join(next.localRoot, "image.bin"))).toEqual(bytes);
    expect((await fs.stat(path.join(next.localRoot, "notes", "empty"))).isDirectory()).toBe(true);
    await expect(fs.stat(path.join(next.localRoot, "task-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId))).toHaveLength(0);
  });

  it("merges independent writes, preserves same-file conflicts, and resolves only against the reviewed current directory", async () => {
    const a = await run(), b = await run();
    await fs.writeFile(path.join(a.localRoot, "a.txt"), "A");
    await fs.writeFile(path.join(b.localRoot, "b.txt"), "B");
    expect((await copies.collectStopped({ companyId, runId: a.runId }))?.state).toBe("saved");
    expect((await copies.collectStopped({ companyId, runId: b.runId }))?.state).toBe("saved");
    const c = await run(), d = await run();
    await fs.writeFile(path.join(c.localRoot, "a.txt"), "C");
    await fs.writeFile(path.join(d.localRoot, "a.txt"), "D");
    await copies.collectStopped({ companyId, runId: c.runId });
    expect((await copies.collectStopped({ companyId, runId: d.runId }))?.state).toBe("conflict");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("C");
    const review = await copies.reviewDirectory(companyId, agentId, d.runId, board());
    expect(review.files).toMatchObject([{ path: "a.txt", current: { text: "C" }, incoming: { text: "D" } }]);
    await agentFileStore(db).write({ ...target(), path: "b.txt", bytes: Buffer.from("new B"), baseHash: fileHash(Buffer.from("B")) }, board());
    await expect(copies.resolveDirectory(companyId, agentId, d.runId, { decision: "use_incoming", currentHash: review.currentHash }, board())).rejects.toMatchObject({ status: 409 });
    const fresh = await copies.reviewDirectory(companyId, agentId, d.runId, board());
    await copies.resolveDirectory(companyId, agentId, d.runId, { decision: "use_incoming", currentHash: fresh.currentHash }, board());
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("D");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("new B");
  });

  it("persists rename and deletion while preserving a concurrently edited deletion", async () => {
    await fs.writeFile(path.join(root, "old.txt"), "old");
    const copy = await run();
    await fs.rename(path.join(copy.localRoot, "old.txt"), path.join(copy.localRoot, "new.txt"));
    await agentFileStore(db).write({ ...target(), path: "old.txt", bytes: Buffer.from("board"), baseHash: fileHash(Buffer.from("old")) }, board());
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("conflict");
    expect(await fs.readFile(path.join(root, "old.txt"), "utf8")).toBe("board");
    await expect(fs.stat(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await agentFileStore(db).write({ ...target(), path: "independent.txt", bytes: Buffer.from("keep"), baseHash: null }, board());
    const reviewed = await copies.reviewDirectory(companyId, agentId, copy.runId, board());
    await copies.resolveDirectory(companyId, agentId, copy.runId, { decision: "use_incoming", currentHash: reviewed.currentHash }, board());
    await expect(fs.stat(path.join(root, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(root, "independent.txt"), "utf8")).toBe("keep");
  });

  it("rejects symlinks without saving any part of the tree", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, "innocent.txt"), "changed");
    await fs.symlink(path.join(home, "outside"), path.join(copy.localRoot, "escape"));
    const result = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(result?.state).toBe("pending_collection");
    await expect(fs.stat(path.join(root, "innocent.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adopts the last deployed head once and bridges an old collector without appending history", async () => {
    const id = randomUUID();
    const content = "last deployed revision";
    await db.insert(agentInstructionRevisions).values({ id, ...target(), entryFile, contentBase64: Buffer.from(content).toString("base64"), contentHash: fileHash(Buffer.from(content)), byteLength: content.length, source: "board" });
    await db.insert(agentInstructionHeads).values({ ...target(), entryFile, revisionId: id });
    const current = await revisions.readCurrent(target(), board());
    expect(current?.content).toBe(content);
    await revisions.commit({ ...target(), entryFile, content: "new directory contents", baseRevisionId: id, source: "cleanup" }, board());
    await revisions.materializeCurrent(target());
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe("new directory contents");
    await expect(revisions.commit({ ...target(), entryFile, content: "stale legacy run", baseRevisionId: id, source: "cleanup" }, board())).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId))).toHaveLength(1);
  });

  it("ordinary file edits leave the loaded instruction digest unchanged", async () => {
    const make = async () => {
      const copy = await run();
      const context = await buildNativeRuntimeContext({ db, agent: { id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } },
        runId: copy.runId, runtimeConfig: {}, runtimeSkillEntries: [], instructionWorkingCopy: { rootPath: copy.executionRoot, entryPath: entryFile, kind: "agent_files" } });
      return { copy, context };
    };
    const before = await make();
    await fs.writeFile(path.join(before.copy.localRoot, "notes.txt"), "new personal knowledge");
    await copies.collectStopped({ companyId, runId: before.copy.runId });
    const after = await make();
    expect(after.context.aggregateDigest).toBe(before.context.aggregateDigest);
    expect(after.context.instructions.bundle.fileCount).toBe(1);
  });
  it("uses the workspace transport to restore after destruction of the remote filesystem", async () => {
    const remoteCwd = path.join(home, "remote-task");
    await fs.mkdir(remoteCwd, { recursive: true });
    await execFile("git", ["init", remoteCwd]);
    const runner: import("@paperclipai/adapter-utils/command-managed-runtime").CommandManagedRuntimeRunner = {
      execute: async input => {
        const startedAt = new Date().toISOString();
        const env = { ...process.env, ...input.env };
        const args = [...(input.args ?? [])];
        if (input.stdin != null && (args[0] === "-c" || args[0] === "-lc")) {
          env.PAPERCLIP_TEST_STDIN = input.stdin;
          args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
        }
        try {
          const result = await execFile(input.command, args, { cwd: input.cwd, env, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
          return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
        } catch (error) {
          const e = error as { code?: number; signal?: NodeJS.Signals; stdout?: string; stderr?: string };
          return { exitCode: typeof e.code === "number" ? e.code : 1, signal: e.signal ?? null, timedOut: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", pid: null, startedAt };
        }
      },
    };
    const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId: randomUUID(), remoteCwd, runner };
    const prepare = async () => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
      return (await copies.prepare({ ...target(), runId, cwd: home, target: executionTarget }))!;
    };
    await fs.mkdir(path.join(root, "build"));
    await fs.writeFile(path.join(root, "build", "personal.txt"), "cache-like names are still agent files");
    const first = await prepare();
    expect(await fs.readFile(path.join(first.executionRoot, "build", "personal.txt"), "utf8")).toBe("cache-like names are still agent files");
    await fs.mkdir(path.join(first.executionRoot, "notes"));
    await fs.writeFile(path.join(first.executionRoot, "notes", "bytes.bin"), Buffer.from([0, 128, 255]));
    await fs.mkdir(path.join(first.executionRoot, "node_modules"));
    await fs.writeFile(path.join(first.executionRoot, "node_modules", "personal.txt"), "retain this too");
    await fs.writeFile(path.join(remoteCwd, "task-only.txt"), "task");
    expect((await execFile("git", ["-C", remoteCwd, "status", "--porcelain", "--untracked-files=all"])).stdout).toBe("?? task-only.txt\n");
    expect((await copies.collectStopped({ companyId, runId: first.runId, target: executionTarget }))?.state).toBe("saved");
    await copies.release(companyId, first.runId);
    expect((await copies.get(companyId, first.runId))?.receipt?.baseline).toBeUndefined();
    await expect(fs.stat(first.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(remoteCwd, { recursive: true });
    await fs.mkdir(remoteCwd);
    copies = agentInstructionWorkingCopyService(db);
    const second = await prepare();
    expect(await fs.readFile(path.join(second.executionRoot, "notes", "bytes.bin"))).toEqual(Buffer.from([0,128,255]));
    expect(await fs.readFile(path.join(second.executionRoot, "node_modules", "personal.txt"), "utf8")).toBe("retain this too");
    await expect(fs.stat(path.join(second.executionRoot, "task-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await copies.collectStopped({ companyId, runId: second.runId, target: executionTarget });
    await copies.release(companyId, second.runId);
  });

  it("stages SSH agent files at the registered root without a nested task workspace", async () => {
    const remoteCwd = path.join(home, "ssh-task");
    const exclude = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" });
    const stage = vi.spyOn(ssh, "syncDirectoryToSsh").mockImplementation(async input => {
      await fs.mkdir(path.dirname(input.remoteDir), { recursive: true });
      await fs.cp(input.localDir, input.remoteDir, { recursive: true });
    });
    const restore = vi.spyOn(ssh, "restoreWorkspaceFromSshExecution").mockImplementation(async input => {
      await fs.cp(input.remoteDir!, input.localDir, { recursive: true });
    });
    try {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
      const target = { kind: "remote" as const, transport: "ssh" as const, environmentId: randomUUID(), remoteCwd,
        spec: { host: "unused.invalid", port: 22, username: "test", remoteCwd } };
      const copy = (await copies.prepare({ companyId, agentId, runId, cwd: home, target }))!;
      expect(stage).toHaveBeenCalledWith(expect.objectContaining({ remoteDir: copy.executionRoot }));
      expect(await fs.readFile(path.join(copy.executionRoot, entryFile), "utf8")).toBe(initial);
      await fs.writeFile(path.join(copy.executionRoot, "ssh-note.txt"), "persistent SSH file");
      expect((await copies.collectStopped({ companyId, runId, target }))?.state).toBe("saved");
      expect(restore).toHaveBeenCalledWith(expect.objectContaining({ remoteDir: copy.executionRoot, restoreGitHistory: false }));
      expect(await fs.readFile(path.join(root, "ssh-note.txt"), "utf8")).toBe("persistent SSH file");
    } finally { stage.mockRestore(); restore.mockRestore(); exclude.mockRestore(); }
  });

  it("deduplicates concurrent stopped callbacks and discards completed operational snapshots", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, "note.txt"), "one write");
    const results = await Promise.all([copies.collectStopped({ companyId, runId: copy.runId }), copies.collectStopped({ companyId, runId: copy.runId })]);
    expect(results.every(result => result?.state === "saved")).toBe(true);
    // Simulate a crash after save but before release. The restart sweeper must
    // reclaim operational baselines without touching canonical files.
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverCaptured();
    const row = await copies.get(companyId, copy.runId);
    expect(row?.receipt?.schema).toBe("paperclip.agent-files.v1");
    expect(row?.receipt?.baseline).toBeUndefined();
    expect(await fs.readFile(path.join(root, "note.txt"), "utf8")).toBe("one write");
  });

});
