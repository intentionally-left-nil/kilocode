/**
 * Ana full-screen view
 *
 * Scaffold for the /ana "skin" — a fully different full-screen UI that
 * replaces the main Kilo chat screen. Typing `/kilo` and submitting
 * returns to the main Kilo UI.
 *
 * SPIKE: on mount, this suspends the OpenTUI renderer and hands the
 * terminal to TermDOM (a real DOM/CSSOM-to-terminal renderer), which
 * mounts a React tree using an actual Base UI Popover (shadcn/ui's
 * underlying primitive), unmodified. This tests whether Base UI's
 * floating-ui positioning resolves correctly on a character grid, as a
 * step toward reusing agentic-desktop's real component code for /ana
 * instead of hand-porting everything to OpenTUI's box/text primitives.
 * Press q or Escape inside the TermDOM screen to hand control back to
 * OpenTUI and return to the Kilo home screen.
 */

import { createSignal, onCleanup, onMount } from "solid-js"
import { RGBA, TextAttributes, type TextareaRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useEvent } from "@tui/context/event"
import { useBindings } from "@tui/keymap"
import { EmptyBorder } from "@tui/ui/border"
import type { AnaTermdomSpikeHandle } from "./termdom-bridge"

const ANA_BACKGROUND = RGBA.fromHex("#0a2e1d")
const ANA_ACCENT = RGBA.fromHex("#4ade80")
const ANA_TEXT = RGBA.fromHex("#e6fff2")
const ANA_MUTED = RGBA.fromHex("#7fbf9c")
const ANA_ERROR = RGBA.fromHex("#f87171")

export function AnaView() {
  const route = useRoute()
  const renderer = useRenderer()
  const sdk = useSDK()
  const event = useEvent()
  const [error, setError] = createSignal<string | undefined>()
  let input: TextareaRenderable | undefined
  let spike: AnaTermdomSpikeHandle | undefined
  let disposed = false
  let resumed = false

  function backToKilo() {
    route.navigate({ type: "home" })
  }

  // renderer.resume() unconditionally re-adds OpenTUI's stdin listener
  // (see CliRenderer.resume() in @opentui/core) with no guard against
  // being called twice -- unlike suspend()/resume() in editor.ts, Ana has
  // two independent call sites that can each try to reclaim the terminal
  // for the same suspend() (onExit below, and onCleanup's safety net).
  // Route navigation in backToKilo() unmounts this component synchronously
  // (before onExit even returns), running onCleanup nested inside onExit,
  // so gate on a flag here rather than relying on `disposed` (which is
  // set one step too late in that sequence) to keep resume() 1:1 with
  // suspend() and avoid doubled keystrokes from a duplicate stdin listener.
  function reclaimTerminal() {
    if (resumed) return
    resumed = true
    renderer.resume()
    renderer.requestRender()
  }

  // Scoped to this view: only active while /ana is the current route.
  useBindings(() => ({
    commands: [
      {
        namespace: "palette",
        name: "ana.back",
        title: "Back to Kilo",
        desc: "Return to the main Kilo UI",
        category: "Ana",
        slashName: "kilo",
        run: backToKilo,
      },
    ],
    bindings: [{ key: "escape", cmd: "ana.back" }],
  }))

  function submit() {
    if (!input) return
    const text = input.plainText.trim()
    input.clear()
    if (text === "/kilo") backToKilo()
  }

  onMount(() => {
    input?.focus()

    // Hand the terminal to TermDOM. OpenTUI and TermDOM can't both hold
    // raw mode / stdin at once, so suspend() releases it first -- same
    // pattern as the $EDITOR hand-off in packages/tui/src/editor.ts.
    renderer.suspend()
    import("./termdom-bridge")
      .then(({ runAnaTermdomSpike }) =>
        runAnaTermdomSpike({
          sdk,
          event,
          onExit: () => {
            if (disposed) return
            reclaimTerminal()
            backToKilo()
          },
        }),
      )
      .then((handle) => {
        spike = handle
      })
      .catch((err) => {
        // Reclaim the terminal even if TermDOM failed to start, so Kilo
        // isn't left stuck with no raw-mode input.
        reclaimTerminal()
        setError(err instanceof Error ? err.stack || err.message : String(err))
      })
  })

  onCleanup(() => {
    disposed = true
    // Safety net: if this view unmounts while the TermDOM spike still
    // owns the terminal (e.g. route changed some other way), tear it
    // down and reclaim the terminal so Kilo isn't left unresponsive.
    spike?.dispose().then(() => reclaimTerminal())
  })

  return (
    <box width="100%" height="100%" flexGrow={1} flexDirection="column" backgroundColor={ANA_BACKGROUND}>
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg={ANA_ACCENT} attributes={TextAttributes.BOLD}>
          🐍 Ana
        </text>
        <box height={1} />
        <text fg={ANA_TEXT}>Modern agentic Python package manager & helper</text>
        <box height={1} />
        <text fg={ANA_MUTED}>Type /kilo to return to the main Kilo UI</text>
        {error() && (
          <>
            <box height={1} />
            <text fg={ANA_ERROR}>TermDOM spike failed: {error()}</text>
          </>
        )}
      </box>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <box border={["left"]} borderColor={ANA_ACCENT} customBorderChars={{ ...EmptyBorder, vertical: "┃" }}>
          <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0} backgroundColor={ANA_BACKGROUND}>
            <textarea
              ref={(r: TextareaRenderable) => {
                input = r
              }}
              placeholder="Ask Ana anything... (/kilo to go back)"
              placeholderColor={ANA_MUTED}
              textColor={ANA_TEXT}
              focusedTextColor={ANA_TEXT}
              cursorColor={ANA_TEXT}
              focusedBackgroundColor={ANA_BACKGROUND}
              minHeight={2}
              maxHeight={4}
              onSubmit={submit}
            />
          </box>
        </box>
      </box>
    </box>
  )
}
