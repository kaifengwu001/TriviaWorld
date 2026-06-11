/**
 * MultiplayerTriviaManager.ts — v2.4
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
 *   - onRoastReceived callback wired in onSessionReady so roastText renders on screen
 */

import { SessionController }  from 'SpectaclesSyncKit.lspkg/Core/SessionController'
import { SyncEntity }         from 'SpectaclesSyncKit.lspkg/Core/SyncEntity'
import { StorageProperty }    from 'SpectaclesSyncKit.lspkg/Core/StorageProperty'
import { StoragePropertySet } from 'SpectaclesSyncKit.lspkg/Core/StoragePropertySet'
import { RectangleButton }    from 'SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton'

interface ISnapCloudRequirements {
  isConfigured(): boolean
  getFunctionsApiUrl(): string
  getSupabaseHeaders(): { [key: string]: string }
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
}

const MSG_GUEST_BUZZ   = 'GUEST_BUZZ'    // guest → host: "GUEST_BUZZ:timestamp:optionIndex"
const MSG_GUEST_RESUME = 'GUEST_RESUME'  // guest → host: resume from PAUSED
const MSG_HOST_ROAST   = 'HOST_ROAST'    // host → guest: "HOST_ROAST:questionId:roast1|roast2"
const MSG_GUEST_READY  = 'GUEST_READY'   // guest → host: guest tapped the Ready button

// Game lifecycle phases (synced via gamePhaseProp)
const PHASE_LOBBY     = 'LOBBY'      // waiting for both players to ready up
const PHASE_COUNTDOWN = 'COUNTDOWN'  // 3-2-1 before first question
const PHASE_ACTIVE    = 'ACTIVE'     // normal round play

@component
export class MultiplayerTriviaManager extends BaseScriptComponent {

  private internetModule: InternetModule = require('LensStudio:InternetModule')

  @input('Component.ScriptComponent') public snapCloudRequirements: ScriptComponent
  @input public functionName: string = ''
  @input public object:  string = ''
  @input public topic:   string = ''

  @input public questionText: Text
  @input public optionButton1: RectangleButton
  @input public optionButton2: RectangleButton
  @input public optionButton3: RectangleButton
  @input public optionButton4: RectangleButton
  @input public optionButtonChildTextName: string = ''

  @input public correctText:   Text
  @input public incorrectText: Text
  @input public myScoreValueText: Text
  @input public statusText: Text | null = null

  // ── Lobby / start coordination ─────────────────────────────────────────────
  @input
  @hint("Button players tap to mark themselves ready in the lobby")
  public readyButton: RectangleButton | null = null

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
  @input public roundDurationSeconds: number = 30
  @input public nextRoundDelaySeconds: number = 5
  @input public enableDebugLogs: boolean = true

  // ── Roast integration ─────────────────────────────────────────────────────
  @input('Component.ScriptComponent')
  @hint("EdgeFunctionRoastById script component")
  public roastFetcherComponent: ScriptComponent

  @input
  @hint("Text component to display the roast message on screen")
  public roastText: Text | null = null

  // ── SyncEntity ────────────────────────────────────────────────────────────
  private gameSyncEntity: SyncEntity | null = null

  private jsonQuestionProp        = StorageProperty.manualString('jsonQuestion', '')
  private timerStartTokenProp     = StorageProperty.manualString('timerStartToken', '')
  private roundStateProp          = StorageProperty.manualString('roundState', 'PLAYING')
  private currentActiveBuzzerProp = StorageProperty.manualString('currentActiveBuzzer', 'NONE')
  private hostScoreProp           = StorageProperty.manualInt('hostScore', 0)
  private guestScoreProp          = StorageProperty.manualInt('guestScore', 0)
  private hostBuzzedTimeProp      = StorageProperty.manualString('hostBuzzedTime', '')
  private guestBuzzedTimeProp     = StorageProperty.manualString('guestBuzzedTime', '')

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

  private readonly REWARD_POINTS  = 10
  private readonly PENALTY_POINTS = 5

  private optionTexts: (Text | null)[] = [null, null, null, null]
  private isHost: boolean              = false
  private localPlayerId: string        = ''
  private localTimeRemaining: number   = 0
  private timerActive: boolean         = false

