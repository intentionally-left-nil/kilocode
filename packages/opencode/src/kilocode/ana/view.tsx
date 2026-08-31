/**
 * Ana full-screen view
 *
 * Scaffold for the /ana "skin" — a fully different full-screen UI that
 * replaces the main Kilo chat screen. For now this is intentionally a
 * blank screen with just a chat input box, styled with a distinct dark
 * green background so it's obvious the skin-switching mechanism works.
 * Typing `/kilo` and submitting returns to the main Kilo UI.
 */

import { onMount } from "solid-js"
import { RGBA, TextAttributes, type TextareaRenderable } from "@opentui/core"
import { useRoute } from "@tui/context/route"
import { useBindings } from "@tui/keymap"
import { EmptyBorder } from "@tui/ui/border"

const ANA_BACKGROUND = RGBA.fromHex("#0a2e1d")
const ANA_ACCENT = RGBA.fromHex("#4ade80")
const ANA_TEXT = RGBA.fromHex("#e6fff2")
const ANA_MUTED = RGBA.fromHex("#7fbf9c")

export function AnaView() {
  const route = useRoute()
  let input: TextareaRenderable | undefined

  function backToKilo() {
    route.navigate({ type: "home" })
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

  onMount(() => input?.focus())

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
