---
name: agent-roundtable
description: "Runs sustained discussions between Claude, Gemini and Codex in independent native sessions. Use when the user wants the three models to respond to each other over several rounds for exploration, a decision or an audit."
argument-hint: "[explore|decide|audit] [topic or target]"
disable-model-invocation: true
---

# Agent Roundtable

Act as the Codex moderator. Use the bundled Node.js runner and the authenticated `claude`, `agy` (Gemini) and `codex` CLIs. The three participants are required. Do not substitute providers or turn a two-model result into a successful panel.

## Prepare

Resolve this skill's installed path. No npm installation is needed; the runner uses Node.js built-ins only. Do not install or update global CLIs or change global permissions/authentication.

Write a brief in a fresh run directory, normally `<target>/.roundtable/<topic>-<timestamp>/`. Include the question, constraints, desired result and the actual material to inspect, with filenames and line numbers when relevant. **Reviewers have no file/shell tools: paths alone are insufficient.** Supply the necessary contents in the brief; label facts, assumptions and host test results separately. Ask only about missing decisions that materially affect the result.

The default `agents.json` disables Claude tools and MCP, denies Gemini command/write/external tool actions through `gemini-permissions.json`, and disables Codex shell/integrations with read-only sandbox and approval policy never. Keep those controls on both start and resume. Native CLIs and the moderator still write their own transcripts. Plan mode alone is not a permission barrier. Model selections live in `agents.json`; record the requested/effective models and leave unreported identity unknown. `--registry FILE` is an explicit adapter override for testing/configuration; preserve the same restrictions when changing real CLI adapters.

On first use or after adapter changes, check installed CLI help and run `node <skill>/scripts/roundtable.mjs doctor --cwd <target>` with the same registry. Doctor sends a real initial probe, not a resume test; report failures. The CLI keeps its JSON report and exits with code 1 if any probe reports FAIL, or 0 when all succeed. Do not run another provider discussion unless authorized by the user.

State/result distinguish `requestedModel` from `effectiveModel`. The native adapters leave `effectiveModel: null` because they do not extract a confirmed identity; the moderator may report separately identified native metadata, never infer it from the request. `registryProvenance` records default/file/inline origin, an absolute path when applicable and a SHA-256 of the serialized registry snapshot actually used. This records provenance, not validation of override permissions.

## Run

```sh
node <skill>/scripts/roundtable.mjs run \
  --brief <run>/brief.md --run-dir <run> --cwd <target> \
  --goal audit --rounds 3
```

Use `explore` for alternatives, `decide` for a recommendation and `audit` for findings. The default is three rounds. Every round includes all three participants; round 1 is independent, and later rounds relay both peers' actual previous replies from one snapshot. Each participant resumes its own explicit native session. Never use a latest-session shortcut.

Use a background session and bounded polling of `state.json` to keep the user informed. Do not start a duplicate run while waiting.

- `debating`: inspect new responses and summaries; report changed positions, evidence and remaining disagreements.
- `awaiting_synthesis`: validate decision-critical evidence through the moderator's authorized checks, then publish `synthesis.md` atomically (temporary sibling then rename). Preserve dissent and unverified claims; distinguish host checks from model conclusions.
- `veto`: wait for each participant to check faithful representation. Approval confirms fidelity, not independently verified correctness. Read all objections in `veto.json` and address or preserve them in the final report.
- `done`, `failed`, `interrupted`: inspect `result.json`, participant health, warnings and final votes before responding.

Each participant has one lifetime replacement attempt. A failed process must stop before its replacement starts; failed termination retains ownership and prevents replacement. A second failure or any required participant dropping fails the procedure. Accepted history is reconstructed after replacement; failed partial replies are excluded. Turn scratch is removed only after its process group stops; termination failure retains it.

Rounds are configurable. `--turn-timeout` (900s), `--wait-timeout` (3600s) and `--kill-grace` (5s) bound individual operations. `--budget-min` (60) gates another round; it is not a total wall-clock or monetary cap. Interrupt the host execution if a hard deadline is required.

## Reapprove a corrected synthesis

When a finished run has `review: objected` or `missing`, correct the draft in a **separate file**, leaving the current `synthesis.md` intact. Submit it explicitly in the same run:

```sh
node <skill>/scripts/roundtable.mjs review-synthesis \
  --run-dir <run> --synthesis <corrected-file>
```

This makes exactly one final-review request to each original native session, using the same registry and tool restrictions. It supplies the corrected draft, previous votes and final-round replies; it never reruns debate, retries automatically or creates replacement sessions. An unavailable session fails the submission. Read all three votes before delivering. Another correction requires another explicit invocation; do not turn this into an automatic loop.

Before replacing the current draft, the command archives the prior `state.json`, `result.json`, synthesis, votes, raw review prompts/replies and optional `final.md` under `reviews/0/`, then `reviews/1/`, etc. Debate files remain untouched and events are appended. Root records describe the current revision, with `reviewRevision` and `synthesisSha256`; delivery stays incomplete while review is pending or unsuccessful. Approval cannot complete an incomplete debate. Regenerate the host's final report for the accepted revision.

The registry must match the original hash, and all three saved session IDs must be healthy. File-backed registries are loaded from their saved path; supply the identical `--registry FILE` when needed. The saved working directory is reused; older runs without it require explicit `--cwd <original-target>`. An edited current draft is rejected when its saved hash is available. Concurrent submissions are blocked by `.review.lock`. A host crash or failed process cleanup may retain that lock: inspect the run and confirm owned processes have stopped before manually clearing it. Never bypass it by starting duplicate reviewers.

The command exits 0 only for complete delivery; objections, missing review, incomplete debate or execution failures exit 1. Approval checks faithful representation, not independent correctness.

## Deliver

The status parser accepts a missing final Markdown fence only when one terminal JSON body is complete and schema-valid. Audit/decision completion still requires claims with evidence references or bounded verification steps. Citations are reported evidence until checked by the moderator.

Read `result`, `review` and `deliveryComplete` separately. Delivery is complete only after a usable outcome and approved final review; `status: done` alone is insufficient. Report incomplete runs and missing/objected reviews honestly. `--no-veto` is only for an explicitly requested transcript without final review. Preserve raw historical records when later resolving objections.

Report the three providers/models, actual rounds, conclusion, evidence checked by the moderator, unresolved findings and any failed attempts or integrity warnings. File fingerprints detect some edits after the fact, exclude Gitignored files and can be unavailable outside Git; they do not replace tool restrictions. Invoking this skill authorizes the requested discussion and run artifacts, not implementation, commits or publication.

After package changes, run `npm test` in `scripts/`. Attribution and license are in NOTICE and LICENSE.
