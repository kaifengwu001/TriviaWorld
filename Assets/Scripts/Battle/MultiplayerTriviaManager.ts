/**
 * MultiplayerTriviaManager.ts — v3.0
 *
 * Changes from v2.9:
 *   - Option buttons are now tinted green/red (adjustable RGBA inputs) using the
 *     SAME flow as the text markers: a pick tints its button the instant it's
 *     made, on both devices (green if correct, red if wrong — including a wrong
 *     pick while a steal is still open).
 *   - When BOTH players miss, the correct answer's button is additionally
 *     revealed in green (button tint only, no text marker).
 *   - Button tints are snapshotted on first use and restored each new round.
 *
 * Changes from v2.8:
 *   - Answer markers now appear the MOMENT a player commits a pick (published via
 *     a new synced `livePicks` prop), so a wrong answer is marked on BOTH devices
 *     while the steal window is still open — not only at round conclusion. A
 *     correct answer behaves the same as before (mark, reveal, next round).
 *   - Marker layout changed: markers are now centered horizontally on their option
 *     button and stacked vertically — the local player's ("Me") marker sits above
 *     the button, the opponent's below — so both stay readable even when both
 *     players pick the same option.
 *
 * Changes from v2.7:
 *   - The Ready button no longer disappears the instant you tap it. Tapping it
 *     now swaps it for a separate "waiting" button (set up in the inspector with
 *     the Primary style and a "Waiting for Opponent" label, same size/position).
 *     That waiting button stays on screen until BOTH players are ready, then both
 *     buttons go away as the countdown begins. (UIKit button styles are applied
 *     via protected, gradient-based state — not settable at runtime — so a second
 *     pre-styled button is swapped in instead of restyling the original.)
 *
 * Changes from v2.6:
 *   - Sync store is now created UNOWNED (claimOwnership=false). Previously the
 *     store was owned by whichever client created it first — a race unrelated to
 *     the session host. When the guest won that race, the host could not write
 *     the store, so host-authoritative updates (e.g. the ready count) silently
 *     failed to reach the guest. Unowned lets the host's writes always propagate.
 *
 * Changes from v2.5:
 *   - Answer markers are now created by the script at runtime (no Text inputs).
 *     They are parented to the chosen option button at conclusion.
 *   - Race fairness / state fixes:
 *       • Buzz timestamps use the SERVER clock (getServerTimeInSeconds) so the
 *         two devices are actually comparable (was Date.now() per device).
 *       • The host waits a short grace window after the first buzz so a slightly
 *         later-arriving but earlier buzz isn't dropped due to network latency.
 *       • The round conclusion (winner + both picks) is published in a SINGLE
 *         synced prop (roundResult) and rendered from that one change. This fixes
 *         the bug where both players briefly saw "Too slow!" because the separate
 *         choice props hadn't synced when the REVEAL state arrived.
 *
 * Changes from v2.4:
 *   - Removed the per-question timer. A question no longer expires: it ends only
 *     when one player answers correctly OR both players answer wrong. The PAUSED
 *     state and GUEST_RESUME flow are gone.
 *   - Per-player response feedback. The response label now shows phrases from
 *     each player's own perspective (e.g. "Too slow!", "They whiffed — steal it!",
 *     "Nailed it!") instead of a shared correct/incorrect label.
 *   - Answer markers. After a question concludes, each player's pick is marked
 *     next to its option button: "Me" / "Opponent" in green (correct) or red
 *     (wrong). Offset (x/y/z) and text size are configurable.
 *   - Question text + answer buttons are hidden during the lobby/countdown and
 *     only appear once a question loads.
 *   - Configurable win score. The game ends and declares a winner when a score
 *     reaches the goal. "Matchpoint!" is shown when a player is one correct
 *     answer from winning.
 *
 * Changes from v2.3:
 *   - Deterministic game start: a LOBBY phase with a "Ready" button and an
 *     "X/2 Ready" status replaces the old race-prone host auto-start. The first
 *     question is only fetched once BOTH players have confirmed ready, which
 *     guarantees both devices are joined + subscribed before jsonQuestion syncs
 *     (fixes the empty / stuck first-question bug when the 2nd player joins).
 *   - Once 2/2 ready, host drives a synced 3-2-1 countdown (large centered text)
 *     and loads the first round for both devices at 0.
 *   - New synced props: gamePhase (LOBBY/COUNTDOWN/ACTIVE), readyCount,
 *     countdownStartToken. New message: GUEST_READY (guest → host).
 *   - Answer buttons are gated to the ACTIVE phase.
 *
 * Changes from v2.2:
 *   - Fixed roast display for guest: host now sends MSG_HOST_ROAST message to guest
 *     after a wrong answer, so each device fetches and shows its own roast locally
 *   - Both devices subscribe to onMessageReceived (was host-only before)
 *   - Host handles: GUEST_BUZZ, GUEST_RESUME
 *   - Guest handles: HOST_ROAST
 */

import { SessionController }  from 'SpectaclesSyncKit.lspkg/Core/SessionController'
import { SyncEntity }         from 'SpectaclesSyncKit.lspkg/Core/SyncEntity'
import { StorageProperty }    from 'SpectaclesSyncKit.lspkg/Core/StorageProperty'
import { StoragePropertySet } from 'SpectaclesSyncKit.lspkg/Core/StoragePropertySet'
// BaseButton is the abstract base of RectangleButton, RoundButton, CapsuleButton
// (and any other UIKit button). Typing the inputs as BaseButton lets the manager
// accept any button variant — they all expose onTriggerUp + getSceneObject().
import { BaseButton }          from 'SpectaclesUIKit.lspkg/Scripts/Components/Button/BaseButton'
// Sassy host types only (pure, Gemini-free module — safe to import here). The
// BattleHostVoice component itself is reached via an `any` accessor (like the
// roast fetcher) so this manager never pulls in the Gemini/live-session deps.
import { BattleEvent, GameSnapshot } from './BattleHostLines'
// Premade-card questions are baked ahead of time (the deck cards never change),
// so the only runtime LLM calls are for user-specific CAPTURED cards.
import { PREMADE_QUESTIONS } from './PremadeQuestions'
// Used to tint the option buttons green/red at runtime. UIKit buttons render
// their background via gradients (baseType "Gradient"), so solid color setters
// are ignored — a flat (single-hue) gradient is assigned to the visual states
// instead, mirroring the approach in TopicSelectionPanel.ts.
import { RoundedRectangleVisual, BaseType } from 'SpectaclesUIKit.lspkg/Scripts/Visuals/RoundedRectangle/RoundedRectangleVisual'
import { GradientParameters }  from 'SpectaclesUIKit.lspkg/Scripts/Visuals/RoundedRectangle/RoundedRectangle'

interface ISnapCloudRequirements {
  isConfigured(): boolean
  getFunctionsApiUrl(): string
  getSupabaseHeaders(): { [key: string]: string }
}

// Snapshot of a button visual's original (theme) gradients for the resting
// states, so a runtime tint can be undone exactly when the next round starts.
interface ButtonVisualSnapshot {
  defaultBaseType: BaseType
  hoveredBaseType: BaseType
  triggeredBaseType: BaseType
  defaultGradient: GradientParameters
  hoveredGradient: GradientParameters
  triggeredGradient: GradientParameters
}

interface TriviaRecord {
  id: number
  question: string
  option1: string
  option2: string
  option3: string
  option4: string
  optionCount: number
  answer: number
  // Short host lines carried inline in the synced JSON so both devices have them:
  // `roast` is spoken on a wrong answer, `praise` on a correct one. Absent on
  // emergency Supabase rows (the curated host bank covers those).
  roast?: string
  praise?: string
}

const MSG_GUEST_BUZZ   = 'GUEST_BUZZ'    // guest → host: "GUEST_BUZZ:timestamp:optionIndex"
const MSG_HOST_ROAST   = 'HOST_ROAST'    // host → guest: "HOST_ROAST:questionId:inline" (show synced inline roast)
const MSG_GUEST_READY  = 'GUEST_READY'   // guest → host: guest tapped the Ready button
// Guest → host: ships one of the guest's card-generated questions during the
// pre-game window. "QADD:<questionJson>" per question, then "QDONE" when finished.
const MSG_Q_ADD        = 'QADD'
const MSG_Q_DONE       = 'QDONE'

// Game lifecycle phases (synced via gamePhaseProp)
const PHASE_LOBBY     = 'LOBBY'      // waiting for both players to ready up
const PHASE_COUNTDOWN = 'COUNTDOWN'  // 3-2-1 before first question
const PHASE_ACTIVE    = 'ACTIVE'     // normal round play
const PHASE_GAMEOVER  = 'GAMEOVER'   // a player reached the win score

// Per-player response phrases — short and punchy. Tweak freely to taste.
const SAY_RACE         = 'Buzz in — first to answer wins!'
const SAY_STEAL_YOURS  = 'They whiffed — steal it!'
const SAY_OPP_STEALING = 'Ouch! Opponent gets a shot…'
const SAY_WIN_ROUND    = 'Nailed it!'
const SAY_ROBBED       = 'Robbed! They stole it.'
const SAY_TOO_SLOW     = 'Too slow!'
const SAY_BOTH_WRONG   = 'Nobody got it!'
const SAY_MATCH_ME     = 'Matchpoint — win it!'
const SAY_MATCH_OPP    = 'Matchpoint — defend!'
const SAY_MATCH_BOTH   = 'Matchpoint!'
const SAY_GAME_WIN     = 'You win!'
const SAY_GAME_LOSE    = 'You lose!'

@component
export class MultiplayerTriviaManager extends BaseScriptComponent {

