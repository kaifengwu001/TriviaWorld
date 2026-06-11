import {SnapCloudRequirements} from "./Examples/SnapCloudRequirements"

@component
export class EdgeFunctionRoastById extends BaseScriptComponent {
  private internetModule: InternetModule = require("LensStudio:InternetModule")

  @input
  @hint("Reference to SnapCloudRequirements for centralized Supabase configuration")
  public snapCloudRequirements: SnapCloudRequirements

  @input
  @hint("Edge Function name (set this to: get-roast-by-id)")
  public functionName: string = "[your-function-name]"

  @input
  @hint("Enable debug logging")
  public enableDebugLogs: boolean = true

  // Callback wired by MultiplayerTriviaManager to display roast on screen
  public onRoastReceived: ((roastText: string) => void) | null = null

  // Tracks the current question id set by the trivia manager
  public id: number = 1

  onAwake() {
    this.log("EdgeFunctionRoastById initializing...")
    this.initializeService()
  }

  private initializeService() {
    if (!this.snapCloudRequirements || !this.snapCloudRequirements.isConfigured()) {
      this.log("SnapCloudRequirements not configured")
      return
    }
    if (!this.functionName || this.functionName === "[your-function-name]") {
      this.log("Function name not configured")
      return
    }
    this.log(`Initialized — endpoint: ${this.snapCloudRequirements.getFunctionsApiUrl()}${this.functionName}`)
  }

  private callEdgeFunctionByIdWithLabel(roastLabel: string, idValue: number) {
    try {
      if (!this.snapCloudRequirements || !this.snapCloudRequirements.isConfigured()) {
        this.log("SnapCloudRequirements not configured")
        return
      }
      if (!this.functionName || this.functionName === "[your-function-name]") {
        this.log("Function name not configured")
        return
      }

      const endpointUrl =
        `${this.snapCloudRequirements.getFunctionsApiUrl()}${this.functionName}?id=${idValue}`

      this.log(`Calling ${roastLabel} for id:${idValue}`)

      const request = RemoteServiceHttpRequest.create()
      request.url = endpointUrl
      request.headers = this.snapCloudRequirements.getSupabaseHeaders()
      request.method = RemoteServiceHttpRequest.HttpRequestMethod.Post
      request.body = JSON.stringify({ id: idValue })

      this.internetModule.performHttpRequest(request, (response) => {
        this.log(`${roastLabel} → status ${response.statusCode}`)

        if (!response.body) {
          this.log(`${roastLabel} → empty body`)
          return
        }

        let parsed: any = null
        try { parsed = JSON.parse(response.body) } catch (e) {
          this.log(`${roastLabel} → not JSON`)
          return
        }

        if (parsed?.error) {
          this.log(`${roastLabel} → error: ${parsed.error}`)
          return
        }

        const data = parsed?.data
        if (!data) {
          this.log(`${roastLabel} → missing "data"`)
          return
        }

        const textValue = data?.[roastLabel]
        if (typeof textValue === "string" && textValue.length > 0) {
          this.log(`${roastLabel} → ${textValue}`)
          if (this.onRoastReceived) {
            this.onRoastReceived(textValue)
          }
        } else {
          this.log(`${roastLabel} → field not found. Keys: ${Object.keys(data).join(", ")}`)
        }
      })
    } catch (error) {
      this.log(`Error (${roastLabel}): ${error}`)
    }
  }

  public fetchRoast1() {
    this.callEdgeFunctionByIdWithLabel("roast1", this.id)
  }

  public fetchRoast2() {
    this.callEdgeFunctionByIdWithLabel("roast2", this.id)
  }

  public callFunctionWithId(idValue: number) {
    this.id = idValue
  }

  private log(message: string) {
    if (this.enableDebugLogs) print(`[EdgeFunctionRoastById] ${message}`)
  }
}