// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice, score } from "@typesafe-ai/sdk";

/**
 * Model tiers, cheapest first. `id` is the static default that goes into the request body
 * when the account catalog has not been read yet; `family` is the substring used to recognise
 * whatever model Claude Code asked for, which may be an older version within the same tier
 * such as `claude-sonnet-4-6`.
 *
 * `thinking` and `effort` are capabilities of the whole family: Haiku supports neither
 * adaptive thinking nor effort, so those fields are stripped when routing down to it.
 * Anything that differs between versions of one tier does not belong here -- see
 * `rejectsDisabledThinking`.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5", family: "haiku", thinking: false, effort: false },
  { name: "sonnet", id: "claude-sonnet-5-5", family: "sonnet", thinking: true, effort: true },
  { name: "opus", id: "claude-opus-5-5", family: "opus", thinking: true, effort: true },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "jev-router";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string Claude Code sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Fable is opt-in because it is the most expensive tier and overkill for most work.
 *
 * Not because of how it bills, as an earlier comment here claimed: the proxy forwards the
 * caller's authentication headers unchanged and substitutes no credential of its own, so
 * billing follows the upstream account's own entitlement and usage rules. Observed on a
 * Claude Code subscription, Fable bills to the subscription -- recorded as an observation
 * of one configuration, not a guarantee for every account or platform.
 *
 * Haiku is excluded for a different reason: at 200k it is the only tier whose context window
 * is not 1M, which is what stops the session declaring a single honest context budget (Claude
 * Code resolves the sentinel model to a 200k default and cannot be told a per-tier window).
 * With Haiku out, every reachable tier is 1M and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` is
 * true on every turn. Drop this clause once a 1M Haiku ships.
 */
/**
 * Opt-in env flag. These are hand-edited in a `.env` file, where `true` and `yes` are at
 * least as natural to write as `1`; a strict `=== "1"` silently ignores them, so a tier the
 * user believes they enabled stays off with nothing to show why. Accepts any of them.
 */
const envFlag = (name) => /^\s*(1|true|yes|on)\s*$/i.test(process.env[name] ?? "");

export const availableTiers = () =>
  TIER_NAMES.filter(
    (n) =>
      (n !== "fable" || envFlag("JEV_ALLOW_FABLE")) &&
      (n !== "haiku" || envFlag("JEV_ALLOW_HAIKU")),
  );

/**
 * Candidate set to route among when the account catalog reports nothing in an enabled tier.
 *
 * An account can report only models whose tiers the opt-in flags disable -- a Haiku-only
 * catalog with `JEV_ALLOW_HAIKU` off. Filtering that to nothing is worse than it sounds: the
 * rewrite still has to name some model, so it would fall back to a tier's static default with
 * no candidate behind it and no decision recorded. Keeping a documented fallback set means
 * the candidate list is never empty, so every forwarded model came from one.
 */
export const defaultCandidates = () =>
  TIERS.filter((tier) => availableTiers().includes(tier.name)).map((tier) => ({
    id: tier.id,
    tier: tier.name,
    maxInput: null,
    description: tier.id,
  }));

/**
 * Exact models that reject `thinking: {type: "disabled"}` instead of honouring it.
 *
 * Deliberately matched per version rather than per family. Opus 5 accepts the opt-out at
 * effort `high` or below while Opus 5.5 rejects it at every effort, and `applyTier` is handed
 * the exact model id, so there is no reason to decide for a whole tier and silently rewrite a
 * request a model would have accepted. Sourced from the Claude API model documentation rather
 * than observed rejections; an id absent from this list is assumed to accept the opt-out,
 * which is the direction that preserves what the caller asked for.
 */
const REJECTS_DISABLED_THINKING = [
  /^claude-opus-5-5/,
  /^claude-sonnet-5-5/,
  /^claude-fable-5/,
  /^claude-mythos-5/,
];

export const rejectsDisabledThinking = (model) =>
  REJECTS_DISABLED_THINKING.some((re) => re.test(model ?? ""));

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.3,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /**
   * Confidence a downgrade has to clear, over and above `minConfidence`. The effective bar is
   * `max(minConfidence, downgradeMinConfidence)`, because the `minConfidence` branch runs
   * first -- lowering this below that only changes which reason is reported.
   *
   * This replaced a `contextTokens > 20000` guard. Switching tiers invalidates the prompt
   * cache, so the next request re-sends the prefix as cache-creation tokens; the old guard
   * refused downgrades once a conversation passed 20k on the reasoning that the rebuild had
   * stopped being worth it. That threshold was an uncalibrated approximation and it blocks
   * switches that are profitable over a long enough run: the rebuild scales with the prefix
   * and so does most of the saving it buys, so payback is counted in *requests*, not tokens.
   * Switching costs `prefix * (write_new - read_new)` once -- not the whole write, since
   * staying would also have paid a read -- against `prefix * (read_old - read_new)` plus the
   * output-price difference on every later request.
   *
   * Those figures are an estimate, not a measurement: they assume a stable cacheable prefix,
   * a warm old cache against a cold new one, comparable output volume per request, the 5-minute
   * TTL, and published per-MTok rates (cache reads for some exact models were not published
   * and were taken as the documented 0.1x-of-input default). They also say nothing about how
   * many requests a given session has left, which is what actually determines whether a
   * switch pays off -- a large conversation offers no lower bound on its own remaining length.
   * Note too that one routed user turn can issue many API requests as tools run.
   *
   * So the number below is not derived. It is a deliberately conservative operating point for
   * the thing the economics cannot settle: whether the cheaper model can finish the work.
   * Jev's confidence is the only signal to hand for that, and it is a proxy at best -- it
   * reports confidence in picking the cheapest adequate *model id*, which is not a calibrated
   * probability of task success, and it is computed from the latest prompt rather than the
   * conversation's substance. Treat 0.7 as a heuristic awaiting measurement of real
   * post-downgrade outcomes (rework, escalation, request count) by confidence band.
   */
  downgradeMinConfidence: 0.7,
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured: ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the
   * deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

