# @platypus/decision-gate

A Tool gate that asks a decision model about every tool call before it runs:
is this call destructive or irreversible? A call the model rates likely enough
is stopped, or, in a Chat, put to the Workspace Owner for approval.

Set `resultDenyThreshold` and it also screens each tool's result before the
model sees it: does the result contain instructions aimed at the assistant
rather than data? A result rated likely enough is withheld. A long result is
screened in parts, so screening it takes one model call per part.

The plugin ships inside the backend, so there is nothing to install. It is off
until you enable it.

## Enable it

1. Get an API key for a provider that serves decision models: `gateway` (the
   default), `anthropic`, `openai`, `google` or `openrouter`.
2. In the backend's `.env`, add `@platypus/decision-gate` to
   `PLATYPUS_PLUGINS` and give it a key and its thresholds:

   ```
   PLATYPUS_PLUGINS=@platypus/web-fetch,@platypus/decision-gate
   PLATYPUS_PLUGIN_CONFIG_DECISION_GATE={"config":{"provider":"gateway","denyThreshold":0.9,"askThreshold":0.6,"resultDenyThreshold":0.8},"credentials":{"apiKey":"your-gateway-api-key"}}
   ```

   Every provider except `gateway` also needs a `model`. Keep any plugins you
   already list. If the key or `denyThreshold` is missing, the backend refuses
   to start and names this plugin in the error.

3. Restart the backend.

Every tool call's arguments go to the provider you chose, and, with
`resultDenyThreshold` set, so does every tool's result.

The gate fails closed: if the decision model is down or slow, tool calls stop
(or ask for approval in a Chat) and results are withheld until it recovers.

See [Configuration → Tool gates](https://docs.platypus.chat/self-hosting/configuration#tool-gates)
for the full reference, including what each threshold means.
