import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  sanitizeSchema,
  newTurnPrompt,
  applyTier,
  claudeModels,
  conversationKey,
  estimateInputTokens,
  feasibleModels,
  resolveModel,
  sessionOf,
  startProxy,
} from "../src/proxy.mjs";
import { defaultCandidates } from "../src/config.mjs";
import { formatExplanation } from "../src/explain.mjs";

test("only the sentinel model is routed", () => {
  assert.equal(isAuto("jev-router"), true);
  assert.equal(isAuto("claude-opus-4-6"), false, "a model the user picked is theirs");
  assert.equal(isAuto("claude-haiku-4-5"), false, "internal Haiku calls pass through");
  assert.equal(isAuto(undefined), false);
});

test("the sentinel is not mistaken for a real tier", () => {
  assert.equal(tierOf("jev-router"), null);
});
import { tierOf, isAuto } from "../src/config.mjs";
import { writeDecision, writeStatus, readStatus, pruneStale, STATUS_DIR } from "../src/status.mjs";
import { mkdirSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("reads the session id out of Claude Code's metadata", () => {
  const sid = "11111111-2222-4333-8444-555555555555";
  assert.equal(sessionOf({ metadata: { user_id: JSON.stringify({ session_id: sid }) } }), sid);
  assert.equal(sessionOf({ metadata: { user_id: "not-json" } }), "");
  assert.equal(sessionOf({}), "");
});

test("status round-trips per session and misses cleanly", () => {
  const sid = `test-${process.pid}`;
  writeStatus(sid, { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.deepEqual(readStatus(sid), { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.equal(readStatus("no-such-session"), null);
  assert.doesNotThrow(() => writeStatus("", { tier: "opus" }));
});

test("status files are private to their owner", { skip: process.platform === "win32" }, () => {
  const sid = `perm-${process.pid}`;
  writeStatus(sid, { tier: "opus" });
  assert.equal(statSync(STATUS_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(STATUS_DIR, `${sid}.json`)).mode & 0o777, 0o600);
});

test("stale status files are pruned and fresh ones kept", () => {
  mkdirSync(STATUS_DIR, { recursive: true });
  const stale = join(STATUS_DIR, `stale-${process.pid}.json`);
  const fresh = join(STATUS_DIR, `fresh-${process.pid}.json`);
  writeFileSync(stale, "{}");
  writeFileSync(fresh, "{}");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  assert.ok(pruneStale() >= 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test("routing status retains the exact recent Jev exchanges", () => {
  const sid = `history-${process.pid}`;
  writeDecision(sid, { prompt: "first", jev: { request: { id: 1 }, response: { confidence: 0.6 } } });
  writeDecision(sid, { prompt: "second", jev: { request: { id: 2 }, response: { confidence: 0.8 } } });
  const status = readStatus(sid);
  assert.equal(status.prompt, "second");
  assert.deepEqual(status.history.map(({ prompt }) => prompt), ["first", "second"]);
  assert.equal(status.history[0].jev.response.confidence, 0.6);
});

test("recognises older model versions within a tier", () => {
  assert.equal(tierOf("claude-sonnet-4-6"), "sonnet");
  assert.equal(tierOf("claude-sonnet-5"), "sonnet");
  assert.equal(tierOf("claude-haiku-4-5"), "haiku");
  assert.equal(tierOf("claude-opus-4-1"), "opus");
  assert.equal(tierOf("claude-fable-5-1[1m]"), "fable");
  assert.equal(tierOf("gpt-9"), null);
  assert.equal(tierOf(undefined), null);
});

test("keeps available Claude model versions as separate Jev choices", () => {
  assert.deepEqual(
    claudeModels([
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
    ]).map(({ id, tier }) => ({ id, tier })),
    [
      { id: "claude-opus-5", tier: "opus" },
      { id: "claude-opus-4-8", tier: "opus" },
    ],
  );
});

test("Claude proxy sends exact account models to Jev and routes the chosen version", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          data: [
            { id: "claude-opus-5", display_name: "Claude Opus 5" },
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
            { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
          ],
        }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-opus-4-8"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ models }) => {
      assert.deepEqual(models.map((model) => model.id), [
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
      ]);
      return { choice: "claude-opus-4-8", confidence: 0.91, ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "debug this race" }],
    }),
  });

  assert.equal(seen[0].model, "claude-opus-4-8");
});

test("a routed request without metadata is recorded under the conversation key", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5-5"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => ({ choice: "claude-sonnet-5-5", confidence: 0.77, ms: 1 }),
  });
  t.after(close);

  // Exactly what `claude -p` sends first: no metadata, so no session id.
  const body = {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: `rename this variable ${process.pid}` }],
  };
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(sessionOf(body), "", "the request carries no session id");
  const status = readStatus(conversationKey(body));
  assert.ok(status, "the decision is filed under the conversation key instead of being dropped");
  assert.equal(status.tier, "sonnet");
  assert.equal(status.confidence, 0.77);
});

