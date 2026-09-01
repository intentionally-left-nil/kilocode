import { describe, it, expect } from "bun:test"
import { THINKING_LEVELS, THINKING_LEVEL_LABEL, THINKING_LEVEL_QUERY, resolveModel, type AnaSDK } from "../../../src/kilocode/ana/inference"

/** Minimal stub of the SDK surface `resolveModel` actually calls. */
function stubSDK(response: {
  all: Array<{ id: string; models: Record<string, { name: string }> }>
  default: Record<string, string>
  connected: string[]
}): AnaSDK {
  return {
    client: {
      provider: {
        list: async () => ({ data: { ...response, failed: [] } }),
      },
    },
  } as unknown as AnaSDK
}

describe("ana inference", () => {
  describe("thinking levels", () => {
    it("maps every level to a Claude-class query term", () => {
      expect(THINKING_LEVEL_QUERY.easy).toEqual(["haiku"])
      expect(THINKING_LEVEL_QUERY.medium).toEqual(["sonnet"])
      expect(THINKING_LEVEL_QUERY.hard).toEqual(["opus"])
    })

    it("has a label for every level", () => {
      for (const level of THINKING_LEVELS) {
        expect(THINKING_LEVEL_LABEL[level]).toBeTruthy()
      }
    })
  })

  describe("resolveModel", () => {
    it("picks the first connected provider whose model IDs match the tier", async () => {
      const sdk = stubSDK({
        all: [
          {
            id: "kilo",
            models: {
              "anthropic/claude-haiku-4-5": { name: "Claude Haiku 4.5" },
              "anthropic/claude-sonnet-4-6": { name: "Claude Sonnet 4.6" },
            },
          },
        ],
        default: { kilo: "anthropic/claude-sonnet-4-6" },
        connected: ["kilo"],
      })

      const resolved = await resolveModel(sdk, "easy")
      expect(resolved).toEqual({
        providerID: "kilo",
        modelID: "anthropic/claude-haiku-4-5",
        name: "Claude Haiku 4.5",
      })
    })

    it("falls through to the next connected provider if the first has no match", async () => {
      const sdk = stubSDK({
        all: [
          { id: "openai", models: { "gpt-5": { name: "GPT-5" } } },
          { id: "kilo", models: { "anthropic/claude-opus-4-6": { name: "Claude Opus 4.6" } } },
        ],
        default: { openai: "gpt-5", kilo: "anthropic/claude-opus-4-6" },
        connected: ["openai", "kilo"],
      })

      const resolved = await resolveModel(sdk, "hard")
      expect(resolved.providerID).toBe("kilo")
      expect(resolved.modelID).toBe("anthropic/claude-opus-4-6")
    })

    it("falls back to the provider's default model when no tier match exists", async () => {
      const sdk = stubSDK({
        all: [{ id: "kilo", models: { "kilo-auto/small": { name: "Kilo Auto (small)" } } }],
        default: { kilo: "kilo-auto/small" },
        connected: ["kilo"],
      })

      const resolved = await resolveModel(sdk, "hard")
      expect(resolved).toEqual({
        providerID: "kilo",
        modelID: "kilo-auto/small",
        name: "Kilo Auto (small)",
      })
    })

    it("throws when no provider is connected", async () => {
      const sdk = stubSDK({ all: [], default: {}, connected: [] })
      await expect(resolveModel(sdk, "medium")).rejects.toThrow(/no connected model provider/i)
    })
  })
})
