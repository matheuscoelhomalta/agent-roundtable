# Agent Roundtable

A Codex skill for sustained discussions between **Claude, Gemini and Codex**, with independent native sessions and a moderator who preserves evidence and dissent.

Ask the three models to explore alternatives, recommend a decision or audit supplied material. Round 1 is independent; later rounds give each model both peers' actual previous replies. The default is three rounds, followed by a review of the moderator's synthesis.

## Requirements

- Node.js and npm for the built-in test command. This package has no npm dependencies; publication tests ran on Node.js 26.9.0.
- Git for installation and working-tree fingerprints.
- Authenticated `claude`, `agy` and `codex` CLIs on `PATH`. Gemini uses **Antigravity's `agy` CLI**, not the `gemini` executable.
- CLI versions that support the arguments in [agents.json](agents.json). Check their installed help and run `doctor` before first use or after adapter changes. CLI flags and model availability vary between versions and accounts.

The moderator runs in Codex. All three participants are required. Requested models are configured in `agents.json`; an unreported effective model identity remains unknown.

## Install in Codex

Clone the repository into your Codex skill directory:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
git clone https://github.com/matheuscoelhomalta/agent-roundtable.git \
  "${CODEX_HOME:-$HOME/.codex}/skills/agent-roundtable"
```

If that destination already exists, inspect it before updating; do not overwrite another installation. This project uses the Codex-specific skill location shown in the [official OpenAI workflow example](https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex#automate-with-skills). Keep this skill out of shared skill directories when it should be discoverable only by Codex.

Invoke it explicitly in Codex, for example:

```text
Use $agent-roundtable for Claude, Gemini and Codex to review this migration
proposal in three rounds. Preserve disagreements and label unverified claims.
```

The skill is configured for explicit invocation. [SKILL.md](SKILL.md) contains the complete moderator procedure.

## Check the adapters

```sh
node /path/to/agent-roundtable/scripts/roundtable.mjs doctor \
  --cwd /path/to/project
```

`doctor` sends one real initial probe to each provider. It prints a JSON report and exits 1 if any probe fails, or 0 when all succeed. It does not test native session resumption. Both `doctor` and discussions use your provider accounts and their normal limits or charges.

## How a run works

1. The moderator writes a brief with the question, constraints and actual material to inspect. Reviewers have no file tools: filenames alone are insufficient.
2. The runner starts three independent sessions. Each later round resumes the corresponding explicit native session and relays both peers' previous replies from the same snapshot.
3. After the configured rounds, the runner waits for the moderator to publish `synthesis.md` atomically in the run directory.
4. Each model checks whether that synthesis faithfully represents the discussion. Approval establishes fidelity, not independently verified correctness.

The moderator validates decision-critical evidence and reports dissent, failures and missing checks. Agreement is a separate signal from a usable outcome.

For manual orchestration, start the runner in a background terminal/session:

```sh
node /path/to/agent-roundtable/scripts/roundtable.mjs run \
  --brief /path/to/run/brief.md \
  --run-dir /path/to/run \
  --cwd /path/to/project \
  --goal audit --rounds 3
```

Use a fresh run directory. Monitor `state.json`; at `awaiting_synthesis`, write the complete draft to a temporary sibling and rename it to `synthesis.md`. The runner then performs the final review and writes `result.json`.

| Option | Meaning | Default |
| --- | --- | --- |
| `--goal` | `explore`, `decide` or `audit` | `explore` |
| `--rounds` | Number of discussion rounds | `3` |
| `--turn-timeout` | Timeout per model turn, in seconds | `900` |
| `--wait-timeout` | Wait for the synthesis, in seconds | `3600` |
| `--kill-grace` | Grace period for process termination, in seconds | `5` |
| `--budget-min` | Time budget that gates starting another round | `60` |
| `--registry` | Explicit adapter configuration override | Bundled `agents.json` |

The round budget is not a hard wall-clock or spending cap. `--no-veto` skips final review only for an explicitly requested transcript. A custom registry is responsible for preserving tool restrictions.

## Read the result

The run directory contains the brief, prompts and replies under `rounds/`, final-review records under `veto/`, `events.log`, `state.json` and `result.json`.

Read these fields separately:

- `result`: debate outcome, such as `consensus`, `completed_with_disagreement`, `incomplete` or `degraded`.
- `review`: `approved`, `objected`, `missing` or explicitly `skipped`.
- `deliveryComplete`: whether a usable debate outcome and the required review are complete.

`status: done` or a successful `run` process exit alone does not establish complete delivery. Inspect `result.json`. Evidence references remain reported claims until the moderator checks them.

## Reapprove a corrected synthesis

For a finished run with an objected or missing review, write the correction in a **separate file**, then submit it explicitly:

```sh
node /path/to/agent-roundtable/scripts/roundtable.mjs review-synthesis \
  --run-dir /path/to/run \
  --synthesis /path/to/corrected-synthesis.md
```

Each invocation sends one review request to each original native session. It supplies the corrected draft, previous votes and final-round replies. There is no automatic loop, repeated debate or replacement session during reapproval.

Previous state, result, synthesis, votes, review prompts/replies and any `final.md` are preserved under `reviews/0/`, `reviews/1/`, and so on. Current records describe the new revision. All three valid approvals and a complete debate are required for `deliveryComplete: true`; the command exits 0 only then.

The original registry hash, healthy native session IDs and working directory must match. Older runs without a saved working directory require `--cwd /path/to/original-project`. An unavailable session fails the submission. A concurrent review is blocked by `.review.lock`; a crash or failed cleanup may leave that lock for manual inspection after confirming the owned processes have stopped.

## Permissions and recovery

The default adapters disable Claude tools/MCP, deny Gemini command/file/external actions and disable Codex shell/integrations with read-only execution and approvals set to never. These restrictions apply on start and resume. Reviewers analyze only supplied context; native CLIs and the moderator still write their own transcripts and run artifacts.

During the discussion, a participant has one lifetime replacement attempt. The old process must stop before its replacement starts. A second failure or loss of any required participant fails the procedure. Reapproval always uses the original saved sessions without replacement.

Working-tree fingerprints are supplementary detection, not access control: they exclude Gitignored files and can be unavailable outside Git. Provider CLI behavior is version-dependent; keep the adapter restrictions intact and validate compatibility on your installation.

## Tests

```sh
npm --prefix /path/to/agent-roundtable/scripts test
```

The suite uses local fake CLIs and injected agents; it does not contact model providers. It covers peer exchange, native resume, outcome/status parsing, permission arguments, process cleanup, final review, reapproval history, interruption and concurrency. The publication check passed all 99 tests. The new reapproval command has not yet been validated end to end against all three real providers.

## Attribution and license

Adapted from [agent-roundtable in glebis/claude-skills](https://github.com/glebis/claude-skills), by Gleb Kalinin, at upstream commit `4d37d3b0af1f98cb4ac820d9abbce95e38e909fb`. This adaptation targets a fixed Claude/Gemini/Codex panel, restricted tools, explicit evidence and faithful synthesis review.

Released under the [MIT license](LICENSE). Original copyright and attribution are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE).
