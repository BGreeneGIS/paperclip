import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, chatCompletionDeliveries as deliveries, chatTaskHandoffs as handoffs,
  companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { chatCompletionDeliveryService, prepareChatCompletionTurn, recordChatCompletion, recordChatHandoff } from "../services/chat-completion-delivery.js";
import { shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat completion delivery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("chat-completion-"); db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });
  beforeEach(async () => { await db.update(deliveries).set({ status: "exhausted" }); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), sourceId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Completion", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lead", status: "idle", adapterType: "process" });
    await db.insert(issues).values({ id: sourceId, companyId, title: "Chat", status: "in_progress", conversationAgentId: agentId,
      conversationUserId: "operator", conversationState: "waiting", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", contextSnapshot: { issueId: sourceId, conversationSessionGeneration: 0 } });
    const create = () => issueService(db).create(companyId, { title: `Write note ${randomUUID()}`, status: "todo", createdByAgentId: agentId, actorRunId: runId });
    const task = await create();
    const finish = (taskId = task.id) => issueService(db).update(taskId, { status: "done" });
    const rows = () => db.select().from(deliveries).where(eq(deliveries.companyId, companyId));
    const due = () => db.update(deliveries).set({ nextAttemptAt: new Date(0) }).where(eq(deliveries.companyId, companyId));
    const wakeup = vi.fn(async (_agentId: string, options: any) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", contextSnapshot: options.contextSnapshot }).returning();
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "queued", idempotencyKey: options.idempotencyKey, runId: run.id });
      return run;
    });
    const service = chatCompletionDeliveryService(db, { wakeup } as any);
    const run = async () => {
      const [delivery] = await rows();
      await service.deliver(delivery.id);
      const [current] = await rows();
      const [r] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.targetRunId!));
      return prepareChatCompletionTurn(db, r);
    };
    return { companyId, agentId, sourceId, runId, task, create, finish, rows, due, wakeup, service, run };
  }
  it("records authenticated origins and atomically creates one event per Done transition", async () => {
    const f = await seed();
    expect(await db.select().from(handoffs).where(eq(handoffs.taskId, f.task.id))).toMatchObject([{ conversationId: f.sourceId, sessionGeneration: 0 }]);
    const done = await f.finish();
    await db.transaction(tx => recordChatCompletion(tx, f.task, done!));
    expect(await f.rows()).toHaveLength(1);
    await issueService(db).update(f.task.id, { status: "todo" });
    expect(await f.rows()).toMatchObject([{ status: "superseded" }]);
    await f.finish(); expect(await f.rows()).toHaveLength(2);
    await expect(db.transaction(async tx => { await issueService(tx as any).update(f.task.id, { status: "todo" }, tx); throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect((await f.rows()).filter(d => d.status === "pending")).toHaveLength(1);
  });
  it.each(["other-company", "other-agent", "old-session", "forged-origin"])("does not enroll %s origins", async kind => {
    const f = await seed();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Unlinked", createdByAgentId: f.agentId }).returning();
    if (kind === "old-session") await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.sourceId));
    await recordChatHandoff(db, { ...task, ...(kind === "other-company" ? { companyId: randomUUID() } : {}), ...(kind === "other-agent" ? { createdByAgentId: randomUUID() } : {}) }, kind === "forged-origin" ? null : f.runId);
    expect(await db.select().from(handoffs).where(eq(handoffs.taskId, task.id))).toEqual([]);
  });
  it("batches pending tasks at turn start and acknowledges only a final persisted reply", async () => {
    const f = await seed(); const second = await f.create(); await f.finish(); await f.finish(second.id);
    await documentService(db).upsertIssueDocument({ issueId: f.task.id, key: "welcome", title: "Welcome", format: "markdown", body: "Come to our garden at 10:30. Everyone is welcome." });
    const run = await f.run();
    expect(run.contextSnapshot?.chatCompletionDeliveryIds).toHaveLength(2);
    expect(run.contextSnapshot?.chatCompletionUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.task.id, status: "done", documents: [expect.objectContaining({ body: expect.stringContaining("10:30") })] })]));
    await issueService(db).addComment(f.sourceId, "Reading the results", { agentId: f.agentId, runId: run.id });
    expect((await f.rows()).every(d => d.status === "queued")).toBe(true);
    const reply = await issueService(db).addComment(f.sourceId, "Both notes are ready.", { agentId: f.agentId, runId: run.id }, { completionReply: true });
    expect((await f.rows()).every(d => d.status === "delivered" && d.responseCommentId === reply.id)).toBe(true);
    const replay = await issueService(db).addComment(f.sourceId, "A differently worded duplicate", { agentId: f.agentId, runId: run.id }, { completionReply: true });
    expect(replay.id).toBe(reply.id);
    await f.due(); await f.service.sweepPending(); expect(f.wakeup).toHaveBeenCalledTimes(1);
  });
  it("does not lose a completion that arrives after the turn starts", async () => {
    const f = await seed(); await f.finish(); const first = await f.run();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, first.id));
    const second = await f.create(); await f.finish(second.id);
    const [delivery] = (await f.rows()).filter(d => d.taskId === second.id);
    await f.service.deliver(delivery.id);
    expect(f.wakeup).toHaveBeenCalledTimes(2);
    expect(first.contextSnapshot?.chatCompletionDeliveryIds).toHaveLength(1);
    expect(shouldQueueFollowupForRunningIssueWake({ contextSnapshot: { wakeReason: "chat_task_completed" }, wakeCommentId: null })).toBe(true);
  });
  it.each(["reset", "reopen"])("suppresses a %s between dispatch and publication", async kind => {
    const f = await seed(); await f.finish(); const run = await f.run();
    if (kind === "reset") await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.sourceId));
    else await issueService(db).update(f.task.id, { status: "todo" });
    await expect(issueService(db).addComment(f.sourceId, "It is finished", { agentId: f.agentId, runId: run.id }, { completionReply: true })).rejects.toThrow();
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, run.id))).toEqual([]);
    await f.due(); await f.service.sweepPending();
    expect(await f.rows()).toMatchObject([{ status: "superseded" }]);
  });
  it("recovers the wake receipt if the dispatcher crashes before saving the run pointer", async () => {
    const f = await seed(); await f.finish(); const [delivery] = await f.rows();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation", status: "claimed", runId: run.id, idempotencyKey: `chat-completion:${delivery.id}:0` });
    await f.service.deliver(delivery.id); expect(f.wakeup).not.toHaveBeenCalled();
  });
  it("serializes concurrent dispatch and retries a failed response without retrying delivered output", async () => {
    const f = await seed(); await f.finish(); const [delivery] = await f.rows();
    await Promise.all([f.service.deliver(delivery.id), f.service.deliver(delivery.id)]);
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    const [queued] = await f.rows();
    await db.update(heartbeatRuns).set({ status: "failed", error: "worker crashed" }).where(eq(heartbeatRuns.id, queued.targetRunId!));
    await f.due(); await f.service.deliver(delivery.id); await f.due(); await f.service.deliver(delivery.id);
    expect(f.wakeup).toHaveBeenCalledTimes(2);
    expect((await f.rows())[0].attempts).toBe(1);
  });
  it("keeps paused agents paused and retries after they resume", async () => {
    const f = await seed(); await f.finish(); const [delivery] = await f.rows();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await f.service.deliver(delivery.id); expect(f.wakeup).not.toHaveBeenCalled();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await f.due(); await f.service.deliver(delivery.id); expect(f.wakeup).toHaveBeenCalledOnce();
  });
  it("queues onboarding completion behind a busy turn without changing generic handoffs", () => {
    expect(shouldQueueFollowupForRunningIssueWake({ contextSnapshot: { wakeReason: "issue_children_completed", onboardingCompletion: true }, wakeCommentId: null })).toBe(true);
    expect(shouldQueueFollowupForRunningIssueWake({ contextSnapshot: { wakeReason: "issue_children_completed" }, wakeCommentId: null })).toBe(false);
  });
});
