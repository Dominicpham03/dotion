import type { AiStatus } from "@/platform/types";

/** What to call the assistant: the model family the server uses. */
export function aiName(s: AiStatus | undefined): string {
  switch (s?.provider) {
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "ollama":
      return "AI";
    default:
      return "AI";
  }
}

/** Where the notes it reads go, in one sentence. */
export function aiPrivacy(s: AiStatus | undefined): string {
  switch (s?.provider) {
    case "claude":
      return "Notes it reads are sent to Anthropic's Claude API to answer; Anthropic doesn't train on them.";
    case "gemini":
      return "Notes it reads are sent to Google to answer.";
    case "ollama":
      return "The model runs on your own computer; your notes never leave it.";
    default:
      return "";
  }
}
