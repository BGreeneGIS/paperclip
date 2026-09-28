import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentInstructionsFileDetail, AgentInstructionCandidate } from "@paperclipai/shared";
import { PromptsTab } from "@/pages/AgentDetail";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgents } from "../fixtures/paperclipData";

const agent = { ...storybookAgents[0]!, id: "agent-files-story", adapterType: "codex_local" as const };
const root = "/instance/agents/agent-files-story/instructions";
const originalInstructions = "# Agent instructions\n\nRead your notes in `notes/context.txt` before starting a task.\n\nKeep useful files in your agent directory for future tasks.\n";
const incomingInstructions = "# Agent instructions\n\nRead your notes before starting a task. Verify changes before handing them off.\n";
const noop = () => {};

function AgentFilesStory({ conflict = false, rejectResolution = false }: { conflict?: boolean; rejectResolution?: boolean }) {
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } }), []);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(0);
  const save = useRef<(() => void) | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const simulateAgent = useRef(noop);
  const onSave = useCallback((action: (() => void) | null) => { save.current = action; }, []);
  const onCancel = useCallback((action: (() => void) | null) => { cancel.current = action; }, []);

  useEffect(() => {
    let version = 0;
    const file = (path: string, content: string, binary = false): AgentInstructionsFileDetail => ({
      path, content, contentHash: `fixture-${++version}`, binary,
      size: binary ? 4 : new TextEncoder().encode(content).length,
      language: path.endsWith(".md") ? "markdown" : "text", markdown: path.endsWith(".md"),
      isEntryFile: path === "AGENTS.md", editable: !binary, deprecated: false, virtual: false,
    });
    const files = new Map([
      ["AGENTS.md", file("AGENTS.md", originalInstructions)],
      ["notes/context.txt", file("notes/context.txt", "Use short, concrete updates.\n")],
      ["cache.bin", file("cache.bin", "", true)],
    ]);
    let candidate: AgentInstructionCandidate | null = conflict ? {
      contract: "agent_files", runId: "run-story", entryFile: "AGENTS.md", baseRevisionId: null,
      baseHash: "fixture-base", state: "conflict", candidateHash: "fixture-incoming", content: null,
      errorCode: "agent_files_conflict", errorMessage: "The agent and the editor changed AGENTS.md. Both copies are preserved.",
      createdAt: "2026-09-28T12:00:00.000Z", updatedAt: "2026-09-28T12:00:00.000Z", conflicts: ["AGENTS.md"],
    } : null;
    let rejectNext = rejectResolution;
    const bundle = () => ({ agentId: agent.id, companyId: agent.companyId, persistence: "agent_files", mode: "managed",
      rootPath: root, managedRootPath: root, entryFile: "AGENTS.md", resolvedEntryPath: `${root}/AGENTS.md`, editable: true,
      warnings: [], legacyPromptTemplateActive: false, legacyBootstrapPromptTemplateActive: false,
      files: [...files.values()].map(({ content: _content, ...summary }) => summary),
    });
    simulateAgent.current = () => {
      files.set("AGENTS.md", file("AGENTS.md", incomingInstructions));
      client.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      client.invalidateQueries({ queryKey: queryKeys.agents.instructionsFile(agent.id, "AGENTS.md") });
    };
    const originalFetch = window.fetch;
    const fixture: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      const base = `/api/agents/${agent.id}/instructions-bundle`;
      if (!url.pathname.startsWith(base)) return originalFetch(input, init);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const suffix = url.pathname.slice(base.length);
      const data = JSON.parse(String(init?.body ?? "{}"));
      if (suffix === "" && method === "GET") return Response.json(bundle());
      if (suffix === "/file") {
        const path = method === "PUT" ? data.path : url.searchParams.get("path")!;
        const current = files.get(path);
        if (method === "PUT" || method === "DELETE") {
          const baseHash = method === "PUT" ? data.baseHash : url.searchParams.get("baseHash");
          if (baseHash !== (current?.contentHash ?? null)) return Response.json({ error: "This file changed after you started editing. Compare the current file before saving again." }, { status: 409 });
          if (method === "DELETE") { files.delete(path); return Response.json({ ok: true }); }
          const next = file(path, data.content);
          files.set(path, next); setSaved(count => count + 1);
          return Response.json(next);
        }
        return current ? Response.json(current) : Response.json({ error: "File not found" }, { status: 404 });
      }
      if (suffix === "/candidates") return Response.json(candidate ? [candidate] : []);
      if (suffix === "/candidates/run-story/files") return Response.json({ currentHash: files.get("AGENTS.md")!.contentHash,
        files: [{ path: "AGENTS.md", current: { exists: true, text: files.get("AGENTS.md")!.content, hash: files.get("AGENTS.md")!.contentHash },
          incoming: { exists: true, text: incomingInstructions, hash: "fixture-incoming" } },
        { path: "notes/run.txt", current: { exists: false, text: null, hash: null }, incoming: { exists: true, text: "Run notes preserved for review.\n", hash: "fixture-note" } }],
      });
      if (suffix === "/candidates/run-story/files/resolve" && method === "POST") {
        if (rejectNext || data.currentHash !== files.get("AGENTS.md")!.contentHash) {
          rejectNext = false; simulateAgent.current();
          return Response.json({ error: "The agent directory changed. Refresh the comparison before applying." }, { status: 409 });
        }
        if (data.decision === "use_incoming") {
          files.set("AGENTS.md", file("AGENTS.md", incomingInstructions));
          files.set("notes/run.txt", file("notes/run.txt", "Run notes preserved for review.\n"));
        }
        candidate = null; return Response.json({ state: "committed" });
      }
      return Response.json({ error: "This action is not included in this story." }, { status: 400 });
    };
    window.fetch = fixture; setReady(true);
    return () => { if (window.fetch === fixture) window.fetch = originalFetch; client.clear(); };
  }, [client, conflict, rejectResolution]);

  return <QueryClientProvider client={client}>
    <div className="space-y-6 p-6">
      <div className="space-y-3 rounded-md border border-border bg-muted p-4">
        <p className="text-sm">Storybook simulation · Real agent instructions editor with in-memory file responses. No provider runs or files on disk. Binary download is shown as a link only.</p>
        <Button variant="outline" onClick={() => simulateAgent.current()}>Simulate agent edit</Button>
        <p role="status" className="text-sm text-muted-foreground">{saved ? `${saved} file save completed in this story.` : "Saved agent files are ready for the next task."}</p>
      </div>
      {ready && <PromptsTab agent={agent} companyId={agent.companyId} onDirtyChange={setDirty} onSavingChange={setSaving}
        onSaveActionChange={onSave} onCancelActionChange={onCancel} />}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" disabled={!dirty || saving} onClick={() => cancel.current?.()}>Cancel changes</Button>
        <Button disabled={!dirty || saving} onClick={() => save.current?.()}>Save changes</Button>
      </div>
    </div>
  </QueryClientProvider>;
}
const meta = { title: "Agents/Persistent files", component: AgentFilesStory, parameters: { layout: "fullscreen" } } satisfies Meta<typeof AgentFilesStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InstructionsAndFiles: Story = {};
export const BrowserEdit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "edit" }));
    const editor = await canvas.findByRole("textbox");
    await userEvent.click(editor);
    await userEvent.type(editor, "Browser edits persist for future tasks. ");
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await expect(await canvas.findByText("1 file save completed in this story.")).toBeVisible();
    await waitFor(() => expect(canvas.getByRole("button", { name: "Save changes" })).toBeDisabled());
  },
};
export const AgentEditArrives: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "edit" });
    await userEvent.click(canvas.getByRole("button", { name: "Simulate agent edit" }));
    await expect(await canvas.findByText(/Verify changes before handing them off/)).toBeVisible();
  },
};
export const BinaryFile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("cache.bin"));
    await expect(await canvas.findByRole("link", { name: "Download cache.bin" })).toBeVisible();
  },
};
const showComparison: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Review preserved files" }));
  await userEvent.click(await canvas.findByText("AGENTS.md", { selector: "summary" }));
  await expect(within(canvas.getByText("AGENTS.md", { selector: "summary" }).parentElement!).getByText("Run's file")).toBeVisible();
};
export const ConcurrentEdits: Story = { args: { conflict: true }, play: showComparison };
export const StaleComparison: Story = {
  args: { conflict: true, rejectResolution: true },
  play: async context => {
    await showComparison(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Apply run edits" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("The preserved files are still available.");
  },
};
export const StaleEditor: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "edit" }));
    await userEvent.type(await canvas.findByRole("textbox"), "Keep this unsaved draft. ");
    await userEvent.click(canvas.getByRole("button", { name: "Simulate agent edit" }));
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Your unsaved edits are retained.");
    await expect(canvas.getByRole("textbox")).toHaveTextContent("Keep this unsaved draft.");
  },
};

export const ResolveConflict: Story = {
  args: { conflict: true },
  play: async context => {
    await showComparison(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Apply run edits" }));
    await waitFor(() => expect(canvas.queryByText("Preserved agent files")).not.toBeInTheDocument());
    await expect(await canvas.findByText(/Verify changes before handing them off/)).toBeVisible();
  },
};
