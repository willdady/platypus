[x] Rename `generate-title` endpoint to `generate-metadata`
[x] Persist provider id to chat record and attempt to restore it when reloading the chat
[x] Tools need to be defined in "sets" not individually
[x] Workspace create page is incorrectly full-width
[x] Create Docker Compose config
[x] Navigating to `/default/workspace` should redirect to `/default`
[x] Prefill the base url field to `https://openrouter.ai/api/v1` when the user selects the OpenRouter provider (but only if the field is empty)
[x] It MUST be possible to edit a previously submitted user message
[x] Bug: navigating to a non-existant workspace should yield a 404 error
[x] The chat prompt should auto-focus when navigating to the chat page
[x] The chat prompt should be vertically centered until the first message is submitted
[x] On the MCP edit/create page add the ability to test the MCP connection
[x] Bug: message sending fails silently when a provider is missconfigured
[x] Add support for Bedrock provider
[x] Change model picker from Select to a dialog with Fuzzy search (Fuse.js?)
[x] Add Google Provider
[x] Add global command pallete
[x] The "agent info" dialog must show the provider in addition to the model id
[x] Need ability to rename a workspace. Repurpose the existing workspace create form.
[x] Bug: Back button should go back in route history.
[x] The root page `/` should render Organizations with Workspaces under each.
[x] Use an accordion component on the home page to make it less "busy"
[x] Add an edit agent button to the agent information dialog.
[x] The root workspace page needs to be designed
[x] Pick a better name than Agent Kit as it's already used by Open AI
[x] Add ability to invite users to workspaces
[x] Add ability to administer members within an Org
[x] Add AuthZ (better-auth)
[x] Add proper logging (not just `console.log`) in backend service
[x] Add testing framework (Vitest?, Jest?)
[x] It should be possible to define org-scoped providers
[x] Rename all ocurrences of "organisation" with "organization"
[x] Show an Empty state on the Org picker when an Org has no Workspaces
[x] Bug: The `generate-metadata` endpoint, sometimes returns a title with a length greater-than 30 characters.
[x] Consider adding a character limit to the Agent description field
[x] Add setting system prompt at the Workspace level. Will also need to design a dynamic system prompt template, possibly using ejs?
[x] Add "Skills" similar to Claude Code
[x] Remove the "New Chat" and "Configure Providers" buttons from the Workspace home page
[x] Reduce the vertical spacing between fields on the Skill form
[x] Make sure "prompt" fields like the skill "body" and agent "system prompt" fields use a mono-spaced font
[x] Create a reusable component for Textarea fields which show character counts
[x] On the agents list, show which tools and skills are enabled. Use badges with appropriate icons.
[x] Add the ability to make certain Textareas expandable to full-screen. This is needed for more ergonomic Markdown editing.
[x] Bug: The `generate-metadata` endpoint, sometimes returns tags which are not kebab-case. Add a post-processing step to enforce this.
[x] Bug: It's incorrectly showing as an error when updating a Workspace with an empty context. This field should be optional.
[x] Add "New Agent" and "New Skill" options the command menu
[x] Users need to be able to edit their name via the profile settings screen
[x] Create a custom UI for "load_skill" tool
[x] Change the "Rename" option to "Edit" under the chat drop-down menu and make it possible to edit and delete tags
[x] Add a built-in tool which allows the LLM to ask the user a qualifying question with suggested responses.
[x] Always include the current user's name and id in the system prompt
[x] Bug: selecting an organization on the organization picker screen should update the browser URL to support deep-linking
[x] Bug: Only display message actions on the last message once streaming stops
[x] The currently selected agent/model should persist when starting a new chat via the sidebar "New Chat" button
[x] Should be able to start a chat with an agent from the command pallete
[x] Consider always injecting the current date and time (ISO 8601) into the system prompt. Timezone should be configurable via env var.
[x] Increase skill body max length to 5000 characters
[x] Need to be able to clone an existing agent
[x] Bug: when clicking the "paste to prompt" button and then the chat submit button the prompt input simply disappears and doesn't send the message as expected
[x] Bug: Skill toggle on the Agent edit page is incorrectly showing the skill body, not the description
[x] Make it possible to configure prompt placeholder text (which is shown when the chat prompt is empty) per agent e.g. "Ask me about financial advice!"
[x] Add a Skills count panel to the workspace homepage
[x] Super admins need to be able to reset a user's password
[x] Bug: links in chat messages don't show pointer on hover
[x] User should be able to provide context about themselves. This context should be injected into the system prompt.
    A user may provider general context about themselves ("I'm a 40 year old white male") but also context about themselves relevant to a specific workspace!
[x] Bug: When clicking Save on the global context field the toast popup says "created" the first time the "updated" on subsequent saves. It should be the same text in both cases.
[x] Add home button to the right of the back button on the user settings screens
[x] Update tagging prompt to remove low-quality or ambiguous words
[ ] It should be possible to disable sign-ups (via an environment variable?)
[ ] Add built-in memory tool. Memory should be per-agent. Consider a workspace scoped memory tool also?
[ ] Consider configuring the "task" model at the workspace level
[ ] Bug: consider sanitising file names when using the Bedrock provider - https://github.com/vercel/ai/issues/11518#issuecomment-3731765347
