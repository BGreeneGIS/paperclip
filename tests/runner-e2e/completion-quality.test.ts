import { describe, expect, it } from "vitest";
import { COMPLETION_QUALITY_CONFIG, completionQualityControls, completionQualityRequest, judgeCompletionQuality, reserveCompletionQuality, validateCompletionQuality } from "./completion-quality.js";
const observation = { sourceId: "chat", marker: "REF", worker: { id: "task", title: "Welcome", status: "done", completedAt: "2026-09-01T00:00:00Z" }, documents: [{ id: "doc", issueId: "task", key: "welcome", body: "Welcome to the garden. Meet at 10:30." }], comments: [{ id: "reply", issueId: "chat", authorAgentId: "agent", createdAt: "2026-09-01T00:01:00Z", body: "The note is ready at /issues/task", createdByRunId: "run" }], runs: [] };
const criteria = Object.keys(COMPLETION_QUALITY_CONFIG.rubric).map(id => ({ id, passed: true, rationale: "Supported by the saved note and reply", evidenceIds: ["reply", "doc"] }));
describe("completion semantic qualification", () => {
  it("uses a pinned no-tool judge and separates untrusted evidence from instructions", () => {
    const request = completionQualityRequest(observation);
    expect(request.model).toBe(COMPLETION_QUALITY_CONFIG.model); expect(request).not.toHaveProperty("tools");
    expect(request.instructions).toContain("untrusted evidence"); expect(request.input).toContain("10:30");
  });
  it("preserves a failure even when the other criteria pass", () => {
    expect(validateCompletionQuality({ criteria }, observation).passed).toBe(true);
    expect(validateCompletionQuality({ criteria: criteria.map((c, i) => ({ ...c, passed: i !== 0 })) }, observation).passed).toBe(false);
  });
  it("requires both reply IDs for a duplicate finding", () => {
    const duplicate = { ...observation, comments: [...observation.comments, { ...observation.comments[0], id: "reply-again" }] };
    const verdict = { criteria: criteria.map(c => c.id === "noDuplicateCompletion"
      ? { ...c, passed: false, evidenceIds: ["reply", "reply-again"] } : c) };
    expect(validateCompletionQuality(verdict, duplicate).passed).toBe(false);
    expect(() => validateCompletionQuality({ criteria: verdict.criteria.map(c => c.id === "noDuplicateCompletion"
      ? { ...c, evidenceIds: ["reply", "reply"] } : c) }, duplicate)).toThrow("both replies");
  });
  it("grounds a joint reply in the other delegated task's result without including foreign or plan documents", () => {
    const input = { ...observation, worker: { ...observation.worker, companyId: "fixture" }, relatedTasks: [
      { task: { id: "second", companyId: "fixture", status: "done", completedAt: observation.worker.completedAt, title: "PRIVATE TITLE" },
        documents: [{ id: "second-doc", issueId: "second", key: "welcome", body: "Another saved welcome note. Contact alice@example.com." },
          { id: "plan", issueId: "second", key: "plan", body: "PRIVATE PLAN" },
          { id: "foreign-doc", issueId: "elsewhere", key: "welcome", body: "PRIVATE OTHER TASK" }] },
      { task: { id: "foreign", companyId: "other", status: "done", completedAt: observation.worker.completedAt },
        documents: [{ id: "foreign-doc", issueId: "foreign", key: "welcome", body: "PRIVATE COMPANY" }] },
    ] };
    const evidence = JSON.parse(completionQualityRequest(input).input);
    expect(evidence.relatedTasks).toHaveLength(1);
    expect(evidence.relatedTasks[0].documents).toEqual([{ id: "second-doc", body: "Another saved welcome note. Contact [REDACTED_EMAIL]." }]);
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
    expect(validateCompletionQuality({ criteria: criteria.map(c => ({ ...c, evidenceIds: ["reply", "second-doc"] })) }, input).passed).toBe(true);
  });
  it("rejects invented references, missing evidence, duplicate criteria and missing replies", () => {
    expect(() => validateCompletionQuality({ criteria: criteria.map(c => ({ ...c, evidenceIds: ["invented"] })) }, observation)).toThrow();
    expect(() => validateCompletionQuality({ criteria: criteria.map(c => ({ ...c, evidenceIds: ["doc"] })) }, observation)).toThrow();
    expect(() => validateCompletionQuality({ criteria: criteria.map((c, i) => i === 1 ? criteria[0] : c) }, observation)).toThrow();
    expect(() => completionQualityRequest({ ...observation, comments: [] })).toThrow();
    expect(() => reserveCompletionQuality(observation, 0.000001)).toThrow();
  });
  it("calibrates repeated announcements without rejecting corrections or distinct-task updates", () => {
    const controls = completionQualityControls(observation);
    expect(controls.map(c => [c.name, c.expectedPass])).toEqual([["accurate", true], ["stale", false], ["unsupported", false], ["corrected", true],
      ["duplicate", false], ["redundant-acknowledgement", false], ["distinct-tasks", true]]);
    expect(controls[3].observation.comments).toHaveLength(2);
    expect(controls[4].observation.comments[0].body).not.toBe(controls[4].observation.comments[1].body);
    const distinct = JSON.parse(completionQualityRequest(controls[6].observation).input);
    expect(distinct.relatedTasks).toHaveLength(1);
    expect(distinct.replies[1].body).toContain(distinct.relatedTasks[0].task.id);
    expect(observation.comments).toHaveLength(1);
    for (const c of controls) expect(completionQualityRequest(c.observation).input).toContain("10:30");
  });
  it("requires approval and sends only minimized, redacted fixture evidence", async () => {
    const privateObservation = { ...observation, worker: { ...observation.worker, title: "PRIVATE TITLE" },
      documents: [...observation.documents.map(d => ({ ...d, body: d.body + " Key private-fixture-value contact alice@example.com or 212-555-0199" })),
        { id: "unrelated", issueId: "other", key: "note", body: "PRIVATE OTHER TASK" }, { id: "plan", issueId: "task", key: "plan", body: "PRIVATE PLAN" }],
      comments: [...observation.comments, { ...observation.comments[0], id: "other", issueId: "other", body: "PRIVATE OTHER CHAT" }] };
    const secrets = ["private-fixture-value"];
    const pending = reserveCompletionQuality(privateObservation, 0.5, secrets);
    let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      const request = String(init?.body);
      expect(request).not.toMatch(/private-fixture-value|alice@example.com|212-555-0199|PRIVATE/);
      expect(request).toContain("REDACTED");
      return new Response(JSON.stringify({ status: "completed", model: COMPLETION_QUALITY_CONFIG.model, usage: { input_tokens: 100, output_tokens: 50 }, output: [{ content: [{ type: "output_text", text: JSON.stringify({ criteria }) }] }] }));
    };
    expect((await judgeCompletionQuality(privateObservation, pending, "fixture-key", fetcher)).status).toBe("failed");
    expect(calls).toBe(0);
    expect((await judgeCompletionQuality(privateObservation, pending, "fixture-key", fetcher, { approvedFixture: true, secrets })).status).toBe("completed");
    expect(calls).toBe(1);
  });
  it("fails closed on missing usage and does not retry", async () => {
    let calls = 0;
    const result = await judgeCompletionQuality(observation, reserveCompletionQuality(observation, 1), "fixture-key", async () => {
      calls++; return new Response(JSON.stringify({ status: "completed", model: COMPLETION_QUALITY_CONFIG.model }));
    }, { approvedFixture: true, secrets: [] });
    expect(result.status).toBe("failed"); expect(result.passed).toBe(false); expect(calls).toBe(1);
  });
});
