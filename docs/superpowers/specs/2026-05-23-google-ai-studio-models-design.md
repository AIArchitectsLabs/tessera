# Google AI Studio Models Design

## Goal

Add Google AI Studio as a first-class model provider for Tessera chat and task runs while leaving the existing OpenAI, OpenAI Codex, Anthropic, OpenRouter, and local provider behavior unchanged.

## Provider

- Provider id: `google`
- Display name: `Google AI Studio`
- Credential environment fallback: `GOOGLE_AI_STUDIO_API_KEY`
- Keychain account: `model.google`, user-scoped as `user.<userKey>.model.google`
- Runtime API: OpenAI-compatible chat completions
- Runtime base URL: `https://generativelanguage.googleapis.com/v1beta/openai`

## Dropdown Models

The Settings > Model dropdown exposes chat-capable Gemini models that are listed in Google AI for Developers documentation and suitable for the OpenAI-compatible chat path:

- `gemini-3.5-flash`
- `gemini-3.1-pro-preview`
- `gemini-3-flash-preview`
- `gemini-3.1-flash-lite`
- `gemini-3.1-flash-lite-preview`
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`

Media-only, TTS, Live API, embedding, robotics, and managed-agent models are intentionally excluded because Tessera's model picker is for text chat/task execution.

## Specs And Cost Metadata

Tessera stores model cost in USD per 1M tokens using the paid standard tier where Google lists a standard price. The runtime metadata uses a 1,048,576 token context window and 65,536 max output tokens for Gemini chat models until a more granular local model registry is introduced.

| Model | Input | Output | Cache Read |
| --- | ---: | ---: | ---: |
| `gemini-3.5-flash` | 1.50 | 9.00 | 0.15 |
| `gemini-3.1-pro-preview` | 2.00 | 12.00 | 0.20 |
| `gemini-3-flash-preview` | 2.00 | 12.00 | 0.20 |
| `gemini-3.1-flash-lite` | 0.25 | 1.50 | 0.025 |
| `gemini-3.1-flash-lite-preview` | 0.25 | 1.50 | 0.025 |
| `gemini-2.5-pro` | 1.25 | 10.00 | 0.125 |
| `gemini-2.5-flash` | 0.30 | 2.50 | 0.03 |
| `gemini-2.5-flash-lite` | 0.10 | 0.40 | 0.01 |

## Testing

- Contract tests must accept `google` model settings, save requests, and runtime provider configs.
- UI helper tests must show Google AI Studio in the provider list and expose every curated Gemini model.
- Settings view tests must verify the Google provider renders a selectable Gemini dropdown.
- Core tests must verify Google AI Studio credential resolution, task model resolution, OpenAI-compatible runtime mapping, and Pi model registry specs.
- Rust settings tests must verify default settings, keychain account naming, missing credential handling, and backfill for existing installs.

## Source Notes

- Google AI for Developers lists current Gemini models and naming patterns in the Gemini API models docs.
- Google AI for Developers documents OpenAI compatibility with the Gemini API key and the `generativelanguage.googleapis.com/v1beta/openai` base URL.
- Google AI for Developers publishes Gemini Developer API pricing by model; this spec uses paid standard tier text pricing.
