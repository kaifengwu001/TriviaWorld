/**
 * Specs Inc. 2026
 * NudgeVoice — the "discover the world" reminder voice.
 *
 * A separate, audio-output-only Gemini Live narrator (same plumbing as
 * WelcomeVoice) whose single job is to gently remind the user about the prayer
 * gesture that discovers the world. ~60 seconds after launch it speaks one
 * generated line conveying nudgeIntent (e.g. "Hey, I found some interesting
 * stuff nearby! Remember the gesture to discover the world?").
 *
 * To avoid holding a second always-on gateway WebSocket for the whole session,
 * it connects LAZILY: it opens the connection only ~connectLeadSec seconds
 * before it needs to speak, then speaks once.
 *
 * It is suppressed if the world was already discovered: PrayerGestureBehavior
 * sets global.worldDiscovered = true on detection, and this script skips both
 * connecting and speaking when that flag is set. Plays once.
 *
 * Audio is streamed back as PCM (24 kHz) and played through a DynamicAudioOutput
 * helper. Give this its own DynamicAudioOutput object (separate from the host
 * voice) to avoid audio conflicts.
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
export class NudgeVoice extends BaseScriptComponent {
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Nudge Voice (Gemini Live)</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Audio-only reminder voice. ~60s after launch it speaks one generated line nudging the user to perform the prayer gesture that discovers the world. Connects lazily and skips itself if the world was already discovered. Does NOT run in the simulator — test on device with internet.</span>')
  @ui.separator

  @ui.group_start("Setup (drag from the RemoteServiceGatewayExamples prefab)")
  @input
  @hint("The 'Websocket requirements' SceneObject from the RemoteServiceGatewayExamples prefab. Enabled on launch so the gateway WebSocket can connect.")
  private websocketRequirementsObj: SceneObject;

  @input
  @hint("A DynamicAudioOutput object that plays the voice. Give this its OWN (separate from the host voice) to avoid audio conflicts — duplicate the prefab's DynamicAudioOutput.")
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
  @hint("What the reminder should convey (the model says it in its own words, so wording varies).")
  private nudgeIntent: string =
    "Tell the user, in a friendly, slightly excited tone, that you've found some interesting things nearby, and remind them about the gesture they can use to discover the world. Keep it to one or two short, natural sentences.";

  @input
  @hint("Seconds after launch before the reminder is spoken")
  private delaySeconds: number = 60;

  @input
  @hint("How many seconds before the reminder to open the Gemini Live connection (lazy connect). Clamped to delaySeconds.")
  private connectLeadSec: number = 5;

  @input
  @hint("If a conversational agent holds the single live session when the nudge is due, how often (seconds) to re-check so the nudge speaks right after that agent releases — instead of being dropped.")
  private retryIntervalSec: number = 2;

  @input
  @hint("Max consecutive FAILED connect attempts (e.g. a session collision keeps evicting us) before the nudge gives up, to avoid hammering the gateway. Waiting for an active agent does NOT count toward this.")
  private maxConnectAttempts: number = 6;

  @input
  @widget(new TextAreaWidget())
  @hint("Host persona / system instruction. The model speaks the requested intent in its own words.")
  private persona: string =
    "You are the warm, upbeat first-person voice host of CurioCity, an AR learning companion. You speak directly to the user. When given an instruction about what to convey, say it in your own words -- one or two short, natural, friendly sentences -- and vary the wording. Never read instructions back, never add stage directions or quotation marks, and don't ask for clarification; just speak naturally to the user.";

  @input
  @hint("Gemini Live model id (no 'models/' prefix — it's added automatically). Supported: gemini-live-2.5-flash, gemini-2.0-flash-live-preview-04-09, gemini-live-2.5-flash-preview-native-audio")
  private model: string = "gemini-live-2.5-flash";
  @ui.group_end

  @ui.separator
  @ui.group_start("Logging")
  @input private enableLogging: boolean = true;
  @ui.group_end

  private logger: Logger;
  private liveSession: ReturnType<typeof Gemini.liveConnect> | null = null;
  private sessionReady = false;
  // True from the moment we start connecting until setup completes (or the socket
  // closes/errors). Guards against opening a second session while one is in flight.
  private connecting = false;
  // Intents sent before the session was ready, flushed in order on setupComplete.
  private pendingIntents: string[] = [];
  // True once the single nudge line has been delivered (then the session closes).
  private done = false;
  // True once the nudge is due (speak time reached) and still wants to be delivered.
  // Gates the auto re-queue so a failed EARLY (lazy) connect doesn't retry prematurely.
  private wantsToSpeak = false;
  // Bumped on every connect()/disconnect(); stale session callbacks (from a session
  // we've since replaced/closed) compare against it and no-op. Prevents reconnect
  // races where an old socket's onClose corrupts the new session's state.
  private sessionToken = 0;
  // Consecutive FAILED connects (session lost before delivering). Reset when a setup
  // completes or when we defer to an active agent; capped by maxConnectAttempts.
  private failureStreak = 0;
  // Reused timer that re-checks (polls) for a free live slot when the nudge is due
  // but a conversational agent is still holding the single session.
  private speakRetryEvent: DelayedCallbackEvent | null = null;

  onAwake(): void {
    this.logger = new Logger("NudgeVoice", this.enableLogging, true);

    // Let other scripts drive the nudge voice if they ever need to.
    (global as any).nudgeVoice = this;

    if (this.websocketRequirementsObj) {
      // Harmless if WelcomeVoice already enabled the shared requirements object.
      this.websocketRequirementsObj.enabled = true;
    } else {
      this.logger.error("websocketRequirementsObj not assigned — gateway WebSocket may fail.");
    }

    this.createEvent("OnStartEvent").bind(() => this.onStart());
  }

  private onStart(): void {
    if (!this.dynamicAudioOutput) {
      this.logger.error("dynamicAudioOutput not assigned — assign a (separate) DynamicAudioOutput.");
      return;
    }

    // In quick-crop mode the nudge fires much sooner (a customizable delay on the
    // InterestStore) since there's no onboarding ahead of it; otherwise use this
    // script's own delaySeconds.
    const store = (global as any).cropInterestStore;
    const skipping = store && typeof store.isSkippingOnboarding === "function" && store.isSkippingOnboarding();
    const delaySeconds = skipping && typeof store.getNudgeDelaySeconds === "function"
      ? store.getNudgeDelaySeconds()
      : this.delaySeconds;

    // Schedule the lazy-connect moment: open the connection connectLeadSec
    // seconds before we need to speak. The actual speak is scheduled from there.
    const lead = Math.min(Math.max(0, this.connectLeadSec), Math.max(0, delaySeconds));
    const connectAt = Math.max(0, delaySeconds) - lead;
    this.logger.info(`Nudge scheduled at ${delaySeconds}s (connecting at ${connectAt}s)`);

    const connectEvent = this.createEvent("DelayedCallbackEvent");
    connectEvent.bind(() => this.onConnectTime(lead));
    connectEvent.reset(connectAt);
  }

  /** Lazy-connect: open the session now, then schedule the spoken line. */
  private onConnectTime(lead: number): void {
    if ((global as any).worldDiscovered) {
      this.logger.info("World already discovered — skipping nudge (no connect).");
      return;
    }

    // If a conversational agent (card or card-query) already owns the single live
    // session, DON'T open a competing one — the gateway evicts/zombifies the older
    // session on a new connect. We leave our session closed for now; onSpeakTime
    // opens it once the slot is free (the agent may release before/after speak time).
    if (this.activeConversationalAgent()) {
      this.logger.info("A conversational agent is active — deferring connect until the slot frees.");
    } else {
      // Gemini Live streams audio back at 24 kHz.
      this.dynamicAudioOutput.initialize(24000);
      this.connect();
    }

    const speakEvent = this.createEvent("DelayedCallbackEvent");
    speakEvent.bind(() => this.onSpeakTime());
    speakEvent.reset(lead);
  }

  private onSpeakTime(): void {
    // One-shot: never re-fire once the line has been delivered.
    if (this.done) return;
    this.wantsToSpeak = true;

    if ((global as any).worldDiscovered) {
      this.logger.info("World discovered — skipping nudge.");
      this.wantsToSpeak = false;
      this.disconnect();
      return;
    }

    // If a conversational agent (card / card-query) holds the single live session,
    // DON'T drop the nudge — QUEUE it: free our own session (so two never run at
    // once) and re-check shortly, so the nudge speaks right after the agent releases.
    // Riding the agent's session is not an option: an off-topic user turn would force
    // it to re-narrate its last line, so we wait for our own slot instead. Waiting on
    // a legitimately-busy agent is not a failure, so reset the failure streak.
    if (this.activeConversationalAgent()) {
      this.logger.info("Conversational agent active — queueing nudge until the slot frees.");
      this.failureStreak = 0;
      if (this.sessionReady || this.connecting) this.disconnect();
      this.scheduleSpeakRetry();
      return;
    }

    // Slot looks clear. If we already hold a ready session, just speak. If we're mid-
    // connect, wait — setupComplete flushes the queued line. Otherwise open one.
    const sphere = (global as any).agentSphere;
    if (sphere && typeof sphere.goHome === "function") sphere.goHome();

    if (this.sessionReady) {
      this.speakIntent(this.nudgeIntent);
      return;
    }
    // Not ready: open a session unless one is already in flight (the lazy early
    // connect). Either way queue the line so setupComplete flushes it — returning
    // early here would leave the in-flight session with nothing to say.
    if (!this.connecting) {
      this.dynamicAudioOutput.initialize(24000);
      this.connect();
    }
    this.speakIntent(this.nudgeIntent); // queued until setup completes
  }

  /**
   * The nudge's own session was lost (error/close) before it delivered — most often a
   * gateway collision (another agent connected and evicted us, since the gateway keeps
   * only the newest session). Re-queue rather than drop, capped by maxConnectAttempts
   * so a persistent collision can't hammer the gateway.
   */
  private onSessionLost(): void {
    if (this.done || !this.wantsToSpeak) return;
    this.failureStreak++;
    if (this.failureStreak > Math.max(1, this.maxConnectAttempts)) {
      this.logger.warn(`Nudge gave up after ${this.failureStreak - 1} failed connects.`);
      this.wantsToSpeak = false;
      return;
    }
    this.logger.info(`Nudge session lost (attempt ${this.failureStreak}) — re-queueing.`);
    this.scheduleSpeakRetry();
  }

  /** Re-check for a free live slot after retryIntervalSec, reusing one timer. */
  private scheduleSpeakRetry(): void {
    const interval = Math.max(0.25, this.retryIntervalSec);
    if (!this.speakRetryEvent) {
      this.speakRetryEvent = this.createEvent("DelayedCallbackEvent");
      this.speakRetryEvent.bind(() => this.onSpeakTime());
    }
    this.speakRetryEvent.reset(interval);
  }

  /**
   * The conversational agent currently holding the single live session, or null.
   * Used as a boolean gate: while any agent is engaged the nudge is skipped entirely
   * (we never open a competing session, and the user is already talking to someone).
   */
  private activeConversationalAgent(): any {
    // ANY agent holding the single gateway live session counts — opening our own
    // session next to it would evict/zombify theirs. Only isActive() is required
    // (the result is used as a boolean at both call sites).
    const candidates = [
      (global as any).cardQueryVoiceAgent,
      (global as any).cardVoiceAgent,
      (global as any).hostVoice,                // WelcomeVoice: live from launch until Start
      (global as any).recommendationVoiceAgent, // live from Start until the card pick
    ];
    for (const agent of candidates) {
      if (agent && typeof agent.isActive === "function" && agent.isActive()) return agent;
    }
    return null;
  }

  /** Connect to Gemini Live and configure audio output with the chosen voice. */
  private connect(): void {
    this.connecting = true;
    // A fresh session starts with an empty outbound queue. Resetting here (rather than
    // appending each retry) stops nudgeIntent copies from piling up across reconnects
    // and being flushed all at once on setupComplete. The caller pushes exactly one.
    this.pendingIntents = [];
    // Token for THIS session: callbacks from a session we've since replaced/closed
    // compare against it and no-op, so a stale onClose can't corrupt a newer session.
    const token = ++this.sessionToken;
    this.liveSession = Gemini.liveConnect();

    this.liveSession.onOpen.add(() => {
      if (token !== this.sessionToken) return;
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
      if (token !== this.sessionToken) return;
      // Log non-audio server messages so errors/status are visible (audio
      // frames are skipped to avoid flooding the console).
      const firstPart = message?.serverContent?.modelTurn?.parts?.[0];
      const isAudioFrame = firstPart?.inlineData?.mimeType?.startsWith("audio/pcm");
      if (!isAudioFrame) {
        this.logger.info("Server msg: " + JSON.stringify(message));
      }

      if (message?.setupComplete) {
        this.sessionReady = true;
        this.connecting = false;
        this.failureStreak = 0; // a real session came up — reset the failure cap
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
        (global as any).agentSubtitle?.pushText?.(message.serverContent.outputTranscription.text);
      }

      // One-shot: once the nudge has been fully spoken, close the session so it
      // doesn't hold a live slot the CardVoiceAgent conversation needs.
      if (message?.serverContent?.turnComplete && !this.done) {
        this.done = true;
        this.logger.info("Nudge delivered — closing session to free a live slot.");
        this.disconnect();
      }
    });

    this.liveSession.onError.add((event) => {
      if (token !== this.sessionToken) return;
      this.connecting = false;
      this.logger.error("Gemini Live error: " + JSON.stringify(event));
      this.onSessionLost();
    });

    this.liveSession.onClose.add((event) => {
      if (token !== this.sessionToken) return;
      this.sessionReady = false;
      this.connecting = false;
      this.logger.warn("Gemini Live closed: " + JSON.stringify(event));
      this.onSessionLost();
    });
  }

  /**
   * Speak an intent: the model generates a short, natural line conveying it (so
   * the wording varies). If the session isn't ready yet, the intent is queued and
   * sent on setupComplete.
   */
  speakIntent(intent: string): void {
    if (!intent || intent.trim().length === 0) return;
    if (!this.sessionReady) {
      this.pendingIntents.push(intent);
      return;
    }
    this.sendIntentTurn(intent);
  }

  private sendIntentTurn(intent: string): void {
    if (!this.liveSession) return;
    this.logger.info("Speaking intent: " + intent);
    const turn: GeminiTypes.Live.ClientContent = {
      client_content: {
        turns: [{ role: "user", parts: [{ text: intent }] }],
        turn_complete: true,
      },
    };
    this.liveSession.send(turn);
  }

  /**
   * Close the live session (after delivery, or to free the slot for an active agent).
   * Bumping the token first means this session's pending onClose/onError callbacks are
   * treated as stale and won't trigger an auto re-queue — only unexpected losses do.
   */
  private disconnect(): void {
    this.sessionToken++;
    if (this.liveSession) {
      try {
        this.liveSession.close();
      } catch (e) {
        this.logger.warn("Session close failed: " + e);
      }
    }
    this.liveSession = null;
    this.sessionReady = false;
    this.connecting = false;
  }
}
