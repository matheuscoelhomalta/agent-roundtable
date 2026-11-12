#!/usr/bin/env node
// Fake headless CLI with native resume. Reads the prompt from stdin, logs argv and
// prompt to --log, and prints one JSON result line like `claude -p --output-format json`.
// --plan selects fixture behavior, shared across calls via --state.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({ strict: false, options: {
  plan: { type: "string", default: "ok" }, state: { type: "string" }, log: { type: "string" },
  name: { type: "string" },
  resume: { type: "string" }, touch: { type: "string" }, status: { type: "string", default: '{"stance":"converged"}' },
} });
const plan = o.plan.split(",");
const n = o.state && existsSync(o.state) ? Number(readFileSync(o.state, "utf8")) : 0;
if (o.state) writeFileSync(o.state, String(n + 1));
const step = plan[Math.min(n, plan.length - 1)];

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (o.log) appendFileSync(o.log, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), resume: o.resume ?? null, n, step, prompt }) + "\n");
  if (o.touch) { const split = o.touch.indexOf('='); writeFileSync(o.touch.slice(0, split), o.touch.slice(split + 1)); }
  if (step === "hang") return setInterval(() => {}, 1000);
  if (step === "fail") { console.error("fake failure"); process.exit(2); }
  const closing = step === 'unclosed-status' ? '' : '\n```\n';
  const status = step === 'object' ? '{"stance":"open","blocking":["Preserve the original veto"]}' : o.status;
  const text = step === 'probe' ? 'OK' : step === 'invalid-status' ? 'No status' : `headless reply ${n} from ${o.name}\n\`\`\`roundtable-status\n${status}${closing}`;
  const emit = () => console.log(JSON.stringify({ type: "result", sessionId: step === 'wrong-session' ? 'wrong-native-session' : o.resume ?? `fake-native-${o.name}`, stopReason: "end_turn", finalText: text }));
  if (step === 'slow') setTimeout(emit, 500);
  else emit();
});