const withTools = (messages) => ({ tools: [{ name: "Bash" }], messages });

test("converts a draft-04 boolean exclusiveMinimum into a draft 2020-12 number", () => {
  const schema = { type: "object", properties: { topN: { minimum: 0, exclusiveMinimum: true } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.topN, { exclusiveMinimum: 0 });
});

test("drops a false exclusiveMaximum and keeps the bound", () => {
  const schema = { properties: { n: { maximum: 10, exclusiveMaximum: false } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.n, { maximum: 10 });
});

test("leaves an already-valid numeric bound alone", () => {
  const schema = { properties: { n: { exclusiveMinimum: 5 } } };
  sanitizeSchema(schema);
  assert.equal(schema.properties.n.exclusiveMinimum, 5);
});

test("reaches schemas nested in arrays and sub-objects", () => {
  const schema = { anyOf: [{ items: { minimum: 1, exclusiveMinimum: true } }] };
  sanitizeSchema(schema);
  assert.deepEqual(schema.anyOf[0].items, { exclusiveMinimum: 1 });
});

test("survives null and primitive nodes", () => {
  assert.doesNotThrow(() => sanitizeSchema(null));
  assert.doesNotThrow(() => sanitizeSchema({ a: null, b: 3, c: "x" }));
});

test("reads a plain string prompt as a new turn", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "fix the bug" }])), "fix the bug");
});

test("reads a text block prompt as a new turn", () => {
  const body = withTools([{ role: "user", content: [{ type: "text", text: "fix the bug" }] }]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("ignores a tool_result continuation mid-turn", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores auxiliary calls that carry no tools", () => {
  const body = { messages: [{ role: "user", content: "summarise this" }] };
  assert.equal(newTurnPrompt(body), null);
});

test("ignores a request whose last message is from the assistant", () => {
  const body = withTools([{ role: "assistant", content: "thinking" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores an empty prompt", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "   " }])), null);
});

test("survives a malformed body", () => {
  assert.equal(newTurnPrompt(undefined), null);
  assert.equal(newTurnPrompt({}), null);
  assert.equal(newTurnPrompt({ tools: [], messages: [] }), null);
});

test("strips system reminders Claude Code injects into the prompt", () => {
  const body = withTools([
    {
      role: "user",
      content: "fix the bug\n<system-reminder>be careful\nabout things</system-reminder>",
    },
  ]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("a prompt that is only a system reminder is not a turn", () => {
  const body = withTools([{ role: "user", content: "<system-reminder>noise</system-reminder>" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("reads a new turn behind context a hook appended after it", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "system", content: [{ type: "text", text: "SessionStart hook additional context: ..." }] },
  ]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("ignores a tool_result continuation behind appended hook context", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
    { role: "system", content: "UserPromptSubmit hook additional context: ..." },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("a request of nothing but system messages is not a turn", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "system", content: "context" }])), null);
});

test("routing to haiku strips fields haiku cannot accept", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  };
  applyTier(body, "haiku");
  assert.equal(body.model, "claude-haiku-4-5");
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
  assert.equal(body.context_management, undefined);
});

test("routing to haiku keeps context-management strategies unrelated to thinking", () => {
  const body = {
    model: "claude-sonnet-4-6",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: "clear_thinking_20251015" }] },
  };
  applyTier(body, "haiku");
  assert.deepEqual(body.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });
});

test("routing to opus leaves thinking and effort intact", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  };
  applyTier(body, "opus");
  assert.equal(body.model, "claude-opus-5-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "medium" });
});

