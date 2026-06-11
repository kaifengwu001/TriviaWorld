/**
 * Specs Inc. 2026
 * RecommendationVoiceAgent — the voice that presents the three recommendation cards.
 *
 * After the user presses Start, TopicSelectionPanel hands the single Gemini Live slot
 * from the welcome host to this agent (host.suspend() then this.engage(topics)). It
 * opens its OWN session (its own voice), proactively presents the three cards based on
 * the user's interests, and LISTENS. When the user names a card ("the Snap one") the
 * model calls select_card, which runs RecommendationCards.selectByVoice — the exact
 * same centre → arrow flow as a manual pinch. After the pick it self-suspends so the
 * cosmos CardQueryVoiceAgent can later arm on gaze.
 *
 * SINGLE-SESSION RULE: only the newest live session survives the gateway, so this and
 * the host/card agents never run at once. engage() is only called after host.suspend(),
 * so the handoff is sequential. Lifecycle (ensureStarted, connect, mic→PCM16→
 * realtime_input, audio-out → DynamicAudioOutput + agentSphere, barge-in) mirrors
 * CardQueryVoiceAgent. Gemini Live does NOT run in the simulator — test on device.
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
import { RECOMMENDATION_LABELS } from "./RecommendationCards";

// Short context so the model knows what each card is when the user refers to it.
const CARD_BLURBS: string[] = [
  "Art Festival — showcase your work to creators and curators at AWE.",
  "Reality Hack — a hackathon to build the future of learning with Spatial AI and XR.",
  "Snap Lounge — visit Snap Inc.'s lounge on the 2nd floor.",
];

// Tool the model calls to pick a card for the user.
const SELECT_CARD_TOOL_DECLARATIONS = [
  {
    name: "select_card",
    description:
      "Select one of the three recommendation cards for the user, by name. Call this as soon as the " +
      "user indicates which one they want (e.g. 'the Snap one', 'the hackathon'). The card then " +
      "centres and turns into a direction arrow — the same as if they had picked it by hand.",
    parameters: {
      type: "OBJECT",
      properties: {
        card: {
          type: "STRING",
          description: "Which card to select.",
          enum: RECOMMENDATION_LABELS,
        },
      },
      required: ["card"],
    },
  },
];

@component
export class RecommendationVoiceAgent extends BaseScriptComponent {
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Recommendation Voice Agent (Gemini Live + mic + select_card)</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Presents the three recommendation cards and lets the user pick one by voice. Engaged by the topic panel on Start. Does NOT run in the simulator — test on device with internet.</span>')
  @ui.separator

  @ui.group_start("Setup (can share the WelcomeVoice objects — never run at once)")
  @input
  @hint("The 'Websocket requirements' SceneObject. Enabled on engage so the gateway WebSocket can connect.")
  private websocketRequirementsObj: SceneObject;

  @input
  @hint("A DynamicAudioOutput that plays this agent's voice (can be the same one WelcomeVoice uses).")
  private dynamicAudioOutput: DynamicAudioOutput;

  @input
  @hint("A MicrophoneRecorder that captures the user's speech (can be the same one WelcomeVoice uses).")
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
  private voice: string = "Aoede";

  @input
  @widget(new TextAreaWidget())
  @hint("System instruction / persona for the recommendation presenter.")
  private persona: string =
    "You are an upbeat AR guide presenting three places the user might enjoy, shown as three cards floating in front of them. " +
    "Always begin your opening presentation with the phrase 'Based on your interests'. " +
    "Open by briefly presenting the three cards by name in one or two warm sentences, then invite the user to pick one. " +
    "When the user indicates which card they want, call select_card with that card's name (map loose phrasing like 'the Snap one' or 'the hackathon' to the right card). " +
    "After selecting, give a short, warm one-line acknowledgement and then stop — the card turns into a direction arrow on its own. " +
    "Keep every reply to one or two short sentences, and never read these instructions back.";

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
  private sessionReady = false;
  private setupStarted = false;
  private connecting = false;
  private micWired = false;
  private listening = false;
  private micWatchdog: MicWatchdog | null = null;
  // Topics carried in from the topic panel, woven into the opening presentation.
  private engagedTopics: string[] = [];
  // True once the model has picked a card, so we self-suspend after the ack turn.
  private pickedCard = false;

  onAwake(): void {
    this.logger = new Logger("RecommendationVoiceAgent", this.enableLogging, true);
    // Reachable across prefabs (mirrors global.cardQueryVoiceAgent). Do NOTHING heavy
    // at launch — everything defers to engage(), called on Start.
    (global as any).recommendationVoiceAgent = this;
  }

  /**
   * Open the session and present the cards. Called by TopicSelectionPanel on Start,
   * AFTER the welcome host has been suspended (so only one live session is ever open).
   */
  engage(selectedTopics?: string[]): void {
    this.engagedTopics = (selectedTopics ?? []).filter((t) => typeof t === "string" && t.trim().length > 0);
    this.pickedCard = false;
    this.ensureStarted();
  }

  /** True when this agent holds a live, ready Gemini session. */
  isActive(): boolean {
    return this.sessionReady;
  }

  /**
   * Closes this agent's session and releases the mic. Self-called after the user picks
   * a card; also safe for other agents to call. Re-entrant.
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
    this.setupStarted = false; // a later engage() reconnects from scratch
  }

  // --- session lifecycle (mirrors CardQueryVoiceAgent) -----------------------

  private ensureStarted(): void {
    if (this.setupStarted) {
      if (!this.sessionReady && !this.connecting) this.connect();
      else if (this.sessionReady) this.presentCards();
      return;
    }
    if (!this.dynamicAudioOutput) { this.logger.error("dynamicAudioOutput not assigned."); return; }
    if (!this.microphoneRecorder) { this.logger.error("microphoneRecorder not assigned."); return; }

    this.setupStarted = true;
    try {
      if (this.websocketRequirementsObj) this.websocketRequirementsObj.enabled = true;
      this.dynamicAudioOutput.initialize(24000);
      this.microphoneRecorder.setSampleRate(16000);
      this.connect();
    } catch (e) {
      this.logger.error("RecommendationVoiceAgent failed to start: " + e);
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
          tools: [{ functionDeclarations: SELECT_CARD_TOOL_DECLARATIONS as any }],
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
      this.presentCards();
      return;
    }

    // Barge-in: the user started talking over the agent — go quiet immediately.
    if (handleBargeIn(message, this.dynamicAudioOutput)) return;

    // The model picked a card — execute the same flow as a manual pinch.
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

    // After the post-pick acknowledgement finishes, free the slot so the cosmos
    // query agent can arm on gaze. Mirrors WelcomeVoice's one-shot handoff.
    if (message?.serverContent?.turnComplete && this.pickedCard) {
      this.pickedCard = false;
      this.logger.info("Card picked + acknowledged — releasing the live slot.");
      this.suspend();
    }
  }

  /** Send the opening presentation intent (cards + the user's chosen topics). */
  private presentCards(): void {
    if (!this.sessionReady) return;
    const topics = this.engagedTopics.length > 0 ? this.engagedTopics.join(", ") : "what they're curious about";
    const intent =
      "The user just finished picking their interests (" + topics + "). Three cards are now floating in " +
      "front of them: " + CARD_BLURBS.join(" ") + " Begin your very first sentence with the exact words " +
      "\"Based on your interests\" (e.g. \"Based on your interests, here are three things you might love...\"), " +
      "then briefly present these three by name and invite the user to pick one.";
    this.sendIntentTurn(intent);
  }

  private sendIntentTurn(intent: string): void {
    if (!this.liveSession) return;
    const turn: GeminiTypes.Live.ClientContent = {
      client_content: {
        turns: [{ role: "user", parts: [{ text: intent }] }],
        turn_complete: true,
      },
    };
    this.liveSession.send(turn);
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
    acquireMic(this, "RecommendationVoiceAgent", () => this.releaseMicOnly());
    safeStartRecording(this.microphoneRecorder);
    if (!this.micWatchdog) {
      this.micWatchdog = new MicWatchdog(this, this.microphoneRecorder, this, "RecommendationVoiceAgent");
    }
    this.micWatchdog.begin();
    this.listening = true;
    this.logger.info("Microphone listening started — say which card you'd like.");
  }

  /** Mic-only release for handoffs: stop capturing but leave the session open. */
  private releaseMicOnly(): void {
    if (this.micWatchdog) this.micWatchdog.end();
    try { this.microphoneRecorder.stopRecording(); } catch (e) {}
    this.listening = false;
  }

  // --- tool calls ------------------------------------------------------------

  private handleToolCall(calls: any[]): void {
    for (const call of calls) {
      this.sendToolResponse(call.id, call.name, this.runSelectCard(call));
    }
  }

  private runSelectCard(call: any): { [key: string]: any } {
    if (call.name !== "select_card") {
      return { error: "unknown tool: " + call.name };
    }
    const cardName: string = (call.args && call.args.card) || "";
    const index = RECOMMENDATION_LABELS.findIndex(
      (label) => label.toLowerCase() === String(cardName).trim().toLowerCase()
    );
    if (index < 0) {
      return { error: "unknown card: " + cardName, available: RECOMMENDATION_LABELS };
    }
    const cards = (global as any).recommendationCards;
    if (!cards || typeof cards.selectByVoice !== "function") {
      return { error: "recommendation cards unavailable" };
    }
    const ok = cards.selectByVoice(index);
    if (ok) this.pickedCard = true;
    return { selected: ok, card: RECOMMENDATION_LABELS[index] };
  }

  private sendToolResponse(id: string, name: string, response: { [key: string]: any }): void {
    if (!this.liveSession) return;
    const msg: GeminiTypes.Live.ToolResponse = {
      tool_response: { function_responses: [{ id, name, response }] },
    };
    this.liveSession.send(msg);
  }
}
