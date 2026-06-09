/**
 * Specs Inc. 2026
 * CardEditTools — the deterministic half of voice-driven card-caption editing.
 *
 * CardVoiceAgent owns the Gemini Live session and the conversation; this module
 * owns the parts that must be exact: the function declarations advertised to the
 * model, and the pure text transforms that turn the model's tool arguments into a
 * final caption (insert an addition before the hashtag line, sanitize stray tags).
 * It deliberately has NO Gemini imports so the agent file stays about the session
 * and this stays trivially testable — same split as QueryOrchestrator.
 *
 * Authoring is Gemini-direct: the model emits the new wording itself as the tool
 * argument (no second GPT-4o round-trip), and the agent applies it to whichever
 * card is currently being discussed (a CardEditTarget supplied by PictureBehavior).
 */

/** The live card the agent is editing — implemented by PictureBehavior per card. */
export interface CardEditTarget {
  /** The card's CardStore id, or null if it hasn't been stored yet. */
  getCardId(): string | null;
  /** The caption text currently shown on the card. */
  getText(): string;
  /** Animate the caption from its current text to `target` (typewriter effect). */
  setTextAnimated(target: string): void;
}

/** Tool declarations advertised to Gemini in the session Setup message. */
export const CARD_EDIT_TOOL_DECLARATIONS = [
  {
    name: "rewrite_caption",
    description:
      "Replace the card's caption with a corrected version. Use this for a genuine CORRECTION (e.g. the " +
      "subject was misidentified, or a stated fact is wrong) — after you have fact-checked the user's claim " +
      "and agree it is warranted; do not call it to merely rephrase, and do not call it if the user is wrong. " +
      "Provide the COMPLETE new caption: the fact text, then a final line of 2-3 #Hashtags matching the " +
      "existing format (#Interest #Subject #Tag).",
    parameters: {
      type: "OBJECT",
      properties: {
        new_caption: {
          type: "STRING",
          description:
            "The complete replacement caption: one or two sentences of fact, then a newline and a " +
            "line of 2-3 #Hashtags.",
        },
      },
      required: ["new_caption"],
    },
  },
  {
    name: "append_caption",
    description:
      "Add one short extra sentence to the card's caption WITHOUT removing anything. Call this whenever the " +
      "user asks to add, note, save, or remember something about the card, or when a genuinely interesting, " +
      "accurate new detail comes up in conversation. Prefer this over rewrite_caption when the existing caption " +
      "is still correct and you are only adding to it. The sentence is inserted before the hashtag line " +
      "automatically — do NOT include hashtags here.",
    parameters: {
      type: "OBJECT",
      properties: {
        addition: {
          type: "STRING",
          description: "A single short sentence to add to the caption. No hashtags.",
        },
      },
      required: ["addition"],
    },
  },
];

/**
 * Strips tag-like sequences and caps length before the text reaches the caption
 * renderer, which can crash on unclosed HTML-style tags. Mirrors ChatGPT.sanitize.
 */
export function sanitizeCaption(text: string): string {
  return (text ?? "").replace(/<[^>]*>/g, "").slice(0, 400);
}

/**
 * Composes the target caption for an append: keeps the trailing "#A #B #C" hashtag
 * line at the very end and inserts the new sentence into the body before it, so the
 * typewriter types the addition in place and the hashtags (the common suffix) stay
 * put. When the caption has no hashtag line, the addition is simply appended.
 */
export function composeAppendTarget(currentText: string, addition: string): string {
  const text = (currentText ?? "").replace(/\s+$/, "");
  const add = sanitizeCaption(addition).trim();
  if (add.length === 0) return text;

  // The hashtag line is the last newline-separated line that starts with '#'.
  const nl = text.lastIndexOf("\n");
  const lastLine = nl >= 0 ? text.slice(nl + 1) : text;
  const hasHashtagLine = nl >= 0 && /^\s*#/.test(lastLine);

  if (hasHashtagLine) {
    const body = text.slice(0, nl).replace(/\s+$/, "");
    return body + " " + add + "\n" + lastLine;
  }
  return text + " " + add;
}
