import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentInstructionCandidate } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";

export function AgentFileConflict({ agentId, companyId, candidate }: {
  agentId: string; companyId?: string; candidate: AgentInstructionCandidate;
}) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const review = useQuery({ queryKey: ["agent-file-conflict", agentId, candidate.runId],
    queryFn: () => agentsApi.agentFileConflict(agentId, candidate.runId, companyId), enabled: open });
  const resolve = useMutation({
    mutationFn: (decision: "keep_current" | "use_incoming") => agentsApi.resolveAgentFileConflict(agentId, candidate.runId,
      { decision, currentHash: review.data!.currentHash }, companyId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.agents.instructionCandidates(agentId) });
      client.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agentId) });
      for (const file of review.data?.files ?? []) client.invalidateQueries({ queryKey: queryKeys.agents.instructionsFile(agentId, file.path) });
    },
  });
  return <div className="space-y-3 rounded-md border border-border p-3">
    <p className="text-sm">{candidate.errorMessage ?? "Agent files are waiting to be saved."}</p>
    {candidate.candidateHash && <Button type="button" variant="outline" size="sm" onClick={() => setOpen(!open)}>Review preserved files</Button>}
    {open && review.data && <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Review the run's changed files before choosing which edits to keep. Other files stay as they are.</p>
      {review.data.files.map(file => <details key={file.path} className="rounded-md border border-border p-3">
        <summary className="cursor-pointer font-mono text-sm">{file.path}</summary>
        <div className="grid gap-3 py-3 md:grid-cols-2">
          {(["current", "incoming"] as const).map(side => <div key={side} className="min-w-0 space-y-2">
            <p className="text-sm font-medium">{side === "current" ? "Current file" : "Run's file"}</p>
            <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-sm">{!file[side].exists ? "Deleted / absent" : file[side].text ?? `Binary or large file · SHA-256 ${file[side].hash}`}</pre>
          </div>)}
        </div>
      </details>)}
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate("keep_current")}>Discard run edits</Button>
        <Button type="button" disabled={resolve.isPending} onClick={() => resolve.mutate("use_incoming")}>Apply run edits</Button>
      </div>
    </div>}
    {(review.error || resolve.error) && <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{(review.error ?? resolve.error)?.message} The preserved files are still available.</p>
      <Button type="button" variant="outline" size="sm" onClick={() => { void review.refetch().then(result => { if (!result.error) resolve.reset(); }); }}>Refresh comparison</Button>
    </div>}
  </div>;
}
