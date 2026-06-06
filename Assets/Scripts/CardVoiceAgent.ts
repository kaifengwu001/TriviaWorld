/**
 * Specs Inc. 2026
 * CardVoiceAgent — the card-aware, conversational half of the voice agent.
 *
 * Unlike WelcomeVoice (a one-way verbatim TTS narrator), this opens a Gemini
 * Live session with BOTH audio output AND microphone input, so the user can
 * speak follow-up questions. When the user pinches/taps a trivia card,
 * PictureBehavior calls engageCard(captionText): the agent proactively speaks a
 * short extra fact about that card, then listens for and answers questions —
 * grounded in the card's caption (which already carries #Interest #Subject #Tag)
 * and the user's selected interests (read from global.cropInterestStore).
 *
 * Registered at global.cardVoiceAgent so cards can reach it across prefab
 * boundaries (mirrors the global.cropInterestStore pattern in InterestStore.ts).
 *
 * Audio is streamed back as PCM (24 kHz) through a DynamicAudioOutput; mic frames
 * are captured by MicrophoneRecorder (16 kHz), converted to PCM16 by
 * AudioProcessor, and streamed up as realtime_input. The mic-loop mirrors the
 * canonical ExampleGeminiLive in the RemoteServiceGateway package.
 *
 * NOTE: Gemini Live runs over a WebSocket on the gateway — it does NOT work in
 * the Lens Studio simulator. Test on device (or Preview with Device Type
 * Override = Spectacles) and make sure the glasses are online.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { Gemini } from "RemoteServiceGateway.lspkg/HostedExternal/GoogleGenAI";
import { GeminiTypes } from "RemoteServiceGateway.lspkg/HostedExternal/GoogleGenAITypes";
import { DynamicAudioOutput } from "RemoteServiceGateway.lspkg/Helpers/DynamicAudioOutput";
import { MicrophoneRecorder } from "RemoteServiceGateway.lspkg/Helpers/MicrophoneRecorder";
import { AudioProcessor } from "RemoteServiceGateway.lspkg/Helpers/AudioProcessor";

@component
export class CardVoiceAgent extends BaseScriptComponent {
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Card Voice Agent (Gemini Live, two-way)</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Conversational agent with mic input. Tap a card and it speaks an extra fact, then answers spoken follow-ups. Does NOT run in the simulator — test on device with internet.</span>')
  @ui.separator

  @ui.group_start("Setup (drag from the RemoteServiceGatewayExamples prefab)")
  @input
  @hint("The 'Websocket requirements' SceneObject. Enabled on launch so the gateway WebSocket can connect.")
  private websocketRequirementsObj: SceneObject;

  @input
  @hint("A DynamicAudioOutput that plays the agent's voice. Use a DEDICATED one (not the same instance as WelcomeVoice) so the two sessions don't fight over playback.")
  private dynamicAudioOutput: DynamicAudioOutput;

  @input
  @hint("The MicrophoneRecorder that captures the user's voice for follow-up questions.")
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
  @hint("System instruction / persona for the conversational agent.")
  private persona: string =
    "You are a warm, patient, encouraging teacher/mentor/museum-guide voice for an AR trivia lens. The user explores cards, " +
    "each showing an interesting fact. When given a card's context, add ONE extra specific, accurate " +
    "detail related to it (never just repeat the caption), then invite them to ask anything. Answer " +
    "follow-up questions conversationally in one to three sentences, staying on that card's subject " +
    "unless the user changes topic. Stay accurate; if you are unsure, say so briefly.";

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
  private setupStarted = false;
  private listening = false;
  // Latest card context waiting to be sent once the session is ready.
  private pendingCaption: string | null = null;
  // Last caption we sent context for, so repeated taps on the same card no-op.
  private currentCaption: string | null = null;

  onAwake(): void {
    this.logger = new Logger("CardVoiceAgent", this.enableLogging, true);

    // Cards reach the agent through this global (same pattern as cropInterestStore).
    // IMPORTANT: do NOTHING heavy at launch — no gateway enable, no audio init, no
    // mic, no Gemini connection. Touching the microphone + a second live session at
    // startup blanks the lens on-device. Everything is deferred to the first card tap.
    (global as any).cardVoiceAgent = this;
  }

  /**
   * Lazily brings the agent online the first time a card is tapped: enables the
   * gateway rig, initializes audio + mic, and opens the Gemini Live session.
   * Wrapped in try/catch so a wiring problem logs instead of throwing (which on
   * device can take the whole lens down).
   */
  private ensureStarted(): void {
    if (this.setupStarted) return;
    if (!this.dynamicAudioOutput) {
      this.logger.error("dynamicAudioOutput not assigned.");
      return;
    }
    if (!this.microphoneRecorder) {
      this.logger.error("microphoneRecorder not assigned.");
      return;
    }
    this.setupStarted = true;
    try {
      if (this.websocketRequirementsObj) {
        this.websocketRequirementsObj.enabled = true;
      }
      // Gemini Live streams audio back at 24 kHz; the mic uploads at 16 kHz.
      this.dynamicAudioOutput.initialize(24000);
      this.microphoneRecorder.setSampleRate(16000);
      this.connect();
    } catch (e) {
      this.logger.error("CardVoiceAgent failed to start: " + e);
      this.setupStarted = false; // allow a retry on the next tap
    }
  }

  /** Connect a conversational Gemini Live session (audio out + mic in). */
  private connect(): void {
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
            parts: [{ text: this.persona }],
          },
          // Keep multi-card conversations from overflowing the context window.
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

    this.liveSession.onMessage.add((message) => {
      if (message?.setupComplete) {
        this.sessionReady = true;
        this.logger.success("Gemini Live ready");
        this.setupMicStreaming();
        // If a card was tapped before the session was ready, send it now.
        if (this.pendingCaption !== null) {
          const queued = this.pendingCaption;
          this.pendingCaption = null;
          this.sendCardContext(queued);
        }
        return;
      }

      // Stream spoken audio out as it arrives.
      const part = message?.serverContent?.modelTurn?.parts?.[0];
      if (part?.inlineData?.mimeType?.startsWith("audio/pcm")) {
        const audio = Base64.decode(part.inlineData.data);
        this.dynamicAudioOutput.addAudioFrame(audio);
        return;
      }

      // Transcriptions: what the agent said, and what the user asked.
      if (message?.serverContent?.outputTranscription?.text) {
        this.logger.info("Agent: " + message.serverContent.outputTranscription.text);
      }
      if (message?.serverContent?.inputTranscription?.text) {
        this.logger.info("User: " + message.serverContent.inputTranscription.text);
      }
    });

    this.liveSession.onError.add((event) => {
      this.logger.error("Gemini Live error: " + JSON.stringify(event));
    });

    this.liveSession.onClose.add((event) => {
      this.sessionReady = false;
      this.logger.warn("Gemini Live closed: " + JSON.stringify(event));
    });
  }

  /** Wire the mic frame -> PCM16 -> realtime_input pipeline (mirrors ExampleGeminiLive). */
  private setupMicStreaming(): void {
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

  /**
   * Called by PictureBehavior when the user pinches/taps a finished card.
   * Pushes that card's context (caption + the user's interests) so the agent
   * speaks an extra fact and then takes spoken follow-ups. The mic starts on the
   * first engage and stays on for the rest of the session.
   */
  engageCard(captionText: string): void {
    if (!captionText || captionText.trim().length === 0) return;
    // Re-tapping the same card shouldn't re-trigger the opener.
    if (captionText === this.currentCaption) return;
    this.currentCaption = captionText;

    // First tap spins up the session/mic; later taps reuse it.
    this.ensureStarted();

    if (!this.sessionReady) {
      this.pendingCaption = captionText;
      return;
    }
    this.sendCardContext(captionText);
  }

  private sendCardContext(captionText: string): void {
    // Open the listening window the first time a card is engaged.
    if (!this.listening) {
      this.microphoneRecorder.startRecording();
      this.listening = true;
      this.logger.info("Microphone listening started");
    }

    const store = (global as any).cropInterestStore;
    const interests: string[] =
      store && typeof store.getInterests === "function" ? store.getInterests() : [];
    const interestLine =
      interests.length > 0 ? interests.join(", ") : "surprising, little-known facts";

    const prompt =
      "The user just selected a trivia card. The card shows:\n\n" +
      captionText +
      "\n\nTheir interests: " +
      interestLine +
      ". Share ONE extra surprising, specific detail related to this card in one or two warm " +
      "sentences (do NOT repeat the caption), then invite them to ask anything about it.";

    this.logger.info("Engaging card: " + captionText);
    const turn: GeminiTypes.Live.ClientContent = {
      client_content: {
        turns: [{ role: "user", parts: [{ text: prompt }] }],
        turn_complete: true,
      },
    };
    this.liveSession.send(turn);
  }
}