test("an unknown tier leaves the request untouched", () => {
  const body = { model: "claude-sonnet-4-6", thinking: { type: "adaptive" } };
  applyTier(body, "nonsense");
  assert.equal(body.model, "claude-sonnet-4-6");
});

test("a conversation keeps one key as it grows, and differs from a sub-agent", () => {
  const main = { messages: [{ role: "user", content: "main task" }] };
  const grown = {
    messages: [{ role: "user", content: "main task" }, { role: "assistant", content: "ok" }],
  };
  const sub = { messages: [{ role: "user", content: "sub-agent task" }] };
  assert.equal(conversationKey(main), conversationKey(grown));
  assert.notEqual(conversationKey(main), conversationKey(sub));
});

test("the key ignores the cache_control breakpoint Claude Code moves between requests", () => {
  const first = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
    ],
  };
  const later = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing" },
        ],
      },
      { role: "assistant", content: "working" },
    ],
  };
  assert.equal(conversationKey(first), conversationKey(later));
});

test("the same opening text in two sessions gets two keys", () => {
  const mk = (id) => ({
    metadata: { user_id: JSON.stringify({ session_id: id }) },
    messages: [{ role: "user", content: "same opening" }],
  });
  assert.notEqual(conversationKey(mk("a")), conversationKey(mk("b")));
});

test("the key survives metadata that is not JSON", () => {
  const body = { metadata: { user_id: "not-json" }, messages: [{ role: "user", content: "hi" }] };
  assert.doesNotThrow(() => conversationKey(body));
});

