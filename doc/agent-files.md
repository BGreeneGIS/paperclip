# Persistent agent files

Each managed agent has one current directory, scoped by company and agent. The
Instructions Editor reads and writes this directory. `AGENTS.md` (or the
configured entry) is one file in it. Agents may create ordinary files and nested
folders for notes, memory, and other personal working material. Files in the
task working directory remain task files.

## Layout

The canonical host directory keeps its existing physical location:

```
<instance>/companies/<company>/agents/<agent>/
  instructions/                 current agent files (editor)
    AGENTS.md
    notes/
    any-supported-file
  file-sync/                   controller-only operational state
    adopted.json
    runs/<run>/live/           isolated writable copy while a run executes
    runs/<run>/captured/       preserved candidate awaiting save or resolution
```

The process starts in its existing task workspace. `AGENT_HOME` points to the
registered writable agent copy. Adapter `HOME` and `CODEX_HOME` keep their
existing meanings and are not personal-file storage. Local copies are outside
the task workspace. Remote providers currently confine file sync to their
workspace: their independent agent copy therefore lives under the excluded
`.paperclip-runtime/agent-files/<agent>/<run>/` area. It is not included in task
workspace sync, Git staging, or task deliverables.

Regular files (including binary bytes) and directories are supported, up to
10,000 entries, 16 MiB per file and 64 MiB total. Symlinks, hardlinks, and special
files are rejected, rather than followed or silently skipped. The instruction
entry remains valid UTF-8, at most 1 MiB, and cannot be deleted. The editor edits
text up to 1 MiB and offers downloads for binary or larger files. The reserved
`.paperclip-runtime` directory and the compatibility-only virtual file
`promptTemplate.legacy.md` are not user storage. Task cache and Git ignore
exclusions do not apply to this directory.

## Run lifecycle

1. Under the agent lock, restore current files into a private run copy and save
   a baseline of paths, kinds, modes, and hashes. This is sync metadata, not a
   revision history.
2. Stage the copy through the existing workspace transport. Point `AGENT_HOME`
   and instruction guidance at that registered root.
3. At the provider's verified checkpoint-and-stop boundary, collect the entire
   directory. Capture incoming bytes before releasing a remote environment.
4. Recheck the responsible user's current authorization. Under the same agent
   lock used by editor writes, merge changes relative to the baseline. Apply an
   independent file change, deduplicate an identical change, and reject a
   competing edit or deletion. Preflight conflicts before modifying any file.
5. Record the result. A conflict or transient failure preserves the captured
   directory. A completed run releases its private files and baseline, retaining
   only a small receipt. The next run starts with the current directory.

The whole-directory contract closes the provider process to establish a safe
collection boundary, including child processes. It preserves the provider's
resumable conversation. Only the loaded instruction entry participates in the
new runtime instruction digest; adding or editing another file does not change
that digest. Relative supporting files are read from `AGENT_HOME`, not from the
read-only prompt snapshot.

The editor supplies the hash of the file it read. A stale edit or delete returns
409 and retains the user's draft. Preserved run changes can be compared against
current files and explicitly applied or discarded. Resolution pins the reviewed
current directory hash and refuses to overwrite a subsequent edit.

## Upgrade and recovery

Migration 0287 creates the preview tables idempotently after master’s 0285/0286.
Existing preview receipts, rows, constraints, and pending captures are retained.
On first use, while holding
the agent row lock, import any deployed revision heads into the existing managed
directory once. A controller-owned marker outside agent files prevents any
later replay of those heads. Existing revision rows remain readable for recovery;
new saves never append to them. Old UUID-based clients receive content tokens
and can still submit their previously recorded revision IDs, which are checked
against the corresponding bytes before a write.

Working-copy receipts and native runtime inputs record the new file contract.
A restored native session with no contract field keeps the old instruction-only
copy shape, prompt digest, paths, and collector. Its writes use the compatibility
bridge into current files, with the original baseline fence. Existing pending
legacy candidates remain resolvable. Neither old task workspaces nor arbitrary
external instruction roots are imported as agent directories.

Stock-agent and plugin resets update their declared files while retaining unrelated
personal files and formerly configured entries.

External bundles retain their existing behavior. Their migration to managed
storage is an explicit configuration action. Historical task cwd, provider-home,
checkpoint, and workspace restoration formats are not rewritten.

Backups must include the persistent instance filesystem as well as the database.
New current-file bytes and preserved directory candidates are not database
revision rows.

Crash recovery retries captured directories without starting a model. Missing
stop proof or lost uncaptured remote bytes produce a visible diagnostic, never a
save receipt. File replacement is atomic, and an interrupted apply can replay
identical changes. A competing edit during recovery is preserved for review.

## Verification

`agent-directory-working-copies.test.ts` exercises nested/binary files, directory
isolation, concurrent changes, deletion conflicts, link rejection, old-head
adoption, and stable prompt digests. The legacy working-copy and native-tool
suites exercise compatibility. Workspace merge tests exercise preflight and
interrupted replay.

The explicit Product E2E `instruction-persistence` suite creates a file through
the browser editor, runs an agent that changes instructions and supporting files,
checks exact binary bytes via the public download route, restarts the server,
and asks a fresh task to prove restored contents using an independent nonce. A
third task creates a concurrent edit, which the browser reviews and resolves.
Run results, including unavailable credentials, must be reported separately from
unit or matcher results; a passing matcher does not prove a live run.
