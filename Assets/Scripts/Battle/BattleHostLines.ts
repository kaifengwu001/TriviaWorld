/**
 * BattleHostLines.ts — the sassy trivia-host "brain" (no Gemini, pure logic).
 *
 * Option A (curated line bank) for Battle mode. This module owns:
 *   - the line bank (short, punchy host lines in two tiers: Playful / Savage),
 *   - the intensity calibration (how spicy to get, from the score state),
 *   - the no-repeat rotation so a single match never repeats a line.
 *
 * It is deliberately Gemini-free and side-effect-free so it can be reasoned
 * about and tested on its own (same split as QueryOrchestrator / TopicAgentTools
 * / CardEditTools). BattleHostVoice owns the live session; this owns *what* to say.
 *
 * Persona (for reference — enforced by the bank, not by an LLM): a sassy quiz-show
 * host à la Tom Gleeson / Anne Robinson. Cocky, quick, lightly roasts your play —
 * never you. Roast targets the answer, the speed, the scoreboard. Escalates when
 * you're winning; eases off when you're losing.
 *
 * GUARDRAILS baked into the data + selection:
 *   - Every line is short (< ~12 words).
 *   - No profanity, nothing mean-spirited.
 *   - A *losing* player never gets a Savage line (intensity is capped + the
 *     selector refuses the Savage pool when behind). BLOWOUT_LOSING stays gentle.
 *   - No repetition within a match (recently-used rotation).
 */

/** Discrete game moments the host can react to (per the local player's view). */
export type BattleEvent =
  | "PRE_MATCHPOINT"    // a fresh question where someone can win this turn
  | "CORRECT"           // local player got it right
  | "FAST_CORRECT"      // right AND fast on the buzzer
  | "WRONG"             // local player answered wrong
  | "TOO_SLOW"          // local player got robbed / didn't buzz in time
  | "TAKE_LEAD"         // local player just pulled ahead
  | "FALL_BEHIND"       // local player just fell behind
  | "BLOWOUT_WINNING"   // local player dominating
  | "BLOWOUT_LOSING"    // local player getting crushed
  | "WIN"               // match won
  | "LOSS";             // match lost

/** Everything the calibration needs, from the local player's perspective. */
export interface GameSnapshot {
  myScore: number;
  oppScore: number;
  winScore: number;
  streak: number;     // consecutive correct answers by the local player
  answerMs: number;   // ms from question shown → local buzz (-1 if no buzz)
}

interface LineTier {
  playful: string[];
  savage: string[];
}

/** Intensity at or above this (and not behind) unlocks the Savage tier. */
const SAVAGE_THRESHOLD = 0.6;

/**
 * The line bank. Several options per slot so the rotation has room to breathe.
 * Lines are sourced from the build brief's example bank, lightly extended to give
 * the rotation more variety while staying in voice and within the guardrails.
 *
 * For events that can ONLY happen while behind (FALL_BEHIND, BLOWOUT_LOSING) the
 * "savage" tier is intentionally kept gentle — and the selector refuses Savage
 * when behind anyway, so these stay encouraging no matter the intensity.
 */
