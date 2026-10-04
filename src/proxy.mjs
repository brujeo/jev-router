import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  TIERS,
  tierOf,
  idOf,
  availableTiers,
  contextWindowForTier,
  defaultCandidates,
  rejectsDisabledThinking,
  tierSpec,
  isAuto,
  modelFitsContext,
  shouldUseExactModel,
} from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { writeDecision, writeStatus } from "./status.mjs";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Jev on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Jev's confidence, so they are removed.
 *
 * Hooks that emit `additionalContext` (`SessionStart`, `UserPromptSubmit`) arrive as trailing
 * `system` messages after the user's own, so the search for the turn has to look past them or
 * every prompt in a hooked setup reads as "no new turn" and silently keeps `current`.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  const messages = body?.messages ?? [];
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role === "system") i--;
  const last = messages[i];
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * Points a request at a tier, removing request fields that tier cannot accept. Claude Code
 * composes the body for whatever model it thinks it is talking to, so downgrading to Haiku
 * while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = model;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  // Some exact models reject an explicit thinking opt-out rather than honouring it, so
  // forwarding one is a guaranteed 400. Dropping the field leaves the model on its default
  // adaptive thinking, which is not what the caller asked for -- so it is decided per model
  // version, never per family, never for a model that would have accepted the request, and
  // reported through `adaptationsFor` so overriding a request-level preference is visible in
  // `/jev-explain` rather than only in a debug log.
  if (adaptationsFor(body, model).length) {
    delete body.thinking;
    debug(`${model} rejects disabled thinking; dropped the opt-out`);
  }
  return body;
}

/** Exact Claude models reported by the account, newest first; static ids are the cold-start fallback. */
export function claudeModels(catalog = []) {
  const models = catalog
    .filter((model) => tierOf(model?.id))
    .map((model) => ({
      id: model.id,
      tier: tierOf(model.id),
      // The account reports each exact model's own limit, which is what a feasibility check
      // has to use: an older version within a tier need not share the family's window.
      // Normalised here rather than trusted: a limit arriving as a string survives Math.max
      // but fails the strict comparison that selects the roomiest candidates, which emptied
      // the list and crashed the resolver. Anything not a positive finite number is dropped
      // so the tier's own window is used instead.
      maxInput: Number.isFinite(Number(model.max_input_tokens)) && Number(model.max_input_tokens) > 0
        ? Number(model.max_input_tokens)
        : null,
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
    }));
  return models.length
    ? models
    : TIERS.map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }));
}

const modelForTier = (models, tier) => models.find((model) => model.tier === tier)?.id ?? idOf(tier);

const windowOf = (model) => model.maxInput ?? contextWindowForTier(model.tier);

/**
 * Request-level preferences this tier/model combination cannot carry, as stable labels.
 *
 * Kept apart from routing reasons on purpose: an adaptation describes what was done to the
 * request after a model was chosen, so folding it into the reason string would let it affect
 * exact-model acceptance, which reads those strings.
 */
export const adaptationsFor = (body, model) =>
  body?.thinking?.type === "disabled" &&
  rejectsDisabledThinking(model, body?.output_config?.effort)
    ? ["thinking opt-out removed"]
    : [];

/**
 * Approximate input size of a request, in tokens, deliberately erring high.
 *
 * Counts `system` and `tools` as well as `messages`, because all three are input the window
 * has to hold -- counting messages alone understates a request carrying a large tool
 * surface. Characters/4 remains an approximation, which is why `modelFitsContext` applies
 * headroom on top rather than trusting this as a bound.
 */
export const estimateInputTokens = (body) =>
  Math.round(
    [body?.messages, body?.system, body?.tools]
      .filter((part) => part != null)
      .reduce((chars, part) => chars + JSON.stringify(part).length, 0) / 4,
  );

/**
 * Candidates to route among, given everything the account offers.
 *
 * Normally those the conversation still fits. When it fits none of them it has outgrown
 * every tier, and the estimate is approximate enough that the API may still accept the
 * request -- but letting a cheapest-first classifier choose among candidates already
 * rejected for capacity is the one outcome that cannot help, since it would answer "too big
 * for every window" with the smallest window available. Offer only the roomiest instead and
 * let the API be the one to refuse.
 */
