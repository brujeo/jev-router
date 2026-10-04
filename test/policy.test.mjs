import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride } from "../src/policy.mjs";
import { QUESTIONS, modelFitsContext, shouldUseExactModel } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.2 });
const base = { prompt: "refactor the parser", current: "sonnet", available: ALL, contextTokens: 0 };

test("score rubrics contain only API-valid descriptions", () => {
  for (const question of Object.values(QUESTIONS).filter((q) => q.type === "score")) {
    assert(question.criteria.every((description) => typeof description === "string"));
    assert(question.criteria.length <= 10);
  }
});

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("opus") }), {
    tier: "opus",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use haiku to fix this typo", jev: sure("opus") });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("detectOverride only fires on a real instruction", () => {
  assert.equal(detectOverride("switch to opus"), "opus");
  assert.equal(detectOverride("use luna"), "haiku");
  assert.equal(detectOverride("use strong"), "opus");
  assert.equal(detectOverride("the opus of his career"), null);
});

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "sonnet");
});

test("never downgrades on a low-confidence answer", () => {
  const out = decide({ ...base, jev: unsure("haiku") });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "haiku", jev: unsure("fable") });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.reason, "low-confidence-capped");
});

test("still allows a confident upgrade to fable", () => {
  assert.equal(decide({ ...base, jev: sure("fable") }).tier, "fable");
});

test("refuses a downgrade Jev is not confident about", () => {
  const out = decide({ ...base, current: "opus", jev: { choice: "haiku", confidence: 0.5 } });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /downgrade-confidence-too-low/);
});

test("allows the same downgrade once Jev is confident", () => {
  assert.equal(decide({ ...base, current: "opus", jev: sure("haiku") }).tier, "haiku");
});

test("conversation size does not decide a downgrade", () => {
  // The rebuild cost scales with the conversation and so does most of the saving it buys, so
  // size is not what policy weighs. Whether the target can still *hold* the conversation is a
  // separate feasibility question, filtered out of the candidate list before decide() runs --
  // hence sonnet here, whose window is the same 1M as opus.
  for (const contextTokens of [0, 20_000, 100_000, 900_000]) {
    const out = decide({ ...base, current: "opus", jev: sure("sonnet"), contextTokens });
    assert.equal(out.tier, "sonnet", `blocked at ${contextTokens} tokens`);
  }
});

test("the confidence bar applies only downward", () => {
  // An upgrade rebuilds the same cache, but buying capability is the safe direction, so it
  // is governed by minConfidence/uncertainCeiling rather than the downgrade bar.
  const mid = { choice: "opus", confidence: 0.5 };
  assert.equal(decide({ ...base, current: "sonnet", jev: mid }).tier, "opus");
});

test("the effective downgrade bar is max(minConfidence, downgradeMinConfidence)", () => {
  // Two thresholds govern downgrades, and the stricter always wins. Lowering
  // downgradeMinConfidence below minConfidence would NOT lower the effective bar, because the
  // minConfidence branch runs first -- only the reason string changes. Pin both boundaries.
  const at = (confidence) =>
    decide({ ...base, current: "opus", jev: { choice: "sonnet", confidence } });

  assert.match(at(0.29).reason, /low-confidence-no-downgrade/);
  assert.match(at(0.3).reason, /downgrade-confidence-too-low/); // minConfidence is exclusive
  assert.match(at(0.69).reason, /downgrade-confidence-too-low/);
  assert.equal(at(0.7).tier, "sonnet"); // the bar itself is inclusive
  assert.equal(at(0.71).tier, "sonnet");
  for (const c of [0.29, 0.3, 0.69]) {
    assert.equal(at(c).tier, "opus", `downgrade leaked through at ${c}`);
  }
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "opus"], jev: sure("sonnet") });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /unavailable/);
});

test("never substitutes upward into paid fable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "fable"], jev: sure("opus") });
  assert.equal(out.tier, "haiku");
});

test("accepts exact model changes within the same tier", () => {
  assert.equal(shouldUseExactModel("jev/no-change", "opus", "opus"), true);
  assert.equal(shouldUseExactModel("low-confidence-no-downgrade/no-change", "opus", "opus"), false);
});

test("tier opt-in flags accept the spellings a .env file invites", async (t) => {
  const { availableTiers } = await import("../src/config.mjs");
  const saved = { ...process.env };
  t.after(() => {
    for (const k of ["JEV_ALLOW_FABLE", "JEV_ALLOW_HAIKU"]) delete process.env[k];
    Object.assign(process.env, saved);
  });

  for (const on of ["1", "true", "TRUE", "yes", "on", " true "]) {
    process.env.JEV_ALLOW_FABLE = on;
    assert(availableTiers().includes("fable"), `${JSON.stringify(on)} should enable fable`);
  }
  for (const off of ["", "0", "false", "no", "off", "disabled"]) {
    process.env.JEV_ALLOW_FABLE = off;
    assert(!availableTiers().includes("fable"), `${JSON.stringify(off)} should not enable fable`);
  }

  // The gate is per tier: enabling one must not enable the other.
  process.env.JEV_ALLOW_FABLE = "true";
  process.env.JEV_ALLOW_HAIKU = "false";
  assert.deepEqual(availableTiers(), ["sonnet", "opus", "fable"]);
});

test("a conversation cannot be routed into a window it has outgrown", () => {
  // Feasibility is enforced on the candidate list, not in decide(): the exact limit the
  // account reported wins over the tier's family window, since an older version within a
  // tier need not match it.
  const haiku = { id: "claude-haiku-4-5", tier: "haiku", maxInput: 200_000 };
  const sonnet = { id: "claude-sonnet-5", tier: "sonnet", maxInput: 1_000_000 };

  assert.equal(modelFitsContext(haiku, 50_000), true);
  assert.equal(modelFitsContext(haiku, 200_000), true); // exactly at the limit still fits
  assert.equal(modelFitsContext(haiku, 200_001), false);
  assert.equal(modelFitsContext(sonnet, 900_000), true);

  // An exact limit narrower than its family window is respected.
  assert.equal(modelFitsContext({ tier: "sonnet", maxInput: 200_000 }, 500_000), false);
  // With no reported limit, fall back to the tier's window.
  assert.equal(modelFitsContext({ tier: "haiku" }, 500_000), false);
  assert.equal(modelFitsContext({ tier: "opus" }, 500_000), true);
  // An unknown tier falls back to the conservative 200k default.
  assert.equal(modelFitsContext({ tier: "nonesuch" }, 500_000), false);
});
