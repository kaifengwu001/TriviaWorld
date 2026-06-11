/**
 * Specs Inc. 2026
 * MicHealth — recovery + exclusive ownership for the SHARED microphone provider.
 *
 * Every MicrophoneRecorder component in the scene points at the same AudioTrackAsset,
 * and `asset.control` is ONE shared MicrophoneAudioProvider: per-agent recorders are an
 * illusion. Consequences this module exists to handle:
 *
 *   - getAudioFrame() is destructive — if two recorders are started at once, whichever
 *     update runs first drains the frame and the other reads 0 samples forever.
 *   - provider.start() near launch (Connected Lenses session spin-up) can fail silently,
 *     latching the provider "started-but-dead": every later start() is a no-op and ALL
 *     agents go deaf. A stop()->start() cycle is the recovery.
 *
 * So: agents begin listening through safeStartRecording() (always cycles stop->start),
 * acquire the mic through acquireMic() (the previous owner's recorder is stopped first,
 * WITHOUT touching its Gemini session), and arm a MicWatchdog that keeps re-cycling the
 * provider with backoff while frames stay empty.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { MicrophoneRecorder } from "RemoteServiceGateway.lspkg/Helpers/MicrophoneRecorder";

const logger = new Logger("MicHealth", true, true);

interface MicOwnerEntry {
  owner: object;
  label: string;
  releaseMicOnly: () => void;
}

/** The single mic-owner slot, on global so it spans prefab/bundle boundaries. */
function ownerSlot(): { entry: MicOwnerEntry | null } {
  const g = global as any;
  if (!g.__micOwner) g.__micOwner = { entry: null };
  return g.__micOwner;
}

/**
 * Stop-then-start the recorder. The leading stop() clears a provider latched
 * "started-but-dead" by a failed launch-window start; on a healthy or never-started
 * provider it is harmless (nothing is buffered across frames to lose).
 */
export function safeStartRecording(recorder: MicrophoneRecorder): void {
  try { recorder.stopRecording(); } catch (e) {}
  try {
    recorder.startRecording();
  } catch (e) {
    logger.error("startRecording failed: " + e);
  }
}

/**
 * Claim the shared mic for `owner`. If another agent holds it, its releaseMicOnly()
 * runs first — that must stop ITS recorder, clear its listening flag, and end its
 * watchdog, but NOT close its Gemini session (session handoff stays with the agents).
 */
export function acquireMic(owner: object, label: string, releaseMicOnly: () => void): void {
  const slot = ownerSlot();
  const current = slot.entry;
  if (current && current.owner !== owner) {
    logger.info(`Mic handoff: ${current.label} -> ${label}`);
    try { current.releaseMicOnly(); } catch (e) {}
  }
  slot.entry = { owner, label, releaseMicOnly };
}

/** Release the mic if (and only if) `owner` currently holds it. */
export function releaseMic(owner: object): void {
  const slot = ownerSlot();
  if (slot.entry && slot.entry.owner === owner) slot.entry = null;
}

export function isMicOwner(owner: object): boolean {
  const slot = ownerSlot();
  return !!slot.entry && slot.entry.owner === owner;
}

/**
 * Watches a freshly started recorder and re-cycles the shared provider while frames
 * stay empty: checks at 2s, then 4/8/16/32s (5 cycles max). Disarms itself the moment
 * a non-empty frame arrives, on end(), or when the agent loses mic ownership (never
 * cycles a mic that was handed to someone else). False positives during genuine
 * silence are harmless — a cycle drops no audio.
 */
export class MicWatchdog {
  private active = false;
  private nonEmpty = 0;
  private cycles = 0;
  private intervalSec = 2;
  private delayed: DelayedCallbackEvent | null = null;

  constructor(
    private host: BaseScriptComponent,
    private recorder: MicrophoneRecorder,
    private owner: object,
    private label: string
  ) {}

  /** Arm (or re-arm) the watchdog right after safeStartRecording(). */
  begin(): void {
    if (!this.delayed) {
      this.delayed = this.host.createEvent("DelayedCallbackEvent");
      this.delayed.bind(() => this.check());
      this.recorder.onAudioFrame.add((frame) => {
        if (this.active && frame.length > 0) this.nonEmpty++;
      });
    }
    this.active = true;
    this.nonEmpty = 0;
    this.cycles = 0;
    this.intervalSec = 2;
    this.delayed.reset(this.intervalSec);
  }

  /** Disarm (suspend / mic handoff). */
  end(): void {
    this.active = false;
  }

  private check(): void {
    if (!this.active) return;
    if (this.nonEmpty > 0) {
      logger.info(`MicWatchdog[${this.label}]: mic healthy (${this.nonEmpty} non-empty frames).`);
      this.active = false;
      return;
    }
    if (!isMicOwner(this.owner)) {
      // The mic moved to another agent between checks — not ours to cycle anymore.
      this.active = false;
      return;
    }
    this.cycles++;
    if (this.cycles > 5) {
      logger.error(
        `MicWatchdog[${this.label}]: mic still silent after 5 stop->start cycles — giving up. ` +
        `Something else is holding the microphone (Connected Lenses voice chat?).`
      );
      this.active = false;
      return;
    }
    logger.warn(
      `MicWatchdog[${this.label}]: 0 non-empty frames after ${this.intervalSec}s — ` +
      `cycling mic (attempt ${this.cycles}/5).`
    );
    safeStartRecording(this.recorder);
    this.intervalSec = Math.min(this.intervalSec * 2, 32);
    this.delayed!.reset(this.intervalSec);
  }
}
