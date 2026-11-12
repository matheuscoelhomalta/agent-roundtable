// npm test (from scripts/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessConsensus } from "./consensus.mjs";

const vote = (agent, over = {}) => ({ agent, parsed: true, stance: "converged", blocking: [], new_issues: [], resolved: [], ...over });
const ctx = (over = {}) => ({ round: 2, maxRounds: 3, minRounds: 2, expectedAgents: ["codex", "gemini"], ...over });

test("everyone converged, nothing blocking or new: stop", () => {
  assert.equal(assessConsensus([vote("codex"), vote("gemini")], ctx()).converged, true);
});

test("never before the minimum round", () => {
  assert.equal(assessConsensus([vote("codex"), vote("gemini")], ctx({ round: 1 })).converged, false);
});

test("a missing vote blocks", () => {
  const r = assessConsensus([vote("codex")], ctx());
  assert.equal(r.converged, false);
  assert.match(r.reason, /gemini/);
});

test("an invalid status block blocks", () => {
  assert.equal(assessConsensus([vote("codex"), vote("gemini", { parsed: false, stance: "open" })], ctx()).converged, false);
});

for (const [name, over] of [
  ["an open stance", { stance: "open" }],
  ["a contradictory converged + blocking", { blocking: ["GEMINI-1: x"] }],
  ["a new issue", { new_issues: ["GEMINI-9"] }],
]) {
  test(`${name} blocks`, () => {
    assert.equal(assessConsensus([vote("codex"), vote("gemini", over)], ctx()).converged, false);
  });
}
