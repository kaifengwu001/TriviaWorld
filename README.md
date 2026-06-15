# CurioCity

**The world is your classroom.** CurioCity is a Snap **Spectacles** AR lens, built in **Lens Studio**, that turns everyday surroundings into a personal, social, AI-powered learning experience. Pick what you're curious about, capture anything in front of you with a gesture, and an AI companion named **Momo** turns it into a trivia "card" tied to your interests. Discover what others have left in the world around you, revisit everything on an interactive globe and in flashcard decks, and challenge a friend to a sassy AI-hosted trivia battle built from the cards you've collected.

CurioCity is the product of merging a world-discovery + conversational-voice lens with a card-based multiplayer trivia game. It has been known during development as *TriviaWorld* / *TriviaGo*; **CurioCity** is the current title.

> **One model backend.** Everything model-powered runs through the **Remote Service Gateway (RSG)** — no Internet Access capability or on-device API keys. Momo and the battle host speak on **Gemini Live**; image understanding and battle-question generation use **OpenAI** (vision + gpt-4o). Trivia questions are **card-driven** (baked for the premade deck, generated on demand for captured cards), each carrying its own roast and praise.

---

## The three pillars

### I — Capture & learn

On launch, Momo greets you by voice and helps you choose interests (or you tap them on a honeycomb panel). A **two-hand pinch-and-pan** crops whatever's in front of you; an OpenAI vision model captions it into a short, surprising factoid framed through your chosen interests, ending in a topic hashtag. The card's border flows a rainbow while Momo is "thinking," then eases to the topic's color once the subject is known. You can then talk to Momo about any card to ask follow-ups or edit its text by voice.

### II — Explore & remember

Everything is location-based and meant to be shared. A **prayer/clap gesture** "discovers the world": a Death-Stranding-style ping scan sweeps your space and reveals a cosmos of cards left by you and others, popping into being on the wavefront. Gaze at one to expand it; like, comment (which hands the card to Momo), share, or delete it. Pull up an **interactive Earth globe** to see where your cards came from — select a city and the globe *dives*, becoming a pannable, multi-resolution holodeck street map. Browse everything as **flashcard decks**, or just ask Momo by voice ("find my cards from Tokyo about botany") and let it fly the globe there and fan the matches into a CoverFlow deck.

### III — Battle

Two players go head-to-head in a trivia battle built from their **merged card pools**. A sassy, audio-only AI game-show host reads each question aloud and reacts to your play — easing off when you're losing, getting spicier when you're ahead. Classic game-show rules: the faster player answers first; a correct answer scores and skips to the next question; a wrong answer loses points and hands the opponent a chance; then the correct answer is revealed.

---

## System architecture

CurioCity is many subsystems that mostly coordinate through a set of `global.*` singletons, so prefab-instantiated objects can reach shared state without scene wiring.

### Global singletons

