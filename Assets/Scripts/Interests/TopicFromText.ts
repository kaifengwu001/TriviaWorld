/**
 * Specs Inc. 2026
 * TopicFromText – maps an AI caption's hashtags back to preset DEFAULT_TOPICS.
 *
 * The vision model (see ChatGPT.ts) ends every caption with a hashtag line:
 *
 *     <one or two sentences of trivia>
 *     #<ChosenInterest> #<Subject> #<RelatedTag>
 *
 * The FIRST hashtag is the interest the model chose, so it is the card's primary
 * topic. Hashtags are CamelCase with no spaces (e.g. "#ArtHistory"), so matching
 * normalizes both sides to lowercase-alphanumeric ("art history" -> "arthistory")
 * before comparing — mirroring ChatGPT.rememberChosenTopic().
 *
 * Dependency-free (no @component) so any script can resolve a topic without a
 * scene reference, in the plain-data style of TopicColors.ts / cardDeckData.ts.
 */
import { DEFAULT_TOPICS } from "./InterestTopics"

// Preset topics keyed by their normalized form, built once.
const NORMALIZED_TOPICS: { key: string; topic: string }[] = DEFAULT_TOPICS.map((t) => ({
  key: normalize(t),
  topic: t,
}))

/**
 * Every preset topic referenced by the hashtags, in hashtag order (so the chosen
 * interest — the first hashtag — comes first). Unrecognized hashtags are dropped;
 * duplicates are removed. Returns [] when nothing matches a preset topic.
 */
export function topicsFromHashtags(hashtags: string[]): string[] {
  const out: string[] = []
  for (const tag of hashtags ?? []) {
    const topic = matchTopic(tag)
    if (topic && out.indexOf(topic) < 0) out.push(topic)
  }
  return out
}

/** The single primary topic (first matching hashtag), or null if none match. */
export function primaryTopicFromHashtags(hashtags: string[]): string | null {
  const topics = topicsFromHashtags(hashtags)
  return topics.length > 0 ? topics[0] : null
}

// --- internal ----------------------------------------------------------------

function matchTopic(hashtag: string): string | null {
  const key = normalize(hashtag)
  if (key.length === 0) return null
  for (const entry of NORMALIZED_TOPICS) {
    if (entry.key === key) return entry.topic
  }
  return null
}

// Lowercase + strip everything that isn't a letter or digit, so "Art History",
// "ArtHistory" and "#art_history" all collapse to the same key.
function normalize(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}
