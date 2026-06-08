/**
 * Specs Inc. 2026
 * WelcomeVoice / Agent voice foundation.
 *
 * Connects to the Gemini Live API through the Remote Service Gateway (so NO
 * Internet Access capability and NO on-device key are needed) and speaks with a
 * chosen voice (default "Leda"). It is the warm "host" voice of TriviaGo:
 * ~5 seconds after launch it GENERATES a welcome greeting from greetingIntent,
 * and announceInterests(topics) speaks a follow-up once the user picks their
 * topics. Lines are generated (so the wording varies run-to-run), not read
 * verbatim. Registered at global.hostVoice so other scripts (e.g. the topic
 * panel) can drive it. Audio-output only — no microphone, so it is safe to run
 * at launch (the mic-bearing CardVoiceAgent stays lazy).
 *
 * Audio is streamed back as PCM (24 kHz) and played through the shared
 * DynamicAudioOutput helper that ships in the RemoteServiceGateway package
 * (it lives on the RemoteServiceGatewayExamples "DynamicAudioOutput" object).
 *
 * NOTE: Gemini Live runs over a WebSocket on the gateway — it does NOT work in
 * the Lens Studio simulator. Test on device (or Preview with Device Type
 * Override = Spectacles) and make sure the glasses are online.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { Gemini } from "RemoteServiceGateway.lspkg/HostedExternal/GoogleGenAI";
import { GeminiTypes } from "RemoteServiceGateway.lspkg/HostedExternal/GoogleGenAITypes";
import { DynamicAudioOutput } from "RemoteServiceGateway.lspkg/Helpers/DynamicAudioOutput";
import { pcm16Rms, pcm16DurationSec } from "./AudioLevel";

@component
export class WelcomeVoice extends BaseScriptComponent {
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Agent Voice (Gemini Live)</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Generative host voice (Gemini Live via the Remote Service Gateway). Speaks a varied welcome greeting a few seconds after launch; announceInterests(topics) speaks the follow-up after the user picks topics. Does NOT run in the simulator — test on device with internet.</span>')
  @ui.separator

  @ui.group_start("Setup (drag from the RemoteServiceGatewayExamples prefab)")
  @input
  @hint("The 'Websocket requirements' SceneObject from the RemoteServiceGatewayExamples prefab. Enabled on launch so the gateway WebSocket can connect.")
  private websocketRequirementsObj: SceneObject;

  @input
  @hint("The 'DynamicAudioOutput' object from the RemoteServiceGatewayExamples prefab (it carries the AudioComponent + audio-output track that plays the voice).")
  private dynamicAudioOutput: DynamicAudioOutput;
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
  private greetingIntent: string =
    "Warmly welcome the user to TriviaGo. Say you're excited to learn and explore the world together with them. Then invite them to tell you a little about themselves and what they're interested in. Keep it to about two short, natural sentences.";

  @input
  @widget(new TextAreaWidget())
  @hint("What to say after the user picks topics. Use {topics} where the chosen interests should be mentioned.")
  private interestsIntentTemplate: string =
    "The user just chose these interests: {topics}. React thoughtfully (a little \"hmm, I see\"), then say that based on those interests you've found some places they might enjoy, and ask if they'd like to take a look. About two short, natural sentences.";

  @input
  @hint("Seconds after launch before the welcome greeting")
  private delaySeconds: number = 5;

  @input
  @widget(new TextAreaWidget())
  @hint("Host persona / system instruction. The model speaks the requested intent in its own words.")
  private persona: string =
    "You are the warm, upbeat first-person voice host of TriviaGo, an AR learning companion. You speak directly to the user. When given an instruction about what to convey, say it in your own words -- one or two short, natural, friendly sentences -- and vary the wording. Never read instructions back, never add stage directions or quotation marks, and don't ask for clarification; just speak naturally to the user.";

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
  private sessionReady = false;
  // True from the instant we start connecting until the session closes — covers
  // the ~1s setup window before sessionReady flips, which is exactly when other
  // agents must NOT open a competing session (a 2nd session at launch blanks the
  // lens on-device). isActive() reports this, not sessionReady.
  private sessionLive = false;
  // Set true when the next completed turn should close the session (the host is a
  // one-shot narrator; releasing the slot keeps CardVoiceAgent's session alive).
  private closeAfterTurn = false;
  // Intents sent before the session was ready, flushed in order on setupComplete.
  private pendingIntents: string[] = [];

  onAwake(): void {
    this.logger = new Logger("WelcomeVoice", this.enableLogging, true);

    // Let other scripts (e.g. the topic panel) drive the host voice.
    (global as any).hostVoice = this;

    if (this.websocketRequirementsObj) {
      this.websocketRequirementsObj.enabled = true;
    } else {
      this.logger.error("websocketRequirementsObj not assigned — gateway WebSocket may fail.");
    }

    this.createEvent("OnStartEvent").bind(() => this.onStart());
  }

  private onStart(): void {
    if (!this.dynamicAudioOutput) {
      this.logger.error("dynamicAudioOutput not assigned — assign the prefab's DynamicAudioOutput.");
      return;
    }

    // Gemini Live streams audio back at 24 kHz.
    this.dynamicAudioOutput.initialize(24000);
    this.connect();

    // Fire the welcome greeting at the chosen delay. If the session isn't ready
    // yet (usually ready within ~1s), speakIntent() queues it for setupComplete.
    const delay = Math.max(0, this.delaySeconds);
    this.logger.info(`Welcome greeting scheduled in ${delay}s`);
    const delayed = this.createEvent("DelayedCallbackEvent");
    delayed.bind(() => this.speakIntent(this.greetingIntent));
    delayed.reset(delay);
  }

  /** Connect to Gemini Live and configure audio output with the chosen voice. */
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
            parts: [{ text: this.persona }],
          },
          output_audio_transcription: {},
        },
      };
      this.liveSession.send(setupMessage);
    });

    this.liveSession.onMessage.add((message) => {
      // Log non-audio server messages so errors/status are visible (audio
      // frames are skipped to avoid flooding the console).
      const firstPart = message?.serverContent?.modelTurn?.parts?.[0];
      const isAudioFrame = firstPart?.inlineData?.mimeType?.startsWith("audio/pcm");
      if (!isAudioFrame) {
        this.logger.info("Server msg: " + JSON.stringify(message));
      }

      if (message?.setupComplete) {
        this.sessionReady = true;
        this.logger.success("Gemini Live ready");
        if (this.pendingIntents.length > 0) {
          const queued = this.pendingIntents;
          this.pendingIntents = [];
          queued.forEach((intent) => this.sendIntentTurn(intent));
        }
        return;
      }

      // Stream spoken audio out as it arrives.
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
      } else if (message?.serverContent?.outputTranscription?.text) {
        this.logger.info("Spoke: " + message.serverContent.outputTranscription.text);
      }

      // After the host's final line finishes, release the live session so it
      // doesn't hold a slot the CardVoiceAgent conversation needs.
      if (message?.serverContent?.turnComplete && this.closeAfterTurn) {
        this.closeAfterTurn = false;
        this.logger.info("Host finished — closing session to free a live slot.");
        this.disconnect();
      }
    });

    this.liveSession.onError.add((event) => {
      this.logger.error("Gemini Live error: " + JSON.stringify(event));
    });

    this.liveSession.onClose.add((event) => {
      this.sessionReady = false;
      this.sessionLive = false;
      this.logger.warn("Gemini Live closed: " + JSON.stringify(event));
    });
  }

  /**
   * True while the host holds a live Gemini session (from launch until it closes
   * after the interest announcement). Other agents poll this so they don't open a
   * second live session at once — the gateway keeps only the newest alive, and a
   * second session at launch blanks the lens on-device.
   */
  isActive(): boolean {
    return this.sessionLive;
  }

  /**
   * Speak an intent: the model generates a short, natural line conveying it (so
   * the wording varies). If the session isn't ready yet, the intent is queued and
   * sent on setupComplete. This is the reusable host hook.
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
   * Speak the post-topic-selection line, weaving in the chosen interests via the
   * {topics} token in interestsIntentTemplate. Called by the topic panel through
   * global.hostVoice once the user confirms their selection.
   */
  announceInterests(topics: string[]): void {
    const cleaned = (topics ?? []).filter((t) => typeof t === "string" && t.trim().length > 0);
    const topicsText = cleaned.length > 0 ? cleaned.join(", ") : "whatever catches their eye";
    const intent = this.interestsIntentTemplate.split("{topics}").join(topicsText);
    // This is the host's last line — close the session once it has been spoken.
    this.closeAfterTurn = true;
    this.speakIntent(intent);
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

  /** Close the live session — the host is a one-shot narrator, so free the slot. */
  private disconnect(): void {
    if (this.liveSession) {
      try {
        this.liveSession.close();
      } catch (e) {
        this.logger.warn("Session close failed: " + e);
      }
    }
    this.sessionReady = false;
    this.sessionLive = false;
  }
}
