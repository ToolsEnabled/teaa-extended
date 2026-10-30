# Gemini CLI sign-in: support and compatibility

Reviewed October 20, 2026, in response to [issue #7](https://github.com/ToolsEnabled/toolsenabled-fleet-mcp/issues/7).

Google's current [authentication guide](https://geminicli.com/docs/get-started/authentication/) recommends personal Google sign-in for eligible users, including AI Pro and Ultra subscribers. Its [quota guidance](https://geminicli.com/docs/resources/quota-and-pricing/) also lists those plans. The authentication guide says headless CLI sessions can reuse authentication already cached by the CLI; without existing sign-in, it recommends API-key or Vertex AI configuration.

The issue reporter separately tested the official Gemini CLI 0.64.0 without Fleet and reported `IneligibleTierError` / `UNSUPPORTED_CLIENT` for their existing individual login, with migration guidance to Antigravity. That is an account/version compatibility observation supplied by the reporter, not a Fleet reproduction and not evidence that every individual account is prohibited. We have not resolved the discrepancy between that observation and Google's published documentation.

Fleet's earlier blanket statement that individual Google sign-in ended on June 18, 2026 was too broad. Personal-subscription Gemini workers remain unqualified by Fleet; that support limit must not be presented as a universal Google policy. Fleet invokes the official CLI and lets it handle authentication; this documentation change neither changes sign-in nor enables a new authentication route.

Google's [FAQ](https://geminicli.com/docs/resources/faq/) prohibits harvesting or piggybacking on Gemini CLI OAuth credentials to access its backend, and points third-party coding agents to Google AI Studio API keys or Vertex AI. Do not extract, copy or replay OAuth tokens. Native CLI execution differs technically from token replay, but does not by itself establish vendor clearance for every orchestration workflow. An assigned Code Assist license likewise is not blanket approval for third-party orchestration.

For a Fleet worker deployment, use an authentication route explicitly permitted for that deployment under your Google agreement. API-key or Vertex AI routes are the documented third-party-agent options; availability and billing remain your decisions. If the official CLI rejects your account, keep that worker off and resolve eligibility with Google. Do not automate a workaround or switch to a personal Antigravity worker: Antigravity is a separate product with its own restrictions.
