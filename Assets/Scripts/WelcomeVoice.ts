/**
 * Specs Inc. 2026
 * WelcomeVoice — the responsive, voice-driven welcome host.
 *
 * Connects to the Gemini Live API through the Remote Service Gateway (so NO
 * Internet Access capability and NO on-device key are needed) and runs a real
 * two-way conversation: it GENERATES a warm greeting a few seconds after launch,
 * then LISTENS (mic in) and helps the user pick their topics by voice. As the user
 * names interests the model calls select_topics / deselect_topics (which toggle the
 * TopicSelectionPanel's buttons for them); when the user says they're ready it calls
 * start_exploring (which presses Start). Lines are generated, not scripted, and the
 * host barges-in — it stops the instant the user speaks (Gemini server-side VAD).
 *
 * SINGLE-SESSION RULE: the RSG gateway keeps only the newest live session alive, so
 * at launch the host is the SOLE session (one mic session is safe — the on-device
 * blank-out comes from a SECOND simultaneous session). On Start the panel calls
 * suspend() here and engage() on the RecommendationVoiceAgent, handing the slot off.
 * Registered at global.hostVoice; other agents poll isActive() so they don't open a
 * competing session while the host still holds it.
 *
 * NOTE: Gemini Live runs over a WebSocket on the gateway — it does NOT work in the
 * Lens Studio simulator. Test on device (or Preview with Device Type Override =
 * Spectacles) and make sure the glasses are online.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { Gemini } from "RemoteServiceGateway.lspkg/HostedExternal/GoogleGenAI";
import { GeminiTypes } from "RemoteServiceGateway.lspkg/HostedExternal/GoogleGenAITypes";
import { DynamicAudioOutput } from "RemoteServiceGateway.lspkg/Helpers/DynamicAudioOutput";
import { MicrophoneRecorder } from "RemoteServiceGateway.lspkg/Helpers/MicrophoneRecorder";
import { AudioProcessor } from "RemoteServiceGateway.lspkg/Helpers/AudioProcessor";
import { pcm16Rms, pcm16DurationSec } from "./AudioLevel";
import { acquireMic, releaseMic, safeStartRecording, MicWatchdog } from "./MicHealth";
import { BARGE_IN_INSTRUCTION, handleBargeIn } from "./VoiceBargeIn";
import { TOPIC_TOOL_DECLARATIONS, runTopicTool, TopicPanelLike } from "./Interests/TopicAgentTools";

@component
export class WelcomeVoice extends BaseScriptComponent {
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Welcome Voice (Gemini Live + mic + tools)</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Generative host that greets, listens, and selects topics + presses Start for the user by voice. Barges-in when the user speaks. Does NOT run in the simulator — test on device with internet.</span>')
  @ui.separator

  @ui.group_start("Setup (drag from the RemoteServiceGatewayExamples prefab)")
  @input
  @hint("The 'Websocket requirements' SceneObject from the RemoteServiceGatewayExamples prefab. Enabled on launch so the gateway WebSocket can connect.")
  private websocketRequirementsObj: SceneObject;

  @input
  @hint("The 'DynamicAudioOutput' object from the RemoteServiceGatewayExamples prefab (it carries the AudioComponent + audio-output track that plays the voice).")
  private dynamicAudioOutput: DynamicAudioOutput;

  @input
  @hint("A MicrophoneRecorder that captures the user's speech (can be shared with the RecommendationVoiceAgent — they never run at once).")
  private microphoneRecorder: MicrophoneRecorder;
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
  private voice: string = "Leda";

  @input
  @widget(new TextAreaWidget())
  @hint("What the launch greeting should convey (the model says it in its own words, so wording varies).")
  // Renamed from greetingIntent so a stale saved inspector value can't override this.
  private greetingText: string =
    "Warmly welcome the user to TriviaGo. Say you're excited to learn and explore the world together with them. Then invite them to tell you what kinds of things they're curious about, so you can set up their topics. Keep it to about two short, natural sentences.";

  @input
  @hint("Seconds after launch before the welcome greeting")
  private delaySeconds: number = 5;

  @input
  @hint("Seconds after launch before the host starts LISTENING (opening the mic). Deferred past the Connected Lenses session spin-up at launch, which otherwise yields a silent mic. Keep it at/after the greeting delay.")
  private listenDelaySeconds: number = 7;

  @input
  @widget(new TextAreaWidget())
  @hint("Host persona / system instruction. The model converses naturally and drives the topic panel through its tools.")
  // Single string literal (NOT concatenated) so Lens Studio populates the inspector
  // default — a `"a" + "b"` default leaves the field blank in the editor.
  private hostPersona: string =
    "You are the warm, upbeat first-person voice host of TriviaGo, an AR learning companion, talking with the user as they look at a panel of topic buttons. Your job is to help them pick the topics they're curious about and then start. LISTEN and respond naturally — never read instructions back, no stage directions or quotation marks. As soon as the user mentions interests, call select_topics with the matching topic names (map loose phrasing like 'science' or 'space stuff' to the closest available topics), then briefly confirm what you selected and ask if they'd like to add anything else or are ready to start. If they want to remove a topic, call deselect_topics. When the user says they're ready (or to go ahead / start), call start_exploring. Don't start until they've confirmed. Keep every reply to one or two short, friendly sentences, and vary your wording.";

  @input
  @hint("Gemini Live model id (no 'models/' prefix — it's added automatically). Supported: gemini-live-2.5-flash, gemini-2.0-flash-live-preview-04-09, gemini-live-2.5-flash-preview-native-audio")
  private model: string = "gemini-live-2.5-flash";
  @ui.group_end

  @ui.separator
  @ui.group_start("Logging")
  @input private enableLogging: boolean = true;
  @ui.group_end

  private logger: Logger;
  private liveSession: ReturnType<typeof Gemini.liveConnect>;
  private audioProcessor: AudioProcessor = new AudioProcessor();
  private sessionReady = false;
  // True from the instant we start connecting until the session closes — covers
  // the ~1s setup window before sessionReady flips, which is exactly when other
  // agents must NOT open a competing session (a 2nd session at launch blanks the
  // lens on-device). isActive() reports this, not sessionReady.
  private sessionLive = false;
  private micWired = false;
  private listening = false;
  private micWatchdog: MicWatchdog | null = null;
  // Intents sent before the session was ready, flushed in order on setupComplete.
  private pendingIntents: string[] = [];

  onAwake(): void {
    this.logger = new Logger("WelcomeVoice", this.enableLogging, true);

    // Let other scripts (e.g. the topic panel) drive / poll the host voice.
    (global as any).hostVoice = this;

    if (this.websocketRequirementsObj) {
      this.websocketRequirementsObj.enabled = true;
    } else {
      this.logger.error("websocketRequirementsObj not assigned — gateway WebSocket may fail.");
    }

    this.createEvent("OnStartEvent").bind(() => this.onStart());
  }

  private onStart(): void {
    // Quick-crop mode: no welcome host at all. Bail before opening a session, so the
    // mic/live slot stays free and isActive() stays false. (websocketRequirementsObj
    // was already enabled in onAwake; NudgeVoice still needs the gateway.)
    const store = (global as any).cropInterestStore;
    if (store && typeof store.isSkippingOnboarding === "function" && store.isSkippingOnboarding()) {
      this.logger.info("Quick-crop mode ON — welcome voice disabled.");
      return;
    }

    if (!this.dynamicAudioOutput) {
      this.logger.error("dynamicAudioOutput not assigned — assign the prefab's DynamicAudioOutput.");
      return;
    }
    if (!this.microphoneRecorder) {
      this.logger.error("microphoneRecorder not assigned — the host won't be able to listen.");
      return;
    }

    // Gemini Live streams audio back at 24 kHz; the mic captures at 16 kHz.
    this.dynamicAudioOutput.initialize(24000);
    this.microphoneRecorder.setSampleRate(16000);
    this.connect();

    // Fire the welcome greeting at the chosen delay. If the session isn't ready
    // yet (usually ready within ~1s), speakIntent() queues it for setupComplete.
    const delay = Math.max(0, this.delaySeconds);
    this.logger.info(`Welcome greeting scheduled in ${delay}s`);
    const delayed = this.createEvent("DelayedCallbackEvent");
    delayed.bind(() => this.speakIntent(this.greetingText));
    delayed.reset(delay);

    // Open the mic LATER, not at launch: starting capture ~1s in collides with the
    // Connected Lenses session spin-up and yields a silent mic (0 samples). The card
    // agents avoid this by opening the mic lazily; we mirror that with a delay.
    const listenDelay = Math.max(0, this.listenDelaySeconds);
    this.logger.info(`Host will start listening in ${listenDelay}s`);
    const listenDelayed = this.createEvent("DelayedCallbackEvent");
    listenDelayed.bind(() => this.startListening());
    listenDelayed.reset(listenDelay);
  }

  /** Connect to Gemini Live and configure audio, mic, and the topic tools. */
  private connect(): void {
    this.sessionLive = true; // hold the slot from the moment we start connecting
    this.liveSession = Gemini.liveConnect();

    this.liveSession.onOpen.add(() => {
      this.logger.info("Gemini Live connection opened — sending setup");

      const generationConfig: GeminiTypes.Common.GenerationConfig = {
        responseModalities: ["AUDIO"],
        temperature: 1,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.voice },
          },
        },
      };

      const setupMessage: GeminiTypes.Live.Setup = {
        setup: {
          model: `models/${this.model}`,
          generation_config: generationConfig,
          system_instruction: {
            parts: [{ text: this.hostPersona + BARGE_IN_INSTRUCTION }],
          },
          tools: [{ functionDeclarations: TOPIC_TOOL_DECLARATIONS as any }],
          output_audio_transcription: {},
          input_audio_transcription: {},
        },
      };
      this.liveSession.send(setupMessage);
    });

    this.liveSession.onMessage.add((message) => this.onMessage(message));

    this.liveSession.onError.add((event) => {
      this.logger.error("Gemini Live error: " + JSON.stringify(event));
    });

    this.liveSession.onClose.add((event) => {
      this.sessionReady = false;
      this.sessionLive = false;
      this.logger.warn("Gemini Live closed: " + JSON.stringify(event));
    });
  }

  private onMessage(message: any): void {
    if (message?.setupComplete) {
      this.sessionReady = true;
      this.logger.success("Gemini Live ready");
      // Wire the mic handlers now, but DON'T start recording yet — startListening()
      // fires on the deferred timer in onStart() to dodge the launch-time mic stall.
      this.setupMicStreaming();
      if (this.pendingIntents.length > 0) {
        const queued = this.pendingIntents;
        this.pendingIntents = [];
        queued.forEach((intent) => this.sendIntentTurn(intent));
      }
      return;
    }

    // Barge-in: the user started talking over the host. Gemini stops generating and
    // flags `interrupted`; flush the buffered audio so the host goes quiet at once.
    // The session + mic stay open, so the user's speech is already streaming up.
    if (handleBargeIn(message, this.dynamicAudioOutput)) return;

    // The model decided to select topics / press start — execute it and reply.
    if (message?.toolCall?.functionCalls) {
      this.handleToolCall(message.toolCall.functionCalls);
      return;
    }

    // Stream spoken audio out as it arrives + feed the orb/ring amplitude.
    const part = message?.serverContent?.modelTurn?.parts?.[0];
    if (part?.inlineData?.mimeType?.startsWith("audio/pcm")) {
      const audio = Base64.decode(part.inlineData.data);
      this.dynamicAudioOutput.addAudioFrame(audio);
      // Loudness + playback duration so the orb/ring stays in sync with the
      // audible voice (frames arrive in a burst, then play out over seconds).
      (global as any).agentSphere?.noteAudioFrame?.(
        pcm16Rms(audio, 2),
        pcm16DurationSec(audio, 24000)
      );
      return;
    }

    if (message?.serverContent?.outputTranscription?.text) {
      this.logger.info("Host: " + message.serverContent.outputTranscription.text);
      (global as any).agentSubtitle?.pushText?.(message.serverContent.outputTranscription.text);
    }
    if (message?.serverContent?.inputTranscription?.text) {
      this.logger.info("User: " + message.serverContent.inputTranscription.text);
    }
  }

  private setupMicStreaming(): void {
    if (this.micWired) return;
    this.micWired = true;
    // Diagnostics: distinguish "no frames" / "all-empty frames (mic not capturing)" /
    // "real audio flowing". Logs a summary roughly once a second for the first ~5s.
    let frames = 0;
    let nonEmpty = 0;
    let chunks = 0;
    this.audioProcessor.onAudioChunkReady.add((encodedAudioChunk) => {
      chunks++;
      const realtimeInput = {
        realtime_input: {
          media_chunks: [{ mime_type: "audio/pcm", data: encodedAudioChunk }],
        },
      } as GeminiTypes.Live.RealtimeInput;
      this.liveSession.send(realtimeInput);
    });
    this.microphoneRecorder.onAudioFrame.add((audioFrame) => {
      frames++;
      if (audioFrame.length > 0) nonEmpty++;
      if (frames <= 300 && frames % 60 === 0) {
        this.logger.info(
          `Mic: ${frames} frames, ${nonEmpty} non-empty, ${chunks} chunks sent to Gemini.`
        );
      }
      this.audioProcessor.processFrame(audioFrame);
    });
  }

  private startListening(): void {
    if (this.listening) return;
    // Defensive: make sure the mic→Gemini handlers are wired (normally done on
    // setupComplete, but the deferred timer could fire first on a slow connect).
    this.setupMicStreaming();
    // All recorders share ONE MicrophoneAudioProvider: claim it (stopping whichever
    // agent held it), cycle stop->start to clear a launch-latched dead provider, and
    // arm the watchdog that keeps cycling while frames stay empty.
    acquireMic(this, "WelcomeVoice", () => this.releaseMicOnly());
    safeStartRecording(this.microphoneRecorder);
    if (!this.micWatchdog) {
      this.micWatchdog = new MicWatchdog(this, this.microphoneRecorder, this, "WelcomeVoice");
    }
    this.micWatchdog.begin();
    this.listening = true;
    this.logger.info("Microphone listening started — tell the host what you're curious about.");
  }

  /** Mic-only release for handoffs: stop capturing but leave the session open. */
  private releaseMicOnly(): void {
    if (this.micWatchdog) this.micWatchdog.end();
    try { this.microphoneRecorder.stopRecording(); } catch (e) {}
    this.listening = false;
  }

  // --- tool calls ------------------------------------------------------------

  private handleToolCall(calls: any[]): void {
    const panel = (global as any).topicPanel as TopicPanelLike;
    for (const call of calls) {
      const out = runTopicTool(call, panel ?? null);
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

  /**
   * True while the host holds a live Gemini session (from launch until it closes on
   * Start). Other agents poll this so they don't open a second live session at once —
   * the gateway keeps only the newest alive, and a second session at launch blanks
   * the lens on-device.
   */
  isActive(): boolean {
    return this.sessionLive;
  }

  /**
   * Speak an intent: the model generates a short, natural line conveying it (so the
   * wording varies). If the session isn't ready yet, the intent is queued and sent on
   * setupComplete. Used for the launch greeting.
   */
  speakIntent(intent: string): void {
    if (!intent || intent.trim().length === 0) return;
    if (!this.sessionReady) {
      this.pendingIntents.push(intent);
      return;
    }
    this.sendIntentTurn(intent);
  }

  /**
   * Close the host's session and release the mic so the RecommendationVoiceAgent can
   * own the single live session. Called by TopicSelectionPanel on Start. Re-entrant.
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
    this.sessionLive = false;
  }

  private sendIntentTurn(intent: string): void {
    this.logger.info("Speaking intent: " + intent);
    const turn: GeminiTypes.Live.ClientContent = {
      client_content: {
        turns: [{ role: "user", parts: [{ text: intent }] }],
        turn_complete: true,
      },
    };
    this.liveSession.send(turn);
  }
}
