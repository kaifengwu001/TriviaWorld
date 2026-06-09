/**
 * Specs Inc. 2026
 * CardStore for the Crop Spectacles lens.
 *
 * Session-scoped singleton that holds EVERY card in memory: the premade cards
 * seeded at startup (the CardDeck cosmos + the standalone PremadeCard) and the
 * cards captured during this session. Captured cards live only for the session;
 * clearCaptured() drops them while keeping the premade seed.
 *
 * Registered on `global.cropCardStore` so it can be read across prefab
 * boundaries (the runtime-instantiated Scanner prefab, the CardDeckController),
 * mirroring how InterestStore registers on `global.cropInterestStore`.
 *
 * future: optional on-device persistence, globe placement by location.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";

/** One card and all of its queryable metadata. */
export interface CardRecord {
  /** Unique id; the store generates one ("card_N") when not supplied. */
  id: string;
  /** Captured/placeholder image. Optional (a card may carry only a link). */
  image?: Texture;
  /** Optional link alternative to an in-memory texture. */
  imageLink?: string;
  /** Caption / trivia text (may include the trailing #hashtag line). */
  text: string;
  /** Parsed hashtags, without the leading '#'. */
  hashtags: string[];
  /** Topics of interest this card relates to (subset of DEFAULT_TOPICS). */
  topics: string[];
  /** Where the card was made, e.g. "Long Beach, California" | "Seattle" | "Los Angeles" | "Tokyo". */
  location: string;
  /** Date the card was made, "YYYY-MM-DD" (date only). */
  captureDate: string;
  /** true = seeded at startup; false = captured this session. */
  premade: boolean;
}

/** The fields a caller supplies; the store fills id/premade/captureDate. */
export type CardInput = Partial<CardRecord> & {
  text: string;
  hashtags: string[];
  topics: string[];
  location: string;
};

@component
export class CardStore extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">CardStore – holds all cards for the session</span><br/><span style="color: #94A3B8; font-size: 11px;">Registered on global.cropCardStore. Premade cards are seeded by CardDeckController; captured cards are added by the capture flow and dropped on clearCaptured().</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false;

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false;

  private logger: Logger;

  // All cards. Never mutated by callers (getters return copies).
  private cards: CardRecord[] = []

  // Monotonic counter for generated ids.
  private idCounter: number = 0

  // Bumped on every CAPTURED card (addCard); premade seeding does NOT bump it.
  // The CardDeckController polls this (getCapturedVersion) to fold newly captured
  // cards into the deck the next time it is shown — so the persistent store is the
  // only thing capture and the (separate) deck scene need to share.
  private capturedVersion: number = 0

  onAwake() {
    this.logger = new Logger("CardStore", this.enableLogging || this.enableLoggingLifecycle, true);
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()");
    (global as any).cropCardStore = this
  }

  /**
   * Adds a card captured this session. Fills a generated id, premade=false, and
   * defaults captureDate to today when not supplied. Returns the stored record.
   */
  addCard(input: CardInput): CardRecord {
    const record = this.finalize(input, false)
    this.cards.push(record)
    this.capturedVersion += 1
    this.logger.info("Captured card " + record.id + " @ " + record.location + " (" + this.cards.length + " total)")
    return record
  }

  /**
   * A monotonic counter bumped each time a card is CAPTURED this session
   * (addCard); premade seeding does not change it. The CardDeckController compares
   * this against the last value it synced to detect cards captured while the deck
   * scene was switched off — the two never need to be enabled at the same time.
   */
  getCapturedVersion(): number {
    return this.capturedVersion
  }

  /**
   * Adds a premade card seeded at startup (deck cosmos or the standalone card).
   * premade=true; captureDate is taken from the input (a faked recent date).
   */
  addPremade(input: CardInput): CardRecord {
    const record = this.finalize(input, true)
    this.cards.push(record)
    return record
  }

  /** Returns a copy of all cards so callers cannot mutate internal state. */
  getCards(): CardRecord[] {
    return this.cards.slice()
  }

  getById(id: string): CardRecord | null {
    for (const c of this.cards) if (c.id === id) return c
    return null
  }

  /** Cards made at the given location (case-insensitive exact match). */
  getByLocation(location: string): CardRecord[] {
    const key = (location ?? "").trim().toLowerCase()
    return this.cards.filter((c) => c.location.trim().toLowerCase() === key)
  }

  /** Cards related to the given topic of interest. */
  getByTopic(topic: string): CardRecord[] {
    return this.cards.filter((c) => c.topics.indexOf(topic) >= 0)
  }

  removeCard(id: string): boolean {
    const next = this.cards.filter((c) => c.id !== id)
    const removed = next.length !== this.cards.length
    this.cards = next
    return removed
  }

  /** Wipes the cards captured this session; keeps the premade seed. */
  clearCaptured(): void {
    const before = this.cards.length
    this.cards = this.cards.filter((c) => c.premade)
    this.logger.info("Cleared " + (before - this.cards.length) + " captured cards (" + this.cards.length + " premade kept)")
  }

  count(): number {
    return this.cards.length
  }

  /** Extracts every "#Tag" from text, returning the tags without the '#'. */
  parseHashtags(text: string): string[] {
    const out: string[] = []
    const re = /#(\w+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text ?? "")) !== null) out.push(m[1])
    return out
  }

  /** Today's date as "YYYY-MM-DD". */
  todayISODate(): string {
    return CardStore.formatDate(new Date())
  }

  /** Formats a Date as "YYYY-MM-DD" (date only, zero-padded). */
  static formatDate(d: Date): string {
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    const day = d.getDate()
    const pad = (n: number) => (n < 10 ? "0" + n : "" + n)
    return y + "-" + pad(m) + "-" + pad(day)
  }

  // --- internal --------------------------------------------------------------

  private finalize(input: CardInput, premade: boolean): CardRecord {
    return {
      id: input.id && input.id.length > 0 ? input.id : this.nextId(),
      image: input.image,
      imageLink: input.imageLink,
      text: input.text ?? "",
      hashtags: (input.hashtags ?? []).slice(),
      topics: (input.topics ?? []).slice(),
      location: input.location ?? "",
      captureDate: input.captureDate && input.captureDate.length > 0 ? input.captureDate : this.todayISODate(),
      premade,
    }
  }

  private nextId(): string {
    this.idCounter += 1
    return "card_" + this.idCounter
  }
}