export function feasibleModels(offered, contextTokens) {
  const fitting = offered.filter((model) => modelFitsContext(model, contextTokens));
  if (fitting.length) return { models: fitting, oversized: false };
  const widest = Math.max(...offered.map(windowOf), 0);
  return { models: offered.filter((model) => windowOf(model) === widest), oversized: true };
}

/**
 * The final selection: `{model, tier, reason}`, or null when `models` is empty.
 *
 * Returns the tier of the model it picked rather than the tier policy settled on, because the
 * two can diverge. Everything downstream has to follow the model actually sent: `applyTier`
 * strips fields using that tier's capability flags, `state.tier` becomes the `current` the
 * next turn compares against, and a mismatch there is not cosmetic -- adapting a Fable
 * request with Haiku's flags strips thinking it needs, and recording Haiku while running
 * Fable makes the next turn's real downgrade invisible to the confidence gate.
 *
 * Every branch resolves against `models`, the already-filtered candidate list. Reusing the
 * model pinned to the session would otherwise resurrect one the conversation has outgrown:
 * holding the current tier is the common path and the pinned model is exactly the one most
 * likely to predate the growth.
 */
export function resolveModel({ models, tier, current, currentModel, chosen, reason }) {
  if (!models.length) return null;
  const of = (id) => models.find((model) => model.id === id);
  const as = (model, extra = "") =>
    model && { model: model.id, tier: model.tier, reason: `${reason}${extra}` };

  if (shouldUseExactModel(reason, chosen?.tier, tier)) {
    const exact = as(of(chosen?.id));
    if (exact) return exact;
  }
  if (tier === current) {
    const held = as(of(currentModel));
    if (held) return held;
  }
  const inTier = as(models.find((model) => model.tier === tier));
  if (inTier) return inTier;

  // Nothing in the settled tier survived the size filter, so staying inside the window means
  // leaving the tier. That is a capacity transition rather than a routing preference, and it
  // is the one path that can enter the paid tier unasked -- `clampToAvailable` declines that
  // for cost, but cost is not a reason it can honour when nothing else holds the
  // conversation. Reported as `+capacity` so the move is never silent.
  const roomiest = [...models].sort((a, b) => windowOf(b) - windowOf(a))[0];
  return as(roomiest, "+capacity");
}

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

export function conversationKey(body) {
  const session = sessionOf(body);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}



