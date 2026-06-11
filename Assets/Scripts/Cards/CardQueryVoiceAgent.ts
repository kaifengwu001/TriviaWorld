/**
 * Specs Inc. 2026
 * CardQueryVoiceAgent — the voice-driven card-search agent.
 *
 * The user, looking at the floating card cosmos above the globe, simply says what
 * they want ("find cards from Tokyo about botany"). This agent runs a Gemini Live
 * session with BOTH audio out AND mic in, plus FUNCTION CALLING: the model
 * extracts the keywords and calls query_cards / clear_query, which a
 * QueryOrchestrator executes against the CardStore while driving the cosmos
 * (spin-faster → fly the matches into a front row) and the globe (zoom to where
 * the cards were captured). After results, the same session answers questions
 * about whichever result card the user is looking at — no second agent needed,
 * because the matches' text is already in this session's context.
 *
 * SINGLE-SESSION RULE: the RSG gateway keeps only the newest live session alive,
 * so this agent and CardVoiceAgent must never be connected at once. When this one
 * starts it suspends CardVoiceAgent; CardVoiceAgent in turn no-ops/delegates while
 * this is active (see CardVoiceAgent.suspend / isActive checks). This mirrors how
 * NudgeVoice/WelcomeVoice delegate instead of opening a competing session.
 *
 * Lifecycle (lazy ensureStarted, connect, mic→PCM16→realtime_input, audio-out →
 * DynamicAudioOutput + agentSphere) mirrors CardVoiceAgent. Gemini Live does NOT
 * run in the Lens Studio simulator — test on device/Spectacles, online.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { Gemini } from "RemoteServiceGateway.lspkg/HostedExternal/GoogleGenAI";
import { GeminiTypes } from "RemoteServiceGateway.lspkg/HostedExternal/GoogleGenAITypes";
import { DynamicAudioOutput } from "RemoteServiceGateway.lspkg/Helpers/DynamicAudioOutput";
import { MicrophoneRecorder } from "RemoteServiceGateway.lspkg/Helpers/MicrophoneRecorder";
import { AudioProcessor } from "RemoteServiceGateway.lspkg/Helpers/AudioProcessor";
import { pcm16Rms, pcm16DurationSec } from "../AudioLevel";
import { acquireMic, releaseMic, safeStartRecording, MicWatchdog } from "../MicHealth";
import { BARGE_IN_INSTRUCTION, handleBargeIn } from "../VoiceBargeIn";
import { CardDeckController } from "./CardDeckController";
import { GlobeController } from "../Globe/GlobeController";
import { QueryOrchestrator, QUERY_TOOL_DECLARATIONS, ToolCall } from "./QueryOrchestrator";

// Seconds the user must look at the deck before the query agent arms itself.
// Covers the first arm and every re-arm (e.g. after a captured-card chat handed
// the live session to CardVoiceAgent).
const GAZE_ACTIVATE_DWELL_SEC = 1.5;

@component
export class CardQueryVoiceAgent extends BaseScriptComponent {
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Card Query Voice Agent (Gemini Live + tools)</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Listens in the cosmos view, extracts query keywords via function-calling, drives the deck + globe, then discusses results. Does NOT run in the simulator — test on device with internet.</span>')
  @ui.separator

  @ui.group_start("Setup (drag from the RemoteServiceGatewayExamples prefab)")
  @input
  @hint("The 'Websocket requirements' SceneObject. Enabled on first listen so the gateway WebSocket can connect.")
  private websocketRequirementsObj: SceneObject;

  @input
  @hint("A DEDICATED DynamicAudioOutput for this agent's voice (not shared with CardVoiceAgent/WelcomeVoice).")
  private dynamicAudioOutput: DynamicAudioOutput;

  @input
  @hint("A DEDICATED MicrophoneRecorder that captures the user's spoken query.")
  private microphoneRecorder: MicrophoneRecorder;
  @ui.group_end

  @ui.separator
  @ui.group_start("Scene references")
  @input
  @hint("The CardDeckController whose cosmos this agent drives (spin/results/focus).")
  private cardDeck: CardDeckController;

  @input
  @hint("The GlobeController to zoom on a result location. If unset, global.globeController is used.")
  @allowUndefined
  private globeController: GlobeController;
  @ui.group_end

  @ui.separator
  @ui.group_start("Activation")
  @input
  @hint("Automatically arm the mic when the user gazes at the deck (and the deck is in the scene). Off = start only via beginListening().")
  private autoStart: boolean = true;
  @ui.group_end

  @ui.separator
  @ui.group_start("Speech")
  @input
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Leda", "Leda"),
      new ComboBoxItem("Puck", "Puck"),
      new ComboBoxItem("Charon", "Charon"),
      new ComboBoxItem("Kore", "Kore"),
      new ComboBoxItem("Fenrir", "Fenrir"),
      new ComboBoxItem("Aoede", "Aoede"),
      new ComboBoxItem("Orus", "Orus"),
      new ComboBoxItem("Zephyr", "Zephyr"),
    ])
  )
  private voice: string = "Aoede";

  @input
  @widget(new TextAreaWidget())
  @hint("System instruction / persona for the query agent.")
  private persona: string =
    "You help the user find AR trivia cards floating in a deck above a globe. When they describe what " +
    "they want, call query_cards with the location, topic, date range, and/or keyword you extract, and " +
    "say a short warm line like 'Gotcha — finding those now!'. If query_cards returns zero cards, ask ONE " +
    "short clarifying question; if the next try still finds nothing, DROP your least-certain keyword and " +
    "query again, briefly narrating each step so the user follows along. When it returns cards, summarize " +
    "how many and where (e.g. 'I found 3 cards captured in Tokyo!'). If some matches can't be shown " +
    "(unshown > 0), mention that. After you summarize the results, STOP and wait silently — do NOT ask the " +
    "user what they want to know and do NOT invite follow-up questions; only speak again when the user " +
    "speaks first. At ANY point — including before any search — the user may ask about the card they're " +
    "looking at ('this card', 'this one', the card in front of them). You do NOT know which card that is " +
    "until you call get_focused_card, so ALWAYS call it first and answer from its text; never guess. NEVER " +
    "tell the user to run a search first when they're asking about a card in view — only if get_focused_card " +
    "reports no card is selected should you gently say you're not sure which card they mean and offer to " +
    "search. Do NOT bring the card up until they actually ask. Keep replies to one to three warm sentences. " +
    "To start over or undo, call clear_query.";

  @input
  @hint("Gemini Live model id (no 'models/' prefix). Supported: gemini-live-2.5-flash, gemini-2.0-flash-live-preview-04-09, gemini-live-2.5-flash-preview-native-audio")
  private model: string = "gemini-live-2.5-flash";
  @ui.group_end

  @ui.separator
  @ui.group_start("Logging")
  @input private enableLogging: boolean = true;
  @ui.group_end

  private logger: Logger;
  private liveSession: ReturnType<typeof Gemini.liveConnect>;
  private audioProcessor: AudioProcessor = new AudioProcessor();
  private orchestrator: QueryOrchestrator = null;
  private sessionReady = false;
  private setupStarted = false;
  private connecting = false;
  private micWired = false;
  private listening = false;
  private micWatchdog: MicWatchdog | null = null;
  // How long the user has been looking at the deck this dwell (for gaze-arm).
  private gazeDwell = 0;

  onAwake(): void {
    this.logger = new Logger("CardQueryVoiceAgent", this.enableLogging, true);
    // Reachable across prefabs (mirrors global.cardVoiceAgent). As with that agent,
    // do NOTHING heavy at launch — touching mic + a live session at startup blanks
    // the lens on-device. Everything defers to beginListening().
    (global as any).cardQueryVoiceAgent = this;
    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()));
  }

  /**
   * Opens the mic and brings the session online so the user can speak a query.
   * Wire this to whatever marks entry into the globe+cosmos view (NOT launch).
   * Safe to call repeatedly.
   */
  beginListening(): void {
    this.gazeDwell = 0;
    this.ensureStarted();
  }

  /** True when this agent holds a live, ready Gemini session. */
  isActive(): boolean {
    return this.sessionReady;
  }

  /**
   * Speak a one-off narration line through THIS agent's live session. One-shot
   * voices (NudgeVoice) call this instead of opening a competing session, since
   * the gateway keeps only the newest session alive. No-op if not ready.
   */
  speakIntent(intent: string): void {
    if (!intent || intent.trim().length === 0 || !this.sessionReady) return;
    const turn: GeminiTypes.Live.ClientContent = {
      client_content: {
        turns: [{ role: "user", parts: [{ text: intent }] }],
        turn_complete: true,
      },
    };
    this.liveSession.send(turn);
  }

  /**
   * Closes this agent's session and releases the mic so another agent
   * (CardVoiceAgent) can own the single live session. Re-entrant.
   */
  suspend(): void {
    if (this.micWatchdog) this.micWatchdog.end();
    if (this.listening && this.microphoneRecorder) {
      try { this.microphoneRecorder.stopRecording(); } catch (e) {}
      this.listening = false;
    }
    releaseMic(this);
    if (this.liveSession) {
      try { (this.liveSession as any).close?.(); } catch (e) {}
    }
    this.sessionReady = false;
    this.connecting = false;
    this.setupStarted = false; // a later beginListening() reconnects from scratch
  }

  // --- session lifecycle (mirrors CardVoiceAgent) ----------------------------

  private ensureStarted(): void {
    if (this.setupStarted) {
      if (!this.sessionReady && !this.connecting) this.connect();
      return;
    }
    if (!this.dynamicAudioOutput) { this.logger.error("dynamicAudioOutput not assigned."); return; }
    if (!this.microphoneRecorder) { this.logger.error("microphoneRecorder not assigned."); return; }

    // Single-session rule: take the live slot from CardVoiceAgent if it holds one.
    const cardAgent = (global as any).cardVoiceAgent;
    if (cardAgent && typeof cardAgent.suspend === "function") cardAgent.suspend();

    this.setupStarted = true;
    try {
      if (this.websocketRequirementsObj) this.websocketRequirementsObj.enabled = true;
      this.dynamicAudioOutput.initialize(24000);
      this.microphoneRecorder.setSampleRate(16000);
      this.connect();
    } catch (e) {
      this.logger.error("CardQueryVoiceAgent failed to start: " + e);
      this.setupStarted = false; // allow a retry
    }
  }

  private connect(): void {
    this.connecting = true;
    this.liveSession = Gemini.liveConnect();

    this.liveSession.onOpen.add(() => {
      this.logger.info("Gemini Live connection opened — sending setup");

      const generationConfig: GeminiTypes.Common.GenerationConfig = {
        responseModalities: ["AUDIO"],
        temperature: 1,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
      };

      const setupMessage: GeminiTypes.Live.Setup = {
        setup: {
          model: `models/${this.model}`,
          generation_config: generationConfig,
          system_instruction: { parts: [{ text: this.persona + BARGE_IN_INSTRUCTION }] },
          tools: [{ functionDeclarations: QUERY_TOOL_DECLARATIONS as any }],
          contextWindowCompression: {
            triggerTokens: 20000,
            slidingWindow: { targetTokens: 16000 },
          },
          output_audio_transcription: {},
          input_audio_transcription: {},
        },
      };
      this.liveSession.send(setupMessage);
    });

    this.liveSession.onMessage.add((message) => this.onMessage(message));

    this.liveSession.onError.add((event) => {
      this.connecting = false;
      this.logger.error("Gemini Live error: " + JSON.stringify(event));
    });

    this.liveSession.onClose.add((event) => {
      this.sessionReady = false;
      this.connecting = false;
      this.logger.warn("Gemini Live closed: " + JSON.stringify(event));
    });
  }

  private onMessage(message: any): void {
    if (message?.setupComplete) {
      this.sessionReady = true;
      this.connecting = false;
      this.logger.success("Gemini Live ready");
      this.setupMicStreaming();
      this.startListening();
      return;
    }

    // Barge-in: the user started talking over the agent. Gemini stops generating and
    // flags `interrupted`; flush the seconds of audio already buffered so the agent
    // goes quiet immediately. The session + mic stay open, so the user's speech is
    // already streaming up for the reply.
    if (handleBargeIn(message, this.dynamicAudioOutput)) return;

    // The model decided to run a query / clear — execute it and reply.
    if (message?.toolCall?.functionCalls) {
      this.handleToolCall(message.toolCall.functionCalls);
      return;
    }

    // Stream spoken audio out as it arrives + feed the orb/ring amplitude.
    const part = message?.serverContent?.modelTurn?.parts?.[0];
    if (part?.inlineData?.mimeType?.startsWith("audio/pcm")) {
      const audio = Base64.decode(part.inlineData.data);
      this.dynamicAudioOutput.addAudioFrame(audio);
      (global as any).agentSphere?.noteAudioFrame?.(
        pcm16Rms(audio, 2),
        pcm16DurationSec(audio, 24000)
      );
      return;
    }

    if (message?.serverContent?.outputTranscription?.text) {
      this.logger.info("Agent: " + message.serverContent.outputTranscription.text);
      (global as any).agentSubtitle?.pushText?.(message.serverContent.outputTranscription.text);
    }
    if (message?.serverContent?.inputTranscription?.text) {
      this.logger.info("User: " + message.serverContent.inputTranscription.text);
    }
  }

  private setupMicStreaming(): void {
    if (this.micWired) return;
    this.micWired = true;
    this.audioProcessor.onAudioChunkReady.add((encodedAudioChunk) => {
      const realtimeInput = {
        realtime_input: {
          media_chunks: [{ mime_type: "audio/pcm", data: encodedAudioChunk }],
        },
      } as GeminiTypes.Live.RealtimeInput;
      this.liveSession.send(realtimeInput);
    });
    this.microphoneRecorder.onAudioFrame.add((audioFrame) => {
      this.audioProcessor.processFrame(audioFrame);
    });
  }

  private startListening(): void {
    if (this.listening) return;
    // Shared-provider hygiene: claim the mic, cycle stop->start (recovers a latched
    // dead provider), and watchdog it until non-empty frames arrive. See MicHealth.
    acquireMic(this, "CardQueryVoiceAgent", () => this.releaseMicOnly());
    safeStartRecording(this.microphoneRecorder);
    if (!this.micWatchdog) {
      this.micWatchdog = new MicWatchdog(this, this.microphoneRecorder, this, "CardQueryVoiceAgent");
    }
    this.micWatchdog.begin();
    this.listening = true;
    this.logger.info("Microphone listening started — say what cards you're looking for.");
  }

  /** Mic-only release for handoffs: stop capturing but leave the session open. */
  private releaseMicOnly(): void {
    if (this.micWatchdog) this.micWatchdog.end();
    try { this.microphoneRecorder.stopRecording(); } catch (e) {}
    this.listening = false;
  }

  // --- tool calls ------------------------------------------------------------

  private handleToolCall(calls: any[]): void {
    const orch = this.ensureOrchestrator();
    for (const call of calls) {
      if (!orch) {
        this.sendToolResponse(call.id, call.name, { error: "query system unavailable" });
        continue;
      }
      const out = orch.run(call as ToolCall);
      this.sendToolResponse(call.id, out.name, out.response);
    }
  }

  private sendToolResponse(id: string, name: string, response: { [key: string]: any }): void {
    if (!this.liveSession) return;
    const msg: GeminiTypes.Live.ToolResponse = {
      tool_response: { function_responses: [{ id, name, response }] },
    };
    this.liveSession.send(msg);
  }

  private ensureOrchestrator(): QueryOrchestrator | null {
    if (this.orchestrator) return this.orchestrator;
    const globe = this.globeController ?? ((global as any).globeController as GlobeController);
    const store = (global as any).cropCardStore;
    if (!this.cardDeck || !globe || !store) {
      this.logger.warn("Orchestrator not ready (deck/globe/store missing).");
      return null;
    }
    this.orchestrator = new QueryOrchestrator(this.cardDeck, globe, store);
    return this.orchestrator;
  }

  // --- per-frame: globe reconcile + gaze activation --------------------------

  private update(dt: number): void {
    if (this.orchestrator) this.orchestrator.reconcileGlobe();

    // The query agent is tied to the deck's presence in the scene: when the deck
    // is gone (e.g. a future menu disables it) the agent must be dormant, so
    // release the mic if it still holds one.
    if (!this.isDeckPresent()) {
      if (this.sessionReady || this.connecting) this.suspend();
      this.gazeDwell = 0;
      return;
    }

    // Gaze-driven activation: arm when the user looks at the deck for the dwell.
    // Once active it stays active (no look-away suspend); CardVoiceAgent.suspend()
    // hands the mic off on a card tap, and looking back at the deck re-arms here.
    // BUT never open a session while WelcomeVoice still holds one — the gateway
    // keeps only the newest live session alive, and a second session at launch
    // blanks the lens on-device. The host's session closes after it announces the
    // user's interests, then gaze arms us normally.
    if (this.autoStart && !this.sessionReady && !this.connecting &&
        !this.isOnboardingVoiceActive() && !this.isCardVoiceActive() &&
        this.cardDeck.isUserGazingAtCosmos()) {
      this.gazeDwell += dt;
      if (this.gazeDwell >= GAZE_ACTIVATE_DWELL_SEC) {
        this.logger.info("User is looking at the deck — arming the query agent.");
        this.beginListening();
        // Reset the dwell so a failed/closed connect can't re-fire beginListening()
        // every frame (a connect + mic-acquire storm that overheats the device).
        // A genuine retry then needs a fresh 1.5s dwell.
        this.gazeDwell = 0;
      }
    } else {
      // Reset the dwell while the host holds the slot / we're not gazing, so a
      // fresh look is required once the welcome session frees the slot.
      this.gazeDwell = 0;
    }
  }

  // True only while the deck is actually present and active in the scene
  // hierarchy. isUserGazingAtCosmos() is pure geometry and would pass even for a
  // disabled deck, so this gate is required before arming on gaze.
  private isDeckPresent(): boolean {
    return !!this.cardDeck && this.cardDeck.getSceneObject().isEnabledInHierarchy;
  }

  // True while either onboarding voice still holds the single live session: the
  // WelcomeVoice host (launch → Start) or the RecommendationVoiceAgent (Start → card
  // pick). We wait them out rather than evict — opening a second session at launch
  // blanks the lens on-device, and the gateway keeps only the newest alive anyway.
  private isOnboardingVoiceActive(): boolean {
    const host = (global as any).hostVoice;
    const rec = (global as any).recommendationVoiceAgent;
    const hostActive = !!host && typeof host.isActive === "function" && host.isActive();
    const recActive = !!rec && typeof rec.isActive === "function" && rec.isActive();
    return hostActive || recActive;
  }

  // True while a CardVoiceAgent card conversation holds the single live session.
  // Prayer-gesture-discovered cards are engaged WHILE the user gazes at the cosmos,
  // so without this gate the gaze-arming above would immediately steal the session
  // back from the card the user just tapped — the two agents then thrash the one
  // session (reconnect + mic re-acquire each cycle) and overheat the device. We
  // stand down while a card is being discussed; the card's session later idle-closes,
  // after which gaze re-arms the query agent normally.
  private isCardVoiceActive(): boolean {
    const cardAgent = (global as any).cardVoiceAgent;
    return !!cardAgent && typeof cardAgent.isActive === "function" && cardAgent.isActive();
  }
}
