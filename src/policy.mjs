import { TIER_NAMES, THRESHOLDS, OVERRIDE_PATTERNS, rankOf } from "./config.mjs";

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(prompt) {
  const hit = OVERRIDE_PATTERNS.find((p) => p.re.test(prompt ?? ""));
  return hit ? hit.tier : null;
}

/**
 * Nearest tier the account can actually run. Prefers stepping up rather than down so we
 * never silently hand a hard task to a weaker model, but never steps up into `fable`
 * (the most expensive tier) unless that is what was asked for.
 *
 * That refusal is about cost, so it has one documented exception outside this function:
 * when nothing else can hold the conversation, `resolveModel` enters the roomiest eligible
 * tier regardless and reports the move as `+capacity`. Fable still requires its opt-in to
 * be a candidate at all, so this widens what an opted-in account may be charged for, not
 * who can be charged.
 */
function clampToAvailable(tier, available) {
  if (available.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIER_NAMES.filter(
    (t, i) => i > rank && available.includes(t) && (t !== "fable" || tier === "fable"),
  );
  if (up.length) return up[0];
  const down = TIER_NAMES.filter((t, i) => i < rank && available.includes(t));
  return down.length ? down[down.length - 1] : null;
}

/**
 * Turns a Jev answer into the model we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the model already in use.
 *
 * @param {object} input
 * @param {string} input.prompt        raw user prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number}} input.jev  null when Jev failed
 * @param {string} input.current       tier currently active in the session
 * @param {string[]} input.available   tier names the account can run
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({ prompt, jev, current, available }) {
  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!jev) return settle(current, "jev-unavailable");
  // An answer naming a model outside the candidate list is a different problem from no
  // answer at all: a stale catalog, a contract drift, or a filter that removed the model
  // after it was offered. Holding is the right fallback either way, but reporting it as an
  // outage hides a misconfiguration that will not fix itself.
  if (!TIER_NAMES.includes(jev.choice)) return settle(current, "jev-invalid-choice");

  let target = jev.choice;

  if (jev.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling], "low-confidence-capped");
  }

  // A downgrade is only worth the cache rebuild if the cheaper model finishes the work;
  // see THRESHOLDS.downgradeMinConfidence for why this is a confidence test and not a
  // conversation-size one.
  if (rankOf(target) < rankOf(current) && jev.confidence < THRESHOLDS.downgradeMinConfidence) {
    return settle(current, "downgrade-confidence-too-low");
  }

  return settle(target, "jev");
}