test("the feasibility filter cannot be bypassed by the model it resolves to", () => {
  const small = { id: "claude-opus-4-1", tier: "opus", maxInput: 200_000 };
  const bigOpus = { id: "claude-opus-5-5", tier: "opus", maxInput: 1_000_000 };
  const bigSonnet = { id: "claude-sonnet-5-5", tier: "sonnet", maxInput: 1_000_000 };
  const offered = [small, bigOpus, bigSonnet];

  const { models, oversized } = feasibleModels(offered, 500_000);
  assert.equal(oversized, false);
  assert.deepEqual(models.map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5-5"]);

  // A held decision must not resurrect the session's pinned model once it is ineligible.
  assert.deepEqual(
    resolveModel({
      models, tier: "opus", current: "opus",
      currentModel: small.id, chosen: null, reason: "downgrade-confidence-too-low/no-change",
    }),
    { model: bigOpus.id, tier: "opus", reason: "downgrade-confidence-too-low/no-change" },
  );
  // An eligible pinned model is still preferred, so a hold does not churn the cache.
  assert.equal(
    resolveModel({
      models, tier: "opus", current: "opus",
      currentModel: bigOpus.id, chosen: null, reason: "jev/no-change",
    }).model,
    bigOpus.id,
  );
  // Jev failure and an explicit override take the same resolution path.
  for (const reason of ["jev-unavailable/no-change", "override/no-change"]) {
    assert.equal(
      resolveModel({ models, tier: "opus", current: "opus", currentModel: small.id, chosen: null, reason }).model,
      bigOpus.id,
    );
  }
  // An exact answer is only honoured if it survived filtering.
  assert.equal(
    resolveModel({ models, tier: "opus", current: "sonnet", chosen: small, reason: "jev" }).model,
    bigOpus.id,
  );
  // Nothing to choose between at all is reported rather than papered over with a static id.
  assert.equal(resolveModel({ models: [], tier: "opus", current: "opus", chosen: null, reason: "jev" }), null);
});

test("a capacity fallback across tiers reports the tier it actually landed on", () => {
  // The settled tier has no eligible candidate, so staying in the window means leaving it.
  // The returned tier must be the new one: applyTier adapts with that tier's flags, and it
  // becomes the `current` the next turn compares against. Returning the settled tier instead
  // would strip a Fable request using Haiku's flags and hide the next real downgrade.
  const onlyFable = [{ id: "claude-fable-5-1", tier: "fable", maxInput: 1_000_000 }];
  const out = resolveModel({
    models: onlyFable, tier: "haiku", current: "haiku",
    currentModel: "claude-haiku-4-5", chosen: null, reason: "jev-unavailable/no-change",
  });
  assert.equal(out.model, "claude-fable-5-1");
  assert.equal(out.tier, "fable", "the reported tier must follow the model actually chosen");
  assert.match(out.reason, /\+capacity/, "entering a tier for capacity must not be silent");

  // And the flags used downstream are the chosen tier's, so thinking survives.
  const body = applyTier({ model: "jev-router", thinking: { type: "adaptive" } }, out.tier, out.model);
  assert.equal(body.model, "claude-fable-5-1");
  assert.deepEqual(body.thinking, { type: "adaptive" });
});

test("a tier that cannot be told not to think drops the opt-out instead of forwarding it", () => {
  // Opus 5.5 rejects thinking:{type:"disabled"} at every effort, so forwarding it is a 400.
  const body = applyTier({ model: "jev-router", thinking: { type: "disabled" } }, "opus");
  assert.equal("thinking" in body, false);
  // Haiku has no thinking support at all; the field goes for the other reason.
  assert.equal("thinking" in applyTier({ model: "x", thinking: { type: "disabled" } }, "haiku"), false);
  // An adaptive request is untouched on a thinking tier.
  assert.deepEqual(
    applyTier({ model: "x", thinking: { type: "adaptive" } }, "opus").thinking,
    { type: "adaptive" },
  );
});

test("a conversation past every window is offered only the roomiest models", () => {
  const haiku = { id: "claude-haiku-4-5", tier: "haiku", maxInput: 200_000 };
  const sonnet = { id: "claude-sonnet-5", tier: "sonnet", maxInput: 1_000_000 };
  const opus = { id: "claude-opus-5", tier: "opus", maxInput: 1_000_000 };

  const { models, oversized } = feasibleModels([haiku, sonnet, opus], 2_000_000);
  assert.equal(oversized, true);
  // Not the full list: answering "too big for every window" with the smallest window is the
  // one choice that cannot help. The API refuses it instead.
  assert.deepEqual(models.map((m) => m.id).sort(), ["claude-opus-5", "claude-sonnet-5"]);
  assert.equal(models.some((m) => m.tier === "haiku"), false);
});

test("the size estimate counts tools and system, not just messages", () => {
  const messages = [{ role: "user", content: "hi" }];
  const withTools = estimateInputTokens({ messages, tools: [{ name: "x", description: "y".repeat(4000) }] });
  const withSystem = estimateInputTokens({ messages, system: "z".repeat(4000) });
  const bare = estimateInputTokens({ messages });
  assert(withTools > bare + 900, "a large tool surface must raise the estimate");
  assert(withSystem > bare + 900, "a large system prompt must raise the estimate");
  assert.equal(estimateInputTokens({}), 0);
});

/** An upstream that serves a model catalog and records every forwarded request body. */
async function catalogUpstream(t, models) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if ((req.url ?? "").startsWith("/v1/models")) {
        return res.end(JSON.stringify({ data: models }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end(JSON.stringify({ id: "msg", type: "message", model: "x" }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => upstream.close());
  return { seen, url: `http://127.0.0.1:${upstream.address().port}` };
}

const turn = (port, text, extra = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: text }],
      ...extra,
    }),
  });