  private internetModule: InternetModule = require('LensStudio:InternetModule')

  @input('Component.ScriptComponent') public snapCloudRequirements: ScriptComponent
  @input public functionName: string = ''
  @input public object:  string = ''
  @input public topic:   string = ''

  @input public questionText: Text
  @input public optionButton1: BaseButton
  @input public optionButton2: BaseButton
  @input public optionButton3: BaseButton
  @input public optionButton4: BaseButton
  @input public optionButtonChildTextName: string = ''

  @input public correctText:   Text
  @input public incorrectText: Text
  @input public myScoreValueText: Text
  @input public statusText: Text | null = null

  @input
  @hint("Per-player response label (e.g. 'Too slow!', 'Nailed it!', 'Matchpoint!')")
  public responseText: Text | null = null

  // ── Answer markers (script-created, shown the moment a pick is made) ────────
  @input
  @hint("Marker offset from its option button center. X centers the marker (0 = dead center); |Y| is the vertical gap — self sits above (+Y), opponent below (−Y).")
  public answerMarkerOffset: vec3 = new vec3(0, 6, 0)

  @input
  @hint("Font size for the answer markers")
  public answerMarkerTextSize: number = 32

  @input
  @hint("Button tint (RGBA) for a correct pick — also reveals the answer when both players miss")
  public correctButtonColor: vec4 = new vec4(0.25, 0.85, 0.35, 1.0)

  @input
  @hint("Button tint (RGBA) for a wrong pick")
  public incorrectButtonColor: vec4 = new vec4(0.95, 0.30, 0.30, 1.0)

  // ── Lobby / start coordination ─────────────────────────────────────────────
  @input
  @hint("Button players tap to mark themselves ready in the lobby")
  public readyButton: BaseButton | null = null

  @input
  @hint("Shown after THIS player readies up (style it Primary, label it 'Waiting for Opponent', same size/position as the Ready button). Hidden until ready, removed once both are ready.")
  public waitingButton: BaseButton | null = null

  @input
  @hint("Text showing how many players are ready, e.g. '1/2 Ready'")
  public readyStatusText: Text | null = null

  @input
  @hint("Large, centered Text used for the 3-2-1 start countdown")
  public countdownText: Text | null = null

  @input
  @hint("Optional on-screen debug readout (role, phase, sync/store state)")
  public debugText: Text | null = null

  @input public opponentScoreValueText: Text
  @input public timerText: Text
  @input public nextRoundDelaySeconds: number = 5

  @input
  @hint("Score needed to win the game")
  public winScore: number = 30

  @input public enableDebugLogs: boolean = true

  // ── Roast display ─────────────────────────────────────────────────────────
  @input
  @hint("Text component to display the roast message on screen")
  public roastText: Text | null = null

  // ── Sassy host voice (optional) ───────────────────────────────────────────
  @input('Component.ScriptComponent')
  @hint("BattleHostVoice script component — speaks the trivia-host reactions. Optional; the game runs fine without it.")
  public battleHostComponent: ScriptComponent

  // ── Card-driven question generator ────────────────────────────────────────
  @input('Component.ScriptComponent')
  @hint("BattleQuestionGenerator script component — turns each player's cards into fun trivia. If unassigned, falls back to the Supabase question fetch.")
  public questionGeneratorComponent: ScriptComponent

  // ── SyncEntity ────────────────────────────────────────────────────────────
  private gameSyncEntity: SyncEntity | null = null

  private jsonQuestionProp        = StorageProperty.manualString('jsonQuestion', '')
  private roundStateProp          = StorageProperty.manualString('roundState', 'PLAYING')
  private currentActiveBuzzerProp = StorageProperty.manualString('currentActiveBuzzer', 'NONE')
  private hostScoreProp           = StorageProperty.manualInt('hostScore', 0)
  private guestScoreProp          = StorageProperty.manualInt('guestScore', 0)
  private hostBuzzedTimeProp      = StorageProperty.manualString('hostBuzzedTime', '')
  private guestBuzzedTimeProp     = StorageProperty.manualString('guestBuzzedTime', '')

  // Conclusion published atomically: "TYPE:hostPick:guestPick"
  //   TYPE ∈ WIN_HOST | WIN_GUEST | BOTH_WRONG   (picks are 1-indexed, -1 = none)
  private roundResultProp         = StorageProperty.manualString('roundResult', '')
  private winnerProp              = StorageProperty.manualString('winner', '')

  // Live picks, published by the host the instant a player commits, so a marker
  // shows on BOTH devices immediately — including a wrong pick made while the
  // steal window is still open. Format: "hostPick:guestPick" (1-indexed, -1=none)
  private livePicksProp           = StorageProperty.manualString('livePicks', '')

  // Lobby / start coordination (host-authoritative)
  private gamePhaseProp           = StorageProperty.manualString('gamePhase', PHASE_LOBBY)
  private readyCountProp          = StorageProperty.manualInt('readyCount', 0)
  private countdownStartTokenProp = StorageProperty.manualString('countdownStartToken', '')

  // ── Local state ───────────────────────────────────────────────────────────
  private correctAnswer: number             = 0
  private currentQuestionId: number         = 0
  private localScore: number                = 0
  private localHasAnsweredPhase: boolean    = false
  private turnProcessed: boolean            = false
  private nextRoundCountdown: number        = 0
  private nextRoundCountdownActive: boolean = false

  // Lobby / start coordination
  private hostReady: boolean                = false
  private guestReady: boolean               = false
  private localReadyDone: boolean           = false
  private hostStartupDone: boolean          = false
  private startCountdown: number            = 0
  private startCountdownActive: boolean     = false

  private readonly START_COUNTDOWN_SECONDS = 3

  // How long (server seconds) the host waits after the first buzz in a race so a
  // slightly later-arriving but earlier buzz isn't dropped to network latency.
  private readonly RACE_GRACE_SECONDS = 0.5

  private readonly REWARD_POINTS  = 10
  private readonly PENALTY_POINTS = 5

  // Host-tracked picks for the current question (1-indexed option, -1 = none)
  private hostPickThisRound: number  = -1
  private guestPickThisRound: number = -1
  private raceDeadline: number       = -1   // server time the host stops waiting

  // Runtime-created answer markers (Text components)
  private meMarker: Text | null  = null
  private oppMarker: Text | null = null

  // Original button visual gradients, captured the first time a button is tinted
  // so the theme look can be restored verbatim each new round (index 0 = option1).
  private optionButtonVisualSnapshots: (ButtonVisualSnapshot | null)[] = [null, null, null, null]

  private optionTexts: (Text | null)[] = [null, null, null, null]
  private isHost: boolean              = false
  private localPlayerId: string        = ''

  // ── Sassy host accessor (any — avoids importing the Gemini-backed component) ─
  private get battleHost(): any {
    return this.battleHostComponent as any
  }

  // ── Question generator accessor (any — keeps the OpenAI import out of here) ──
  private get questionGenerator(): any {
    return this.questionGeneratorComponent as any
  }

  // ── Card-driven question queue (host-assembled, served one per round) ───────
  // Order: recently-captured cards from BOTH players (round-robin interleave)
  // first, then premade-card questions. Built once during the pre-game window.
  private questionQueue: TriviaRecord[] = []
  private queueIndex: number            = 0
  private premadeStartIndex: number     = -1  // where premade questions begin in the queue
  private hostCaptured: TriviaRecord[]  = []  // this host's captured-card questions
  private guestCaptured: TriviaRecord[] = []  // guest's captured-card questions (via QADD)
  private premadeQuestions: TriviaRecord[] = []
  private hostCapturedReady: boolean    = false
  private guestDone: boolean            = false
  private premadeReady: boolean         = false
  private queueAssembled: boolean       = false
  private generationStarted: boolean    = false
  private awaitingQueue: boolean        = false  // a round is waiting for the queue
  private nextSyntheticId: number       = 100000 // AI ids never collide with Supabase ids
  private currentRoast: string          = ''      // inline wrong-answer line for the live question
  private currentPraise: string         = ''      // inline correct-answer line for the live question

  // How many premade-card questions to pre-generate (enough to finish a match).
  private readonly PREMADE_BATCH_COUNT  = 12
  // How long the host waits for slow/silent generation before assembling anyway.
  private readonly QUEUE_ASSEMBLE_DEADLINE_SEC = 8

  // ── Sassy host local state (per-device, local player's perspective) ─────────
  private matchStarted: boolean       = false  // beginMatch() fired once
  private gameOverAnnounced: boolean  = false  // WIN/LOSS spoken once
  private localStreak: number         = 0      // consecutive correct answers
  private lastLeadSign: number        = 0      // -1 behind / 0 even / +1 ahead
  private announcedBlowout: boolean   = false  // blowout called for this streak
  private questionLoadedAt: number    = 0      // getTime() when the question showed
  private localAnswerMs: number       = -1     // ms from show → local buzz (-1 none)
  private localRoastSpokenThisRound: boolean = false // local player already heard its roast

