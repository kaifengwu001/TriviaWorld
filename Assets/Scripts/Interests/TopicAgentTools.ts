/**
 * Specs Inc. 2026
 * TopicAgentTools — the deterministic half of the voice-driven topic picker.
 *
 * WelcomeVoice owns the Gemini Live session and the conversation; this module owns
 * the tool declarations advertised to the model and the exact, side-effecting
 * dispatch that toggles the TopicSelectionPanel's buttons and presses Start. It
 * deliberately has NO Gemini imports (mirrors QueryOrchestrator) so it stays
 * trivially testable and the agent file stays about the session.
 */
import { DEFAULT_TOPICS } from "./InterestTopics";
import { ToolCall } from "../Cards/QueryOrchestrator";

/** Minimal shape of the TopicSelectionPanel we drive (lives on global.topicPanel). */
export interface TopicPanelLike {
  setTopicSelection(topics: string[], on: boolean): { matched: string[]; selected: string[] };
  getSelectedTopics(): string[];
  getAvailableTopics(): string[];
  startExploring(): void;
}

/** Tool declarations advertised to Gemini in the session Setup message. */
export const TOPIC_TOOL_DECLARATIONS = [
  {
    name: "select_topics",
    description:
      "Turn ON one or more topic buttons on the panel for the user. Call this as soon as the user " +
      "names interests (map loose phrasing like 'science' to the closest available topics). Returns " +
      "the topics that were matched and the full set now selected.",
    parameters: {
      type: "OBJECT",
      properties: {
        topics: {
          type: "ARRAY",
          description: "Topics to select. Use the exact available topic names.",
          items: { type: "STRING", enum: DEFAULT_TOPICS },
        },
      },
      required: ["topics"],
    },
  },
  {
    name: "deselect_topics",
    description:
      "Turn OFF one or more topic buttons the user no longer wants. Returns the topics matched and " +
      "the full set still selected.",
    parameters: {
      type: "OBJECT",
      properties: {
        topics: {
          type: "ARRAY",
          description: "Topics to deselect. Use the exact available topic names.",
          items: { type: "STRING", enum: DEFAULT_TOPICS },
        },
      },
      required: ["topics"],
    },
  },
  {
    name: "start_exploring",
    description:
      "Press the 'Start exploring' button to confirm the user's selection and begin. Only call this " +
      "once the user has said they're ready. Returns the final selected topics.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
];

/** Args for select_topics / deselect_topics. */
interface TopicsArg {
  topics?: string[];
}

/**
 * Executes a topic tool call against the panel and returns the structured response
 * for the model to narrate from. Mirrors QueryOrchestrator.run's shape.
 */
export function runTopicTool(
  call: ToolCall,
  panel: TopicPanelLike | null
): { name: string; response: { [key: string]: any } } {
  if (!panel) {
    return { name: call.name, response: { error: "topic panel unavailable" } };
  }
  if (call.name === "select_topics" || call.name === "deselect_topics") {
    const args = (call.args ?? {}) as TopicsArg;
    const topics = Array.isArray(args.topics) ? args.topics : [];
    const on = call.name === "select_topics";
    const out = panel.setTopicSelection(topics, on);
    return {
      name: call.name,
      response: { matched: out.matched, selected: out.selected, available: panel.getAvailableTopics() },
    };
  }
  if (call.name === "start_exploring") {
    const selected = panel.getSelectedTopics();
    panel.startExploring();
    return { name: call.name, response: { started: true, selected } };
  }
  return { name: call.name, response: { error: "unknown tool: " + call.name } };
}
