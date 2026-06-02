/**
 * Specs Inc. 2026
 * Chat GPT component for the Crop Spectacles lens.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import {OpenAI} from "RemoteServiceGateway.lspkg/HostedExternal/OpenAI"

@component
export class ChatGPT extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">ChatGPT – sends captured image to OpenAI for identification</span><br/><span style="color: #94A3B8; font-size: 11px;">Encodes a texture as base64 and queries GPT-4o with vision capabilities to identify the cropped object.</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false;

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false;

  private logger: Logger;

  private ImageQuality = CompressionQuality.HighQuality
  private ImageEncoding = EncodingType.Jpg

  // Interests chosen in recent captures (most-recent first). Used to nudge the
  // model away from fixating on a single topic across consecutive captures.
  private recentTopics: string[] = []
  private readonly maxRecentTopics = 2

  onAwake() {
    this.logger = new Logger("ChatGPT", this.enableLogging || this.enableLoggingLifecycle, true);
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()");
  }

  makeImageRequest(imageTex: Texture, callback) {
    this.logger.info("Making image request...")
    Base64.encodeTextureAsync(
      imageTex,
      (base64String) => {
        this.logger.info("Image encode Success!")
        const textQuery = this.buildPrompt()
        this.sendGPTChat(textQuery, base64String, callback)
      },
      () => {
        this.logger.error("Image encoding failed!")
      },
      this.ImageQuality,
      this.ImageEncoding
    )
  }

  async sendGPTChat(request: string, image64: string, callback: (response: string) => void) {
    OpenAI.chatCompletions({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {type: "text", text: request},
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,` + image64
              }
            }
          ]
        }
      ],
      max_tokens: 110
    })
      .then((response) => {
        if (response.choices && response.choices.length > 0) {
          const safeText = this.sanitize(response.choices[0].message.content)
          this.logger.info("Response from OpenAI: " + safeText)
          this.rememberChosenTopic(safeText)
          callback(safeText)
        }
      })
      .catch((error) => {
        this.logger.error("Error in OpenAI request: " + error)
      })
  }

  /**
   * Builds the prompt for the vision model, seeding it with the user's selected
   * interests (read from the session-scoped InterestStore on `global`) so the
   * model returns a factoid connected to those interests.
   */
  private buildPrompt(): string {
    const store = (global as any).cropInterestStore
    const interests: string[] =
      store && typeof store.getInterests === "function" ? store.getInterests() : []

    // Present the interests in a fresh random order each call so the model
    // doesn't anchor on whichever topic happens to be listed first.
    const shuffled = this.shuffle(interests)

    const interestLine =
      shuffled.length > 0
        ? `The user's interests (in no particular order): ${shuffled.join(", ")}.`
        : `The user enjoys surprising, little-known facts.`

    // Only forbid recent topics when at least one untouched interest remains,
    // otherwise we'd leave the model with nothing valid to pick.
    const avoidable = this.recentTopics.filter((t) => shuffled.some((i) => i === t))
    const hasAlternative = shuffled.length > avoidable.length
    const avoidLine =
      shuffled.length > 0 && avoidable.length > 0 && hasAlternative
        ? `For variety, do NOT pick any of these recently used interests: ${avoidable.join(", ")}. Pick a different one this time.`
        : ``

    const pickLine =
      shuffled.length > 0
        ? `Weigh ALL of the interests above for THIS specific subject and pick the single one that yields the most surprising yet accurate connection. Judge each subject on its own; don't gravitate to a favorite topic, and don't reflexively pick the interest most obviously tied to the subject.`
        : `Find a lateral, non-obvious angle that yields the most surprising connection.`

    return [
      `First, silently identify the main subject in the image.`,
      interestLine,
      pickLine,
      avoidLine,
      `Then write a single piece of unexpected, true, little-known trivia that connects the subject to the chosen interest.`,
      ``,
      `Rules:`,
      `- Be specific and factually accurate. Do not invent facts; if unsure, choose a fact you are confident about.`,
      `- The trivia is around 30 words; never exceed 40 words. One or two sentences.`,
      `- After the trivia, add a final line with 3-4 hashtags, space-separated, no other text:`,
      `  the chosen interest first, then the recognized subject, then 1-2 other relevant tags.`,
      `  Use CamelCase with no spaces inside a hashtag (e.g. #ArtHistory).`,
      `- Output ONLY the trivia text then the hashtag line. No title, no preamble, no quotation marks, no emoji, no markdown.`,
      ``,
      `Format template (structure only — do NOT copy its topic or content):`,
      `<one or two sentences of trivia>`,
      `#<ChosenInterest> #<Subject> #<RelatedTag>`
    ]
      .filter((line) => line !== "")
      .join("\n")
  }

  /**
   * Records the interest the model chose (the first hashtag, mapped back to a
   * real interest name) so subsequent prompts can ask for something different.
   */
  private rememberChosenTopic(text: string) {
    const store = (global as any).cropInterestStore
    const interests: string[] =
      store && typeof store.getInterests === "function" ? store.getInterests() : []
    if (interests.length === 0) {
      return
    }
    const match = text.match(/#(\w+)/)
    if (!match) {
      return
    }
    const tag = match[1].toLowerCase()
    const chosen = interests.find((i) => i.replace(/\s+/g, "").toLowerCase() === tag)
    if (!chosen) {
      return
    }
    this.recentTopics = [chosen, ...this.recentTopics.filter((t) => t !== chosen)].slice(
      0,
      this.maxRecentTopics
    )
    this.logger.info("Recent topics: " + this.recentTopics.join(", "))
  }

  /** Returns a new array with the elements in random order (no mutation). */
  private shuffle<T>(input: T[]): T[] {
    const copy = input.slice()
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = copy[i]
      copy[i] = copy[j]
      copy[j] = tmp
    }
    return copy
  }

  /**
   * Strips tag-like sequences and caps length before the text reaches the
   * caption renderer, which can crash on unclosed HTML-style tags.
   */
  private sanitize(text: string): string {
    return (text ?? "").replace(/<[^>]*>/g, "").slice(0, 400)
  }
}