  private readonly FAST_ANSWER_MS       = 2500 // under this = "fast correct"
  private readonly BLOWOUT_GAP          = 20   // score gap that counts as a blowout

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  onAwake() {
    this.cacheOptionChildTextNodes()
    this.setupAnswerButtons()
    this.hideAnswerFeedback()
    this.setStatusText('Connecting…')

    if (this.timerText) this.timerText.text = ''
    if (this.opponentScoreValueText) this.opponentScoreValueText.text = '0'
    if (this.myScoreValueText) this.myScoreValueText.text = '0'
    if (this.roastText) this.roastText.enabled = false

    // Lobby UI: hide the text labels until the session is ready.
    // NOTE: do NOT disable the ready/option button SceneObjects here — UIKit
    // buttons wire up their tap handler in OnStartEvent, which never fires for an
    // object that is disabled at startup. Disabling them now would permanently
    // break onTriggerUp. Their visibility is managed after the session is ready.
    if (this.countdownText) { this.countdownText.enabled = false; this.countdownText.text = '' }
    if (this.readyStatusText) this.readyStatusText.enabled = false
    this.setResponse('')
    this.hideAnswerMarkers()

    // The waiting button must NOT be disabled here (its UIKit visual + handlers
    // only wire up in OnStartEvent, which never fires for an object disabled at
    // startup). Let it initialize this frame, then hide it one frame later.
    this.hideWaitingButtonAfterInit()

    this.createEvent("UpdateEvent").bind(() => this.onUpdate())
    SessionController.getInstance().notifyOnReady(() => this.onSessionReady())
  }

