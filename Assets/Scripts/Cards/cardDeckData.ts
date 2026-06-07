/**
 * Specs Inc. 2026
 * cardDeckData.ts – the premade "cosmos" deck cards.
 *
 * Authored by hand (no JSON import — Lens Studio isolatedModules, same as
 * cityBounds.ts). The `text` and the card images are PLACEHOLDERS to be filled
 * in later; the id / hashtags / topics / location / captureDate are real and
 * used for storage + querying.
 *
 *   - id          unique, stable.
 *   - topics      a subset of DEFAULT_TOPICS (Assets/Scripts/Interests/InterestTopics.ts).
 *   - location    one of "Seattle" | "Los Angeles" | "Tokyo" (cities in cityBounds.ts).
 *   - captureDate "YYYY-MM-DD", faked within the recent 3 months (≈ 2026-03 … 2026-06).
 *
 * CARD_DECK_DATA are the 20 cards SPAWNED as the cosmos. SEED_CARDS are premade
 * records registered in the store but NOT spawned (e.g. the standalone
 * PremadeCard already present in the scene), so it is in storage too.
 */

/** One premade deck card. */
export interface CardDeckEntry {
  id: string;
  text: string;
  hashtags: string[];   // without the leading '#'
  topics: string[];     // subset of DEFAULT_TOPICS
  location: string;     // "Seattle" | "Los Angeles" | "Tokyo"
  captureDate: string;  // "YYYY-MM-DD"
}

export const CARD_DECK_DATA: CardDeckEntry[] = [
  { id: "deck_01", text: "Placeholder card 1.",  hashtags: ["Space", "Astronomy"],        topics: ["Space", "Physics"],        location: "Seattle",     captureDate: "2026-03-09" },
  { id: "deck_02", text: "Placeholder card 2.",  hashtags: ["Music", "Jazz"],             topics: ["Music"],                   location: "Tokyo",       captureDate: "2026-03-14" },
  { id: "deck_03", text: "Placeholder card 3.",  hashtags: ["Botany", "Ferns"],           topics: ["Botany", "Biology"],       location: "Los Angeles", captureDate: "2026-03-18" },
  { id: "deck_04", text: "Placeholder card 4.",  hashtags: ["History", "Edo"],            topics: ["History"],                 location: "Tokyo",       captureDate: "2026-03-23" },
  { id: "deck_05", text: "Placeholder card 5.",  hashtags: ["Chemistry", "Catalysis"],    topics: ["Chemistry"],               location: "Seattle",     captureDate: "2026-03-27" },
  { id: "deck_06", text: "Placeholder card 6.",  hashtags: ["Aviation", "JetEngine"],     topics: ["Aviation", "Physics"],     location: "Los Angeles", captureDate: "2026-04-01" },
  { id: "deck_07", text: "Placeholder card 7.",  hashtags: ["Food", "Ramen"],            topics: ["Food"],                    location: "Tokyo",       captureDate: "2026-04-05" },
  { id: "deck_08", text: "Placeholder card 8.",  hashtags: ["Trains", "Shinkansen"],      topics: ["Trains"],                  location: "Tokyo",       captureDate: "2026-04-09" },
  { id: "deck_09", text: "Placeholder card 9.",  hashtags: ["ArtHistory", "Ukiyoe"],      topics: ["Art History", "History"],  location: "Los Angeles", captureDate: "2026-04-13" },
  { id: "deck_10", text: "Placeholder card 10.", hashtags: ["Design", "Bauhaus"],         topics: ["Design"],                  location: "Seattle",     captureDate: "2026-04-17" },
  { id: "deck_11", text: "Placeholder card 11.", hashtags: ["Biology", "Mycology"],       topics: ["Biology", "Botany"],       location: "Seattle",     captureDate: "2026-04-21" },
  { id: "deck_12", text: "Placeholder card 12.", hashtags: ["Physics", "Optics"],         topics: ["Physics"],                 location: "Los Angeles", captureDate: "2026-04-25" },
  { id: "deck_13", text: "Placeholder card 13.", hashtags: ["XR", "SpatialComputing"],    topics: ["XR", "Design"],            location: "Seattle",     captureDate: "2026-04-29" },
  { id: "deck_14", text: "Placeholder card 14.", hashtags: ["Space", "Nebula"],           topics: ["Space"],                   location: "Tokyo",       captureDate: "2026-05-03" },
  { id: "deck_15", text: "Placeholder card 15.", hashtags: ["Music", "Synthesizers"],     topics: ["Music", "XR"],             location: "Los Angeles", captureDate: "2026-05-07" },
  { id: "deck_16", text: "Placeholder card 16.", hashtags: ["Food", "Coffee"],           topics: ["Food", "Chemistry"],       location: "Seattle",     captureDate: "2026-05-11" },
  { id: "deck_17", text: "Placeholder card 17.", hashtags: ["History", "GoldRush"],       topics: ["History"],                 location: "Los Angeles", captureDate: "2026-05-15" },
  { id: "deck_18", text: "Placeholder card 18.", hashtags: ["Aviation", "Seaplanes"],     topics: ["Aviation"],                location: "Seattle",     captureDate: "2026-05-20" },
  { id: "deck_19", text: "Placeholder card 19.", hashtags: ["Botany", "CherryBlossom"],   topics: ["Botany"],                  location: "Tokyo",       captureDate: "2026-05-25" },
  { id: "deck_20", text: "Placeholder card 20.", hashtags: ["Trains", "Monorail"],        topics: ["Trains", "Design"],        location: "Los Angeles", captureDate: "2026-05-30" },
];

/** Premade records registered in the store but NOT spawned as cosmos cards. */
export const SEED_CARDS: CardDeckEntry[] = [
  // The standalone PremadeCard already present (disabled) in the scene.
  { id: "premade_seed", text: "Premade card caption.", hashtags: ["History"], topics: ["History"], location: "Seattle", captureDate: "2026-06-02" },
];
