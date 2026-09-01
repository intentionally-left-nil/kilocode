/**
 * TermDOM spike bridge for the /ana skin.
 *
 * Boots a real DOM (via @b9g/termdom) inside the terminal and mounts a
 * React tree. Ports agentic-desktop's chat "draft" welcome screen
 * (DraftWelcomeHeadline + the ComposerPrimitive.Input shell from
 * plugins/kilo-ui/src/web/chat/components/assistant-ui/thread.tsx) as a
 * self-contained component -- a real <textarea> in a real bordered shell.
 * Submitting transitions from the centered "draft" composer to a docked
 * chat layout, the same isDraft branch agentic-desktop's Thread component
 * uses. Chat turns are real: each send resolves a model and streams a
 * reply from a real (throwaway) Kilo chat session over the SDK client --
 * see ./inference.ts for why this goes through the SDK rather than
 * calling `Provider`/`AppRuntime` directly (this code runs in the TUI
 * worker process, which has no direct access to the backend's in-process
 * Effect services) -- the same shape as termdom's own chat.ts example
 * (https://github.com/bikeshaving/termdom/blob/main/examples/chat.ts).
 *
 * A right-hand sidebar lets you pick a "thinking level" -- easy / medium /
 * hard -- which is a simplified stand-in for a full model picker, mapped to
 * Claude-class tiers (haiku / sonnet / opus respectively). See
 * ./inference.ts for how a level resolves to an actual model.
 *
 * Written with React.createElement (no JSX) so this file doesn't need a
 * per-file @jsxImportSource pragma to override the package's Solid JSX
 * default (see tsconfig.json: jsxImportSource: "@opentui/solid").
 *
 * IMPORTANT: react/react-dom/@base-ui/react are imported dynamically,
 * *after* globalThis.document/window are wired to the terminal, not as
 * static top-level imports. @base-ui/utils/useIsoLayoutEffect.mjs does
 * `typeof document !== 'undefined' ? useLayoutEffect : noop` -- a check
 * evaluated exactly once, at module-load time. A static import here would
 * be hoisted and evaluated before the globals exist, permanently binding
 * that hook to a no-op for the process's lifetime and silently breaking
 * every layout-effect-driven state sync in Base UI (this is also why
 * @base-ui/react is still imported dynamically even though this file no
 * longer renders a Base UI component directly -- kept for the next
 * component we port).
 *
 * The caller (AnaView) is responsible for calling `renderer.suspend()` on
 * the OpenTUI CliRenderer before invoking this, and `renderer.resume()`
 * after `onExit` fires -- TermDOM and OpenTUI cannot both hold the
 * terminal (raw mode / stdin) at the same time.
 */

import {
  resolveModel,
  createChatSession,
  deleteChatSession,
  sendMessage,
  abortMessage,
  THINKING_LEVELS,
  THINKING_LEVEL_LABEL,
  type AnaSDK,
  type AnaEvent,
  type ThinkingLevel,
} from "./inference"

export interface AnaTermdomSpikeHandle {
  dispose: () => Promise<void>
}

const SYSTEM_PROMPT =
  "You are Ana, a modern agentic Python package manager and helper. " +
  "Answer conversationally and concisely, formatting code in markdown fences when useful."

const DEFAULT_LEVEL: ThinkingLevel = "medium"

// Sidebar is a fixed character-column width; the main pane's width is
// computed here (from the real terminal width, not CSS flex-grow) rather
// than via `flex: 1` -- flex-grow's width distribution turned out unreliable
// several levels deep in this nested layout (it's what made the sidebar
// buttons render oversized, and separately let message text grow past the
// visible edge instead of wrapping). Giving `.main` an explicit `ch` width
// here means every descendant (`.chat`, `.chat-messages`, `.msg-row`)
// inherits a genuinely bounded width through plain block layout instead of
// depending on flex math to get it right.
const SIDEBAR_CH = 22

