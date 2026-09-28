import { describe, expect, it } from "vitest";
import { COMPLETION_QUALITY_CONFIG, completionQualityRequest, judgeCompletionQuality, reserveCompletionQuality, validateCompletionQuality } from "./completion-quality.js";
const observation = { sourceId: "chat", marker: "REF", worker: { id: "task", title: "Welcome", status: "done", completedAt: "2026-09-01T00:00:00Z" }, documents: [{ id: "doc", key: "welcome", body: "Welcome to the garden. Meet at 10:30." }], comments: [{ id: "reply", authorAgentId: "agent", createdAt: "2026-09-01T00:01:00Z", body: "The note is ready at /issues/task", createdByRunId: "run" }], runs: [] };
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
  it("rejects invented references, missing evidence, duplicate criteria and missing replies", () => {
    expect(() => validateCompletionQuality({ criteria: criteria.map(c => ({ ...c, evidenceIds: ["invented"] })) }, observation)).toThrow();
    expect(() => validateCompletionQuality({ criteria: [criteria[0], criteria[0], criteria[2]] }, observation)).toThrow();
    expect(() => completionQualityRequest({ ...observation, comments: [] })).toThrow();
    expect(() => reserveCompletionQuality(observation, 0.000001)).toThrow();
  });
  it("fails closed on missing usage and does not retry", async () => {
    let calls = 0;
    const result = await judgeCompletionQuality(observation, reserveCompletionQuality(observation, 1), "fixture-key", async () => {
      calls++; return new Response(JSON.stringify({ status: "completed", model: COMPLETION_QUALITY_CONFIG.model }));
    });
    expect(result.status).toBe("failed"); expect(result.passed).toBe(false); expect(calls).toBe(1);
  });
});
