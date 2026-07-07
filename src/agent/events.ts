/**
 * Defensive renderer for SDK stream events. The SDK's docs note that some event
 * subfields (notably tool_call args/results) are internal and can change, so we
 * discriminate on `type` and access fields loosely rather than trusting a shape.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
function extractText(event: any): string {
  if (typeof event.text === "string") return event.text;
  if (typeof event.delta === "string") return event.delta;
  const content = event.message?.content ?? event.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("");
  return "";
}

export function renderEvent(event: any): void {
  const t = event?.type;
  switch (t) {
    case "assistant": {
      const text = extractText(event);
      if (text) process.stdout.write(text);
      break;
    }
    case "tool_call": {
      const name = event.tool ?? event.name ?? event.toolName ?? "tool";
      const phase = event.status ?? event.phase ?? "";
      process.stdout.write(`\n  \x1b[36m[tool]\x1b[0m ${name}${phase ? ` \x1b[90m${phase}\x1b[0m` : ""}\n`);
      break;
    }
    case "status": {
      process.stdout.write(`  \x1b[33m[status]\x1b[0m ${event.status ?? event.state ?? ""}\n`);
      break;
    }
    default:
      // thinking / usage / system — kept quiet; usage is summarized at the end
      break;
  }
}
