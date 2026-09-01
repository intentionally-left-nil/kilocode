/**
 * Model resolution + real inference for the /ana chat window, driven
 * entirely through the SDK client (`@kilocode/sdk`) rather than any
 * direct in-process `Provider`/`AppRuntime`/Effect calls.
 *
 * The TUI (this code) runs in a separate worker process from the backend
 * that actually hosts `Provider`/`AppRuntime` -- Instance/App context is
 * established per-HTTP-request by server middleware and never exists in
 * the TUI process. Calling `AppRuntime.runPromise(Provider.Service.use(...))`
 * from here throws "InstanceRef not provided" (src/effect/instance-state.ts).
 * So instead of resolving models server-side (`Provider.closest`), the same
 * substring-tiering is done client-side against `GET /provider`, and
 * inference goes through a normal (if throwaway) chat Session over the SDK
 * -- the same transport every other real chat interaction in Kilo uses.
 *
 * "Thinking level" is a simplified stand-in for a full model picker: easy /
 * medium / hard map to Claude-class model tiers (haiku / sonnet / opus).
 */

import type { useSDK } from "@tui/context/sdk"
import type { useEvent } from "@tui/context/event"

export type AnaSDK = ReturnType<typeof useSDK>
export type AnaEvent = ReturnType<typeof useEvent>

export const THINKING_LEVELS = ["easy", "medium", "hard"] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export const THINKING_LEVEL_LABEL: Record<ThinkingLevel, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
}

/** Substrings matched against a provider's model IDs, client-side. */
export const THINKING_LEVEL_QUERY: Record<ThinkingLevel, string[]> = {
  easy: ["haiku"],
  medium: ["sonnet"],
  hard: ["opus"],
}

export interface ResolvedModel {
  providerID: string
  modelID: string
  name: string
}

/**
 * Resolves a thinking level to an actual provider/model by fetching the
 * live provider catalog (`GET /provider`) and substring-matching model IDs
 * against the level's query terms -- the same approach `Provider.closest`
 * uses server-side, relocated to a place that can actually reach it.
 * Checks providers in `connected` order and falls back to that provider's
 * own default model if none of its model IDs match, so a level always
 * resolves to *something* rather than erroring outright.
 */
export async function resolveModel(sdk: AnaSDK, level: ThinkingLevel): Promise<ResolvedModel> {
  const res = await sdk.client.provider.list({}, { throwOnError: true })
  const { all, default: defaults, connected } = res.data
  const query = THINKING_LEVEL_QUERY[level]

  for (const providerID of connected) {
    const provider = all.find((p) => p.id === providerID)
    if (!provider) continue
    const modelID = Object.keys(provider.models).find((id) => query.some((term) => id.includes(term)))
    if (modelID) return { providerID, modelID, name: provider.models[modelID]?.name ?? modelID }
  }

  const providerID = connected[0]
  if (!providerID) throw new Error("No connected model provider is available")
  const modelID = defaults[providerID]
  if (!modelID) throw new Error(`No default model configured for provider ${providerID}`)
  const provider = all.find((p) => p.id === providerID)
  return { providerID, modelID, name: provider?.models[modelID]?.name ?? modelID }
}

/**
 * Built-in "plan" agent -- a real, primary chat agent with no baked-in
 * `agent.prompt` of its own (unlike the hidden "title"/"summary"/
 * "compaction" utility agents, whose own prompt is *prepended* before the
 * per-request `system` override in session/llm/request.ts, not replaced by
 * it -- reusing one of those makes the model see "output ONLY a thread
 * title, nothing else" ahead of, and dominating over, Ana's persona,
 * which is exactly why early responses were getting clipped to a
 * title-length string regardless of the `system` override below).
 * "plan" mode structurally denies all edit tools; combined with the
 * `tools: { "*": false }` override on every prompt() call below (a
 * wildcard permission key, the same mechanism the hidden agents use for
 * their own "*": "deny" catch-all), Ana's chat can't trigger file edits,
 * shell commands, or MCP tools regardless of new tools registered later.
 */
const AGENT = "plan"

/** Creates the (single, reused-for-the-conversation) chat session Ana talks through. */
export async function createChatSession(sdk: AnaSDK, model: ResolvedModel): Promise<string> {
  const res = await sdk.client.session.create(
    { agent: AGENT, model: { id: model.modelID, providerID: model.providerID }, directory: sdk.directory },
    { throwOnError: true },
  )
  return res.data.id
}

export async function deleteChatSession(sdk: AnaSDK, sessionID: string): Promise<void> {
  await sdk.client.session.delete({ sessionID, directory: sdk.directory }).catch(() => {})
}

export interface SendMessageOptions {
  sdk: AnaSDK
  event: AnaEvent
  sessionID: string
  model: ResolvedModel
  system: string
  text: string
  onDelta: (chunk: string) => void
}

/**
 * Sends one user turn to the (already-created) chat session and streams
 * the reply back via `onDelta`, subscribed through the TUI's own event bus
 * (`useEvent()`, which unwraps the SDK's raw SSE payload and scopes it to
 * this project/directory) for `message.part.delta` -- the same live-token
 * mechanism the main Kilo TUI uses -- filtered down to this session and
 * its "text" field. Returns the final, authoritative text from the
 * completed message once `session.prompt` resolves (guards against any
 * delta ordering/drop issues in the incremental view).
 *
 * `directory: opts.sdk.directory` matters here: `createKiloClient`'s
 * automatic `x-kilo-directory` header injection (kept in sync with
 * `useEvent()`'s own directory/project scoping) only rewrites GET/HEAD
 * requests (see packages/sdk/js/src/v2/client.ts's `rewrite()`) --
 * `session.create`/`session.prompt` are POST, so without this every other
 * piece of TUI code that creates/prompts a session threads `directory`
 * through explicitly (e.g. packages/tui/src/component/prompt/index.tsx),
 * and this needs to as well or its events get silently filtered out by
 * the directory/project mismatch, with no visible symptom beyond
 * "streaming never shows up" (the plain HTTP response above still works
 * regardless, since it doesn't depend on SSE delivery).
 */
export async function sendMessage(opts: SendMessageOptions): Promise<string> {
  const unsubscribe = opts.event.on("message.part.delta", (evt) => {
    if (evt.properties.sessionID !== opts.sessionID) return
    if (evt.properties.field !== "text") return
    opts.onDelta(evt.properties.delta)
  })

  try {
    const res = await opts.sdk.client.session.prompt(
      {
        sessionID: opts.sessionID,
        agent: AGENT,
        model: { providerID: opts.model.providerID, modelID: opts.model.modelID },
        system: opts.system,
        tools: { "*": false },
        parts: [{ type: "text", text: opts.text }],
        directory: opts.sdk.directory,
      },
      { throwOnError: true },
    )
    return res.data.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
  } finally {
    unsubscribe()
  }
}

export async function abortMessage(sdk: AnaSDK, sessionID: string): Promise<void> {
  await sdk.client.session.abort({ sessionID, directory: sdk.directory }).catch(() => {})
}