  // ── Roast fetcher accessor ────────────────────────────────────────────────
  private get roastFetcher(): any {
    return this.roastFetcherComponent as any
  }

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
    // NOTE: do NOT disable the ready button's SceneObject here — UIKit buttons
    // wire up their tap handler in OnStartEvent, which never fires for an object
    // that is disabled at startup. Disabling it now would permanently break
    // onTriggerUp. Visibility is managed via applyGamePhaseUI after it inits.
    if (this.countdownText) { this.countdownText.enabled = false; this.countdownText.text = '' }
    if (this.readyStatusText) this.readyStatusText.enabled = false

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
        this.timerStartTokenProp,
        this.roundStateProp,
        this.currentActiveBuzzerProp,
        this.hostScoreProp,
        this.guestScoreProp,
        this.hostBuzzedTimeProp,
        this.guestBuzzedTimeProp,
        this.gamePhaseProp,
        this.readyCountProp,
        this.countdownStartTokenProp,
      ]),
      true, 'Session', gameNetworkId
    )

    // ── Wire roast callback — fires when HTTP response arrives ────────────────
    // Both devices need this so roastText renders when the fetcher gets a response
    if (this.roastFetcherComponent && this.roastText) {
      this.roastFetcher.onRoastReceived = (text: string) => {
        this.log(`Roast received: ${text}`)
        if (this.roastText) {
          this.roastText.text = text
          this.roastText.enabled = true
        }
      }
    }

    this.setupScoreboardCrossTalk()

    this.jsonQuestionProp.onAnyChange.add(() => {
      const raw = this.jsonQuestionProp.currentValue
      if (raw) this.parseAndApplyJson(raw)
    })

    this.timerStartTokenProp.onAnyChange.add(() => {
      const token = this.timerStartTokenProp.currentValue ?? ''
      if (!token) return
      const duration = parseFloat(token.split(':')[0])
      if (duration > 0) {
        this.localTimeRemaining = duration
        this.timerActive = true
        this.turnProcessed = false
        this.nextRoundCountdownActive = false
        this.log(`Timer started: ${duration}s`)
      }
    })

    this.hostBuzzedTimeProp.onAnyChange.add(() => {
      if (this.hostBuzzedTimeProp.currentValue) {
        this.timerActive = false
        this.log('Timer frozen: hostBuzzedTime')
      }
    })
    this.guestBuzzedTimeProp.onAnyChange.add(() => {
      if (this.guestBuzzedTimeProp.currentValue) {
        this.timerActive = false
        this.log('Timer frozen: guestBuzzedTime')
      }
    })

    this.roundStateProp.onAnyChange.add(() => this.handleRoundStateChange())
    this.currentActiveBuzzerProp.onAnyChange.add(() => this.handleBuzzerStateChange())

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

      if (message === MSG_GUEST_RESUME) {
        if (this.roundStateProp.currentValue === 'PAUSED') {
          this.startNextRound()
        }
        return
      }

      if (message.startsWith(MSG_GUEST_BUZZ + ':')) {
        const parts = message.split(':')
        if (parts.length >= 3) {
          this.guestBuzzedTimeProp.setPendingValue(`${parts[1]}:${parts[2]}`)
        }
        return
      }
    }

    // ── Guest handles roast instruction from host ───────────────────────────
    if (!this.isHost) {
      if (message.startsWith(MSG_HOST_ROAST + ':')) {
        // Format: "HOST_ROAST:questionId:roast1" or "HOST_ROAST:questionId:roast2"
        const parts = message.split(':')
        if (parts.length >= 3) {
          const questionId = parseInt(parts[1])
          const roastField = parts[2] as 'roast1' | 'roast2'
          this.log(`Guest fetching ${roastField} for question id:${questionId}`)
          if (this.roastFetcherComponent) {
            this.roastFetcher.callFunctionWithId(questionId)
            if (roastField === 'roast1') {
              this.roastFetcher.fetchRoast1()
            } else {
              this.roastFetcher.fetchRoast2()
            }
          }
        }
        return
      }
    }
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
    this.setReadyButtonVisible(false)
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
      if (this.readyStatusText) this.readyStatusText.enabled = false

    } else if (phase === PHASE_ACTIVE) {
      this.setReadyButtonVisible(false)
      if (this.readyStatusText) this.readyStatusText.enabled = false
      this.startCountdownActive = false
      if (this.countdownText) this.countdownText.enabled = false
    }
  }

  // Renders the lobby on this device. Safe to call before the store/host settle,
  // so the Ready button always appears at start regardless of network timing.
  private showLobbyLocally() {
    this.setReadyButtonVisible(!this.localReadyDone)
    if (this.readyStatusText) {
      this.readyStatusText.enabled = true
      const count = this.readyCountProp.currentOrPendingValue ?? 0
      this.readyStatusText.text = `${count}/2 Ready`
    }
    if (this.countdownText) { this.countdownText.enabled = false; this.countdownText.text = '' }
    if (this.questionText) this.questionText.text = ''
    this.startCountdownActive = false
    this.hideAnswerFeedback()
    this.setStatusText(this.localReadyDone
      ? 'Ready! Waiting for opponent…'
      : 'Tap Ready to start')
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

    const lines = [
      `ROLE: ${role}   (cached isHost: ${this.isHost})`,
      `user: ${this.localPlayerId}   users: ${userCount}`,
      `store: ready=${storeReady} owns=${owns} canWrite=${canModify}`,
      `phase: ${phase}   round: ${roundState}   buzzer: ${buzzer}`,
      `ready: ${readyCount}/2   (host=${this.hostReady} guest=${this.guestReady} me=${this.localReadyDone})`,
      `score: me=${this.localScore}   q.id=${this.currentQuestionId} ans=${this.correctAnswer}`,
      `timer: ${this.timerActive ? this.localTimeRemaining.toFixed(1) + 's' : 'off'}` +
        `   startCd: ${this.startCountdownActive ? this.startCountdown.toFixed(1) + 's' : 'off'}`,
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
    this.hostBuzzedTimeProp.setPendingValue('')
    this.guestBuzzedTimeProp.setPendingValue('')
    this.currentActiveBuzzerProp.setPendingValue('NONE')
    this.roundStateProp.setPendingValue('PLAYING')
    this.fetchAndSync()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Round state handlers
  // ───────────────────────────────────────────────────────────────────────────

  private handleRoundStateChange() {
    const state = this.roundStateProp.currentValue

    if (state === 'REVEAL_CORRECT') {
      this.timerActive = false
      this.hideAnswerFeedback()
      if (this.correctText) this.correctText.enabled = true
      this.nextRoundCountdown = this.nextRoundDelaySeconds
      this.nextRoundCountdownActive = true
      if (this.isHost) this.scheduleNextRound(this.nextRoundDelaySeconds)

    } else if (state === 'REVEAL_INCORRECT') {
      this.timerActive = false
      this.hideAnswerFeedback()
      if (this.incorrectText) this.incorrectText.enabled = true
      this.nextRoundCountdown = this.nextRoundDelaySeconds
      this.nextRoundCountdownActive = true
      if (this.isHost) this.scheduleNextRound(this.nextRoundDelaySeconds)

    } else if (state === 'PAUSED') {
      this.timerActive = false
      this.nextRoundCountdownActive = false
      this.hideAnswerFeedback()
      if (this.timerText) this.timerText.text = 'Paused'
      this.setStatusText('No answer — tap any option to continue')
    }
  }

  private handleBuzzerStateChange() {
    const activeBuzzer = this.currentActiveBuzzerProp.currentValue
    this.localHasAnsweredPhase = false

    const myStealTurn = (activeBuzzer === 'HOST_ONLY' && this.isHost)
                     || (activeBuzzer === 'GUEST_ONLY' && !this.isHost)

    if (activeBuzzer === 'NONE') {
      this.setStatusText('RACE! Buzz in first!')
    } else if (myStealTurn) {
      this.timerActive = true
      this.setStatusText('Opponent missed! YOUR TURN to steal!')
    } else {
      this.timerActive = false
      this.setStatusText('Opponent is answering…')
    }
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
      if (!hostToken && !guestToken) return

      const hostTime  = hostToken  ? parseInt(hostToken.split(':')[0])  : Infinity
      const guestTime = guestToken ? parseInt(guestToken.split(':')[0]) : Infinity
      const hostOpt   = hostToken  ? parseInt(hostToken.split(':')[1])  : -1
      const guestOpt  = guestToken ? parseInt(guestToken.split(':')[1]) : -1

      this.turnProcessed = true
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

  private processTurnAuthoritative(player: 'HOST' | 'GUEST', chosenOption: number) {
    this.timerActive = false

    const isCorrect         = chosenOption === this.correctAnswer
    const currentHostScore  = this.hostScoreProp.currentValue  ?? 0
    const currentGuestScore = this.guestScoreProp.currentValue ?? 0
    const activeBuzzer      = this.currentActiveBuzzerProp.currentValue

    this.log(`Turn: player=${player} option=${chosenOption} correct=${isCorrect}`)

    if (isCorrect) {
      if (player === 'HOST') {
        this.hostScoreProp.setPendingValue(currentHostScore + this.REWARD_POINTS)
      } else {
        this.guestScoreProp.setPendingValue(currentGuestScore + this.REWARD_POINTS)
      }
      this.roundStateProp.setPendingValue('REVEAL_CORRECT')

    } else {
      if (player === 'HOST') {
        this.hostScoreProp.setPendingValue(Math.max(0, currentHostScore - this.PENALTY_POINTS))
      } else {
        this.guestScoreProp.setPendingValue(Math.max(0, currentGuestScore - this.PENALTY_POINTS))
      }

      if (activeBuzzer === 'NONE') {
        // First wrong answer — open steal window and trigger roast for wrong player
        this.triggerRoastForWrongAnswer(player, 'roast1')

        this.hostBuzzedTimeProp.setPendingValue('')
        this.guestBuzzedTimeProp.setPendingValue('')
        this.turnProcessed = false
        const nextTarget = (player === 'HOST') ? 'GUEST_ONLY' : 'HOST_ONLY'
        this.currentActiveBuzzerProp.setPendingValue(nextTarget)

      } else {
        // Steal attempt also failed — trigger roast for stealing player
        this.triggerRoastForWrongAnswer(player, 'roast2')
        this.roundStateProp.setPendingValue('REVEAL_INCORRECT')
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Roast integration
  // ───────────────────────────────────────────────────────────────────────────

  private triggerRoastForWrongAnswer(
    wrongPlayer: 'HOST' | 'GUEST',
    roastField: 'roast1' | 'roast2'
  ) {
    if (!this.roastFetcherComponent) {
      this.log('roastFetcher not assigned — skipping roast')
      return
    }

    if (wrongPlayer === 'HOST') {
      // Host fetches and shows its own roast directly
      this.log(`Host fetching ${roastField} for question id:${this.currentQuestionId}`)
      this.roastFetcher.callFunctionWithId(this.currentQuestionId)
      if (roastField === 'roast1') {
        this.roastFetcher.fetchRoast1()
      } else {
        this.roastFetcher.fetchRoast2()
      }

    } else if (wrongPlayer === 'GUEST') {
      // Host sends a message telling the guest to fetch its own roast
      // The guest handles this in onMessageReceived and fetches locally
      const msg = `${MSG_HOST_ROAST}:${this.currentQuestionId}:${roastField}`
      this.log(`Sending roast instruction to guest: ${msg}`)
      this.hostSendMessage(msg)
    }
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

    if (this.timerActive) {
      this.localTimeRemaining -= getDeltaTime()
      if (this.localTimeRemaining <= 0) {
        this.localTimeRemaining = 0
        this.timerActive = false
        if (this.timerText) this.timerText.text = ''
        if (this.isHost) {
          this.turnProcessed = true
          this.roundStateProp.setPendingValue('PAUSED')
        }
      } else {
        if (this.timerText) this.timerText.text = this.localTimeRemaining.toFixed(1) + 's'
      }
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
    // Ignore option taps until the game is actually live (lobby / countdown).
    if (this.gamePhaseProp.currentOrPendingValue !== PHASE_ACTIVE) return

    const currentState = this.roundStateProp.currentValue

    if (currentState === 'PAUSED') {
      this.setStatusText('Resuming…')
      if (this.isHost) {
        this.startNextRound()
      } else {
        this.guestSendMessage(MSG_GUEST_RESUME)
      }
      return
    }

    if (this.localHasAnsweredPhase) return
    if (currentState !== 'PLAYING') return

    const currentBuzzerState = this.currentActiveBuzzerProp.currentValue
    if (currentBuzzerState === 'GUEST_ONLY' && this.isHost)  return
    if (currentBuzzerState === 'HOST_ONLY'  && !this.isHost) return

    this.localHasAnsweredPhase = true
    this.timerActive = false
    this.hideAnswerFeedback()

    const isCorrect = index === this.correctAnswer
    if (isCorrect) {
      if (this.correctText) this.correctText.enabled = true
      this.setStatusText('Correct! Syncing…')
    } else {
      if (this.incorrectText) this.incorrectText.enabled = true
      this.setStatusText(currentBuzzerState === 'NONE'
        ? 'Incorrect! Passing turn…'
        : 'Incorrect! Round over.')
    }

    if (this.isHost) {
      this.hostBuzzedTimeProp.setPendingValue(`${Date.now()}:${index}`)
    } else {
      this.guestSendMessage(`${MSG_GUEST_BUZZ}:${Date.now()}:${index}`)
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
          this.timerStartTokenProp.setPendingValue(`${this.roundDurationSeconds}:${Date.now()}`)
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
      if (this.questionText) this.questionText.text = String(record.question ?? '')
      this.setOptionText(0, String(record.option1 ?? ''))
      this.setOptionText(1, String(record.option2 ?? ''))
      this.setOptionText(2, String(record.option3 ?? ''))
      this.setOptionText(3, String(record.option4 ?? ''))
      this.localHasAnsweredPhase = false
      this.hideAnswerFeedback()

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

  private cacheOptionChildTextNodes() {
    this.optionTexts[0] = this.findButtonChildText(this.optionButton1)
    this.optionTexts[1] = this.findButtonChildText(this.optionButton2)
    this.optionTexts[2] = this.findButtonChildText(this.optionButton3)
    this.optionTexts[3] = this.findButtonChildText(this.optionButton4)
  }

  private findButtonChildText(btn: RectangleButton): Text | null {
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