| Global | Owner | Purpose |
|---|---|---|
| `global.cropInterestStore` | `InterestStore` | Session-scoped selected interest topics. |
| `global.cropCardStore` | `CardStore` | Every card in memory — premade seed + this session's captures. |
| `global.hostVoice` | `WelcomeVoice` | Momo's welcome session; other voices poll it so they never open a competing RSG session. |
| `global.nudgeVoice` | `NudgeVoice` | The lazy gesture-reminder narrator. |
| `global.topicPanel` | `TopicSelectionPanel` | The launch topic picker (driven by the host's tools). |
| `global.recommendationCards` | `RecommendationCards` | The post-onboarding "places for you" cards + AR arrow. |
| `global.recommendationVoiceAgent` | `RecommendationVoiceAgent` | Voice that presents/selects the recommendation cards. |
| `global.cardVoiceAgent` | `CardVoiceAgent` | Conversational agent for a single card (with voice editing). |
| `global.cardQueryVoiceAgent` | `CardQueryVoiceAgent` | Voice search over the card cosmos. |
| `global.agentSphere` | `AgentSphere` | Momo's audio envelope + visual orb. |
| `global.agentSubtitle` | `AgentSubtitle` | Live, typed-out captions of Momo's speech. |
| `global.battleHostVoice` | `BattleHostVoice` | The Battle game-show host. |
| `global.worldDiscovered` | `PrayerGestureBehavior` | Set true on first discovery; suppresses the nudge. |
| `global.globeController` | `GlobeController` | The globe/map state machine; driven by the query agent. |
| `global.sceneSwitcher` | `SceneSwitcherPanel` | Radio-style scene/group toggling. |

### Voices & Momo's presence (Gemini Live via RSG)

All conversational agents connect to **Gemini Live through RSG**. Generated speech streams back as **24 kHz PCM** through a `DynamicAudioOutput` (each voice gets its own to avoid conflicts); mic input flows through one **shared** `MicrophoneAudioProvider`. Because the gateway keeps **only the newest live session alive**, the voices hand the single slot between each other rather than running at once.

| Script | Role |
|---|---|
| `WelcomeVoice` | Momo's two-way welcome host: generates a greeting, listens, and calls the topic tools to pick interests / start. Persona is pinned in code to keep it "Momo," never "Gemini." |
| `NudgeVoice` | Audio-only narrator that lazily connects ~60 s in to remind you of the discovery gesture, then disconnects; suppressed once the world is discovered. |
| `RecommendationVoiceAgent` | After Start, takes the slot from the host to present the three recommendation cards and select one by voice. |
| `CardVoiceAgent` + `CardEditTools` | Conversational agent for the card you're looking at; `CardEditTools` holds the Gemini-free tool declarations + exact text transforms for voice caption editing. |
| `CardQueryVoiceAgent` + `QueryOrchestrator` | Voice search over the cosmos; the orchestrator (Gemini-free) filters `CardStore`, drives the cosmos `CardDeckController`, and steers the globe through a per-frame intent state machine. |
| `TopicAgentTools` | The deterministic, Gemini-free `select_topics` / `deselect_topics` / `start_exploring` declarations + dispatch that drive `TopicSelectionPanel`. |
| `VoiceBargeIn` | Shared interruption handling: on a Gemini interrupt it flushes buffered playback and silences the orb so Momo stops mid-sentence. |
| `MicHealth` | Recovers and arbitrates the single shared mic (`safeStartRecording` cycles stop→start, `acquireMic` claims it exclusively, a watchdog re-cycles a dead provider with backoff). |
| `AgentSphere` | `global.agentSphere`: schedules PCM frames by real playback time so the envelope tracks audible speech; positions the orb in the FoV; exposes `getAudioLevel()` / `interruptAudio()`. |
| `AgentRing` + `AgentNoiseDisc` | The orb's "agent ring": three additive Perlin-distorted CMY rings that bloom colored fringes with loudness, plus idle-animated eyes (see `AgentVisual/README.md`). |
| `AgentSubtitle` | `global.agentSubtitle`: a world-space caption that types out in sync with the voice, two-line row-rolling, placed beside the orb or under the active card. |

### Capture pipeline

| Script | Responsibility |
|---|---|
| `CameraService` | Camera access for capture. |
| `CropRegion` / `PictureController` | The two-hand crop selection and capture orchestration. |
| `PictureBehavior` | A captured card's lifecycle (crop → AI caption → topic); `getResolvedTopics()` returns `null` (capturing), `[]` (undecidable), or `[topic, …]`. |
| `ChatGPT` | OpenAI vision captioning: image → one–two sentences of trivia + a `#hashtag` line. |
| `CaptionBehavior` / `TypewriterText` | Lays caption text under the picture and types/edits it (delete-then-type diffs, keeping the hashtag suffix fixed). |
| `CardBackdrop` / `CardBackdropController` / `PlaneRect` | The rounded-rect card border: flowing rainbow while capturing → cross-fade to topic color (or white). See `CardBackdrop/README.md` for the shader graph. |

### Interests & topics

`TopicSelectionPanel` builds a honeycomb of Spectacles-UI-Kit capsule buttons and commits the selection to `InterestStore` (`global.cropInterestStore`). `InterestTopics` holds the preset `DEFAULT_TOPICS` — Art History, Chemistry, Biology, Botany, Physics, Space, Music, History, Food, Design, Trains, Aviation, XR. `TopicColors` is the single source of truth for topic→color (stable hashed fallback for unknown topics); `TopicFromText` maps a caption's first hashtag back to a preset topic.

### Recommendations

After Start, `RecommendationCards` (`global.recommendationCards`) flies in three `PremadeCard` sneak-peeks of nearby places to visit; selecting one (by pinch or via `RecommendationVoiceAgent`) eases it to center, dissipates the rest, and spawns a **head-locked AR arrow** that points toward a world-fixed heading with a distance readout, then fades.

### Discovery & cards in the world

| Script | Responsibility |
|---|---|
| `PrayerGestureBehavior` | Detects the palms-together pose, sets `global.worldDiscovered`, fires the ping. |
| `PingController` | Expanding spherical "ping" shells via a graph shader on the World Mesh (`pingData`, `pingBrightness`, `bandThickness`, `trailLength`, `trailFalloff`, `maxRadius`, `pingColor`); cm units. |
| `WorldMeshFallback` | Ping renders on live World Mesh, or a ground-plane quad when reconstruction isn't available. |
| `PingCardSpawner` | Reveals location-filtered `PremadeCard`s exactly as the wavefront reaches each (reveal time = distance ÷ ping speed); cards open on gaze. |
| `Bubbles/*` | The morph system every card and the agent ring build on: `BubbleMesh` (blob↔rounded-rect Perlin morph), `BubbleMeshBuilder` (hollow-band mesh), `ShapeGeometry`, `PerlinNoise`, `BubbleField`. |
| `PremadeCard/*` | The card visual: `PremadeCard` (image + caption inside a morphing bubble border), `CardCaption` (text layout), `CardMorph` (pure 0→1 morph timeline). |
| `CardButtons/*` | The per-card social rail — profile / like / comment / share / delete — with `ShareDrawer` (share-to row), `CardButtonFactory`, and `CardButtonHost` (adapts captured vs premade cards). "Comment" engages Momo on that card. |

### Cards, cosmos & query

`CardStore` (`global.cropCardStore`) holds every card — the premade seed and this session's captures. `cardDeckData` authors the **37 premade "cosmos" cards** (20 Tokyo + 17 Seattle), each with real trivia text, topics, location, and date. `CardDeckController` spawns the cosmos as a head-wrapping cylinder of always-expanded cards laid out by relevance, folds captured cards in as the store grows, and — in query mode — fans matches into an iPod-style CoverFlow deck you scrub through.

### Interactive globe → city map

A guided state machine takes you from a full Earth globe to a pannable street map and back: **OVERVIEW → ZOOMING_IN → DOCKED (L0..Ln) → ZOOMING_OUT → OVERVIEW**, math-aligned so the globe→table handoff matches by construction.

| Script | Responsibility |
|---|---|
| `GlobeController` | The state machine + input router (SIK pinch-select / one-hand pan / two-hand zoom, plus touch). Drives the "dive" where the globe rotates a city up, slides it onto the table center, scales until its footprint matches the table, and fades out. Exposes `focusCityByName()` for the query agent. |
| `GlobeView` | Rotate-to-aim / scale-to-zoom Earth sphere, per-channel pose tweening, self-righting spring, material-clone fading. |
| `MapViewport` | The holodeck table: UV pan/zoom under a fixed feathered crop, dual-sampler LOD crossfades, live dive-handoff framing. Material graph exposes `mapTex` / `uvOffset` / `uvScale`. |
| `CityData` + `cityBounds` (`.json` → generated `.ts`) | Binds per-city LOD bounds to imported textures. Ships **Tokyo, Seattle, Los Angeles**, each L0 (0.45°) / L1 (0.14°) / L2 (0.045°) plus a wide L-1 (4.5°) dive-handoff capture. |
| `CityMarker` / `CardMarkerLayer` | Invisible per-city selection targets, and the visible textured markers — one per `CardStore` card, scattered around its city, merged when close, clipped to the table circle, re-mapped onto whichever surface is showing. |
| `CardGeo` / `GeoMath` | Pure, engine-free math (trivially testable): UV ↔ sphere, easing, bounds↔UV, footprint matching; deterministic id-seeded scatter, on-land rejection sampling (`waterMask`), and in-scene clustering that never merges across cities. |
| `GpsPingLayer` | A surface-aligned GPS icon (default Los Angeles) that tracks the globe/table like the markers do. |
| `PinchDragTracker` | Jitter-filtered drag deltas (wraps SIK's `OneEuroFilter`). |

Street imagery is **baked offline** by `tools/generate_map_textures.py` from OpenStreetMap tiles; that tool is the single source of truth for `cityBounds.json` (and the generated `cityBounds.ts` mirror), so capture framing can't drift from in-lens alignment.

### Battle mode

Battle questions come from **your cards**, and each question carries its own `roast` (spoken on a miss) and `praise` (spoken on a correct answer):

| Source | Script | How |
|---|---|---|
| Premade "cosmos" deck (37 fixed cards) | `PremadeQuestions.ts` | Authored once and baked in — instant, free, reliable; correct-answer slots are varied so players can't pattern-match. |
| Captured cards (user-specific) | `BattleQuestionGenerator.ts` | One **OpenAI gpt-4o** call per batch of 8 turns each card's fact into a 4-option question + inline roast + praise; malformed entries are dropped, not fatal. |

The host is `BattleHostVoice` (`global.battleHostVoice`): an audio-only Gemini Live narrator — **per-device and unsynced**, so each player hears commentary about *their* play. It reads the question aloud, cuts the read the instant the local player buzzes, and speaks calibrated reactions plus the per-question roast/praise. It is **generation-free**: it sends each exact line wrapped in a `SAY:` marker at `temperature: 0` and tells the model to read it verbatim — which both enforces the guardrails and stops the Live model from chatting back. Its "brain," `BattleHostLines`, is a Gemini-free curated line bank (sassy quiz-show persona) with intensity calibration (`computeIntensity`), a no-repeat rotation, and guardrails baked into the data and selector: lines are short, never profane, and a player who is **behind is never roasted**.

**Game-show rules (per the design doc):** an energetic host reads each question; both players race to answer; the faster player answers first; a correct answer scores and immediately advances (with a short timer bump); a wrong answer loses points and gives the opponent a chance; after the opponent answers, the correct answer is revealed to both, then the next question loads.

**The session manager — `MultiplayerTriviaManager`.** The two-player match is orchestrated by **`MultiplayerTriviaManager`**, built on **SpectaclesSyncKit**. A single host-owned `SyncEntity` plus the `SessionController` carry shared state, and the host is authoritative. On match start the host builds the question queue from both players' merged card pools, interleaving each player's questions round-robin. Buzzes travel guest→host via `session.sendMessage`; the host opens a short grace window after the first buzz so a slightly-later-arriving but earlier press isn't dropped to network latency, then scores authoritatively and advances. Both devices subscribe to `onMessageReceived`, so each reacts to the result locally.

---

## Data sources

- **Remote Service Gateway (RSG)** — the only model backend. It carries **Gemini Live** (Momo and the battle host), **OpenAI vision** (`ChatGPT` captioning), and **OpenAI gpt-4o** (`BattleQuestionGenerator`), plus Snap services. Tokens live in `Assets/Scene.scene` and are scrubbed on commit (see Setup).
- **Card deck** — the source of all Battle questions: baked (`PremadeQuestions.ts`) for the 37 cosmos cards, runtime-generated for captured cards. Each question carries its own roast and praise.
- **OpenStreetMap** — map tiles consumed **offline** by `tools/generate_map_textures.py`; not fetched at runtime.

### Battle question format

Both baked and generated questions share one shape (the manager assigns the `id` at queue-assembly time):

```json
{
  "question": "What famous statue gets its green color from the same process that greens old copper roofs?",
  "option1": "Michelangelo's David",
  "option2": "The Lincoln Memorial",
  "option3": "The Statue of Liberty",
  "option4": "Mount Rushmore",
  "optionCount": 4,
  "answer": 3,
  "roast": "Green with envy at the folks who got that one?",
  "praise": "Correct — you've got an eye for green."
}
```

`answer` is the 1-based index of the correct option. `BattleQuestionGenerator` requests this JSON from gpt-4o (one call per batch of 8 cards) and drops malformed entries; `PremadeQuestions` ships the same shape pre-authored.

---

## Setup

### Clone (Git LFS)

The full project uses [Git LFS](https://git-lfs.com) for binary assets and packages. Install it before cloning:

```bash
git lfs install
git clone <repo-url>
```

### RSG credentials (important)

`RemoteServiceGatewayCredentials` stores its API tokens (OpenAI, Google, Snap) inline in `Assets/Scene.scene`. A **git clean filter** replaces the token values with placeholders on every commit while your local copy keeps the real ones. The filter is declared in `.gitattributes` but configured in `.git/config` (not part of the repo), so after cloning run once:

```bash
git config filter.rsgtokens.clean ".gitfilters/scrub-rsg-tokens.sh"
git config filter.rsgtokens.smudge cat
```

> ⚠️ Commit `Assets/Scene.scene` **without** the filter configured and your real tokens go in as plaintext.

Then open the project, select `RemoteServiceGatewayCredentials`, and paste your own tokens (OpenAI + Google/Gemini + Snap) into the inspector.

### Prerequisites

- [Lens Studio](https://ar.snap.com/lens-studio) with Spectacles support
- SpectaclesInteractionKit (SIK) + Spectacles UI Kit + RemoteServiceGateway + SpectaclesSyncKit (the multiplayer Battle manager runs on SyncKit)
- RSG credentials for OpenAI (vision + gpt-4o) + Google (Gemini Live) + Snap
- A separate `DynamicAudioOutput` per voice (welcome / nudge / recommendation / card / query / battle host) to avoid audio conflicts
- Python 3 (only to regenerate map textures)

### Regenerating map textures

```bash
python tools/generate_map_textures.py
```

`cityBounds.json` is the single source of truth; the tool re-bakes the per-city LOD PNGs from OpenStreetMap tiles and rewrites the generated `cityBounds.ts`. Hand-edit the JSON and re-run the tool rather than editing the `.ts`. Assign the generated PNGs to the per-city texture arrays on `CityData` (L0..Ln order, plus the wide L-1 handoff capture).

### Component setup references

- **Agent ring visuals** — `Scripts/AgentVisual/README.md`.
- **Card border shader** — `Scripts/CardBackdrop/README.md` (exposes `baseColor` + `reveal`).
- **Bubble morph system** — `Scripts/Bubbles/README.md`.
- **Globe/map** — `Scripts/Globe/README.md` (LOD bounds, dive handoff, map material graph).
- **Battle host** — needs the shared *Websocket requirements* object and its own `DynamicAudioOutput`; pick a voice (Charon, Puck, …). `BattleQuestionGenerator` only needs the OpenAI RSG token (same as `ChatGPT`).

### On-device only

Gemini Live runs over a gateway WebSocket and **does not work in the Lens Studio simulator**. Use Preview with a device (Device Type Override = Spectacles) or run on Spectacles, online. For two-player testing across different Snapchat accounts, set the same **Developer Settings → Skip Session Selection** password on both devices.

---

## Project structure

```
Scripts/
  CameraService.ts, CropRegion.ts, PictureController.ts,
    PictureBehavior.ts, CaptionBehavior.ts, TypewriterText.ts,
    ChatGPT.ts, APIKeyHint.ts        — Capture pipeline + vision captioning
  WelcomeVoice.ts, NudgeVoice.ts, CardVoiceAgent.ts,
    VoiceBargeIn.ts, MicHealth.ts, AudioLevel.ts, AgentSphere.ts  — Momo voice stack
  AgentVisual/   — AgentRing, AgentNoiseDisc, AgentSubtitle (+ README)
  Bubbles/       — BubbleMesh, BubbleMeshBuilder, ShapeGeometry, PerlinNoise, BubbleField (+ README)
  PremadeCard/   — PremadeCard, CardCaption, CardMorph
  CardBackdrop/  — CardBackdrop, CardBackdropController, PlaneRect (+ README)
  CardButtons/   — CardActionButtons(+Controller), CardButtonFactory, CardButtonHost, ShareDrawer
  Cards/         — CardStore, CardDeckController, CardQueryVoiceAgent,
                   QueryOrchestrator, CardEditTools, cardDeckData
  Interests/     — InterestStore, InterestTopics, TopicSelectionPanel,
                   TopicAgentTools, TopicColors, TopicFromText
  Recommendations/ — RecommendationCards, RecommendationVoiceAgent
  PrayerGestureBehavior.ts, PingController.ts, WorldMeshFallback.ts  — World discovery
  PingSpawner/   — PingCardSpawner
  Globe/         — GlobeController, GlobeView, MapViewport, CityData, cityBounds(.json/.ts),
                   CityMarker, CardMarkerLayer, CardGeo, GeoMath, GpsPingLayer,
                   PinchDragTracker, waterMask (+ README)
  Battle/        — MultiplayerTriviaManager, BattleHostVoice, BattleHostLines,
                   BattleQuestionGenerator, PremadeQuestions
  SceneSwitcher/ — SceneSwitcherPanel
tools/generate_map_textures.py   — Offline map-texture + cityBounds generator
```

*(The full repo also contains `Assets/Scene.scene`, `Packages/`, `.gitfilters/`, and the RSG token-scrubbing config described under Setup.)*

---

## Lessons learned

**RSG keeps only the newest session alive.** Two simultaneous Gemini Live sessions blank the device, so the voices enforce a single live session and hand the slot off explicitly (`suspend()` / `engage()`), polling each other's `isActive()` before connecting.

**The shared mic is destructive and can latch dead.** Every recorder points at one `MicrophoneAudioProvider`; `getAudioFrame()` drains the frame, and a failed `start()` near launch can leave the provider "started-but-dead." Always cycle stop→start, acquire exclusively, and watchdog-recover.

**Drive the audio envelope by playback time, not frame arrival.** Gemini bursts seconds of PCM up front; scheduling frames by their real playback duration keeps the orb (and subtitle reveal) synced to what's audible.

**To make a Live model *read* instead of *chat*, command it.** Sending a line as a plain user turn made Gemini reply to it. Wrapping each line in a `SAY:` marker at `temperature: 0` with a strict "perform this verbatim" instruction turns it into a faithful TTS performer with the guardrails intact.

**Separate the "brain" from the "voice."** `BattleHostLines`, `TopicAgentTools`, `QueryOrchestrator`, and `CardEditTools` hold the deterministic, model-free logic; the agent components own only the live session. The logic stays trivially testable and the agents stay about the session.

**Bake what never changes; generate only what's personal.** The 37 fixed cosmos cards ship pre-authored questions (instant, free, reliable); only user-captured cards pay for an OpenAI call — same question shape either way.

**Clone materials before modifying them.** The globe, map, card borders, bubbles, and agent ring all clone their base material and override color/alpha/blend on the clone, so shared assets are never mutated.

**Keep placement math pure and deterministic.** `GeoMath` / `CardGeo` / `ShapeGeometry` / `CardMorph` have no engine dependencies, and every card scatter is seeded by the card id — so markers are testable and never drift between frames, zooms, or sessions.

**Match the globe→table handoff by footprint span.** The dive aligns the globe and the flat map by making their on-screen footprints equal at the crossover, so the swap reads as detail sharpening rather than a jump.

---

## Credits

CurioCity (working titles *TriviaWorld* / *TriviaGo*) is a Spectacles + Spatial-AI learning experience. Source headers are marked "Specs Inc. 2026."