export async function startProxy({ upstreamURL = ANTHROPIC_BASE_URL, route = askJev } = {}) {
  // Tier routed for each conversation's turn in flight, reused by its follow-up requests and
  // by the downgrade guard, which needs to know what the prompt cache was built on.
  const convos = new Map();
  const catalog = new Map();
  const stateFor = (key) => {
    let s = convos.get(key);
    if (!s) {
      if (convos.size > 50) convos.delete(convos.keys().next().value);
      convos.set(key, (s = { tier: null }));
    }
    return s;
  };

  const server = http.createServer((req, res) => {
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);

      if (/^\/v1\/messages/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          // Claude Code's request shape is undocumented and moves; JEV_DUMP captures it.
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          // Anything that is not the sentinel is a model the user chose, and an explicit
          // choice beats the router. That also covers Claude Code's own cheap Haiku calls
          // for titles and summaries, which must never be pinned up to the session's tier.
          if (!isAuto(body.model)) {
            debug(`passthrough, user selected ${body.model}`);
            // Only a real agent turn reflects the user's choice. Claude Code's own auxiliary
            // calls carry no tools and must not flip the status line to manual mid-session.
            if (Array.isArray(body.tools)) {
              writeStatus(sessionOf(body), { manual: true, at: Date.now() });
            }
          } else {
            const key = conversationKey(body);
            const state = stateFor(key);
            // What the prompt cache was built on, which is what a downgrade would discard.
            const current = state.tier ?? "opus";
            const prompt = newTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>");
            let fresh = null;
            const enabled = claudeModels([...catalog.values()]).filter((model) =>
              availableTiers().includes(model.tier),
            );
            // Never empty: a catalog reporting only gated-off tiers would otherwise filter to
            // nothing and leave the rewrite naming a model no candidate list ever contained.
            const offered = enabled.length ? enabled : defaultCandidates();
            if (prompt && !explaining) {
              const contextTokens = estimateInputTokens(body);
              const { models, oversized } = feasibleModels(offered, contextTokens);
              if (oversized) {
                debug(`${key} ctx~${contextTokens}: no candidate fits the estimate with headroom`);
              }
              const available = [...new Set(models.map((model) => model.tier))];
              // The pinned model is only a starting point if it is still eligible; otherwise
              // it is precisely the stale choice the filter just rejected.
              const currentModel = models.some((model) => model.id === state.model)
                ? state.model
                : modelForTier(models, current);
              const jev = await route({ prompt, current: currentModel, currentTier: current, contextTokens, models });
              const chosen = models.find((model) => model.id === jev?.choice);
              const tierAnswer = jev && { ...jev, choice: chosen?.tier };
              const settled = decide({ prompt, jev: tierAnswer, current, available });
              // The selection's own tier, not the settled one: see resolveModel.
              const { model, tier, reason } = resolveModel({
                models,
                tier: settled.tier,
                current,
                currentModel,
                chosen,
                reason: settled.reason,
              });
              state.tier = tier;
              state.model = model;
              fresh = {
                prompt,
                model,
                confidence: jev?.confidence ?? null,
                metrics: jev?.metrics ?? null,
                reason,
                oversized,
                jev: jev ? { request: jev.request, response: jev.response } : null,
              };
              debug(
                `${key} ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
                  `${current} -> ${tier} (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
              );
            }
            // The sentinel is not a real model, so every routed request must be rewritten,
            // including follow-ups that reuse the tier chosen for the turn.
            const tier = state.tier ?? current;
            const model = state.model ?? idOf(tier);
            debug(`${key} rewrite ${body.model} -> ${model}`);
            // Read before applyTier, which is what removes them.
            const adapted = adaptationsFor(body, model);
            applyTier(body, tier, model);
            // Publish what went out. Claude Code's UI shows the row you picked, not the tier
            // it resolved to, so the status line is the only place this is visible.
            // `claude -p` omits metadata on the first request of a session, so there is no
            // session id to file the decision under and it would be dropped. The conversation
            // key is stable for the same conversation and is already what `debug` prints, so
            // it is the identifier a user can pass to `jev-explain` for a print-mode run.
            if (fresh && !explaining) {
              writeDecision(sessionOf(body) || key, { tier, ...fresh, adapted, at: Date.now() });
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      const target = new URL(upstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      if (req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "")) {
        delete headers["accept-encoding"];
      }
      // Under JEV_DEBUG, ask for an uncompressed stream so the model the API reports can be
      // read back out of it. Not worth the bandwidth cost in normal operation.
      if (process.env.JEV_DEBUG) delete headers["accept-encoding"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (up) => {
          const isModels = req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const chunks = [];
            up.on("data", (chunk) => chunks.push(chunk));
            up.on("end", () => {
              const data = Buffer.concat(chunks);
              try {
                for (const model of JSON.parse(data.toString()).data ?? []) {
                  if (tierOf(model?.id)) catalog.set(model.id, model);
                }
              } catch (err) {
                debug(`could not read Claude model catalog: ${err.message}`);
              }
              const headers = { ...up.headers };
              delete headers["content-length"];
              res.writeHead(up.statusCode, headers);
              res.end(data);
            });
            return;
          }
          res.writeHead(up.statusCode, up.headers);
          // Report the model the API itself says it used, so the routing can be confirmed
          // from the wire rather than trusted from our own decision log. Claude Code's UI
          // always shows the model it asked for, never the one we rewrote to.
          if (process.env.JEV_DEBUG) {
            let seen = false;
            up.on("data", (c) => {
              if (seen) return;
              const m = /"model"\s*:\s*"([^"]+)"/.exec(c.toString("utf8"));
              if (!m) return;
              seen = true;
              debug(`${up.statusCode} served by ${m[1]}`);
            });
          }
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