test("a catalog of only gated-off tiers still forwards a model from a candidate list", async (t) => {
  // Regression: this forwarded the static opus default with no candidate behind it.
  // Isolated from the ambient environment: with haiku enabled the catalog is usable and this
  // test would pass without ever exercising the fallback.
  const saved = process.env.JEV_ALLOW_HAIKU;
  process.env.JEV_ALLOW_HAIKU = "false";
  t.after(() => {
    if (saved === undefined) delete process.env.JEV_ALLOW_HAIKU;
    else process.env.JEV_ALLOW_HAIKU = saved;
  });

  const { seen, url } = await catalogUpstream(t, [{ id: "claude-haiku-4-5", max_input_tokens: 200000 }]);
  let offered = null;
  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async ({ models }) => {
      offered = models.map((m) => m.id);
      return null;
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`);
  await turn(port, `gated catalog ${process.pid}`);

  // Establishes which path ran: the classifier saw the static fallback, not the gated catalog.
  assert.ok(offered, "the classifier was never called");
  assert.equal(offered.includes("claude-haiku-4-5"), false, "a gated-off tier was offered");
  assert.deepEqual(offered, defaultCandidates().map((m) => m.id));

  assert.equal(seen.length, 1);
  // Haiku is the only catalog model and is gated off, so the documented fallback set is used;
  // whatever is forwarded must be a model from it, never the sentinel.
  assert.notEqual(seen[0].model, "jev-router");
  assert.ok(
    defaultCandidates().some((m) => m.id === seen[0].model),
    `forwarded ${seen[0].model}, which is not in the fallback candidate set`,
  );
  // The discriminating assertion: the broken version skipped routing entirely and let the
  // rewrite name a static default, so no decision existed to explain what was sent. Checking
  // the forwarded id alone cannot tell the two apart -- the static default is in the fallback
  // set too.
  const status = readStatus(conversationKey({ messages: [{ role: "user", content: `gated catalog ${process.pid}` }] }));
  assert.ok(status, "a model was forwarded with no routing decision behind it");
  assert.equal(status.model, seen[0].model, "the recorded decision disagrees with what was sent");
});

test("a held turn replaces a pinned model the conversation has outgrown", async (t) => {
  const { seen, url } = await catalogUpstream(t, [
    { id: "claude-opus-4-1", max_input_tokens: 200000 },
    { id: "claude-opus-5-5", max_input_tokens: 1000000 },
    { id: "claude-sonnet-5-5", max_input_tokens: 1000000 },
  ]);
  // Jev keeps asking for sonnet, never confidently enough to clear the downgrade bar.
  const { port, close } = await startProxy({
    upstreamURL: url,
    route: async () => ({ choice: "claude-sonnet-5-5", confidence: 0.5, ms: 1 }),
  });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/v1/models`);

  const convo = `outgrow me ${process.pid}`;
  await turn(port, convo); // small first turn: pins some opus
  // Same conversation, now far past the smaller window.
  await turn(port, convo, {
    messages: [{ role: "user", content: convo }, { role: "user", content: "x".repeat(3_000_000) }],
  });

  assert.equal(seen.length, 2);
  // Without this the test passes even if catalog handling regressed and the larger model was
  // used from the start -- there would be nothing to outgrow.
  assert.equal(seen[0].model, "claude-opus-4-1", "the first turn did not pin the smaller model");
  assert.equal(seen[1].model, "claude-opus-5-5", "forwarded a model the conversation outgrew");
});

