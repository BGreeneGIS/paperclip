import { expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveManagedProjectWorkspaceDir, resolveDefaultAgentWorkspaceDir } from "../../server/src/home-paths.js";
import { pollUntil, type RunnerApi } from "./api.js";
import { sendChatMessage, readChatOutputDocument, collectChatRunEvidence, type ChatFlowInput, type ChatRun } from "./chat-flow.js";
import { prepareChatBrief } from "./chat-stories.js";
import { completionDelivery, completionOutputUsesReleasedBrief, type CompletionObservation } from "./completion-updates.js";

type Row = Record<string, any>;
export async function observeCompletionUpdate(input: {
  page: Page; api: RunnerApi; sourceId: string; workerId: string; marker: string;
  allRuns(): Promise<Row[]>;
  evidence(name: string, data: unknown): Promise<void>;
  capture(id: string, label: string, file: string): Promise<void>;
}) {
  const startedAt = new Date().toISOString();
  const observationWindowEndsAt = Date.now() + 120_000;
  let observation: CompletionObservation | undefined;
  let failure: unknown;
  try {
    await pollUntil({
      label: "unsolicited source-thread completion reply and result access",
      // Keep observing even after an early reply, so a later correction is retained.
      deadlineAt: observationWindowEndsAt + 5_000, intervalMs: 1000,
      load: async () => {
        const worker = await input.api.get<Row>(`/api/issues/${input.workerId}`);
        const documents = await input.api.get<Row[]>(`/api/issues/${input.workerId}/documents`);
        observation = {
          sourceId: input.sourceId, worker, marker: input.marker,
          documents: await Promise.all(documents.map(d => input.api.get<Row>(`/api/issues/${worker.id}/documents/${encodeURIComponent(d.key)}`))),
          comments: await input.api.get<Row[]>(`/api/issues/${input.sourceId}/comments?order=asc`),
          runs: await input.allRuns(),
        };
        observation.renderedLinks = [];
        for (const response of completionDelivery(observation).responses) {
          const reply = input.page.locator(`[id=${JSON.stringify(`comment-${response.id}`)}]`);
          observation.renderedLinks.push(...(await reply.locator("a[href]").evaluateAll(elements =>
            elements.map(element => element.getAttribute("href")!))).map(href => ({ commentId: response.id, href })));
        }
        return completionDelivery(observation);
      },
      accept: result => Date.now() >= observationWindowEndsAt && result.checks.every(c => c.passed),
      reject: () => observation!.runs.length > 12 ? "completion probe exceeded 12 runs" : undefined,
      timeoutDetail: result => result?.checks.filter(c => !c.passed).map(c => c.id).join(", "),
    });
    const delivery = completionDelivery(observation!);
    if (!delivery.response) throw new Error("Completion observation lost its source reply");
    // Verify browser persistence, not just an API comment. No new user input.
    await input.page.reload({ waitUntil: "domcontentloaded" });
    const reply = input.page.locator(`[id=${JSON.stringify(`comment-${delivery.response.id}`)}]`);
    await expect(reply).toBeVisible();
    if (delivery.resultLinks.length) {
      const link = delivery.resultLinks[0]!;
      const url = new URL(link, input.api.baseURL);
      expect(url.origin).toBe(new URL(input.api.baseURL).origin);
      await expect(reply.locator(`a[href=${JSON.stringify(link)}]`).first()).toBeVisible();
      const sourceUrl = input.page.url();
      try {
        // A client-side route can return HTTP 200 even when the task is missing.
        // Open the actual rendered target and prove that its task loaded.
        await input.page.goto(url.href, { waitUntil: "domcontentloaded" });
        await expect(input.page.getByRole("heading", { name: String(observation!.worker.title), exact: true })).toBeVisible();
        const accessibleWorker = await input.api.get<Row>(`/api/issues/${encodeURIComponent(observation!.worker.identifier ?? input.workerId)}`);
        expect(accessibleWorker.id).toBe(input.workerId);
        const accessibleOutput = await readChatOutputDocument(input.api, accessibleWorker.id, input.marker);
        expect(observation!.documents.some(d => d.id === accessibleOutput.id && d.body === accessibleOutput.body)).toBe(true);
      } finally {
        await input.page.goto(sourceUrl, { waitUntil: "domcontentloaded" });
        await expect(reply).toBeVisible();
      }
    } else {
      await expect(reply).toContainText(input.marker);
    }
    return observation!;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const evidenceErrors: string[] = [];
    const preserve = async (label: string, collect: () => Promise<void>) => {
      try { await collect(); }
      catch (error) { evidenceErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    await preserve("observation", () => input.evidence("completion-update.json", {
      schema: "paperclip.completion-update-probe.v6", startedAt, finishedAt: new Date().toISOString(),
      observation, delivery: observation ? completionDelivery(observation) : null,
      observedFailure: failure instanceof Error ? failure.message : null,
    }));
    await preserve("screenshot", () => input.capture("completion-update", "Originating thread after delegated completion", "completion-update.png"));
    if (observation) await preserve("run evidence", async () => {
      const results = await Promise.allSettled(observation!.runs.map(run => collectChatRunEvidence(input.api, run as ChatRun)));
      await input.evidence("completion-update-run-evidence.json", results.map((result, index) => {
        if (result.status === "fulfilled") return result.value;
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        evidenceErrors.push(`run ${observation!.runs[index]!.id}: ${error}`);
        return { runId: observation!.runs[index]!.id, evidenceError: error };
      }));
    });
    if (evidenceErrors.length) {
      await input.evidence("completion-update-evidence-errors.json", { errors: evidenceErrors }).catch(() => {});
      // Preserve the behavior failure. A successful probe still needs its evidence.
      if (!failure) throw new Error(`Completion evidence collection failed: ${evidenceErrors.join("; ")}`);
    }
  }
}

export async function runChatCompletionUpdate(context: {
  input: ChatFlowInput; marker: string; allRuns(): Promise<ChatRun[]>; refreshIssue(): Promise<void>; issue(): { id: string };
}) {
  const { input, marker } = context;
  const { api, fixtures: f, execution, page } = input;
  const company = `/api/companies/${f.company.id}`;
  const busy = execution.task.id === "handoff-completion-busy";
  const multiple = execution.task.id === "handoff-completion-multiple";
  const restart = execution.task.id === "handoff-completion-restart";
  const taskCount = multiple ? 2 : 1;
  const userMessages: string[] = [];
  const replyWait = busy ? await prepareChatBrief(resolveDefaultAgentWorkspaceDir(f.agent.id), `${input.nonce}-reply`, 240_000) : null;
  const config = execution.profile.buildAgent({ environmentId: f.environment.id, environmentFixtureId: "local", workspacePath: input.workspacePath, secretRefs: f.secretRefs, executionId: input.nonce });
  const worker = await api.post<Row>(`${company}/agents`, { ...config, name: "Riley Writer", role: "engineer", reportsTo: f.agent.id });
  const project = await api.post<Row>(`${company}/projects`, { name: "Garden welcome", description: "A non-code neighborhood garden meetup. No repository needed." });
  // A project task runs in its managed project workspace. The agent-home path
  // used by projectless chats is outside the native Codex workspace projection.
  const workspace = resolveManagedProjectWorkspaceDir({ companyId: f.company.id, projectId: project.id });
  const relative = path.relative(path.dirname(input.workspacePath), workspace);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Completion fixture escaped isolated instance");
  const wait = await prepareChatBrief(workspace, input.nonce, 240_000);
  const reference = marker;
  const instructions = `For the welcome-note assignment, run node ${wait.scriptPath} to read the organizer's brief before writing the final note. Save a two-sentence welcome note as a Paperclip document on your assigned task using the brief's details and explicitly include its RSVP code in the note. Then complete your task. Do not edit or comment on another task.`;
  const saved = await api.request.put(`/api/agents/${worker.id}/instructions-bundle/file`, { data: { path: "AGENTS.md", content: instructions } });
  expect(saved.ok()).toBe(true);
  expect(await api.get(`/api/agents/${worker.id}/instructions-bundle/file?path=AGENTS.md`)).toMatchObject({ content: instructions });
  const prompt = `Create ${multiple ? "two separate tasks titled Welcome note A and Welcome note B" : "one task"} in the Garden welcome project (${project.id}) assigned to Riley Writer to write a two-sentence welcome note for our free Friday garden meetup. Riley has the organizer's brief. Save the finished note on that task and include RSVP code ${marker} in the note so attendees know which code to give the organizer. Please tell me here when the work is finished and give me access to the result. You may start the handoff now; no further approval is needed. Let Riley write the note.`;
  let task: Row | undefined;
  let delegated: Row[] = [];
  try {
    userMessages.push(prompt);
    await sendChatMessage(page, prompt);
    await pollUntil({ label: "worker waiting while originating chat is idle", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
      load: async () => {
        await context.refreshIssue();
        const source = await api.get<Row>(`/api/issues/${context.issue().id}`);
        const tasks = await api.get<Row[]>(`${company}/issues`);
        delegated = tasks.filter(t => t.assigneeAgentId === worker.id);
        task = delegated[0];
        const runs = await context.allRuns();
        return { source, tasks, runs, ready: await readFile(wait.ready, "utf8").catch(() => "") };
      },
      accept: state => delegated.length === taskCount && state.ready === "waiting" && state.source.conversationState === "waiting" &&
        state.runs.some(r => r.contextSnapshot?.issueId === task!.id && r.status === "running") &&
        state.runs.some(r => r.contextSnapshot?.issueId === state.source.id && r.status === "succeeded") &&
        !state.runs.some(r => r.contextSnapshot?.issueId === state.source.id && ["queued", "running"].includes(r.status)),
    });
    expect(task!.parentId).toBeNull();
    expect(task!.projectId).toBe(project.id);
    await input.evidence("completion-update-boundary.json", { task, source: await api.get(`/api/issues/${context.issue().id}`), runs: await context.allRuns(), gateReady: true, prompt, reference });
    await input.capture("completion-idle", "Chat is idle while Riley waits for the brief", "completion-idle.png");
    let busyRun: ChatRun | undefined;
    if (replyWait) {
      const busyPrompt = `A separate question while Riley works: run node ${replyWait.scriptPath} to read my supplied reference, then acknowledge that reference here. This is discussion only; do not create tasks or projects.`;
      userMessages.push(busyPrompt);
      await sendChatMessage(page, busyPrompt);
      await pollUntil({ label: "source reply is running at its brief gate", deadlineAt: Date.now() + 120_000, intervalMs: 1000,
        load: async () => { busyRun = (await context.allRuns()).find(r => r.contextSnapshot?.issueId === context.issue().id && r.status === "running");
          return Boolean(busyRun) && await readFile(replyWait.ready, "utf8").catch(() => "") === "waiting"; }, accept: Boolean });
    }
    await writeFile(wait.gate, `The free Friday meetup starts at 10:30 in the community garden. The saved note must include RSVP code ${reference}.`);
    await pollUntil({ label: "delegated welcome note completed", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
      load: () => api.get<Row>(`/api/issues/${task!.id}`), accept: t => t.status === "done" });
    if (busyRun) {
      const boundary = (await context.allRuns()).find(r => r.id === busyRun!.id);
      expect(boundary?.status).toBe("running");
      await input.evidence("completion-busy-boundary.json", { sourceRun: boundary, worker: await api.get(`/api/issues/${task!.id}`) });
      // Let the queued completion wake be recorded while the original turn still waits.
      const wakeBoundary = await pollUntil({ label: "completion wake is durably deferred behind active reply", deadlineAt: Date.now() + 90_000, intervalMs: 1000,
        load: () => api.get<Row>(`/api/issues/${context.issue().id}/diagnostics/wakes`),
        accept: diagnostics => diagnostics.events.some((w: Row) => w.kind === "wake_request" && w.agentId === f.agent.id &&
          w.reason === "chat_task_completed" && ["deferred_issue_execution", "queued"].includes(w.status)) });
      expect((await context.allRuns()).find(r => r.id === busyRun!.id)?.status).toBe("running");
      await input.evidence("completion-busy-queued-wake.json", wakeBoundary);
      await writeFile(replyWait!.gate, `REFERENCE${marker}`);
    }
    if (restart) {
      const beforeRestart = await api.get<Row[]>(`/api/issues/${context.issue().id}/comments?order=asc`);
      const workerState = await api.get<Row>(`/api/issues/${task!.id}`);
      expect(beforeRestart.filter(c => c.authorAgentId && c.createdAt >= workerState.completedAt), "restart must precede completion publication").toEqual([]);
      // The worker has durably committed Done. Restart the real server; neither
      // task records nor completion events are fabricated by the fixture.
      await input.evidence("completion-restart-boundary.json", { worker: await api.get(`/api/issues/${task!.id}`), runs: await context.allRuns() });
      await input.restart();
      await page.goto(`/${f.company.issuePrefix}/chats/${f.agent.id}`, { waitUntil: "commit" });
    }
    for (const [index, item] of delegated.entries()) {
      await pollUntil({ label: "delegated note completed", deadlineAt: Date.now() + 180_000, intervalMs: 1000,
        load: () => api.get<Row>(`/api/issues/${item.id}`), accept: t => t.status === "done" });
      await observeCompletionUpdate({ ...input, sourceId: context.issue().id, workerId: item.id, marker, allRuns: context.allRuns,
        evidence: (name, data) => input.evidence(multiple ? `${index}-${name}` : name, data) });
      const output = await readChatOutputDocument(api, item.id, marker);
      await input.evidence(`completion-update-worker-output-${index}.json`, { task: await api.get(`/api/issues/${item.id}`), output });
      expect(completionOutputUsesReleasedBrief(output.body), "worker output must use the released start time").toBe(true);
      expect(await api.get(`/api/issues/${item.id}/documents/${encodeURIComponent(output.key)}`)).toEqual(output);
    }
    expect((await api.get<Row[]>(`${company}/issues`)).map(t => t.id).sort()).toEqual(delegated.map(t => t.id).sort());
    const comments = await api.get<Row[]>(`/api/issues/${context.issue().id}/comments?order=asc`);
    expect(comments.filter(c => c.authorUserId).map(c => c.body)).toEqual(userMessages);
    const runs = await context.allRuns();
    for (const item of delegated) {
      const replyRuns = runs.filter(r => r.status === "succeeded" && r.contextSnapshot?.issueId === context.issue().id &&
        Array.isArray(r.contextSnapshot?.chatCompletionUpdates) && r.contextSnapshot.chatCompletionUpdates.some((u: Row) => u.id === item.id));
      const replies = comments.filter(c => c.authorAgentId === f.agent.id && replyRuns.some(r => r.id === c.createdByRunId));
      expect(replies, `one correlated completion reply for ${item.id}`).toHaveLength(1);
    }
  } finally {
    await writeFile(wait.gate, `Reference: ${reference}`);
    if (replyWait) await writeFile(replyWait.gate, `REFERENCE${marker}`);
    await context.refreshIssue();
  }
}
