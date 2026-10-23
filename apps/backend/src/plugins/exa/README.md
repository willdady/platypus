# @platypus/exa

A Web-search backend that serves the Chat **Search** toggle through
[Exa](https://exa.ai)'s hosted API. It supplies both search and page reading.

The plugin ships inside the backend, so there is nothing to install. It is off
until you enable it.

## Enable it

1. Get an API key from your [Exa dashboard](https://dashboard.exa.ai).
2. In the backend's `.env`, add `@platypus/exa` to `PLATYPUS_PLUGINS` and give
   it the key:

   ```
   PLATYPUS_PLUGINS=@platypus/web-fetch,@platypus/exa
   PLATYPUS_PLUGIN_CONFIG_EXA={"credentials":{"apiKey":"your-exa-api-key"}}
   ```

   Keep any plugins you already list. If the key is missing, the backend refuses
   to start and names this plugin in the error.

3. Restart the backend.
4. Open a Provider's **Advanced settings** and set **Web search** to **Exa**.
   Chats on that Provider now offer the **Search** toggle.

Search queries, and the URLs the model asks to read, go to Exa and are billed
to your Exa account. Exa fetches pages from its own servers, not from your
deployment.

See [Configuration → Web search](https://docs.platypus.chat/self-hosting/configuration#web-search)
for the full reference.