test("a thinking opt-out is removed before a model that rejects it", async (t) => {
  const { seen, url } = await catalogUpstream(t, [{ id: "claude-opus-5-5", max_input_tokens: 1000000 }]);
  const { port, close } = await startProxy({ upstreamURL: url, route: async () => null });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/v1/models`);

  await turn(port, `no thinking please ${process.pid}`, { thinking: { type: "disabled" } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, "claude-opus-5-5");
  assert.equal("thinking" in seen[0], false, "an opt-out this model rejects must not be forwarded");
});

test("a capacity move is carried into the next turn's downgrade classification", async (t) => {
  // The state-propagation defect in full: a capacity fallback changes tier, and the *next*
  // turn has to compare against the tier actually running. If it compared against the tier
  // policy had settled on, the real downgrade would be invisible and skip the confidence bar.
  const saved = process.env.JEV_ALLOW_FABLE;
  process.env.JEV_ALLOW_FABLE = "true";
  t.after(() => {
    if (saved === undefined) delete process.env.JEV_ALLOW_FABLE;
    else process.env.JEV_ALLOW_FABLE = saved;
  });

  // Only fable can hold a large conversation; opus is present but too small.
  const { seen, url } = await catalogUpstream(t, [
    { id: "claude-opus-5-5", max_input_tokens: 200_000 },
    { id: "claude-fable-5-1", max_input_tokens: 1_000_000 },
  ]);
  const { port, close } = await startProxy({
    upstreamURL: url,
    // Jev asks for opus throughout, never confidently enough to clear the downgrade bar.
    route: async () => ({ choice: "claude-opus-5-5", confidence: 0.5, ms: 1 }),
  });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/v1/models`);

  const convo = `capacity carry ${process.pid}`;
  // Turn 1: past opus's window, so the only candidate that fits is fable.
  await turn(port, convo, {
    messages: [{ role: "user", content: convo }, { role: "user", content: "x".repeat(2_000_000) }],
  });
  assert.equal(seen[0].model, "claude-fable-5-1", "did not move to the only tier that fits");

  const status = readStatus(conversationKey({ messages: [{ role: "user", content: convo }] }));
  assert.equal(status.tier, "fable", "recorded the settled tier instead of the one running");
  assert.match(status.reason, /\+capacity/);

  // Turn 2: small again, so opus is eligible and Jev's 0.5 opus answer is now a real
  // fable->opus downgrade. It must be recognised as one and held.
  await turn(port, convo);
  assert.equal(seen[1].model, "claude-fable-5-1", "a low-confidence downgrade was let through");
  const after = readStatus(conversationKey({ messages: [{ role: "user", content: convo }] }));
  assert.match(after.reason, /downgrade-confidence-too-low/, `reason was ${after.reason}`);
});

test("a model that accepts a thinking opt-out keeps it", async (t) => {
  // The counterpart to dropping it: opus 5 honours the opt-out at effort high or below, so
  // rewriting that request would change behaviour for no reason.
  const { seen, url } = await catalogUpstream(t, [{ id: "claude-opus-5", max_input_tokens: 1_000_000 }]);
  const { port, close } = await startProxy({ upstreamURL: url, route: async () => null });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/v1/models`);

  await turn(port, `keep my opt-out ${process.pid}`, {
    thinking: { type: "disabled" },
    output_config: { effort: "high" },
  });
  assert.equal(seen[0].model, "claude-opus-5");
  assert.deepEqual(seen[0].thinking, { type: "disabled" }, "an opt-out this model accepts was removed");
});

test("a reported context limit is only believed when it is one", () => {
  // Number() alone would make a boolean a capacity; the family window is the safer fallback.
  const limit = (max_input_tokens) =>
    claudeModels([{ id: "claude-opus-5", max_input_tokens }])[0].maxInput;
  assert.equal(limit(200_000), 200_000);
  assert.equal(limit("200000"), 200_000, "a numeric string is unambiguous and kept");
  for (const bogus of [true, false, [200_000], {}, "abc", -5, 0, Infinity, NaN, null, undefined]) {
    assert.equal(limit(bogus), null, `${JSON.stringify(bogus) ?? "undefined"} became a capacity`);
  }
});

test("an adaptation reaches the decision record and the explanation", async (t) => {
  // The disclosure path end to end: applyTier removes the field, and the user can still see
  // that their request was changed rather than only that a model was chosen.
  const { seen, url } = await catalogUpstream(t, [{ id: "claude-opus-5-5", max_input_tokens: 1_000_000 }]);
  const { port, close } = await startProxy({ upstreamURL: url, route: async () => null });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/v1/models`);

  const convo = `disclose the adaptation ${process.pid}`;
  await turn(port, convo, { thinking: { type: "disabled" } });

  assert.equal("thinking" in seen[0], false);
  const status = readStatus(conversationKey({ messages: [{ role: "user", content: convo }] }));
  assert.deepEqual(status.adapted, ["thinking opt-out removed"]);
  assert.match(formatExplanation(status), /Adapted:/);
});