/**
 * Context window sizes per model tier. Haiku has a smaller context window;
 * Sonnet, Opus, and Fable all support the full 1M token context.
 */
export const CONTEXT_WINDOWS = {
  haiku: 200000,
  sonnet: 1000000,
  opus: 1000000,
  fable: 1000000,
};

/**
 * Get the context window for a given tier. Falls back to a conservative 200K
 * if the tier is unknown.
 */
export const contextWindowForTier = (tierName) => CONTEXT_WINDOWS[tierName] ?? 200000;

/**
 * Multiplier applied to an estimated token count before comparing it against a model's
 * limit. The size of a request is estimated from serialised characters, which is neither a
 * token count nor an upper bound on one: JSON punctuation inflates it, while token-dense
 * text deflates it. The only safe direction for a feasibility error is to treat the request
 * as larger than measured, so the headroom reduces usable capacity and never extends it.
 */
export const FEASIBILITY_HEADROOM = 1.15;

/**
 * Whether a conversation plausibly still fits a candidate model's context window.
 *
 * Feasibility, not economics: routing a conversation to a model that cannot hold it is a
 * hard API rejection rather than an expensive choice, so candidates are dropped from the
 * list before Jev ever sees them instead of being weighed against cost in `decide()`.
 * Prefers the exact limit the account reported for that model over the tier's family
 * window, because an older version within a tier need not match it.
 *
 * "Plausibly" is the honest word: the input is an estimate, so this reduces the chance of
 * routing into a window the conversation has outgrown but cannot guarantee a fit. It is a
 * routing-time safeguard -- tool continuations within a turn reuse the tier already chosen
 * and are not re-checked.
 */
export const modelFitsContext = (model, contextTokens = 0) =>
  contextTokens * FEASIBILITY_HEADROOM <= (model?.maxInput ?? contextWindowForTier(model?.tier));

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

/** Phrases that mean "the human already decided", checked against the raw prompt. */
export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    `\\b(?:use|switch to|with|on)\\s+(?:${{
      haiku: "haiku|fast|luna",
      sonnet: "sonnet|balanced|terra",
      opus: "opus|strong|sol",
      fable: "fable|long|astra",
    }[t.name]})\\b`,
    "i",
  ),
}));

export const QUESTIONS = {
  task_complexity: score(
    "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
    COMPLEXITY_SCALE,
  ),
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
    COMPLEXITY_SCALE,
  ),
  tool_complexity: score(
    "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
    COMPLEXITY_SCALE,
  ),
};

const GUIDANCE = {
  haiku: {
    what: "Trivial, mechanical, or purely factual work.",
    signals: ["Rename, reformat, comment, or run one obvious command"],
    not_for: "Design judgement or multi-file reasoning.",
  },
  sonnet: {
    what: "Ordinary day-to-day engineering with a clear, bounded shape.",
    signals: ["Implement a specified function, test existing behaviour, or fix an understood local bug"],
    not_for: "Open-ended architecture, subtle concurrency, or unknown-cause debugging.",
  },
  opus: {
    what: "Hard reasoning, ambiguity, or high blast radius.",
    signals: ["Unknown-cause debugging, cross-module design, security, auth, concurrency, or migrations"],
    not_for: "Routine work with a clear implementation.",
  },
  fable: {
    what: "Very large or long-running work beyond a normal focused session.",
    signals: ["Whole-repo migration, unusually large context, or multi-hour autonomous execution"],
    not_for: "Anything a strong model can finish in one focused session.",
  },
};

/** Build a Jev choice from the exact models available to this account and CLI. */
export const questionForModels = (models) =>
  choice(
    [
      "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.",
      "Treat different model versions as separate choices. Judge required reasoning, not requested reply length.",
    ],
    Object.fromEntries(
      models.map(({ id, tier, description }) => [
        id,
        { model: description ?? id, ...GUIDANCE[tier] },
      ]),
    ),
  );

/** Whether policy accepted Jev's exact model, including a version change within one tier. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