  private onSessionReady() {
    const sc = SessionController.getInstance()
    this.localPlayerId = sc.getLocalUserId() ?? 'localPlayer'
    this.isHost = sc.isHost() === true

    this.log(`Session ready — isHost:${this.isHost} localId:${this.localPlayerId}`)

    const gameNetworkId = { customNetworkId: 'triviaGameState', networkIdType: 'Custom' } as any
    this.gameSyncEntity = new SyncEntity(
      this,
      new StoragePropertySet([
        this.jsonQuestionProp,
        this.roundStateProp,
        this.currentActiveBuzzerProp,
        this.hostScoreProp,
        this.guestScoreProp,
        this.hostBuzzedTimeProp,
        this.guestBuzzedTimeProp,
        this.roundResultProp,
        this.winnerProp,
        this.livePicksProp,
        this.gamePhaseProp,
        this.readyCountProp,
        this.countdownStartTokenProp,
      ]),
      // claimOwnership=false → the store is created UNOWNED. With ownership the
      // store is owned by whichever device creates it first (a race that does NOT
      // track the session host); a non-owning host can't write, so its synced
      // updates are silently dropped (e.g. ready count stuck on the guest). An
      // unowned store lets every device send+receive, and since only the host
      // writes synced props, the host's writes always propagate with no conflict.
      false, 'Session', gameNetworkId
    )

    this.setupScoreboardCrossTalk()

    this.jsonQuestionProp.onAnyChange.add(() => {
      const raw = this.jsonQuestionProp.currentValue
      if (raw) this.parseAndApplyJson(raw)
    })

    this.roundStateProp.onAnyChange.add(() => this.handleRoundStateChange())
    this.currentActiveBuzzerProp.onAnyChange.add(() => this.handleBuzzerStateChange())
    this.roundResultProp.onAnyChange.add(() => this.renderRoundResult())
    this.livePicksProp.onAnyChange.add(() => this.renderLivePicks())
    this.winnerProp.onAnyChange.add(() => {
      if (this.gamePhaseProp.currentOrPendingValue === PHASE_GAMEOVER) this.showGameOver()
    })

    // ── Lobby / start coordination ───────────────────────────────────────────
    this.gamePhaseProp.onAnyChange.add(() => this.applyGamePhaseUI())
    this.readyCountProp.onAnyChange.add(() => this.updateReadyStatusText())
    this.countdownStartTokenProp.onAnyChange.add(() => {
      const token = this.countdownStartTokenProp.currentValue ?? ''
      if (!token) return
      const secs = parseFloat(token.split(':')[0])
      if (secs > 0) {
        this.startCountdown = secs
        this.startCountdownActive = true
        this.setReadyButtonVisible(false)
        this.setWaitingButtonVisible(false)
        if (this.readyStatusText) this.readyStatusText.enabled = false
        this.log(`Start countdown: ${secs}s`)
      }
    })

    this.readyButton?.onTriggerUp.add(() => this.onReadyTapped())

    // Both devices subscribe — each handles the messages relevant to their role
    sc.onMessageReceived.add(
      (_session, _userId, message, _senderInfo) => this.onMessageReceived(message)
    )

    // Show the lobby immediately so the Ready button is always visible at start,
    // independent of host-role timing or stale synced state from a prior run.
    this.showLobbyLocally()

    // Host role can settle AFTER the session reports ready (e.g. host migration
    // after a preview reset can make both sides briefly look like guests). Re-
    // evaluate whenever it changes so the real host runs startup and recovers.
    sc.onHostUpdated.add(() => this.handleHostUpdated())

    // When the store is ready, the host clears stale state and both render phase.
    this.gameSyncEntity.notifyOnReady(() => this.handleStoreReady())
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Host-role resolution (robust to migration after a reset)
  // ───────────────────────────────────────────────────────────────────────────

  private handleStoreReady() {
    this.isHost = SessionController.getInstance().isHost() === true
    this.log(`Store ready — isHost:${this.isHost}`)
    if (this.isHost) this.runHostStartup()
    this.applyGamePhaseUI()
  }

  private handleHostUpdated() {
    if (!this.gameSyncEntity) return
    this.isHost = SessionController.getInstance().isHost() === true
    this.log(`Host updated — isHost now ${this.isHost}`)

    if (this.isHost) {
      this.runHostStartup()
      // Recover a Ready press this device made before its host role settled.
      if (this.localReadyDone && !this.hostReady) {
        this.hostReady = true
        this.updateReadyCount()
      }
    } else if (this.localReadyDone) {
      // Re-assert our Ready to the (possibly new) host whose tally we missed.
      this.guestSendMessage(MSG_GUEST_READY)
    }

    this.applyGamePhaseUI()
  }

  // Host-only, runs once per session: wipe stale synced state for a clean start.
  private runHostStartup() {
    if (!this.isHost) return
    if (this.hostStartupDone) return
    this.hostStartupDone = true
    this.resetToFreshLobby()
  }

  private resetToFreshLobby() {
    this.log('Resetting to fresh lobby')

    this.hostReady = false
    this.guestReady = false

    this.readyCountProp.setPendingValue(0)
    this.countdownStartTokenProp.setPendingValue('')
    this.jsonQuestionProp.setPendingValue('')
    this.hostBuzzedTimeProp.setPendingValue('')
    this.guestBuzzedTimeProp.setPendingValue('')
    this.currentActiveBuzzerProp.setPendingValue('NONE')
    this.roundResultProp.setPendingValue('')
    this.livePicksProp.setPendingValue('')
    this.winnerProp.setPendingValue('')
    this.hostScoreProp.setPendingValue(0)
    this.guestScoreProp.setPendingValue(0)
    this.roundStateProp.setPendingValue('PLAYING')
    this.gamePhaseProp.setPendingValue(PHASE_LOBBY)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Message handling — both devices
  // ───────────────────────────────────────────────────────────────────────────

  private onMessageReceived(message: string) {
    this.log(`Message received: ${message}`)

    // ── Host handles guest input messages ───────────────────────────────────
    if (this.isHost) {
      if (message === MSG_GUEST_READY) {
        this.guestReady = true
        this.updateReadyCount()
        return
      }

      if (message.startsWith(MSG_GUEST_BUZZ + ':')) {
        const parts = message.split(':')
        if (parts.length >= 3) {
          this.guestBuzzedTimeProp.setPendingValue(`${parts[1]}:${parts[2]}`)
        }
        return
      }

      if (message.startsWith(MSG_Q_ADD + ':')) {
        // Payload is JSON (contains ':'), so slice past the prefix — don't split.
        const json = message.substring(MSG_Q_ADD.length + 1)
        this.acceptGuestQuestion(json)
        return
      }

      if (message === MSG_Q_DONE) {
        this.guestDone = true
        this.log(`Guest finished sending ${this.guestCaptured.length} question(s)`)
        this.tryAssembleQueue()
        return
      }
    }

    // ── Guest shows its own already-synced inline roast on the host's cue ─────
    if (!this.isHost) {
      if (message.startsWith(MSG_HOST_ROAST + ':')) {
        // Format: "HOST_ROAST:questionId:inline" — the roast is already in the
        // synced question JSON, so the guest just renders its local copy.
        this.log('Guest showing inline roast')
        this.applyRoast(this.currentRoast)
        return
      }
    }
  }

  // Host-only: stores a card-generated question shipped by the guest. If the
  // queue was already assembled (deadline fired before the guest finished),
  // splice it in just before the premade section — unless premade questions have
  // already started being served, in which case append it to the end.
  private acceptGuestQuestion(json: string) {
    let rec: TriviaRecord
    try {
      rec = this.toRecord(JSON.parse(json))
    } catch (e) {
      this.log(`Bad guest question payload: ${e}`)
      return
    }

    if (!this.queueAssembled) {
      this.guestCaptured.push(rec)
      return
    }

    rec.id = this.nextSyntheticId++
    if (this.premadeStartIndex >= 0 && this.queueIndex <= this.premadeStartIndex) {
      this.questionQueue.splice(this.premadeStartIndex, 0, rec)
      this.premadeStartIndex += 1
    } else {
      this.questionQueue.push(rec)
    }
    this.log('Spliced late guest question into queue')
  }

  private guestSendMessage(message: string) {
    const session = SessionController.getInstance().getSession()
    if (!session) { this.log('ERROR: session null'); return }
    session.sendMessage(message)
    this.log(`Guest sent: ${message}`)
  }

  private hostSendMessage(message: string) {
    const session = SessionController.getInstance().getSession()
    if (!session) { this.log('ERROR: session null'); return }
    session.sendMessage(message)
    this.log(`Host sent: ${message}`)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lobby / deterministic start
  // ───────────────────────────────────────────────────────────────────────────

  private onReadyTapped() {
    if (!this.gameSyncEntity) return
    if (this.gamePhaseProp.currentOrPendingValue !== PHASE_LOBBY) return
    if (this.localReadyDone) return

    this.localReadyDone = true
    // Swap the Ready button for the "Waiting for Opponent" button. It stays up
    // until both players are ready (applyGamePhaseUI / countdown hides it then).
    this.setReadyButtonVisible(false)
    this.setWaitingButtonVisible(true)
    this.setStatusText('Ready! Waiting for opponent…')

    if (this.isHost) {
      this.hostReady = true
      this.updateReadyCount()
    } else {
      this.guestSendMessage(MSG_GUEST_READY)
    }
  }

  // Host-only: recompute ready count, sync it, and start the countdown at 2/2.
  private updateReadyCount() {
    if (!this.isHost) return
    const count = (this.hostReady ? 1 : 0) + (this.guestReady ? 1 : 0)
    this.log(`Ready count → ${count}/2`)
    this.readyCountProp.setPendingValue(count)
    this.updateReadyStatusText()
    if (count >= 2) this.beginStartCountdown()
  }

  // Host-only: enter COUNTDOWN, sync the start token, and load round 1 at 0.
  private beginStartCountdown() {
    if (!this.isHost) return
    if (this.gamePhaseProp.currentOrPendingValue !== PHASE_LOBBY) return

    this.log('Both ready — beginning start countdown')
    this.gamePhaseProp.setPendingValue(PHASE_COUNTDOWN)
    this.countdownStartTokenProp.setPendingValue(`${this.START_COUNTDOWN_SECONDS}:${Date.now()}`)

    const delayEvent = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent
    delayEvent.bind(() => {
      this.gamePhaseProp.setPendingValue(PHASE_ACTIVE)
      this.startNextRound()
    })
    delayEvent.reset(this.START_COUNTDOWN_SECONDS)
  }

  private applyGamePhaseUI() {
    const phase = this.gamePhaseProp.currentOrPendingValue

    if (phase === PHASE_LOBBY) {
      this.showLobbyLocally()

    } else if (phase === PHASE_COUNTDOWN) {
      this.setReadyButtonVisible(false)
      this.setWaitingButtonVisible(false)
      if (this.readyStatusText) this.readyStatusText.enabled = false
      this.setGameElementsVisible(false)
      // Both devices begin generating questions from their own cards now, so the
      // queue is ready by the time the first round needs it.
      this.beginQuestionGeneration()

    } else if (phase === PHASE_ACTIVE) {
      this.setReadyButtonVisible(false)
      this.setWaitingButtonVisible(false)
      if (this.readyStatusText) this.readyStatusText.enabled = false
      this.startCountdownActive = false
      if (this.countdownText) this.countdownText.enabled = false
      // Board is shown when the question actually loads (parseAndApplyJson).

    } else if (phase === PHASE_GAMEOVER) {
      this.setReadyButtonVisible(false)
      this.setWaitingButtonVisible(false)
      if (this.readyStatusText) this.readyStatusText.enabled = false
      this.startCountdownActive = false
      this.nextRoundCountdownActive = false
      if (this.countdownText) this.countdownText.enabled = false
      if (this.timerText) this.timerText.text = ''
      this.showGameOver()
    }
  }

  // Renders the lobby on this device. Safe to call before the store/host settle,
  // so the Ready button always appears at start regardless of network timing.
  private showLobbyLocally() {
    this.setReadyButtonVisible(!this.localReadyDone)
    this.setWaitingButtonVisible(this.localReadyDone)
    if (this.readyStatusText) {
      this.readyStatusText.enabled = true
      const count = this.readyCountProp.currentOrPendingValue ?? 0
      this.readyStatusText.text = `${count}/2 Ready`
    }
    if (this.countdownText) { this.countdownText.enabled = false; this.countdownText.text = '' }
    this.startCountdownActive = false
    this.setGameElementsVisible(false)
    this.hideAnswerMarkers()
    this.hideAnswerFeedback()
    this.setResponse('')
    this.setStatusText(this.localReadyDone
      ? 'Ready! Waiting for opponent…'
      : 'Tap Ready to start')

    // Fresh lobby (both devices reach here) → reset the host's per-match memory.
    this.resetBattleHostLocalState()
    this.resetQuestionQueueState()
  }

  // Clears the card-question queue so a rematch regenerates from scratch. Runs on
  // both devices whenever a fresh lobby is shown.
  private resetQuestionQueueState() {
    this.questionQueue = []
    this.queueIndex = 0
    this.premadeStartIndex = -1
    this.hostCaptured = []
    this.guestCaptured = []
    this.premadeQuestions = []
    this.hostCapturedReady = false
    this.guestDone = false
    this.premadeReady = false
    this.queueAssembled = false
    this.generationStarted = false
    this.awaitingQueue = false
    this.currentRoast = ''
    this.currentPraise = ''
  }

  private updateReadyStatusText() {
    if (!this.readyStatusText) return
    if (this.gamePhaseProp.currentOrPendingValue !== PHASE_LOBBY) return
    const count = this.readyCountProp.currentOrPendingValue ?? 0
    this.readyStatusText.text = `${count}/2 Ready`
  }

  private setReadyButtonVisible(visible: boolean) {
    if (!this.readyButton) return
    const so = this.readyButton.getSceneObject()
    if (so) so.enabled = visible
  }

  private setWaitingButtonVisible(visible: boolean) {
    if (!this.waitingButton) return
    const so = this.waitingButton.getSceneObject()
    if (so) so.enabled = visible
  }

  // Gives the waiting button one frame to run its own OnStartEvent setup (UIKit
  // buttons only initialize their visual when enabled at startup), then hides it.
  private hideWaitingButtonAfterInit() {
    if (!this.waitingButton) return
    const ev = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent
    ev.bind(() => this.setWaitingButtonVisible(false))
    ev.reset(0)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Debug overlay
  // ───────────────────────────────────────────────────────────────────────────

  private updateDebugText() {
    if (!this.debugText) return

    const sc = SessionController.getInstance()
    const liveIsHost = sc.isHost()
    const role = liveIsHost === null ? 'UNKNOWN' : (liveIsHost ? 'HOST' : 'GUEST')

    const entity = this.gameSyncEntity
    const storeReady = entity ? entity.isSetupFinished : false
    const owns = entity ? entity.doIOwnStore() : false
    const canModify = entity ? entity.canIModifyStore() : false
    const userCount = sc.getUsers ? sc.getUsers().length : -1

    const phase = this.gamePhaseProp.currentOrPendingValue ?? '?'
    const roundState = this.roundStateProp.currentOrPendingValue ?? '?'
    const buzzer = this.currentActiveBuzzerProp.currentOrPendingValue ?? '?'
    const readyCount = this.readyCountProp.currentOrPendingValue ?? 0
    const hostScore = this.hostScoreProp.currentOrPendingValue ?? 0
    const guestScore = this.guestScoreProp.currentOrPendingValue ?? 0
    const result = this.roundResultProp.currentOrPendingValue || '-'

    const lines = [
      `ROLE: ${role}   (cached isHost: ${this.isHost})`,
      `user: ${this.localPlayerId}   users: ${userCount}`,
      `store: ready=${storeReady} owns=${owns} canWrite=${canModify}`,
      `phase: ${phase}   round: ${roundState}   buzzer: ${buzzer}`,
      `ready: ${readyCount}/2   (host=${this.hostReady} guest=${this.guestReady} me=${this.localReadyDone})`,
      `score: H=${hostScore} G=${guestScore} / goal ${this.winScore}`,
      `q.id=${this.currentQuestionId} ans=${this.correctAnswer}   result: ${result}`,
      `startCd: ${this.startCountdownActive ? this.startCountdown.toFixed(1) + 's' : 'off'}`,
    ]

    this.debugText.enabled = true
    this.debugText.text = lines.join('\n')
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Round scheduling
  // ───────────────────────────────────────────────────────────────────────────

  private scheduleNextRound(delaySecs: number) {
    if (!this.isHost) return
    this.log(`Next round in ${delaySecs}s`)
    const delayEvent = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent
    delayEvent.bind(() => this.startNextRound())
    delayEvent.reset(delaySecs)
  }

  private startNextRound() {
    if (!this.isHost) return
    this.turnProcessed = false
    this.raceDeadline = -1
    this.hostPickThisRound = -1
    this.guestPickThisRound = -1
    this.hostBuzzedTimeProp.setPendingValue('')
    this.guestBuzzedTimeProp.setPendingValue('')
    this.roundResultProp.setPendingValue('')
    this.livePicksProp.setPendingValue('')
    this.currentActiveBuzzerProp.setPendingValue('NONE')
    this.roundStateProp.setPendingValue('PLAYING')
    this.serveNextQuestion()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Card-driven question queue
  // ───────────────────────────────────────────────────────────────────────────

  // Kicks off question prep. Runs on BOTH devices (from the COUNTDOWN phase).
  // CAPTURED-card questions are generated at runtime from this device's own cards
  // (the guest ships its results to the host); the host fills the premade pool
  // from the BAKED question set (no LLM call). Idempotent — fires once per match.
  private beginQuestionGeneration() {
    if (this.generationStarted) return
    this.generationStarted = true

    // Captured-card questions need the generator (their cards are user-specific).
    if (this.questionGeneratorComponent) {
      const captured = this.gatherCapturedCards()
      this.log(`Generating from ${captured.length} captured card(s) (isHost:${this.isHost})`)
      this.questionGenerator.generate(captured, (records: any[]) => {
        const recs = (records ?? []).map((r) => this.toRecord(r))
        if (this.isHost) {
          this.hostCaptured = recs
          this.hostCapturedReady = true
          this.tryAssembleQueue()
        } else {
          // Ship each question to the host, then signal completion.
          for (const r of recs) this.guestSendMessage(`${MSG_Q_ADD}:${JSON.stringify(r)}`)
          this.guestSendMessage(MSG_Q_DONE)
        }
      })
    } else {
      // No generator → no captured questions; the baked premade set carries the
      // match. Still signal completion so the host can assemble immediately.
      this.hostCaptured = []
      this.hostCapturedReady = true
      if (!this.isHost) this.guestSendMessage(MSG_Q_DONE)
    }

    if (this.isHost) {
      // Premade-card questions are baked ahead of time — instant, no API call.
      // Shuffle so each match draws a different premade slate.
      this.premadeQuestions = this.shuffleCards(PREMADE_QUESTIONS)
        .slice(0, this.PREMADE_BATCH_COUNT)
        .map((q) => this.toRecord(q))
      this.premadeReady = true

      // Don't let slow captured-card generation or a silent guest stall the
      // start — assemble with whatever has arrived once the deadline passes.
      const deadline = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent
      deadline.bind(() => { if (!this.queueAssembled) this.tryAssembleQueue(true) })
      deadline.reset(this.QUEUE_ASSEMBLE_DEADLINE_SEC)

      this.tryAssembleQueue()
    }
  }

  // Host-only: builds the ordered queue once the pieces are ready (or forced).
  // Captured questions from both players come first (round-robin interleave so
  // each player's recent captures alternate), then the premade-card questions.
  private tryAssembleQueue(force: boolean = false) {
    if (!this.isHost || this.queueAssembled) return
    const ready = this.hostCapturedReady && this.guestDone && this.premadeReady
    if (!ready && !force) return

    const captured = this.interleave(this.hostCaptured, this.guestCaptured)
    this.questionQueue = captured.concat(this.premadeQuestions)
    for (const r of this.questionQueue) r.id = this.nextSyntheticId++
    this.premadeStartIndex = captured.length
    this.queueAssembled = true
    this.log(`Queue assembled — ${captured.length} captured + ${this.premadeQuestions.length} premade (forced:${force})`)

    // A round may already be waiting on the queue (countdown finished first).
    if (this.awaitingQueue) {
      this.awaitingQueue = false
      this.serveNextQuestion()
    }
  }

  // Host-only: publishes the next queued question (the synced render path is
  // unchanged). Waits if the queue isn't assembled yet; tops up from the baked
  // premade pool if it runs dry mid-match so a round never stalls.
  private serveNextQuestion() {
    if (!this.isHost) return

    // Queue not built yet (countdown beat generation) — serve as soon as ready.
    if (!this.queueAssembled) {
      this.awaitingQueue = true
      this.setStatusText('Loading questions…')
      return
    }

    // Queue ran dry in a long match — refill from the baked premade pool.
    if (this.queueIndex >= this.questionQueue.length) {
      this.topUpPremade()
      if (this.queueIndex >= this.questionQueue.length) {
        // Baked pool somehow empty — emergency Supabase question.
        this.log('Queue exhausted — falling back to Supabase')
        this.fetchAndSync()
        return
      }
    }

    const record = this.questionQueue[this.queueIndex]
    this.queueIndex += 1
    this.jsonQuestionProp.setPendingValue(JSON.stringify(record))
  }

  // Host-only: appends a fresh shuffled slate of baked premade questions when the
  // queue runs dry in a long match (synchronous — no LLM call).
  private topUpPremade() {
    const more = this.shuffleCards(PREMADE_QUESTIONS).slice(0, this.PREMADE_BATCH_COUNT)
    for (const q of more) {
      const rec = this.toRecord(q)
      rec.id = this.nextSyntheticId++
      this.questionQueue.push(rec)
    }
  }

  // Cards captured THIS session, from the session-scoped store. Mapped to the
  // generator's minimal CardSeed shape. Returns [] when no store/captures exist.
  private gatherCapturedCards(): any[] {
    const store = (global as any).cropCardStore
    if (!store || typeof store.getCards !== 'function') return []
    return (store.getCards() as any[])
      .filter((c) => c.premade === false)
      .map((c) => ({ text: c.text, topics: c.topics ?? [], location: c.location ?? '' }))
  }

  // Maps a generated question object to a TriviaRecord (id assigned at assembly).
  private toRecord(r: any): TriviaRecord {
    return {
      id: 0,
      question: String(r?.question ?? ''),
      option1: String(r?.option1 ?? ''),
      option2: String(r?.option2 ?? ''),
      option3: String(r?.option3 ?? ''),
      option4: String(r?.option4 ?? ''),
      optionCount: Number(r?.optionCount ?? 4),
      answer: Number(r?.answer ?? 1),
      roast: typeof r?.roast === 'string' ? r.roast : '',
      praise: typeof r?.praise === 'string' ? r.praise : '',
    }
  }

  // Round-robin merge so both players' recent captures alternate (fairness).
  private interleave(a: TriviaRecord[], b: TriviaRecord[]): TriviaRecord[] {
    const out: TriviaRecord[] = []
    const max = Math.max(a.length, b.length)
    for (let i = 0; i < max; i++) {
      if (i < a.length) out.push(a[i])
      if (i < b.length) out.push(b[i])
    }
    return out
  }

  private shuffleCards<T>(input: T[]): T[] {
    const copy = input.slice()
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp
    }
    return copy
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Round state handlers
  // ───────────────────────────────────────────────────────────────────────────

  // Scheduling only — the on-screen conclusion is driven by renderRoundResult so
  // it can't race the roundState change across the network.
  private handleRoundStateChange() {
    const state = this.roundStateProp.currentValue
    if (state !== 'REVEAL_CORRECT' && state !== 'REVEAL_INCORRECT') return

    this.hideAnswerFeedback()

    // Don't queue another round if this answer just won the game.
    if (this.gamePhaseProp.currentOrPendingValue === PHASE_GAMEOVER) return

    this.nextRoundCountdown = this.nextRoundDelaySeconds
    this.nextRoundCountdownActive = true
    if (this.isHost) this.scheduleNextRound(this.nextRoundDelaySeconds)
  }

  // Renders markers from the live picks prop so a selection is marked on both
  // devices the moment it's committed — including a wrong pick made while the
  // question is still in play (the steal window). The conclusion phrase is left
  // to renderRoundResult; here we only place/refresh the markers.
  private renderLivePicks() {
    const raw = this.livePicksProp.currentOrPendingValue || ''
    if (!raw) { this.hideAnswerMarkers(); return }

    const parts = raw.split(':')
    const hostChoice  = parseInt(parts[0] ?? '-1')
    const guestChoice = parseInt(parts[1] ?? '-1')
    this.showAnswerMarkers(hostChoice, guestChoice)
  }

  // Renders the conclusion (phrase + markers) from the single atomic result prop.
  private renderRoundResult() {
    const raw = this.roundResultProp.currentOrPendingValue || ''
    if (!raw) { this.hideAnswerMarkers(); return }

    const parts = raw.split(':')
    const type = parts[0]
    const hostChoice  = parseInt(parts[1] ?? '-1')
    const guestChoice = parseInt(parts[2] ?? '-1')
    const myChoice = this.isHost ? hostChoice : guestChoice

    const iWon = (type === 'WIN_HOST' && this.isHost) || (type === 'WIN_GUEST' && !this.isHost)

    let phrase: string
    if (type === 'BOTH_WRONG') {
      phrase = SAY_BOTH_WRONG
    } else {
      phrase = iWon ? SAY_WIN_ROUND : (myChoice > 0 ? SAY_ROBBED : SAY_TOO_SLOW)
    }

    this.showAnswerMarkers(hostChoice, guestChoice)

    // When nobody got it, reveal the correct answer with a green button tint
    // (no text marker) so both players still learn the answer.
    if (type === 'BOTH_WRONG') {
      this.colorOptionButton(this.correctAnswer, this.correctButtonColor)
    }

    // On a game-winning answer the win/lose banner takes priority.
    if (this.gamePhaseProp.currentOrPendingValue === PHASE_GAMEOVER) {
      this.showGameOver()
    } else {
      this.setResponse(phrase)
      this.narrateRoundResult(iWon, myChoice)
    }
  }

  private handleBuzzerStateChange() {
    const activeBuzzer = this.currentActiveBuzzerProp.currentValue
    this.localHasAnsweredPhase = false

    if (activeBuzzer === 'NONE') return  // race prompt is set when the question loads

    const myStealTurn = (activeBuzzer === 'HOST_ONLY' && this.isHost)
                     || (activeBuzzer === 'GUEST_ONLY' && !this.isHost)
    this.setResponse(myStealTurn ? SAY_STEAL_YOURS : SAY_OPP_STEALING)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Host-authoritative buzzer evaluation
  // ───────────────────────────────────────────────────────────────────────────

  private evaluateBuzzerRaceAuthoritative() {
    if (!this.isHost) return
    if (this.roundStateProp.currentValue !== 'PLAYING') return
    if (this.turnProcessed) return

    const hostToken    = this.hostBuzzedTimeProp.currentValue  || ''
    const guestToken   = this.guestBuzzedTimeProp.currentValue || ''
    const activeBuzzer = this.currentActiveBuzzerProp.currentValue

    if (activeBuzzer === 'NONE') {
      if (!hostToken && !guestToken) { this.raceDeadline = -1; return }

      // Wait a short grace window for the other player's buzz to arrive, so the
      // genuinely-earlier buzz wins even if its network message lands later.
      const now = this.serverNow()
      if (this.raceDeadline < 0) this.raceDeadline = now + this.RACE_GRACE_SECONDS
      const bothIn = !!hostToken && !!guestToken
      if (!bothIn && now < this.raceDeadline) return

      const hostTime  = hostToken  ? parseFloat(hostToken.split(':')[0])  : Infinity
      const guestTime = guestToken ? parseFloat(guestToken.split(':')[0]) : Infinity
      const hostOpt   = hostToken  ? parseInt(hostToken.split(':')[1])  : -1
      const guestOpt  = guestToken ? parseInt(guestToken.split(':')[1]) : -1
      if (hostToken)  this.hostPickThisRound  = hostOpt
      if (guestToken) this.guestPickThisRound = guestOpt

      this.turnProcessed = true
      this.raceDeadline = -1
      if (hostTime <= guestTime) {
        this.processTurnAuthoritative('HOST', hostOpt)
      } else {
        this.processTurnAuthoritative('GUEST', guestOpt)
      }

    } else if (activeBuzzer === 'HOST_ONLY' && hostToken) {
      this.turnProcessed = true
      this.processTurnAuthoritative('HOST', parseInt(hostToken.split(':')[1]))

    } else if (activeBuzzer === 'GUEST_ONLY' && guestToken) {
      this.turnProcessed = true
      this.processTurnAuthoritative('GUEST', parseInt(guestToken.split(':')[1]))
    }
  }

  private serverNow(): number {
    const t = SessionController.getInstance().getServerTimeInSeconds()
    return (t === null || t < 0) ? getTime() : t
  }

  private processTurnAuthoritative(player: 'HOST' | 'GUEST', chosenOption: number) {
    const isCorrect         = chosenOption === this.correctAnswer
    const currentHostScore  = this.hostScoreProp.currentValue  ?? 0
    const currentGuestScore = this.guestScoreProp.currentValue ?? 0
    const activeBuzzer      = this.currentActiveBuzzerProp.currentValue

    this.log(`Turn: player=${player} option=${chosenOption} correct=${isCorrect}`)

    // Record what this player picked (covers the steal branch too).
    if (player === 'HOST') this.hostPickThisRound = chosenOption
    else                   this.guestPickThisRound = chosenOption

    // Surface the pick to both devices immediately so its marker appears now —
    // not only at conclusion. Matters for a wrong answer during a live steal.
    this.publishLivePicks()

    if (isCorrect) {
      const newScore = (player === 'HOST' ? currentHostScore : currentGuestScore) + this.REWARD_POINTS
      if (player === 'HOST') this.hostScoreProp.setPendingValue(newScore)
      else                   this.guestScoreProp.setPendingValue(newScore)

      this.publishRoundResult(player === 'HOST' ? 'WIN_HOST' : 'WIN_GUEST')
      this.roundStateProp.setPendingValue('REVEAL_CORRECT')

      if (newScore >= this.winScore) {
        this.winnerProp.setPendingValue(player)
        this.gamePhaseProp.setPendingValue(PHASE_GAMEOVER)
        this.log(`Game over — winner ${player} (${newScore})`)
      }

    } else {
      if (player === 'HOST') {
        this.hostScoreProp.setPendingValue(Math.max(0, currentHostScore - this.PENALTY_POINTS))
      } else {
        this.guestScoreProp.setPendingValue(Math.max(0, currentGuestScore - this.PENALTY_POINTS))
      }

      if (activeBuzzer === 'NONE') {
        // First wrong answer — open steal window and trigger roast for wrong player
        this.triggerRoastForWrongAnswer(player)

        this.hostBuzzedTimeProp.setPendingValue('')
        this.guestBuzzedTimeProp.setPendingValue('')
        this.turnProcessed = false
        this.raceDeadline = -1
        const nextTarget = (player === 'HOST') ? 'GUEST_ONLY' : 'HOST_ONLY'
        this.currentActiveBuzzerProp.setPendingValue(nextTarget)

      } else {
        // Steal attempt also failed — both wrong, conclude the question.
        this.triggerRoastForWrongAnswer(player)
        this.publishRoundResult('BOTH_WRONG')
        this.roundStateProp.setPendingValue('REVEAL_INCORRECT')
      }
    }
  }

  // Publishes the conclusion as one atomic synced value so the phrase + markers
  // render together (never half-synced like the old separate choice props).
  private publishRoundResult(type: 'WIN_HOST' | 'WIN_GUEST' | 'BOTH_WRONG') {
    this.roundResultProp.setPendingValue(
      `${type}:${this.hostPickThisRound}:${this.guestPickThisRound}`
    )
  }

  // Host-only: publishes the current picks so both devices can mark them right
  // away. Re-publishing as picks accumulate (e.g. first wrong, then the steal)
  // keeps both markers in sync mid-question.
  private publishLivePicks() {
    if (!this.isHost) return
    this.livePicksProp.setPendingValue(
      `${this.hostPickThisRound}:${this.guestPickThisRound}`
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Roast integration
  // ───────────────────────────────────────────────────────────────────────────

  // Every battle question carries its roast inline (synced in the question JSON),
  // so the wrong player's own device just renders its copy — no network lookup.
  // A question with no roast simply falls through to the host's curated wrong line.
  private triggerRoastForWrongAnswer(wrongPlayer: 'HOST' | 'GUEST') {
    if (!this.currentRoast) return
    if (wrongPlayer === 'HOST') {
      this.applyRoast(this.currentRoast)
    } else {
      // Cue the guest to render its own already-synced inline roast.
      const msg = `${MSG_HOST_ROAST}:${this.currentQuestionId}:inline`
      this.log(`Sending inline-roast cue to guest: ${msg}`)
      this.hostSendMessage(msg)
    }
  }

  // Render the roast on screen and speak it via the host, cancelling the curated
  // wrong-answer fallback (the question-specific roast takes over that moment).
  private applyRoast(text: string) {
    if (!text) return
    this.log(`Roast: ${text}`)
    if (this.roastText) {
      this.roastText.text = text
      this.roastText.enabled = true
    }
    this.localRoastSpokenThisRound = true
    this.battleHost?.speakRoast(text)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Scoreboard
  // ───────────────────────────────────────────────────────────────────────────

  private setupScoreboardCrossTalk() {
    this.hostScoreProp.onAnyChange.add(() => {
      const score = this.hostScoreProp.currentValue ?? 0
      this.log(`hostScore → ${score}`)
      if (this.isHost) {
        this.localScore = score
        if (this.myScoreValueText) this.myScoreValueText.text = String(score)
      } else {
        if (this.opponentScoreValueText) this.opponentScoreValueText.text = String(score)
      }
    })
    this.guestScoreProp.onAnyChange.add(() => {
      const score = this.guestScoreProp.currentValue ?? 0
      this.log(`guestScore → ${score}`)
      if (!this.isHost) {
        this.localScore = score
        if (this.myScoreValueText) this.myScoreValueText.text = String(score)
      } else {
        if (this.opponentScoreValueText) this.opponentScoreValueText.text = String(score)
      }
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Frame update
  // ───────────────────────────────────────────────────────────────────────────

  private onUpdate() {
    this.updateDebugText()

    if (this.startCountdownActive) {
      this.startCountdown -= getDeltaTime()
      if (this.startCountdown <= 0) {
        this.startCountdownActive = false
        if (this.countdownText) { this.countdownText.text = ''; this.countdownText.enabled = false }
        this.setStatusText('Loading…')
      } else if (this.countdownText) {
        this.countdownText.enabled = true
        this.countdownText.text = String(Math.ceil(this.startCountdown))
      }
    }

    if (this.isHost) {
      this.evaluateBuzzerRaceAuthoritative()
    }

    if (this.nextRoundCountdownActive) {
      this.nextRoundCountdown -= getDeltaTime()
      if (this.nextRoundCountdown <= 0) {
        this.nextRoundCountdownActive = false
        if (this.timerText) this.timerText.text = ''
        this.setStatusText('Loading…')
      } else {
        if (this.timerText) {
          this.timerText.text = `Next in ${this.nextRoundCountdown.toFixed(1)}s`
        }
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Input — answer buttons
  // ───────────────────────────────────────────────────────────────────────────

  private setupAnswerButtons() {
    this.optionButton1?.onTriggerUp.add(() => this.checkUserAnswer(1))
    this.optionButton2?.onTriggerUp.add(() => this.checkUserAnswer(2))
    this.optionButton3?.onTriggerUp.add(() => this.checkUserAnswer(3))
    this.optionButton4?.onTriggerUp.add(() => this.checkUserAnswer(4))
  }

  private checkUserAnswer(index: number) {
    // Ignore option taps unless a question is actually live.
    if (this.gamePhaseProp.currentOrPendingValue !== PHASE_ACTIVE) return
    if (this.localHasAnsweredPhase) return
    if (this.roundStateProp.currentValue !== 'PLAYING') return

    const currentBuzzerState = this.currentActiveBuzzerProp.currentValue
    if (currentBuzzerState === 'GUEST_ONLY' && this.isHost)  return
    if (currentBuzzerState === 'HOST_ONLY'  && !this.isHost) return

    this.localHasAnsweredPhase = true
    this.setStatusText('Locked in…')

    // Cut THIS device's question read the instant the local player buzzes (the
    // other device keeps reading until the round actually concludes). The outcome
    // line — roast at buzz-eval, or praise/general at conclusion — plays after.
    this.battleHost?.stopQuestionRead()

    // How fast the local player buzzed (for the host's "fast correct" reaction).
    this.localAnswerMs = Math.max(0, (getTime() - this.questionLoadedAt) * 1000)

    // Server time so the host can rank host vs guest buzzes on one shared clock.
    const ts = this.serverNow()
    if (this.isHost) {
      this.hostBuzzedTimeProp.setPendingValue(`${ts}:${index}`)
    } else {
      this.guestSendMessage(`${MSG_GUEST_BUZZ}:${ts}:${index}`)
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Supabase fetch
  // ───────────────────────────────────────────────────────────────────────────

  private fetchAndSync() {
    const cloud = this.snapCloudRequirements as unknown as ISnapCloudRequirements
    if (!cloud?.isConfigured()) return

    const endpointUrl = `${cloud.getFunctionsApiUrl()}${this.functionName}`
    const payload: Record<string, string> = {}
    const obj   = this.object?.trim()
    const topic = this.topic?.trim()
    if (obj)   payload['object'] = obj
    if (topic) payload['topic']  = topic

    const request = RemoteServiceHttpRequest.create()
    request.url     = endpointUrl
    request.headers = cloud.getSupabaseHeaders()
    request.method  = RemoteServiceHttpRequest.HttpRequestMethod.Post
    request.body    = JSON.stringify(payload)

    this.setStatusText('Loading question…')

    this.internetModule.performHttpRequest(request, (response) => {
      if (response.statusCode !== 200) {
        this.setStatusText('Error loading question')
        return
      }
      try {
        const result = JSON.parse(response.body)
        if (result.ok === true && result.record) {
          this.jsonQuestionProp.setPendingValue(JSON.stringify(result.record))
        }
      } catch (e) {
        this.log(`Parse fault: ${e}`)
      }
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UI helpers
  // ───────────────────────────────────────────────────────────────────────────

  private parseAndApplyJson(jsonStr: string) {
    try {
      const record = JSON.parse(jsonStr) as TriviaRecord

      this.currentQuestionId = Number(record.id ?? 0)
      this.correctAnswer = Number(record.answer ?? 0)
      // Every battle question carries its host lines inline in the synced JSON:
      // roast (wrong answer) and praise (correct answer).
      this.currentRoast = typeof record.roast === 'string' ? record.roast : ''
      this.currentPraise = typeof record.praise === 'string' ? record.praise : ''

      if (this.questionText) this.questionText.text = String(record.question ?? '')
      this.setOptionText(0, String(record.option1 ?? ''))
      this.setOptionText(1, String(record.option2 ?? ''))
      this.setOptionText(2, String(record.option3 ?? ''))
      this.setOptionText(3, String(record.option4 ?? ''))
      this.localHasAnsweredPhase = false
      this.localRoastSpokenThisRound = false  // fresh question → no roast spoken yet
      this.hideAnswerFeedback()

      // Host timing: remember when this question appeared so we can tell a fast
      // buzz from a slow one, and clear last round's answer time.
      this.questionLoadedAt = getTime()
      this.localAnswerMs = -1

      // Reveal the board (hidden during lobby/countdown) and clear last round.
      this.setGameElementsVisible(true)
      this.hideAnswerMarkers()
      this.setResponse(this.questionStartResponse())

      // ── Sassy host: connect on the first question, and tease a matchpoint ────
      if (!this.matchStarted) {
        this.matchStarted = true
        this.battleHost?.beginMatch()
      }
      if (this.battleHost && this.isLocalMatchpoint()) {
        this.battleHost.onBattleEvent('PRE_MATCHPOINT' as BattleEvent, this.battleSnapshot())
      }

      // Read the question aloud (just the question — never the options). On a
      // matchpoint round the taunt above was sent first, so this non-interrupting
      // read queues right after it. Cut instantly at a local buzz (checkUserAnswer)
      // or overridden by the outcome line at conclusion.
      this.battleHost?.speakQuestion(String(record.question ?? ''))

      // Clear roast from previous round
      if (this.roastText) {
        this.roastText.enabled = false
        this.roastText.text = ''
      }

      this.log(`Question loaded — id:${this.currentQuestionId} answer:${this.correctAnswer}`)
    } catch (e) {
      this.log(`UI render fault: ${e}`)
    }
  }

  private hideAnswerFeedback() {
    if (this.correctText)   this.correctText.enabled   = false
    if (this.incorrectText) this.incorrectText.enabled = false
  }

  private setStatusText(msg: string) {
    if (this.statusText) this.statusText.text = msg
    this.log(msg)
  }

  // ── Response label ─────────────────────────────────────────────────────────

  private setResponse(msg: string) {
    if (!this.responseText) return
    this.responseText.text = msg
    this.responseText.enabled = msg.length > 0
  }

  // Phrase shown when a fresh question appears: Matchpoint warning, else race.
  private questionStartResponse(): string {
    const hostScore  = this.hostScoreProp.currentOrPendingValue  ?? 0
    const guestScore = this.guestScoreProp.currentOrPendingValue ?? 0
    const myScore  = this.isHost ? hostScore : guestScore
    const oppScore = this.isHost ? guestScore : hostScore

    const meMatch  = myScore  + this.REWARD_POINTS >= this.winScore
    const oppMatch = oppScore + this.REWARD_POINTS >= this.winScore

    if (meMatch && oppMatch) return SAY_MATCH_BOTH
    if (meMatch)  return SAY_MATCH_ME
    if (oppMatch) return SAY_MATCH_OPP
    return SAY_RACE
  }

  private showGameOver() {
    const winner = this.winnerProp.currentOrPendingValue ?? ''
    const iWon = (winner === 'HOST' && this.isHost) || (winner === 'GUEST' && !this.isHost)
    this.setResponse(iWon ? SAY_GAME_WIN : SAY_GAME_LOSE)
    this.setStatusText('Game over')

    // Sassy host: announce the result once, then free the live session after the
    // line has had time to play (closing immediately would cut it off).
    if (this.battleHost && !this.gameOverAnnounced) {
      this.gameOverAnnounced = true
      this.battleHost.onBattleEvent((iWon ? 'WIN' : 'LOSS') as BattleEvent, this.battleSnapshot())
      const ev = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent
      ev.bind(() => this.battleHost?.endMatch())
      ev.reset(8)
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Sassy host narration (per-device, local player's perspective)
  // ───────────────────────────────────────────────────────────────────────────

  // One spoken line per round conclusion, and the question's OWN line always wins:
  //   win  → this question's praise (real-time for captured cards, baked for
  //          premade), falling back to the curated CORRECT bank only if absent;
  //   loss → this question's roast, falling back to the curated WRONG/TOO_SLOW
  //          bank only if it's missing/slow.
  private narrateRoundResult(iWon: boolean, myChoice: number) {
    if (!this.battleHost) return

    if (iWon) this.localStreak += 1
    else      this.localStreak = 0

    // detectLeadEvent() is called every round for its side effects (it maintains
    // lastLeadSign / announcedBlowout); its event is only SPOKEN as a fallback when
    // the question carries no applicable specific line — the card praise/roast wins.
    const leadEvent = this.detectLeadEvent()
    const snap = this.battleSnapshot()

    if (iWon) {
      // PRIMARY: the question's own praise line. Only if it carries none (e.g. a
      // Supabase row) do we fall to a momentum swing, then the curated CORRECT bank.
      if (this.currentPraise) {
        this.battleHost.speakPraise(this.currentPraise)
      } else if (leadEvent) {
        this.battleHost.onBattleEvent(leadEvent, snap)
      } else {
        const fast = this.localAnswerMs >= 0 && this.localAnswerMs < this.FAST_ANSWER_MS
        this.battleHost.onBattleEvent(fast ? 'FAST_CORRECT' : 'CORRECT', snap)
      }
    } else {
      // The wrong buzzer already heard this question's roast at buzz time — never
      // speak a second loss line for them (fixes the duplicate + the override).
      if (this.localRoastSpokenThisRound) return
      // This local player didn't buzz wrong (robbed / too slow), so no roast played:
      // one loss line — a momentum swing if there is one, else the generic bank.
      if (leadEvent) {
        this.battleHost.onBattleEvent(leadEvent, snap)
      } else {
        this.battleHost.onBattleEvent(myChoice > 0 ? 'WRONG' : 'TOO_SLOW', snap)
      }
    }
  }

  // Detects a lead flip / blowout from the (synced) scores. Returns the event to
  // call once on transition, or null. Updates the tracked lead state either way.
  private detectLeadEvent(): BattleEvent | null {
    const hs = this.hostScoreProp.currentOrPendingValue ?? 0
    const gs = this.guestScoreProp.currentOrPendingValue ?? 0
    const my  = this.isHost ? hs : gs
    const opp = this.isHost ? gs : hs
    const sign = my > opp ? 1 : (my < opp ? -1 : 0)
    const gap = Math.abs(my - opp)

    let ev: BattleEvent | null = null
    if (gap >= this.BLOWOUT_GAP) {
      if (!this.announcedBlowout && sign !== 0) {
        ev = sign > 0 ? 'BLOWOUT_WINNING' : 'BLOWOUT_LOSING'
        this.announcedBlowout = true
      }
    } else {
      this.announcedBlowout = false
      if (sign !== 0 && sign !== this.lastLeadSign) {
        ev = sign > 0 ? 'TAKE_LEAD' : 'FALL_BEHIND'
      }
    }
    this.lastLeadSign = sign
    return ev
  }

  private battleSnapshot(): GameSnapshot {
    const hs = this.hostScoreProp.currentOrPendingValue ?? 0
    const gs = this.guestScoreProp.currentOrPendingValue ?? 0
    return {
      myScore:  this.isHost ? hs : gs,
      oppScore: this.isHost ? gs : hs,
      winScore: this.winScore,
      streak:   this.localStreak,
      answerMs: this.localAnswerMs,
    }
  }

  // True when either player can win on the next correct answer (a tense moment).
  private isLocalMatchpoint(): boolean {
    const hs = this.hostScoreProp.currentOrPendingValue ?? 0
    const gs = this.guestScoreProp.currentOrPendingValue ?? 0
    const my  = this.isHost ? hs : gs
    const opp = this.isHost ? gs : hs
    return (my + this.REWARD_POINTS >= this.winScore) ||
           (opp + this.REWARD_POINTS >= this.winScore)
  }

  private resetBattleHostLocalState() {
    this.matchStarted = false
    this.gameOverAnnounced = false
    this.localStreak = 0
    this.lastLeadSign = 0
    this.announcedBlowout = false
    this.localAnswerMs = -1
    this.localRoastSpokenThisRound = false
  }

  // ── Board visibility ───────────────────────────────────────────────────────

  private setGameElementsVisible(visible: boolean) {
    if (this.questionText) this.questionText.enabled = visible
    this.setButtonObjVisible(this.optionButton1, visible)
    this.setButtonObjVisible(this.optionButton2, visible)
    this.setButtonObjVisible(this.optionButton3, visible)
    this.setButtonObjVisible(this.optionButton4, visible)
  }

  private setButtonObjVisible(btn: BaseButton, visible: boolean) {
    if (!btn) return
    const so = btn.getSceneObject()
    if (so) so.enabled = visible
  }

  private optionButtonByIndex(index: number): BaseButton | null {
    switch (index) {
      case 1: return this.optionButton1
      case 2: return this.optionButton2
      case 3: return this.optionButton3
      case 4: return this.optionButton4
      default: return null
    }
  }

  // ── Answer markers (created by the script, positioned at the buttons) ───────

  private showAnswerMarkers(hostChoice: number, guestChoice: number) {
    const myChoice  = this.isHost ? hostChoice : guestChoice
    const oppChoice = this.isHost ? guestChoice : hostChoice

    this.meMarker  = this.ensureMarker(this.meMarker, 'AnswerMarker_Me')
    this.oppMarker = this.ensureMarker(this.oppMarker, 'AnswerMarker_Opponent')

    // Self marker always sits above its button, opponent always below — so the
    // two never collide even when both players land on the same option.
    this.placeMarker(this.meMarker, 'Me', myChoice, true)
    this.placeMarker(this.oppMarker, 'Opponent', oppChoice, false)

    // Tint each chosen button to match its marker (green = correct, red = wrong).
    this.colorPickedButton(hostChoice)
    this.colorPickedButton(guestChoice)
  }

  // Tints one player's chosen button green (correct) or red (wrong). No-op for
  // an out-of-range choice (e.g. -1 when that player hasn't picked yet).
  private colorPickedButton(choice: number) {
    if (choice < 1 || choice > 4) return
    const color = choice === this.correctAnswer ? this.correctButtonColor : this.incorrectButtonColor
    this.colorOptionButton(choice, color)
  }

  // Lazily creates a Text SceneObject for a marker. No font is required — the
  // engine renders new Text components with the default font.
  private ensureMarker(existing: Text | null, name: string): Text {
    if (existing) return existing
    const obj = global.scene.createSceneObject(name)
    obj.enabled = false
    const t = obj.createComponent('Component.Text') as Text
    t.horizontalAlignment = HorizontalAlignment.Center
    t.verticalAlignment = VerticalAlignment.Center
    return t
  }

  private placeMarker(marker: Text, label: string, choice: number, isSelf: boolean) {
    const markerSO = marker.getSceneObject()
    if (!markerSO) return

    if (choice < 1 || choice > 4) { markerSO.enabled = false; return }
    const btn = this.optionButtonByIndex(choice)
    const btnSO = btn ? btn.getSceneObject() : null
    if (!btnSO) { markerSO.enabled = false; return }

    markerSO.setParent(btnSO)
    markerSO.layer = btnSO.layer   // draw on the same render layer as the button
    // Centered horizontally on the button; self above (+Y), opponent below (−Y).
    const off = this.answerMarkerOffset || new vec3(0, 6, 0)
    const yMag = Math.abs(off.y)
    const y = isSelf ? yMag : -yMag
    const t = markerSO.getTransform()
    t.setLocalPosition(new vec3(off.x, y, off.z))
    t.setLocalRotation(quat.quatIdentity())

    marker.text = label
    marker.size = this.answerMarkerTextSize
    marker.textFill.color = this.markerColor(choice === this.correctAnswer)
    markerSO.enabled = true
  }

  private hideAnswerMarkers() {
    if (this.meMarker) {
      const so = this.meMarker.getSceneObject()
      if (so) so.enabled = false
    }
    if (this.oppMarker) {
      const so = this.oppMarker.getSceneObject()
      if (so) so.enabled = false
    }
    // Markers and button tints share the same lifecycle, so clearing one clears
    // the other (covers new question, lobby reset, and empty live/result props).
    this.resetOptionButtonColors()
  }

  private markerColor(correct: boolean): vec4 {
    // Text markers reuse the button hue but always render fully opaque — the
    // configured alpha only applies to the (optionally translucent) button tint.
    const c = correct ? this.correctButtonColor : this.incorrectButtonColor
    return new vec4(c.r, c.g, c.b, 1.0)
  }

  // ── Option button tinting (green/red) ──────────────────────────────────────

  private optionButtonVisual(index: number): RoundedRectangleVisual | null {
    const btn = this.optionButtonByIndex(index)
    if (!btn) return null
    const visual = (btn as any).visual
    return visual ? (visual as RoundedRectangleVisual) : null
  }

  // Tints an option button by assigning a flat gradient to its resting states.
  // The visual re-applies the active state on its own LateUpdateEvent, so the
  // change is picked up the next frame. Originals are snapshotted on first tint.
  private colorOptionButton(index: number, color: vec4) {
    if (index < 1 || index > 4) return
    const visual = this.optionButtonVisual(index)
    if (!visual) return

    this.snapshotOptionButtonVisual(index, visual)

    const grad = this.flatGradient(color)
    visual.defaultBaseType = 'Gradient'
    visual.hoveredBaseType = 'Gradient'
    visual.triggeredBaseType = 'Gradient'
    visual.defaultGradient = grad
    visual.hoveredGradient = grad
    visual.triggeredGradient = grad
  }

  private snapshotOptionButtonVisual(index: number, visual: RoundedRectangleVisual) {
    if (this.optionButtonVisualSnapshots[index - 1]) return
    this.optionButtonVisualSnapshots[index - 1] = {
      defaultBaseType: visual.defaultBaseType,
      hoveredBaseType: visual.hoveredBaseType,
      triggeredBaseType: visual.triggeredBaseType,
      defaultGradient: visual.defaultGradient,
      hoveredGradient: visual.hoveredGradient,
      triggeredGradient: visual.triggeredGradient,
    }
  }

  private resetOptionButtonColors() {
    for (let index = 1; index <= 4; index++) {
      const snap = this.optionButtonVisualSnapshots[index - 1]
      if (!snap) continue
      const visual = this.optionButtonVisual(index)
      if (visual) {
        visual.defaultBaseType = snap.defaultBaseType
        visual.hoveredBaseType = snap.hoveredBaseType
        visual.triggeredBaseType = snap.triggeredBaseType
        visual.defaultGradient = snap.defaultGradient
        visual.hoveredGradient = snap.hoveredGradient
        visual.triggeredGradient = snap.triggeredGradient
      }
      this.optionButtonVisualSnapshots[index - 1] = null
    }
  }

  // A flat, single-hue gradient that reads as a solid fill (per TopicSelectionPanel).
  private flatGradient(color: vec4): GradientParameters {
    return {
      enabled: true,
      type: 'Linear',
      start: new vec2(-2, 1),
      end: new vec2(2, -1),
      stop0: { enabled: true, percent: 0, color },
      stop1: { enabled: true, percent: 1, color },
    }
  }

  private cacheOptionChildTextNodes() {
    this.optionTexts[0] = this.findButtonChildText(this.optionButton1)
    this.optionTexts[1] = this.findButtonChildText(this.optionButton2)
    this.optionTexts[2] = this.findButtonChildText(this.optionButton3)
    this.optionTexts[3] = this.findButtonChildText(this.optionButton4)
  }

  private findButtonChildText(btn: BaseButton): Text | null {
    if (!btn) return null
    const root = btn.getSceneObject()
    if (!root) return null
    if (this.optionButtonChildTextName?.length > 0) {
      const named = this.findChildByNameRecursive(root, this.optionButtonChildTextName)
      if (named) {
        const t = named.getComponent('Text') as Text
        if (t) return t
      }
    }
    return this.findFirstTextInDescendants(root)
  }

  private findChildByNameRecursive(root: SceneObject, name: string): SceneObject | null {
    if (root.name === name) return root
    const count = root.getChildrenCount()
    for (let i = 0; i < count; i++) {
      const child = root.getChild(i)
      if (!child) continue
      if (child.name === name) return child
      const deeper = this.findChildByNameRecursive(child, name)
      if (deeper) return deeper
    }
    return null
  }

  private findFirstTextInDescendants(root: SceneObject): Text | null {
    const rootText = root.getComponent('Text') as Text
    if (rootText) return rootText
    const count = root.getChildrenCount()
    for (let i = 0; i < count; i++) {
      const child = root.getChild(i)
      if (!child) continue
      const t = child.getComponent('Text') as Text
      if (t) return t
      const deeper = this.findFirstTextInDescendants(child)
      if (deeper) return deeper
    }
    return null
  }

  private setOptionText(index: number, value: string) {
    const t = this.optionTexts[index]
    if (t) t.text = value
  }

  private log(msg: string) {
    if (this.enableDebugLogs) print(`[MultiplayerTriviaManager] ${msg}`)
  }
}