const LINE_BANK: Record<BattleEvent, LineTier> = {
  PRE_MATCHPOINT: {
    playful: [
      "Neck and neck — I'm actually invested now.",
      "Whole match comes down to this.",
      "This one's for the match. Make it count.",
    ],
    savage: [
      "One of you is about to be very disappointed.",
      "Place your bets. I already have.",
      "Win it now or live with the regret.",
    ],
  },

  CORRECT: {
    playful: [
      "Look at you — knew you had one in you.",
      "Correct. Nicely done.",
      "Right answer. We love to see it.",
    ],
    savage: [
      "Correct. Don't let it go to your head — it's lonely up there.",
      "Correct. I'm almost impressed.",
      "Correct. Look who came to play.",
    ],
  },

  FAST_CORRECT: {
    playful: [
      "Barely read the question and nailed it.",
      "Fast and right. Okay, okay.",
      "Fast hands — and you actually knew it.",
    ],
    savage: [
      "That fast? You're making this look rude.",
      "Speed and accuracy? Who hurt you?",
      "Quick and correct. Insufferable, honestly.",
    ],
  },

  WRONG: {
    playful: [
      "Bold. Wrong, but bold.",
      "Not quite — but I admire the commitment.",
      "Wrong, but you really went for it.",
    ],
    savage: [
      "That answer should be studied by scientists. From a distance.",
      "I'll pretend I didn't see that.",
      "That wasn't just wrong. It was impressively wrong.",
    ],
  },

  TOO_SLOW: {
    playful: [
      "Tick tock — the question wasn't getting easier.",
      "Blink and the question's gone — like just now.",
      "Too slow — the buzzer gave up waiting.",
    ],
    savage: [
      "I've seen glaciers commit faster than that.",
      "Should I put on some coffee?",
      "The buzzer's right there, you know.",
    ],
  },

  TAKE_LEAD: {
    playful: [
      "Ooh, momentum — this just got interesting.",
      "Look who woke up.",
      "And just like that, you're in front.",
    ],
    savage: [
      "And you're in front. Didn't see that coming.",
      "The lead. Enjoy it while it lasts.",
      "You've got the lead. Don't fumble it now.",
    ],
  },

  FALL_BEHIND: {
    // Behind → the selector keeps this gentle regardless of intensity.
    playful: [
      "Don't sweat it — long match ahead.",
      "Shake it off, you've got this.",
      "One slip. It happens. Reset.",
    ],
    savage: [
      "Tactical regrouping. Sure. Let's call it that.",
      "Just a dip. You'll climb back.",
    ],
  },

  BLOWOUT_WINNING: {
    playful: [
      "You're running away with this one.",
      "This is starting to look effortless.",
      "Total control. Nicely done.",
    ],
    savage: [
      "At this point it's just bullying. Carry on.",
      "This stopped being fair a while ago.",
      "This is no longer a contest. It's a lesson.",
    ],
  },

  BLOWOUT_LOSING: {
    // Never goes savage — encouraging only (selector enforces it too).
    playful: [
      "Every expert started somewhere — you're just earlier than most.",
      "Rough round. Happens to everyone.",
      "Still your match to swing. Chin up.",
    ],
    savage: [
      "Plenty of game left. Stay with me.",
      "Comebacks make the best stories.",
    ],
  },

  WIN: {
    playful: [
      "Winner! Genuinely well played.",
      "Champion — you earned every bit of that.",
      "That's the match. Beautifully done.",
    ],
    savage: [
      "Winner! You were brilliant out there.",
      "Champion! What a performance.",
      "You did it — and you made it look easy.",
    ],
  },

  LOSS: {
    playful: [
      "Tough one — you gave it a real fight.",
      "So close. You'll get the next one.",
      "Not your match — the next one's yours.",
    ],
    savage: [
      "Great effort — closer than the score says.",
      "It's a tough one. You played really well today.",
      "No shame in that one — well fought.",
    ],
  },
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Intensity 0–1: how spicy the host should get.
 *   - even game → ~0.5, climbs as you pull ahead, falls as you fall behind,
 *   - a hot streak nudges it up,
 *   - HARD CAP: if you're behind, intensity is capped low (so a losing player
 *     never gets a Savage line — see the selector, which also refuses Savage
 *     when behind).
 */
export function computeIntensity(snap: GameSnapshot): number {
  const goal = Math.max(snap.winScore, 1);
  const norm = clamp((snap.myScore - snap.oppScore) / goal, -1, 1); // -1..1
  let intensity = 0.5 + norm * 0.5;                                  // 0..1
  intensity += Math.min(Math.max(snap.streak, 0), 3) * 0.08;         // streak bonus
  intensity = clamp(intensity, 0, 1);

  // Behind → keep it gentle. This is the Section-4/6 calibration rule.
  if (snap.myScore < snap.oppScore) intensity = Math.min(intensity, 0.35);
  return intensity;
}

/**
 * Picks lines for the host, calibrating tier by intensity and never repeating a
 * line within a match. Stateful (holds the recently-used set) — one per voice.
 */
export class BattleHostDirector {
  private recent: string[] = [];
  private readonly maxRecent: number = 6;

  /** Reset the no-repeat memory (call at the start of a fresh match). */
  reset(): void {
    this.recent = [];
  }

  /**
   * The line to speak for an event, or null if the bank has nothing for it.
   * Returns the chosen text and the intensity it was selected at (handy for
   * logging / vocal-energy hints).
   */
  lineFor(event: BattleEvent, snap: GameSnapshot): { text: string; intensity: number } | null {
    const bank = LINE_BANK[event];
    if (!bank) return null;

    const intensity = computeIntensity(snap);
    const behind = snap.myScore < snap.oppScore;

    // Savage only when spicy AND not behind (losing players are never roasted).
    const useSavage = intensity >= SAVAGE_THRESHOLD && !behind && bank.savage.length > 0;
    let pool = useSavage ? bank.savage : bank.playful;
    if (pool.length === 0) pool = bank.playful.length > 0 ? bank.playful : bank.savage;

    const text = this.pickFresh(pool);
    if (!text) return null;
    return { text, intensity };
  }

  /** Choose a line not used recently; if the pool is exhausted, avoid at least
   *  the immediately previous line so we never say the same thing twice in a row. */
  private pickFresh(pool: string[]): string | null {
    if (pool.length === 0) return null;
    const last = this.recent.length > 0 ? this.recent[this.recent.length - 1] : null;

    let candidates = pool.filter((l) => this.recent.indexOf(l) < 0);
    if (candidates.length === 0) candidates = pool.filter((l) => l !== last);
    if (candidates.length === 0) candidates = pool;

    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    this.remember(choice);
    return choice;
  }

  private remember(line: string): void {
    this.recent.push(line);
    while (this.recent.length > this.maxRecent) this.recent.shift();
  }
}
