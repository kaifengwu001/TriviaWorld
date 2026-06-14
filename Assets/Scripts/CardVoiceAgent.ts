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
import { pcm16Rms, pcm16DurationSec } from "./AudioLevel";
import { acquireMic, releaseMic, safeStartRecording, MicWatchdog } from "./MicHealth";
import { BARGE_IN_INSTRUCTION, handleBargeIn } from "./VoiceBargeIn";
import {
  CARD_EDIT_TOOL_DECLARATIONS,
  CardEditTarget,
  composeAppendTarget,
  sanitizeCaption,
} from "./Cards/CardEditTools";

// Appended to the persona IN CODE at connect time so the model is always told to
// invoke the edit tools — independent of the persona @input, whose value is baked
// into VoiceAgent.prefab and can lag behind code (a known gotcha in this project).
// Audio-dialog models tend to verbalize an action ("I'll fix it") instead of
// emitting a function call unless the system instruction explicitly demands the call.
const TOOL_USAGE_INSTRUCTION =
  " You can EDIT this card's caption with two functions; when an edit is warranted you must actually CALL the " +
  "function, not just say you will.\n" +
  "append_caption(addition): ADD one short sentence to the caption WITHOUT removing anything (it is inserted " +
  "before the #hashtag line; pass no hashtags). Call it whenever the user asks to add, note, save, or remember " +
  "something about the card, OR when a genuinely interesting and accurate new fact comes up while you talk. " +
  "PREFER appending over rewriting whenever the existing caption is still correct and you are only adding to it.\n" +
  "rewrite_caption(new_caption): REPLACE the whole caption with a corrected version, including a trailing line of " +
  "2-3 #Hashtags. Before you call it you MUST FACT-CHECK the user's claim — do NOT blindly accept it: you cannot " +
  "see their photo, so trust the user about what is physically pictured, but for any factual claim use your own " +
  "knowledge. If the user is clearly wrong, politely correct THEM and do NOT rewrite unless they insist after you " +
  "explain. Only rewrite for a real correction, not a rephrase.\n" +
  "After any successful edit, briefly confirm aloud what you changed. Never edit during small talk.";

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
    "unless the user changes topic. Stay accurate; if you are unsure, say so briefly. " +
    "You can also EDIT the card's caption using your tools: call rewrite_caption when the user clearly " +
    "corrects a factual error or what the image shows (provide the full corrected caption plus its " +
    "#Hashtag line), and call append_caption when the conversation surfaces a genuinely interesting new " +
    "detail worth keeping on the card (one short sentence, no hashtags). Only edit on a real correction " +
    "or a worthwhile addition — never for small talk — and briefly confirm out loud after you do.";

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
  private connecting = false;
  private micWired = false;
  private listening = false;
  private micWatchdog: MicWatchdog | null = null;
  // Latest card context waiting to be sent once the session is ready.
  private pendingCaption: string | null = null;
  // Last caption we sent context for, so repeated taps on the same card no-op.
  private currentCaption: string | null = null;
  // The card currently being discussed, so spoken corrections/additions can edit
  // its caption in place. Set by engageCard; null when no card is engaged.
  private activeCard: CardEditTarget | null = null;
  // Optional opener-prompt override for the active card (used by demo mode to
  // steer what the agent says). When set it replaces the default opener;
  // {caption} and {interests} placeholders are substituted. null -> default.
  private activePrompt: string | null = null;
  // Whether THIS live session has already opened at least one card. The session
  // is long-lived, so its context window still holds the previous card's
  // conversation; the second card onward must be told to drop that prior topic
  // (otherwise the agent answers, then drifts back to the old card). Reset to
  // false on every new connection (a fresh session has no history to leave).
  private engagedAnyCardThisSession = false;

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
    if (this.setupStarted) {
      // Already initialized once. If the session has since dropped (e.g. Gemini's
      // max-duration close), re-establish it so the next card tap still works.
      if (!this.sessionReady && !this.connecting) this.connect();
      return;
    }
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
    this.connecting = true;
    // A brand-new session starts with an empty context window, so the first card
    // it opens needs no "forget the previous card" framing.
    this.engagedAnyCardThisSession = false;
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
            // Force the tool directive on in code; the persona @input alone can be a
            // stale prefab value that omits it (see TOOL_USAGE_INSTRUCTION).
            parts: [{ text: this.persona + TOOL_USAGE_INSTRUCTION + BARGE_IN_INSTRUCTION }],
          },
          tools: [{ functionDeclarations: CARD_EDIT_TOOL_DECLARATIONS as any }],
          // Keep multi-card conversations from overflowing the context window.
          contextWindowCompression: {
            triggerTokens: 20000,
            slidingWindow: { targetTokens: 16000 },
          },
          output_audio_transcription: {},
          input_audio_transcription: {},
        },
      };
      this.logger.info("Sending setup: " + JSON.stringify(setupMessage));
      this.liveSession.send(setupMessage);
    });

    this.liveSession.onMessage.add((message) => {
      // Detect an audio frame up front so we can stream it AND skip it from the
      // verbose RAW log — audio arrives as a high-frequency burst that would
      // otherwise drown out the messages we actually want to inspect (tool calls,
      // setup errors, turnComplete).
      const part = message?.serverContent?.modelTurn?.parts?.[0];
      const isAudioFrame = part?.inlineData?.mimeType?.startsWith("audio/pcm");
      if (!isAudioFrame) {
        this.logger.info("RAW: " + JSON.stringify(message));
      }

      if (message?.setupComplete) {
        this.sessionReady = true;
        this.connecting = false;
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

      // Barge-in: the user started talking over the agent. Gemini stops generating
      // and flags `interrupted`; flush the seconds of audio already buffered so the
      // agent goes quiet immediately instead of finishing its sentence. The session
      // + mic stay open, so the user's speech is already streaming up for the reply.
      if (handleBargeIn(message, this.dynamicAudioOutput)) return;

      // The model decided to edit this card's caption. Gemini Live may deliver the
      // call as a top-level toolCall OR as a functionCall part inside the model turn
      // — accept both so a part-delivered call isn't dropped by the audio branch.
      const calls = this.extractFunctionCalls(message);
      if (calls.length > 0) {
        this.handleToolCall(calls);
        return;
      }

      // Stream spoken audio out as it arrives.
      if (isAudioFrame) {
        const audio = Base64.decode(part.inlineData.data);
        this.dynamicAudioOutput.addAudioFrame(audio);
        // Pass the frame's loudness AND its playback duration so the orb/ring
        // reacts to amplitude over the whole utterance — frames arrive in a burst
        // up front, so the visual must be scheduled by playback time, not arrival.
        (global as any).agentSphere?.noteAudioFrame?.(
          pcm16Rms(audio, 2),
          pcm16DurationSec(audio, 24000)
        );
        return;
      }

      // Transcriptions: what the agent said, and what the user asked.
      if (message?.serverContent?.outputTranscription?.text) {
        this.logger.info("Agent: " + message.serverContent.outputTranscription.text);
        (global as any).agentSubtitle?.pushText?.(message.serverContent.outputTranscription.text);
      }
      if (message?.serverContent?.inputTranscription?.text) {
        this.logger.info("User: " + message.serverContent.inputTranscription.text);
      }
    });

    this.liveSession.onError.add((event) => {
      this.connecting = false;
      this.logger.error("Gemini Live error: " + JSON.stringify(event));
    });

    this.liveSession.onClose.add((event) => {
      this.sessionReady = false;
      this.connecting = false;
      // Keep setupStarted/mic wiring intact — the next engageCard() reconnects
      // via ensureStarted(), reusing the already-initialized mic + audio output.
      this.logger.warn("Gemini Live closed: " + JSON.stringify(event));
    });
  }

  /** Wire the mic frame -> PCM16 -> realtime_input pipeline (mirrors ExampleGeminiLive). */
  private setupMicStreaming(): void {
    // Wire the mic pipeline exactly once. setupComplete fires again on reconnect,
    // and these handlers read this.liveSession dynamically (always the current one).
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

  /**
   * Called by PictureBehavior when the user pinches/taps a finished card.
   * Pushes that card's context (caption + the user's interests) so the agent
   * speaks an extra fact and then takes spoken follow-ups. The mic starts on the
   * first engage and stays on for the rest of the session.
   */
  engageCard(captionText: string, target?: CardEditTarget, promptOverride?: string): void {
    if (!captionText || captionText.trim().length === 0) return;
    // Remember which card to edit if the conversation calls for a correction or
    // addition. Updated on every engage so it always points at the discussed card.
    this.activeCard = target ?? null;
    // Optional per-card opener override (demo mode). Blank -> use the default.
    this.activePrompt =
      promptOverride && promptOverride.trim().length > 0 ? promptOverride : null;
    // Single-session rule: take the live slot from the query agent if it holds it
    // (bidirectional handoff — when the user later looks back at the cosmos the
    // query agent re-arms itself). Opening a competing session without suspending
    // it first would silently zombify the query conversation.
    const queryAgent = (global as any).cardQueryVoiceAgent;
    if (queryAgent && typeof queryAgent.suspend === "function" && queryAgent.isActive?.()) {
      this.logger.info("Taking the live session from CardQueryVoiceAgent for this card.");
      queryAgent.suspend();
    }
    // Re-tapping the active card shouldn't re-trigger the opener — but if the
    // session has dropped, let the tap through so ensureStarted() reconnects.
    if (captionText === this.currentCaption && this.sessionReady) return;
    this.currentCaption = captionText;

    // First tap spins up the session/mic; later taps reuse it.
    this.ensureStarted();

    if (!this.sessionReady) {
      this.pendingCaption = captionText;
      return;
    }
    this.sendCardContext(captionText);
  }

  /** True when this agent holds a live, ready Gemini session. */
  isActive(): boolean {
    return this.sessionReady;
  }

  /**
   * Closes this agent's session and releases the mic so the CardQueryVoiceAgent
   * can own the single live session (the gateway keeps only the newest alive).
   * The next engageCard() reconnects from scratch via ensureStarted(). Re-entrant.
   */
  suspend(): void {
    if (this.micWatchdog) this.micWatchdog.end();
    if (this.listening) {
      try { this.microphoneRecorder.stopRecording(); } catch (e) {}
      this.listening = false;
    }
    releaseMic(this);
    if (this.liveSession) {
      try { (this.liveSession as any).close?.(); } catch (e) {}
    }
    this.sessionReady = false;
    this.connecting = false;
    this.setupStarted = false;
    this.currentCaption = null;
  }

  /** Mic-only release for handoffs: stop capturing but leave the session open. */
  private releaseMicOnly(): void {
    if (this.micWatchdog) this.micWatchdog.end();
    try { this.microphoneRecorder.stopRecording(); } catch (e) {}
    this.listening = false;
  }

  /**
   * Speak a one-off narration line through THIS agent's live session. Other
   * one-shot voices (NudgeVoice) call this instead of opening their own session —
   * the gateway keeps only the newest session alive, so a competing connect would
   * silently evict (zombify) this conversation.
   */
  speakIntent(intent: string): void {
    if (!intent || intent.trim().length === 0 || !this.sessionReady) return;
    this.logger.info("Speaking delegated line: " + intent);
    const turn: GeminiTypes.Live.ClientContent = {
      client_content: {
        turns: [{ role: "user", parts: [{ text: intent }] }],
        turn_complete: true,
      },
    };
    this.liveSession.send(turn);
  }

  // --- caption editing tools -------------------------------------------------

  /**
   * Collects function calls from both shapes Gemini Live can use: the dedicated
   * top-level toolCall message (toolCall.functionCalls) and functionCall parts
   * carried inside a model turn (serverContent.modelTurn.parts[].functionCall).
   */
  private extractFunctionCalls(message: any): any[] {
    const calls: any[] = [];
    const top = message?.toolCall?.functionCalls;
    if (Array.isArray(top)) calls.push(...top);
    const parts = message?.serverContent?.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) if (p?.functionCall) calls.push(p.functionCall);
    }
    return calls;
  }

  /** Dispatches the model's caption-edit tool calls and replies to each. */
  private handleToolCall(calls: any[]): void {
    for (const call of calls) {
      const args = call?.args ?? {};
      const response = this.applyEdit(call?.name, args);
      this.sendToolResponse(call?.id, call?.name, response);
    }
  }

  /** Applies one edit to the active card; returns the function-response payload. */
  private applyEdit(name: string, args: { [key: string]: any }): { [key: string]: any } {
    const card = this.activeCard;
    if (!card) {
      this.logger.warn("Edit tool called but no card is active.");
      return { ok: false, error: "no card is currently being discussed" };
    }

    let finalText: string | null = null;
    if (name === "rewrite_caption") {
      const next = sanitizeCaption(args.new_caption ?? "");
      if (next.trim().length === 0) return { ok: false, error: "new_caption was empty" };
      finalText = next;
    } else if (name === "append_caption") {
      const addition = (args.addition ?? "").toString();
      if (addition.trim().length === 0) return { ok: false, error: "addition was empty" };
      finalText = composeAppendTarget(card.getText(), addition);
    } else {
      return { ok: false, error: "unknown tool: " + name };
    }

    // Animate the change on the live card, then persist it so queries + future
    // spawns see the new wording.
    card.setTextAnimated(finalText);
    const id = card.getCardId();
    if (id) {
      const store = (global as any).cropCardStore;
      if (store && typeof store.updateText === "function") store.updateText(id, finalText);
    }
    this.logger.info("Applied " + name + " to card " + (id ?? "(unstored)"));
    return { ok: true };
  }

  private sendToolResponse(id: string, name: string, response: { [key: string]: any }): void {
    if (!this.liveSession) return;
    const msg: GeminiTypes.Live.ToolResponse = {
      tool_response: { function_responses: [{ id, name, response }] },
    };
    this.liveSession.send(msg);
  }

  /**
   * Dev helpers to exercise the caption typewriter without a live session (Gemini
   * Live does not run in the simulator). Call from the Logger console after a
   * capture, e.g. (global as any).cardVoiceAgent.debugAppendActiveCard("...").
   */
  debugRewriteActiveCard(newCaption: string): void {
    this.applyEdit("rewrite_caption", { new_caption: newCaption });
  }
  debugAppendActiveCard(addition: string): void {
    this.applyEdit("append_caption", { addition });
  }

  /**
   * Builds the opener prompt the agent acts on when a card is engaged. Normally
   * a "share one extra fact" instruction grounded in the caption + the user's
   * interests; when an override was supplied (demo mode), that text is used
   * instead with {caption} and {interests} placeholders substituted.
   */
  private buildOpenerPrompt(captionText: string, isTopicSwitch: boolean): string {
    const store = (global as any).cropInterestStore;
    const interests: string[] =
      store && typeof store.getInterests === "function" ? store.getInterests() : [];
    const interestLine =
      interests.length > 0 ? interests.join(", ") : "surprising, little-known facts";

    // When moving to a different card mid-session, force a hard context switch:
    // the model still has the previous card in its context window and will
    // otherwise answer, then drift back to it ("anyway, back to..."). This
    // applies to BOTH the default and injected-override openers.
    const switchPreamble = isTopicSwitch
      ? "The user has just turned to a COMPLETELY DIFFERENT, brand-new card. The previous card and " +
        "everything you were discussing about it is over. Do NOT mention it, return to it, or say " +
        "things like \"anyway, back to\" — your entire focus is now ONLY this new card.\n\n"
      : "";

    if (this.activePrompt) {
      const hasCaptionPlaceholder = this.activePrompt.indexOf("{caption}") >= 0;
      const injected = this.activePrompt
        .split("{caption}").join(captionText)
        .split("{interests}").join(interestLine);
      // The agent never receives the captured image (only ChatGPT does, and demo
      // mode skips it), so without the caption it has nothing real to talk about
      // and will invent details or drift to a previous card. Always ground it in
      // the caption: if the author placed {caption} themselves, respect that;
      // otherwise append the caption as explicit grounding.
      const grounding = hasCaptionPlaceholder
        ? ""
        : "\n\nThis card shows the following — keep everything you say grounded in it and do " +
          "not invent unrelated details:\n" +
          captionText;
      return switchPreamble + injected + grounding;
    }

    return (
      switchPreamble +
      "The user just selected a trivia card. The card shows:\n\n" +
      captionText +
      "\n\nTheir interests: " +
      interestLine +
      ". Share ONE extra surprising, specific detail related to this card in one or two warm " +
      "sentences (do NOT repeat the caption), then invite them to ask anything about it."
    );
  }

  private sendCardContext(captionText: string): void {
    // Open the listening window the first time a card is engaged.
    if (!this.listening) {
      // Shared-provider hygiene: claim the mic, cycle stop->start (recovers a latched
      // dead provider), and watchdog it until non-empty frames arrive. See MicHealth.
      acquireMic(this, "CardVoiceAgent", () => this.releaseMicOnly());
      safeStartRecording(this.microphoneRecorder);
      if (!this.micWatchdog) {
        this.micWatchdog = new MicWatchdog(this, this.microphoneRecorder, this, "CardVoiceAgent");
      }
      this.micWatchdog.begin();
      this.listening = true;
      this.logger.info("Microphone listening started");
    }

    // The first card of a session gets a clean opener; every later card must be
    // told to abandon the prior card (see engagedAnyCardThisSession).
    const isTopicSwitch = this.engagedAnyCardThisSession;
    this.engagedAnyCardThisSession = true;
    const prompt = this.buildOpenerPrompt(captionText, isTopicSwitch);

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
