# Optional AI draft authoring

P4 uses OpenAI first, with an administrator-configured model. Core operation remains local and works without this feature or internet connectivity. A local model adapter is future work.

The browser sends a prompt only after the operator explicitly chooses generation and acknowledges the disclosed project context. The context contains selected-project signal identifiers, names, types and directions; it does not include archive readings, passwords, Wi-Fi settings or private provisioning. Prompts and provider output are untrusted. Server-side ownership checks run before context construction. Credentials reside in a private server file, never in frontend environment variables or project exports.

The provider adapter uses the Responses API, bounded output, a deadline and no tools. It requests a structured envelope, handles refusal and incomplete output, then validates the inner graph/HMI document using application validators. Signal bindings must belong to the selected project and match the required type/direction. Generated script blocks are initially excluded. Invalid content is rejected without modifying a draft. Provider errors are sanitized, and generation is rate/concurrency limited.

A valid proposal remains a preview. Apply to draft is a separate deliberate action that uses the editor undo/redo stack. Saving, preparing and activating continue through their existing workflows. Generation does not send device commands, create a prepared revision or activate a graph. Ordinary Docker tests use an injected local provider fixture; a real OpenAI request is separate acceptance requiring configured credentials.

Primary reference: [OpenAI Structured Outputs and incomplete/refused responses](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), reviewed 2026-10-13. Structured formatting does not establish that a proposed control scheme is correct for equipment; application validation and operator review are still required.

## Server setup

Choose an OpenAI model available to your account that supports Responses with strict Structured Outputs. Model availability and provider charges are account-specific. No model or API key is built into Open APCS.

Create a private file **outside the repository**, readable by the API container's UID 1000. For example, create `~/.local/share/open-apcs/ai.json` using a local editor in a directory with mode 700, then set the file to mode 600. Its exact schema is:

```json
{
  "apiKey": "YOUR_PRIVATE_OPENAI_API_KEY",
  "model": "YOUR_RESPONSES_MODEL_ID"
}
```

The placeholders are not working credentials. Do not commit this file, place it in frontend environment variables, or paste its contents into issues. A symlink, group/world-readable file, unknown key or oversized configuration is rejected. The browser can read only whether AI is configured and the model identifier.

For loopback development, add the optional override:

```bash
export APCS_AI_CONFIG_FILE="$HOME/.local/share/open-apcs/ai.json"
docker compose -f compose.yml -f compose.ai.yml up -d --no-build --wait api web
```

For the HTTPS LAN profile, retain all overrides already used for your deployment:

```bash
export APCS_AI_CONFIG_FILE="$HOME/.local/share/open-apcs/ai.json"
docker compose --env-file .env.lan -f compose.yml -f compose.lan.yml -f compose.ai.yml up -d --no-build --wait api web
```

If you use a physical-device or notifications override, include that file as well. The override mounts only the private AI file into the API container. No image rebuild is required. Apply configuration changes by recreating the API service (`up -d --force-recreate api` with the same files); ordinary source changes continue to use watch/HMR. As with any API restart, running equipment is not automatically rearmed. Removing the AI override/configuration disables generation; existing manually reviewed documents remain ordinary local documents.

## Operator workflow

Open a graph or screen draft, select **AI assistant**, describe the requirements, and inspect **Signal context**. At most 100 selected boolean/numeric signals are disclosed, without live values or history. Names and the prompt themselves can contain sensitive information; review them before consenting. The check box authorizes this external generation request, not device operation.

**Generate proposal** sends the request. Review the summary and generated JSON; **Apply proposal to draft** asks to replace the current local document. Undo restores the previous document. Save and prepare remain separate actions, and graphs still require explicit activation. Generated content supports at most 64 elements; scripts, schedules and sequences are excluded from AI output in this initial adapter. Manual editors retain these capabilities.

## API and operational bounds

- `GET /api/v1/ai/status`: authenticated configured/model status, no secret.
- `POST /api/v1/projects/:id/ai/proposals`: owner/CSRF protected; accepts `kind`, `prompt`, selected `signalIds`, and `allowExternal: true`.
- At most five proposals per minute per client IP in this single API process; one outbound request at a time. Requests are not automatically retried.
- Prompt: 4,000 characters; context: 64 KiB; provider response: 256 KiB; generated document: 64 KiB. Provider deadline: 30 seconds; browser deadline: 35 seconds.
- Fixed OpenAI HTTPS endpoint, redirects rejected, no provider tools, `store: false`. This does not override the provider's independent data retention policies.
- Audit records include kind, model and completed-document checksum. Prompts, generated documents and provider error bodies are not copied into the audit log. Ordinary explicit draft saves retain their normal version history.

Timeouts, refusals, malformed output and invalid/cross-project bindings leave drafts unchanged. Missing configuration returns an explicit unavailable state; it does not prevent local editing or execution. Contract and browser tests use isolated local fixtures without billing or network calls to OpenAI. A live provider check remains unperformed until private credentials/model are supplied on the server.