export async function runAnaTermdomSpike(opts: {
  sdk: AnaSDK
  event: AnaEvent
  onExit: () => void
}): Promise<AnaTermdomSpikeHandle> {
  const { sdk, event } = opts
  const { TermDOM } = await import("@b9g/termdom")
  const term = new TermDOM()
  const mainCh = Math.max(40, (process.stdout.columns || 80) - SIDEBAR_CH - 1)
  // .chat's `padding: 1ch 2ch` eats 4ch of mainCh (2ch each side); leave a
  // little more breathing room so a max-width bubble never has to compete
  // with that padding for space.
  const bubbleCh = Math.max(20, mainCh - 8)
  const composerCh = Math.min(60, mainCh - 6)

  // Mirror term.window's surface onto globalThis, same as a real browser
  // environment would provide. Libraries under Base UI (@floating-ui/utils,
  // @base-ui/utils/useAnimationFrame) reference bare globals directly --
  // `HTMLElement`, `requestAnimationFrame`, `matchMedia`, etc. -- rather
  // than `window.HTMLElement`/`window.requestAnimationFrame`. Skip Node
  // core identifiers we must not clobber (timers/microtask APIs Node
  // already provides compatibly); document/window are set explicitly
  // first since they're excluded from the generic copy below.
  ;(globalThis as any).document = term.document
  ;(globalThis as any).window = term.window
  const skip = new Set(["document", "window", "self", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask"])
  for (const key of Object.getOwnPropertyNames(term.window)) {
    if (skip.has(key)) continue
    const value = (term.window as any)[key]
    if (typeof value === "function" || (typeof value === "object" && value !== null)) {
      ;(globalThis as any)[key] = value
    }
  }

  // Only now -- with the globals in place -- pull in React, so its
  // module-level environment detection sees a real document/window
  // instead of "undefined".
  const React = await import("react")
  const { createRoot } = await import("react-dom/client")

  const h = React.createElement
  const { useState, useEffect, useRef } = React

  const { document } = term

  // Colors below are hand-converted from @anaconda/shadcn-theme's actual
  // dark-mode oklch tokens (extracted reference copy at
  // plugins/environments/src/mcp-app/theme.css in agentic-desktop), since
  // TermDOM does not resolve oklch()/color-mix() -- it silently drops the
  // paint. Converted via the standard OKLab->sRGB matrix; storm-900 and
  // storm-50 were cross-checked against the hardcoded hex fallbacks in
  // packages/contracts/src/features/theme-tokens.ts (#141820 / #fafafa)
  // and matched exactly.
  const storm900 = "#141820" // --background (dark)
  const storm850 = "#1c2027" // --card / --popover / --muted (dark)
  const storm50 = "#fafafa" // --foreground (dark)
  const stormMuted = "#93a3bb" // --muted-foreground (dark, storm-400)
  const borderDim = "#29313c" // --border at the ~60% opacity thread.tsx uses for shells/bubbles
  const primary = "#96f778" // --primary (dark, lime-600)
  const primaryForeground = storm900 // --primary-foreground (dark)
  const errorColor = "#f87171" // --destructive-foreground-ish (matches AnaView's ANA_ERROR)

  // agentic-desktop's draft composer sits inside a large blurred
  // `bg-primary/8` (`/15` in dark mode) ellipse -- `blur-[90px]`, ~110% of
  // the composer's size (thread.tsx's ComposerDockMask). TermDOM doesn't
  // support opacity, blur, or gradients (all no-op/not-applicable on a
  // character grid per its compatibility table), so this approximates the
  // falloff as concentric solid rings, each mixing a bit more of `primary`
  // into the page background, going outward. Values pre-blended offline:
  // mix(storm900, primary, {0.20, 0.12, 0.06}).
  const glowInner = "#2e4532"
  const glowMid = "#24332b"
  const glowOuter = "#1c2525"

  const style = document.createElement("style")
  style.textContent = `
    body { background-color: ${storm900}; color: ${storm50}; height: 100%; }

    .welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 2ch;
    }
    .welcome-heading { color: ${storm50}; font-weight: bold; margin-bottom: 1px; }
    .welcome-hint { color: ${stormMuted}; margin-top: 1px; }

    /* Concentric approximation of the blurred bg-primary/8 ambient glow
       behind the draft composer -- see comment above. */
    .glow-row { display: flex; justify-content: center; width: 100%; }
    .glow-outer { background-color: ${glowOuter}; border-radius: 1px; padding: 1px; display: flex; justify-content: center; }
    .glow-mid { background-color: ${glowMid}; border-radius: 1px; padding: 1px; display: flex; justify-content: center; }
    .glow-inner { background-color: ${glowInner}; border-radius: 1px; padding: 1px; display: flex; justify-content: center; }

    /* Ported from thread.tsx's aui_composer-shell: border-border/60 bg-(--composer-bg)
       rounded-(--composer-radius) border p-(--composer-padding). */
    .composer-shell {
      border: 1px solid ${borderDim};
      border-radius: 1px;
      background-color: ${storm850};
      padding: 1ch;
      display: flex;
      flex-direction: column;
      gap: 1px;
      width: ${composerCh}ch;
    }
    .composer-shell:focus-within { border-color: ${borderDim}; background-color: ${storm850}; }
    .composer-input {
      background-color: transparent;
      color: ${storm50};
      border: none;
      width: 100%;
    }
    .composer-input::placeholder { color: ${stormMuted}; }
    .composer-action { display: flex; justify-content: flex-end; margin-top: 1px; }
    /* ComposerAction's send button: shadcn Button variant="default" size="icon"
       rounded-full -- solid bg-primary / text-primary-foreground. */
    .composer-send {
      background-color: ${primary};
      color: ${primaryForeground};
      border: none;
      border-radius: 1px;
      padding: 0 1ch;
    }
    .composer-send[disabled] { background-color: ${storm850}; color: ${stormMuted}; }

    .chat { display: flex; flex-direction: column; height: 100%; padding: 1ch 2ch; }
    .chat-messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
    /* Chat bubbles, aligned via text-align + display: inline-block rather
       than flexbox's justify-content: flex-end -- the earlier flex-based
       version pushed user messages past the visible width instead of
       right-aligning them within it (same underlying flex-width unreliability
       as the sidebar buttons above, now worked around at the source by
       giving .main a real ch width instead of flex: 1). inline-block gives
       each bubble intrinsic (shrink-to-fit) sizing capped by max-width, so
       short messages hug their content and long ones wrap within it instead
       of bleeding off-screen.
       aui-user-message-content: border-border/60 bg-background rounded-xl
       border, right-aligned; assistant renders as plain foreground text. */
    .msg-row { margin-top: 1px; }
    .msg-row-user { text-align: right; }
    .msg-bubble { display: inline-block; max-width: ${bubbleCh}ch; text-align: left; padding: 0 1ch; }
    .msg-bubble-user {
      border: 1px solid ${borderDim};
      border-radius: 1px;
      background-color: ${storm850};
      color: ${storm50};
    }
    .msg-bubble-assistant { color: ${storm50}; }
    .msg-bubble-pending { color: ${stormMuted}; }
    .msg-bubble-error {
      border: 1px solid ${errorColor};
      border-radius: 1px;
      background-color: ${storm850};
      color: ${errorColor};
    }
    .chat-composer { width: 100%; margin-top: 1px; }

    /* Overall layout: chat/draft content on the left, thinking-level picker
       docked on the right -- same border-left shell language as Ana's
       OpenTUI home screen (view.tsx's EmptyBorder-bordered composer).
       .main gets an explicit ${mainCh}ch width (computed from the real
       terminal width in JS) rather than flex: 1 -- see the SIDEBAR_CH
       comment above for why. */
    .app-shell { display: flex; flex-direction: row; height: 100%; }
    .main { width: ${mainCh}ch; flex-shrink: 0; display: flex; flex-direction: column; height: 100%; }
    .sidebar {
      width: ${SIDEBAR_CH}ch;
      flex-shrink: 0;
      border-left: 1px solid ${borderDim};
      background-color: ${storm850};
      padding: 1ch;
      display: flex;
      flex-direction: column;
    }
    .sidebar-title { color: ${storm50}; font-weight: bold; margin-bottom: 1px; }
    /* Buttons default to display: inline-block with UA-injected "[ " / " ]"
       bracket content around their text (termdom's terminal-native button
       affordance) -- stripped below for a plain bordered pill instead.
       Fixed-width (not width: 100%) since percentage width against a flex
       column's stretched cross-axis rendered comically oversized here. */
    .level-btn {
      display: block;
      box-sizing: border-box;
      border: 1px solid ${borderDim};
      border-radius: 1px;
      background-color: ${storm900};
      color: ${storm50};
      padding: 0 1ch;
      margin-top: 1px;
      text-align: left;
      white-space: nowrap;
      width: 18ch;
    }
    .level-btn::before, .level-btn::after { content: ""; }
    .level-btn-active {
      background-color: ${primary};
      color: ${primaryForeground};
      border-color: ${primary};
    }
    .sidebar-model { color: ${stormMuted}; margin-top: 1px; }
    .sidebar-model-error { color: ${errorColor}; margin-top: 1px; }
  `
  document.head.appendChild(style)

  interface Message {
    role: "user" | "assistant"
    text: string
    error?: boolean
  }

  type LevelStatus =
    | { type: "loading" }
    | { type: "ready"; name: string }
    | { type: "error"; message: string }

  // Lives outside React state (rather than a ref) so `dispose()` below --
  // called from the top-level keydown handler, outside any component --
  // can abort + clean up the (real, server-persisted) chat session when
  // the user quits back to Kilo.
  let activeSessionID: string | undefined

  function ComposerShell(props: {
    value: string
    onChange: (v: string) => void
    onSubmit: () => void
    disabled: boolean
    inputRef: any
  }) {
    const canSend = !props.disabled && props.value.trim().length > 0
    function onKeyDown(ev: any) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault()
        props.onSubmit()
      }
    }
    return h(
      "div",
      { className: "composer-shell" },
      h("textarea", {
        ref: props.inputRef,
        className: "composer-input",
        placeholder: props.disabled ? "Ana is thinking..." : "Send a message...",
        value: props.value,
        rows: 2,
        disabled: props.disabled,
        onChange: (ev: any) => props.onChange(ev.target.value),
        onKeyDown,
      }),
      h(
        "div",
        { className: "composer-action" },
        h(
          "button",
          { className: "composer-send", disabled: !canSend, onClick: props.onSubmit },
          "\u2191 Send",
        ),
      ),
    )
  }

  function Sidebar(props: {
    level: ThinkingLevel
    onSelect: (level: ThinkingLevel) => void
    status: LevelStatus | undefined
  }) {
    return h(
      "div",
      { className: "sidebar" },
      h("div", { className: "sidebar-title" }, "Thinking"),
      THINKING_LEVELS.map((level) =>
        h(
          "button",
          {
            key: level,
            className: `level-btn ${level === props.level ? "level-btn-active" : ""}`,
            onClick: () => props.onSelect(level),
          },
          THINKING_LEVEL_LABEL[level],
        ),
      ),
      props.status?.type === "loading" ? h("div", { className: "sidebar-model" }, "Resolving model...") : null,
      props.status?.type === "ready" ? h("div", { className: "sidebar-model" }, props.status.name) : null,
      props.status?.type === "error"
        ? h("div", { className: "sidebar-model-error" }, `\u26a0 ${props.status.message}`)
        : null,
    )
  }

  function App() {
    const [value, setValue] = useState("")
    const [messages, setMessages] = useState<Message[]>([])
    const [level, setLevel] = useState<ThinkingLevel>(DEFAULT_LEVEL)
    const [statusByLevel, setStatusByLevel] = useState<Partial<Record<ThinkingLevel, LevelStatus>>>({})
    const [busy, setBusy] = useState(false)
    const inputRef = useRef<any>(null)
    const bottomRef = useRef<any>(null)
    const isDraft = messages.length === 0

    useEffect(() => {
      inputRef.current?.focus()
    }, [])

    // Keep the tail of the conversation in view as it grows -- mirrors
    // termdom's own chat.ts example scrolling the prompt into view after
    // every message (scrollToPrompt()); `.chat-messages` here is its own
    // overflow-y: auto region rather than page-level scroll, but
    // scrollIntoView() still walks up to it. Re-runs on every delta too, so
    // a long streaming reply keeps pinned to the bottom as it grows.
    useEffect(() => {
      bottomRef.current?.scrollIntoView?.()
    }, [messages])

    // Kick off (and cache) model resolution for a level, updating the
    // sidebar's status as it settles. Shared by the mount/level-change
    // effect below and by submit() (so retrying a send after a failed
    // resolution also refreshes the sidebar instead of leaving it stuck on
    // a stale error).
    function resolveTracked(target: ThinkingLevel) {
      setStatusByLevel((s) => ({ ...s, [target]: { type: "loading" } }))
      const promise = resolveModel(sdk, target)
      promise.then(
        (resolved) => setStatusByLevel((s) => ({ ...s, [target]: { type: "ready", name: resolved.name } })),
        (err) =>
          setStatusByLevel((s) => ({
            ...s,
            [target]: { type: "error", message: err instanceof Error ? err.message : String(err) },
          })),
      )
      return promise
    }

    function ensureLevelResolving(target: ThinkingLevel) {
      if (statusByLevel[target]) return
      void resolveTracked(target)
    }

    useEffect(() => {
      ensureLevelResolving(level)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [level])

    function selectLevel(next: ThinkingLevel) {
      setLevel(next)
      ensureLevelResolving(next)
    }

    async function submit() {
      const text = value.trim()
      if (!text || busy) return

      // Same escape hatch as OpenTUI's own Ana screen (view.tsx) and the
      // same exact-match contract: typing "/kilo" and submitting returns
      // to the main Kilo UI, in addition to the Escape/q keydown handler
      // below. Goes through the same dispose()+onExit path so the
      // throwaway chat session is cleaned up either way.
      if (text === "/kilo") {
        setValue("")
        dispose().then(opts.onExit)
        return
      }

      setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: "" }])
      setValue("")
      setBusy(true)

      function appendDelta(chunk: string) {
        setMessages((m) => {
          const next = m.slice()
          const last = next.at(-1)
          if (!last || last.role !== "assistant") return m
          next[next.length - 1] = { ...last, text: last.text + chunk }
          return next
        })
      }

      try {
        const resolved = await resolveTracked(level)
        const sessionID = activeSessionID ?? (await createChatSession(sdk, resolved))
        activeSessionID = sessionID
        const finalText = await sendMessage({
          sdk,
          event,
          sessionID,
          model: resolved,
          system: SYSTEM_PROMPT,
          text,
          onDelta: appendDelta,
        })
        // Authoritative overwrite -- guards against any delta ordering/drop
        // issues in the incremental view above.
        setMessages((m) => {
          const next = m.slice()
          const last = next.at(-1)
          if (!last || last.role !== "assistant") return m
          next[next.length - 1] = { ...last, text: finalText }
          return next
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setMessages((m) => {
          const next = m.slice()
          const last = next.at(-1)
          if (!last || last.role !== "assistant") return m
          next[next.length - 1] = { role: "assistant", text: `\u26a0 ${message}`, error: true }
          return next
        })
      } finally {
        setBusy(false)
        inputRef.current?.focus()
      }
    }

    const composer = h(ComposerShell, { value, onChange: setValue, onSubmit: submit, disabled: busy, inputRef })
    const sidebar = h(Sidebar, { level, onSelect: selectLevel, status: statusByLevel[level] })

    if (isDraft) {
      return h(
        "div",
        { className: "app-shell" },
        h(
          "div",
          { className: "main" },
          h(
            "div",
            { className: "welcome" },
            h("div", { className: "welcome-heading" }, "What should we work on?"),
            h(
              "div",
              { className: "glow-row" },
              h(
                "div",
                { className: "glow-outer" },
                h("div", { className: "glow-mid" }, h("div", { className: "glow-inner" }, composer)),
              ),
            ),
            h("div", { className: "welcome-hint" }, "Type /kilo or press Escape to return to Kilo"),
          ),
        ),
        sidebar,
      )
    }

    return h(
      "div",
      { className: "app-shell" },
      h(
        "div",
        { className: "main" },
        h(
          "div",
          { className: "chat" },
          h(
            "div",
            { className: "chat-messages" },
            messages.map((m, i) =>
              h(
                "div",
                { key: i, className: `msg-row ${m.role === "user" ? "msg-row-user" : ""}` },
                h(
                  "div",
                  {
                    className: `msg-bubble ${
                      m.role === "user"
                        ? "msg-bubble-user"
                        : m.error
                          ? "msg-bubble-error"
                          : m.text.length === 0
                            ? "msg-bubble-assistant msg-bubble-pending"
                            : "msg-bubble-assistant"
                    }`,
                  },
                  m.role === "assistant" && m.text.length === 0 ? "Ana is thinking\u2026" : m.text,
                ),
              ),
            ),
            h("div", { ref: bottomRef }),
          ),
          h("div", { className: "chat-composer" }, composer),
        ),
      ),
      sidebar,
    )
  }

  await term.attach()
  const root = createRoot(document.body)
  root.render(h(App, null))

  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    // Best-effort: stop any in-flight generation and clean up the
    // throwaway chat session so it doesn't linger in the session list.
    if (activeSessionID) {
      const sessionID = activeSessionID
      await abortMessage(sdk, sessionID)
      await deleteChatSession(sdk, sessionID)
    }
    root.unmount()
    await term.dispose()
  }

  document.addEventListener("keydown", (ev: any) => {
    if (ev.key === "Escape" || (ev.key === "q" && document.activeElement?.tagName !== "TEXTAREA")) {
      dispose().then(opts.onExit)
    }
  })

  return { dispose }
}
