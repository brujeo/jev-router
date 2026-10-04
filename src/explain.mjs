const WIDTH = 33;
const row = (text = "") => `│ ${text.slice(0, WIDTH - 2).padEnd(WIDTH - 2)} │`;
const metric = (value) => (Number.isFinite(value) ? value.toFixed(2) : "n/a");
const wrapped = (label, value) => {
  const words = `${label}${value}`.replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  for (const word of words) {
    if (!lines.length || `${lines.at(-1)} ${word}`.length > WIDTH - 2) lines.push(word);
    else lines[lines.length - 1] += ` ${word}`;
  }
  return lines.map(row);
};

const decision = (reason = "") => {
  if (reason.includes("override")) return "prompt override";
  if (reason.includes("jev-unavailable")) return "Jev unavailable; held";
  if (reason.includes("low-confidence-no-downgrade")) return "low confidence; held";
  if (reason.includes("low-confidence-capped")) return "low confidence; capped";
  if (reason.includes("downgrade-confidence-too-low")) return "downgrade not confident enough";
  if (reason.includes("unavailable")) return "nearest available tier";
  return "Jev recommendation";
};

export function formatExplanation(status) {
  if (!status) return "Jev Router: no routing decision has been recorded for this session.";
  if (status.manual) return "Jev Router: routing is paused because you selected a model manually.";

  const m = status.metrics ?? {};
  const request = status.jev?.request?.state;
  // `answers.model` is the key config.mjs asks under, and the choice is an exact model id.
  // This read was `answers.model_tier`, which never exists, so it always fell through to the
  // tier that was actually selected -- making a recommendation the policy *refused* look like
  // the one it followed, which is exactly the case worth seeing.
  const recommendation =
    status.jev?.response?.answers?.model?.choice ?? status.tier ?? "unknown";
  return [
    `┌${"─".repeat(WIDTH)}┐`,
    row("Jev Router"),
    row(),
    row("Jev request"),
    ...wrapped("Prompt: ", status.prompt ?? "not recorded"),
    // Model ids are longer than the box is wide, so these wrap rather than silently truncate.
    ...wrapped("Current model: ", (request?.session?.current_model ?? "unknown").toUpperCase()),
    row(`Context tokens: ${request?.session?.context_tokens ?? "unknown"}`),
    row(),
    row("Jev response"),
    row(`Task complexity     ${metric(m.taskComplexity)}`),
    row(`Reasoning required  ${metric(m.reasoningRequired)}`),
    row(`Tool complexity     ${metric(m.toolComplexity)}`),
    row(`Context size        ${metric(m.contextSize)}`),
    row(),
    ...wrapped("Jev recommended: ", recommendation.toUpperCase()),
    ...wrapped("Selected model: ", (status.model ?? status.tier ?? "unknown").toUpperCase()),
    row(),
    row(`Confidence: ${status.confidence == null ? "n/a" : `${Math.round(status.confidence * 100)}%`}`),
    ...wrapped("Decision: ", decision(status.reason)),
    `└${"─".repeat(WIDTH)}┘`,
  ].join("\n");
}
