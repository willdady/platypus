# Changelog

## [1.15.0](https://github.com/willdady/platypus/compare/v1.14.1...v1.15.0) (2026-01-07)


### Features

* **frontend:** new chats now default to the previously used agent or model ([cb78842](https://github.com/willdady/platypus/commit/cb78842a0964c4a0dd87cee3e520fce84e586967))

## [1.14.1](https://github.com/willdady/platypus/compare/v1.14.0...v1.14.1) (2026-01-06)


### Bug Fixes

* **frontend:** message actions only appear on last message once streaming stops ([1640921](https://github.com/willdady/platypus/commit/164092120aa364602b9e201a3669d8831b8129fa))

## [1.14.0](https://github.com/willdady/platypus/compare/v1.13.1...v1.14.0) (2026-01-04)


### Features

* **backend:** the user's name and id and now included in the system prompt ([a021f82](https://github.com/willdady/platypus/commit/a021f82527644f0f40186fbaeb4974313b9efbb8))
* **frontend:** add description to workspace context field ([7bfab80](https://github.com/willdady/platypus/commit/7bfab80fdad48a758b637241811ea22fba5087e3))
* **frontend:** implement route-based organization selection and fix layout flicker ([3015c71](https://github.com/willdady/platypus/commit/3015c711d0029bc7215cb96dd9df1131fe300fd0))
* **frontend:** reduced backdrop blur on ExpandableTextarea ([aadde9e](https://github.com/willdady/platypus/commit/aadde9ee597e0948e10c3d829872c2afb7e1b869))


### Bug Fixes

* **frontend:** organizations are sorted alphabetically ([b8421cd](https://github.com/willdady/platypus/commit/b8421cd98dc3152e0933029740ed732c341b38bf))
* **frontend:** workspaces are sorted alphabetically ([93e4dc5](https://github.com/willdady/platypus/commit/93e4dc5de7623fe76ddbf4f675b20c450994a7ca))

## [1.13.1](https://github.com/willdady/platypus/compare/v1.13.0...v1.13.1) (2026-01-03)


### Bug Fixes

* **frontend:** frontend docker image failing to build ([c87315d](https://github.com/willdady/platypus/commit/c87315d4faa1226ca74cbb589493b25175398c0f))

## [1.13.0](https://github.com/willdady/platypus/compare/v1.12.0...v1.13.0) (2026-01-03)


### Features

* **ai-sdk:** upgrading to latest version ([6ca4598](https://github.com/willdady/platypus/commit/6ca459844ce8c5722f84510ad0960b3bebced6b4))
* **backend:** add askFollowupQuestion elicitation tool ([858c12f](https://github.com/willdady/platypus/commit/858c12f5c6f9626425e80587cf2054a652be6f95))
* **frontend:** added UI for the loadSkill tool ([a6d5688](https://github.com/willdady/platypus/commit/a6d5688582ec6567d6748bef3c871c37bad2cfe7))
* **frontend:** implement AskFollowupQuestionTool component and integration ([3a76fe0](https://github.com/willdady/platypus/commit/3a76fe04badcf684d76193bcc3c92a21e940c205))
* **frontend:** support rendering images in chat messages and unify message actions ([beb3dbe](https://github.com/willdady/platypus/commit/beb3dbe9174eb0ea6fd497c88ddd78b3931eeb1c))
* **provider:** added Anthropic ([8fced03](https://github.com/willdady/platypus/commit/8fced0373c480a648a8426b4571f5e990490ad4b))
* **schemas:** minor tweaks to skill field length requirements ([e2a04b9](https://github.com/willdady/platypus/commit/e2a04b9a9c7227a51293deae3cc48fdb3e94b6a8))

## [1.12.0](https://github.com/willdady/platypus/compare/v1.11.0...v1.12.0) (2026-01-01)


### Features

* **frontend:** add support for editing chat tags with TagInput component ([6dc7862](https://github.com/willdady/platypus/commit/6dc78622979d25a8778b12997a33ac4779b6ba95))
* **frontend:** users can now change their name via settings screen ([aa6ee9d](https://github.com/willdady/platypus/commit/aa6ee9d3b7b54f10fffe21a22e4554c0f0b2e330))

## [1.11.0](https://github.com/willdady/platypus/compare/v1.10.0...v1.11.0) (2025-12-31)


### Features

* **frontend:** add ExpandableTextarea component with full-screen mode ([820f6b3](https://github.com/willdady/platypus/commit/820f6b3b256cde03ab6cd76812b31b5620099017))
* **frontend:** style tweaks on Org picker screen ([60bb48b](https://github.com/willdady/platypus/commit/60bb48b41bc713fd867276978f9982bb372d880b))
* **frontend:** updated CSS theme ([316965f](https://github.com/willdady/platypus/commit/316965f818e0cfbac78bf7df0964fc752adf90eb))


### Bug Fixes

* **frontend:** mode toggle dropdown now uses cursor pointer ([c62c34c](https://github.com/willdady/platypus/commit/c62c34c7ba7a5eb19675f4f51f59526df2193b2a))

## [1.10.0](https://github.com/willdady/platypus/compare/v1.9.0...v1.10.0) (2025-12-31)


### Features

* **frontend:** add new agent and skill options to command menu ([02a030f](https://github.com/willdady/platypus/commit/02a030f25bdabac3aae200de831be1bca52af8ba))
* **frontend:** create reusable TextareaWithCounter component and use in forms ([dc98771](https://github.com/willdady/platypus/commit/dc98771f427108acb8e91b3e7b3f722e25ca1c57))
* **frontend:** fix font variables and apply mono-spaced font to workspace context ([965a54e](https://github.com/willdady/platypus/commit/965a54e950524349bff6eefd47e629364a4662c0))
* **frontend:** remove quick action buttons from workspace home ([5f8b784](https://github.com/willdady/platypus/commit/5f8b784f7b7774fa7ef90ea69b3a48144be4c2e2))


### Bug Fixes

* **backend:** enforce kebab-case and deduplicate tags in generate-metadata ([cbe87d7](https://github.com/willdady/platypus/commit/cbe87d798f6364cddba2060eab3e7cacd1f35999))
* **schemas:** allow null for optional workspace context ([2ea8903](https://github.com/willdady/platypus/commit/2ea8903b5a22377b7a09e962388a5a0227b2d2ba))

## [1.9.0](https://github.com/willdady/platypus/compare/v1.8.0...v1.9.0) (2025-12-30)


### Features

* **skills:** can now create skills and assign them to agents! ([dc8c7c3](https://github.com/willdady/platypus/commit/dc8c7c307ef0b2de6a5c1905d80a153cc116d166))


### Bug Fixes

* **ui:** regression where chat model select was unselected when starting a new chat ([6f1bfd1](https://github.com/willdady/platypus/commit/6f1bfd1858626e6ca89ed2af21fc5f4a55fbd219))

## [1.8.0](https://github.com/willdady/platypus/compare/v1.7.0...v1.8.0) (2025-12-30)


### Features

* **workspace:** added "context" field to workspace ([8d2a113](https://github.com/willdady/platypus/commit/8d2a113dbb7746ffce86dd5003e5d708fa0e0183))

## [1.7.0](https://github.com/willdady/platypus/compare/v1.6.2...v1.7.0) (2025-12-29)


### Features

* **agents:** description field now limited to a maximum of 96 characters ([d82c53b](https://github.com/willdady/platypus/commit/d82c53b97e93c61904fafc9c7824dbd5b5407c7f))
* **ui:** added dedicated empty state when an Org has no Workspaces ([8ee9262](https://github.com/willdady/platypus/commit/8ee926298ebc051b51fcdcf4e654db1157a29b3c))


### Bug Fixes

* **backend:** truncate generated chat titles before writing to database ([9211908](https://github.com/willdady/platypus/commit/9211908f78a4ec71c21ccfeaa6f990dee55abc5c))
* **ui:** organization menu items now correctly show cursor pointer on hover ([72a1377](https://github.com/willdady/platypus/commit/72a13770766abb56666aae742b6270260e02b6e4))

## [1.6.2](https://github.com/willdady/platypus/compare/v1.6.1...v1.6.2) (2025-12-28)


### Bug Fixes

* **agents:** starting a chat from an agent's "New Chat" button selects the agent on the chat screen model picker ([c4487c4](https://github.com/willdady/platypus/commit/c4487c4f1014e89ba9617992c298f8f2d31993ba))

## [1.6.1](https://github.com/willdady/platypus/compare/v1.6.0...v1.6.1) (2025-12-28)


### Bug Fixes

* **ui:** incorrect navigation to missing page after submitting agent creation form ([53a892b](https://github.com/willdady/platypus/commit/53a892bf10a822248e1ac737cdc26cba6ad0b985))
* **ui:** sign-in/up forms now show cursor pointer on submit buttons ([edcf559](https://github.com/willdady/platypus/commit/edcf5596a0fa5df6e78132fb7ea8a2367925d0cc))

## [1.6.0](https://github.com/willdady/platypus/compare/v1.5.1...v1.6.0) (2025-12-28)


### Features

* **providers:** add org-scoped providers in addtion to existing workspace-scoped providers ([215b010](https://github.com/willdady/platypus/commit/215b0101d8f9960cffd50fb66bd513a4edafdf61))
* **ui:** add "Profile Settings" option to command menu ([4ad7f96](https://github.com/willdady/platypus/commit/4ad7f96d2951ff1b80d2e39989cb34ce94a1e088))
* **ui:** added Home button to Org settings screens ([8e2c2ad](https://github.com/willdady/platypus/commit/8e2c2adb6d7159cc84cc259a999c1439560068ec))


### Bug Fixes

* **spelling:** renamed all occurances of "organisation" to US spelling "organization" ([a1022dc](https://github.com/willdady/platypus/commit/a1022dc14c473402e64b5b90e38799b5fd1a2d12))

## [1.5.1](https://github.com/willdady/platypus/compare/v1.5.0...v1.5.1) (2025-12-27)


### Bug Fixes

* **ui:** base URL on provider form no longer pre-fills when selecting OpenRouter as provider type ([f4453b9](https://github.com/willdady/platypus/commit/f4453b96e24cf75c5c55e2a2cf754b0f914f109a))
* **ui:** chat screen not sending credentials to backend ([fba0340](https://github.com/willdady/platypus/commit/fba0340c54adb34fae5d5ec1208c72265cc1100f))

## [1.5.0](https://github.com/willdady/platypus/compare/v1.4.0...v1.5.0) (2025-12-27)


### Features

* **testing:** add Vitest and tests for backend routes and middleware ([d6fa43f](https://github.com/willdady/platypus/commit/d6fa43f5ec2af96d08b0385f5f8156f284fd6265))
* **ui:** added not-found page ([be04735](https://github.com/willdady/platypus/commit/be04735a02e828d870c5b06aac4de407906ce4eb))
* updated next.js to 16.1.1 ([53cc9ac](https://github.com/willdady/platypus/commit/53cc9acba2575988c9a69e243758c4480ea8be99))


### Bug Fixes

* **ui:** navigating to an Org when not signed-in now correctly redirects to sign-in page ([d8d59fb](https://github.com/willdady/platypus/commit/d8d59fb03a8f1932199ca27e1f0b7a4eeaf88ce9))

## [1.4.0](https://github.com/willdady/platypus/compare/v1.3.0...v1.4.0) (2025-12-26)


### Features

* **backend:** adding logging library ([0b6ac70](https://github.com/willdady/platypus/commit/0b6ac7098eed6f1edf0ff066d836db13c39ee8c6))
* **ui:** improved empty states for the Providers and MCP settings screens ([ab61b9d](https://github.com/willdady/platypus/commit/ab61b9d5865cb339d1e826aab462bb90930192ea))


### Bug Fixes

* **backend:** setting NODE_ENV=production in Dockerfile ([e3bfd77](https://github.com/willdady/platypus/commit/e3bfd779aef22e04aaffc9e5165dc57cf7395d47))

## [1.3.0](https://github.com/willdady/platypus/compare/v1.2.0...v1.3.0) (2025-12-26)


### Features

* **auth:** add better-auth ([527269d](https://github.com/willdady/platypus/commit/527269d8c3bd0c8dfefd351c8ec7ab60bcfc3a8b))
* **auth:** default admin username and password now configurable via env vars ([72c79aa](https://github.com/willdady/platypus/commit/72c79aaf04483a16eff6d77503986ac16957529b))
* **authz:** add middlewares to backend routes ([a62eca2](https://github.com/willdady/platypus/commit/a62eca254c781b2ba416fdd47d8788758353d616))
* **routing:** routes are now hierarchical ([8c9824b](https://github.com/willdady/platypus/commit/8c9824bcfca2962661c7bbf85eabcf38be076b90))
* super admins now denoted via field on user table instead of env var ([7958fb2](https://github.com/willdady/platypus/commit/7958fb2aa149b532073db1b8de0ecd5ca5c1b3a7))
* **ui:** add user settings screen ([e00ecb8](https://github.com/willdady/platypus/commit/e00ecb821d6604545fc35cda7838e6e6e798ff6d))
* **ui:** added bottom margin to settings pages ([883a22f](https://github.com/willdady/platypus/commit/883a22f81978b6206e308a7269b58450ee3e363f))
* **ui:** improved the Org switcher UI ([bc9f4a4](https://github.com/willdady/platypus/commit/bc9f4a4ba4a79936f6b157f88f9d58965476dfd3))
* **ui:** ProtectedRoute component now renders permission errors. ([289af70](https://github.com/willdady/platypus/commit/289af70b9accad674a20d5fed6796d3af52780f5))
* **ui:** updated Org settings page ([37eff32](https://github.com/willdady/platypus/commit/37eff32baceb6e2e40dc988f9a254af59c9a3802))
* **user-management:** add member management ([ce3cda2](https://github.com/willdady/platypus/commit/ce3cda2c26128ec09adb4de8e4573019d87b2ff2))
* **user-management:** org admins can now invite users to workspaces ([c9d0b4b](https://github.com/willdady/platypus/commit/c9d0b4b54234314bf35b1c9b1cd1847cb5409211))

## [1.2.0](https://github.com/willdady/platypus/compare/v1.1.0...v1.2.0) (2025-12-22)

### Features

- **backend:** add indexes to tables with foreign keys ([db6f340](https://github.com/willdady/platypus/commit/db6f3403db0502b039bfe5a2c92a1b76f156af7f))
- **ui:** add `About` option to command menu ([086a3a9](https://github.com/willdady/platypus/commit/086a3a90bf49ed29dceab6c018886c2809f69a4e))

## [1.1.0](https://github.com/willdady/platypus/compare/v1.0.1...v1.1.0) (2025-12-22)

### Features

- docker images now tagged with root `package.json` version ([ea8fa9d](https://github.com/willdady/platypus/commit/ea8fa9d28e2e87f984b8555bbab9dca3acacac95))
- **frontend:** improved URL joining ([324bc7a](https://github.com/willdady/platypus/commit/324bc7a6a9170c305f58a6c48741f9191e5d567c))
- **ui:** add About page showing current version and link to Github project ([55b9114](https://github.com/willdady/platypus/commit/55b91144eef9d604a0659e0808d6ed71c7797b6f))

### Bug Fixes

- missnamed example ENV file in frontend app ([0e6ee10](https://github.com/willdady/platypus/commit/0e6ee10bce41610f969380e81ac8038b6bb57a90))
- **ui:** forcing RootLayout to be dynamic so environment variables don't get baked in. ([44867f4](https://github.com/willdady/platypus/commit/44867f4fee12b168c1776584ac75188f5b2bd682))

## 1.0.1 (2025-12-21)

### Features

- `generate-title` endpoint now also generates up-to 5 tags ([7edc4a7](https://github.com/willdady/platypus/commit/7edc4a7e9478d18eda49dcd8f68dc29588c5ee8f))
- `title` field removed from `chatUpdateSchema` ([d37fc17](https://github.com/willdady/platypus/commit/d37fc1711dd316c083c346a7c563fae5d0b88e2b))
- added "tags" field to chat table ([e4e0dee](https://github.com/willdady/platypus/commit/e4e0dee58c3e467c6bb6a37b557259a5fcaefa61))
- added "Test Connection" button to MCP form ([432ab2f](https://github.com/willdady/platypus/commit/432ab2f6dce2fe7e85a2bd57417cb9fe967b6db9))
- added `description` field to agent table and added agents list screen ([0b1bc6f](https://github.com/willdady/platypus/commit/0b1bc6f296ea58fc112ef1dc89749591631dc817))
- added `headers` field to provider form ([f8cbea3](https://github.com/willdady/platypus/commit/f8cbea3b26cc13595f27f2cb0fd4fbbf79eb2194))
- added `modelId` field to `Agent` table ([84a7451](https://github.com/willdady/platypus/commit/84a74514c9764cedb41dfc7d761416990333af5e))
- added `modelIds` field to provider schema ([7e56999](https://github.com/willdady/platypus/commit/7e56999dce5e5e5dc1e9a75a37e49d7bd2a7ab92))
- added `taskModelId` field to provider table ([d68ee33](https://github.com/willdady/platypus/commit/d68ee33f4c5fee40d995eb5cd68a47dd33b00899))
- added 2x additional fields to agent table, schemas and ui ([fd59496](https://github.com/willdady/platypus/commit/fd594963b4aedd96e91648f1d1aa442ca5af2471))
- added 2x additional OpenAI-specific fields to the Provider table ([99adebb](https://github.com/willdady/platypus/commit/99adebb28725b5cbdf2830cd4d005448c0545bf7))
- added agent create button to AgentsList ([076790e](https://github.com/willdady/platypus/commit/076790eadfa358bb1846cf34e11ab6b8878574b7))
- added agent edit page ([f48a55e](https://github.com/willdady/platypus/commit/f48a55e23139571614371b2928a0c59f73f0e014))
- added Bedrock provider ([c05f379](https://github.com/willdady/platypus/commit/c05f379e3cd3078e1173eda32c2b47b7fc34cc11))
- added delete chat functionality ([0656896](https://github.com/willdady/platypus/commit/065689672b7e081734d2edc209c3137fa8a18628))
- added delete confirmation dialogs to provider and mcp forms ([714d8af](https://github.com/willdady/platypus/commit/714d8af43ed7b79f98304eba0f5bdd290983d2c2))
- added Docker Compose config and initial Drizzle migration files ([c31eb67](https://github.com/willdady/platypus/commit/c31eb6785a32fc1d9cf86aea9d1db4069603749a))
- added model picker to Chat component ([07eddfc](https://github.com/willdady/platypus/commit/07eddfce1e626b4ca1ab948c75a60b165223a6be))
- added new workspace list on org page ([f0735d8](https://github.com/willdady/platypus/commit/f0735d824571febdc0e95972b1c807c9df8ab901))
- added providers endpoints ([ac67d87](https://github.com/willdady/platypus/commit/ac67d87a30f2cc15f22b6b9c76b9b1cf7db7af1e))
- added Reasoning to Chat component ([f10c7f0](https://github.com/willdady/platypus/commit/f10c7f0e87cdf93f1cc87e4b50efe1b0aa5816e5))
- added tools jsonb field to Agent table ([1c66e97](https://github.com/willdady/platypus/commit/1c66e9726197356538fea26e63f8a2bfec6c2a8b))
- added workspace select to sidebar ([0dd5c7b](https://github.com/willdady/platypus/commit/0dd5c7b18d2eb07ea0d46abc0dec3480dc3ebe04))
- adding 4 fields to Agent table ([411c9c0](https://github.com/willdady/platypus/commit/411c9c05954606319b764661c7c7502eba5b0f77))
- adding AGENTS.md derived from CLAUDE.md ([16495ca](https://github.com/willdady/platypus/commit/16495ca8c737df12fb47e2203cf4e09edf98ed38))
- additional fields on chat table ([8cf8bc1](https://github.com/willdady/platypus/commit/8cf8bc1a01815ab02e0cc16a0d6e80af4fdd25fb))
- **agent-form:** added missing seed field and updated layout ([9b000db](https://github.com/willdady/platypus/commit/9b000db68fb386bda59f27297fc5233ce92f6d2e))
- all existing forms now auto-focus first text input ([11f003b](https://github.com/willdady/platypus/commit/11f003bb48b17753cc5f4a78f80a07a9dde54f24))
- backend now creates tables at startup ([6afe804](https://github.com/willdady/platypus/commit/6afe80450ae0dc24bd6899e7f82f42e0606e554b))
- backend routes now take query parameters ([b8d1240](https://github.com/willdady/platypus/commit/b8d12400096ff59a9a0fec951a50ee1c37c78aa8))
- **backend:** added `/chat/tags` endpoint ([c3dfb84](https://github.com/willdady/platypus/commit/c3dfb8496a00fbce13d0021b50a095e76f798e8b))
- **backend:** added chat list route ([b026440](https://github.com/willdady/platypus/commit/b026440dbbb120ab6b9dd6a7b674dc758fba759c))
- **backend:** added chat PUT endpoint ([f59c465](https://github.com/willdady/platypus/commit/f59c4656e933f1e6e9a0edf69fa6d9114993f96e))
- **backend:** added Dockerfile for backend app ([e3ecceb](https://github.com/willdady/platypus/commit/e3ecceb4ceec89ac9f8a3460496cef7385c31cd7))
- **backend:** added max length to generated chat title ([89edc0c](https://github.com/willdady/platypus/commit/89edc0c85fd9264a054dd599229b19c01933e8fa))
- **backend:** improved "default" Org and Workspace creation ([7227549](https://github.com/willdady/platypus/commit/7227549e2a5bbbe03ca52e86b1679e44830402fb))
- **backend:** removed validation from `generate-metadata` LLM call ([7940735](https://github.com/willdady/platypus/commit/79407351e384d1021aa6caa95495f5639b48f005))
- base url field now pre-fills when switching to OpenRouter provider ([e1767df](https://github.com/willdady/platypus/commit/e1767dfcfa03d8464d106fb33d821b7bcdf53231))
- can now "star" chats ([8aebb7e](https://github.com/willdady/platypus/commit/8aebb7e4065e24c64886e379951d5d2badcfae0a))
- can now categorise tools ([14b819f](https://github.com/willdady/platypus/commit/14b819fbf0cc6d098d84f595c273965a391f34e8))
- can now configure chat settings from chat screen ([ac07398](https://github.com/willdady/platypus/commit/ac073985acfb0303a83a94d5dbae1f147b30fabb))
- can now edit existing user messages ([7b00158](https://github.com/willdady/platypus/commit/7b00158dd31df1ecc4e5d2b5724ae0736c315bac))
- can now renamed Workspace from settings page ([a2dbde1](https://github.com/willdady/platypus/commit/a2dbde1b1869691c73c1c5cc9127771e47804b4e))
- can now select agent from chat screen ([db2efca](https://github.com/willdady/platypus/commit/db2efca24324c282d57c13a82297fa136505ef6c))
- chat component now renders sources ([aab19a9](https://github.com/willdady/platypus/commit/aab19a9c7f89943624063c10c93b63ae3d70ccb8))
- chat component now shows alert if no providers are configured ([49644ef](https://github.com/willdady/platypus/commit/49644efb37ccd181dda7d955bb7e939ecf56a4aa))
- chat list now revalidates after first chat response ([368ae7d](https://github.com/willdady/platypus/commit/368ae7d4378331340ce0cd9917bd66287144061e))
- chat now uses models from providers ([b10f688](https://github.com/willdady/platypus/commit/b10f6881826a646919d2beb122a8414ab5576f52))
- chat UI now supports attachments ([64de7e0](https://github.com/willdady/platypus/commit/64de7e0b8d2b1d52654f886c0fbd24ff3d57a5a2))
- **chat-ui:** added regenerate action to last assistant message ([e5823d8](https://github.com/willdady/platypus/commit/e5823d80760a7e6df5b466ac9733f160ec3a5b45))
- chats are now filtered and sorted by `createdAt` ([1971d4f](https://github.com/willdady/platypus/commit/1971d4fcf6e86d693670ee1d27e373c27f51c41a))
- chats now group in sidebar ([09c8bf4](https://github.com/willdady/platypus/commit/09c8bf404d79201093e928b31becd6df157b0e7e))
- chats now persist to the database ([a1729a6](https://github.com/willdady/platypus/commit/a1729a6e5cb0fa5ec4b7939358f6f8e42028451b))
- deleted 2x unneeded provider fields ([81241cc](https://github.com/willdady/platypus/commit/81241ccb9eba59850f23d77a41e3976220d0c53d))
- deleted the `agent_tool` m2m table as it's not needed ([fcbfc53](https://github.com/willdady/platypus/commit/fcbfc53483e1075f139151b53f0c868641ed22c6))
- fixed position settings menu on workspace settings layout ([e29af5b](https://github.com/willdady/platypus/commit/e29af5ba6fe5267a49bcd89888001814ef8af4d7))
- frontend now reads backend URL from env ([6a7512b](https://github.com/willdady/platypus/commit/6a7512b882dbad91fc47a3fc7dce2a3b9c9b5ecf))
- **frontend:** added docker build scripts ([51e81bd](https://github.com/willdady/platypus/commit/51e81bdbd0f189c5e39b689cd76cf82fd71a6715))
- **frontend:** adding pointer state to buttons ([dc81f5e](https://github.com/willdady/platypus/commit/dc81f5e21f8ba10d636364fa806ecbe45476ab8a))
- **frontend:** backend url now set via context on root layout ([aebe4cc](https://github.com/willdady/platypus/commit/aebe4ccb37f5786ef3a359682801b9f859c10c42))
- **frontend:** chat screen now has responsive width ([f97feb1](https://github.com/willdady/platypus/commit/f97feb1723498e462af99c10535d3556c19a62c7))
- **frontend:** improved style on workspace picker page ([730d69b](https://github.com/willdady/platypus/commit/730d69b2c034be6493b088cf0d7acc2866cd08cd))
- **frontend:** moved chat to it's own component ([985d124](https://github.com/willdady/platypus/commit/985d124b97eea77cc110eb529e5d45e0ce8b5c20))
- **frontend:** stubbed initial pages ([49e1090](https://github.com/willdady/platypus/commit/49e1090a4c664ba2918b1d7810bb494b4f90a89e))
- **frontend:** stubbed MCP page ([b2a319c](https://github.com/willdady/platypus/commit/b2a319c6923d95c44bd781681947f920510d5cc4))
- implemented mcp routes and UI ([46bf4d8](https://github.com/willdady/platypus/commit/46bf4d8a01632ee9710d45373ba093d0e433e91e))
- implemented title generation endpoint ([3128491](https://github.com/willdady/platypus/commit/3128491d245e921cc5a995b5ce220270326f7603))
- implementing tools list endpoint ([1dfde35](https://github.com/willdady/platypus/commit/1dfde350984e74f5e135410cce77ba8edcec9758))
- improved chat rename error handling ([3ccbb6d](https://github.com/willdady/platypus/commit/3ccbb6ded6216c468e6f55430dfd6ba04169af78))
- improved prompt input styling ([3bfc913](https://github.com/willdady/platypus/commit/3bfc9138b7ed481885cdc3501cec90f2e0a66a2f))
- list item margins ([fd4e375](https://github.com/willdady/platypus/commit/fd4e3757240a41e29515b922b879510b03944604))
- MCP servers can now be enabled on agents ([a243122](https://github.com/willdady/platypus/commit/a243122001856e216518a2f4ad44def445adce07))
- more consistent Alert styling ([1a6b71c](https://github.com/willdady/platypus/commit/1a6b71c9e735057b378ce7ddd16fe5bfe7fe2463))
- moved fetches to server components ([c8161a5](https://github.com/willdady/platypus/commit/c8161a587440cd9f9aa829542040519771e25f88))
- moved provider headers field inside collapsible component ([1bb8601](https://github.com/willdady/platypus/commit/1bb8601c5b6281a5ad8648d5ffea307c6717341e))
- navigating to `/{orgId}/workspace` now redirects to `/{orgId}` ([2dd6d78](https://github.com/willdady/platypus/commit/2dd6d7802d21e40648b37719e21787cb91604308))
- pinning Postgres to v17 due to issue with Drizzle on Postgres v18 ([3ff9603](https://github.com/willdady/platypus/commit/3ff960325501efd01369592ad142ed6f67e37957))
- provider and mcp list components now show alert when none are configured ([3237c89](https://github.com/willdady/platypus/commit/3237c898002b788bb7627a633abb4746bfd5a031))
- provider and model ids now persist to chat table ([bd03bf5](https://github.com/willdady/platypus/commit/bd03bf5593414aaf4d886647157bb2cc0daff235))
- **provider:** added `extraBody` field to provider table for use with OpenRouter ([c61c326](https://github.com/willdady/platypus/commit/c61c326dc0a31f07839463de0d0349bc52198af4))
- **provider:** added Google provider ([6546cc5](https://github.com/willdady/platypus/commit/6546cc5d8438e8e9193d0664bdda47ccd5b36f1e))
- quick chat endpoint now uses the model from the request ([83fc187](https://github.com/willdady/platypus/commit/83fc187797a10fbe923c9e3077214ca2dfa5210f))
- reduced the max width of the chat UI ([2e99392](https://github.com/willdady/platypus/commit/2e993924fc880b60cd0a756f18e6dc9d2fa837b5))
- removed `shadcn-io` ai components ([81d9a95](https://github.com/willdady/platypus/commit/81d9a95d454b73109d21501dd641632edc16af15))
- removed models routes and updated AgentForm to use providers ([b180a03](https://github.com/willdady/platypus/commit/b180a03712f3dd85de7fd93651cca255b662587c))
- removing Tool table ([ef4093f](https://github.com/willdady/platypus/commit/ef4093ff34796e664d568e6ed5d1df96244eaf67))
- render errors returned from `useChat` ([d259221](https://github.com/willdady/platypus/commit/d259221232504926a4ef8024725d2d40929ed908))
- **search:** added search toggle ([cd452fe](https://github.com/willdady/platypus/commit/cd452fe57b97ecc7198bfafe32c349cc40964fcb))
- sort model ids before writing to provider table ([7a149bf](https://github.com/willdady/platypus/commit/7a149bf099a82908510858a10a63a25688a61675))
- starting a chat from the agent list now works as expected ([72fc86c](https://github.com/willdady/platypus/commit/72fc86c2f75c01843222cb38553b5dcd900b5c78))
- stubbed Agent form ([3b86cee](https://github.com/willdady/platypus/commit/3b86cee37c26524258a548a65600c7e4fe897108))
- stubbed providers form ([ab8b4d9](https://github.com/willdady/platypus/commit/ab8b4d98650260a8823afab7a460f0d42c00b4c5))
- style and formatting updates ([b674d2d](https://github.com/willdady/platypus/commit/b674d2d4079ae61f4c4e53beb0863a734e6002f7))
- style updates ([116b232](https://github.com/willdady/platypus/commit/116b232a88b2b89eb9a0f7f4bc6667b586120bf6))
- tool calls now render in chat ([c92fcd3](https://github.com/willdady/platypus/commit/c92fcd32f0dd7cf3268bd8a7181fc9bc5a9d0110))
- tools are now defined as sets, not individual tools ([973fdaf](https://github.com/willdady/platypus/commit/973fdaf2e26c19e9a51a53ede426ba294ba94a57))
- **ui:** "advanced" fields on chat settings dialog are now collapsed by default ([343c2e4](https://github.com/willdady/platypus/commit/343c2e45540c83a059c43d5db2586a40b8dff53e))
- **ui:** accordion on app home page now open by default when there is only 1 Org ([6255283](https://github.com/willdady/platypus/commit/6255283ea367f70211132b749950fa707ea79a82))
- **ui:** add accordion layout to app home page ([45684d0](https://github.com/willdady/platypus/commit/45684d0978e817788c338474ed46de254fb41993))
- **ui:** added agent info dialog to Chat component ([2fa607f](https://github.com/willdady/platypus/commit/2fa607fdef8e7d279c044931d5edb1d6580b905c))
- **ui:** added confirmation dialog for deleting workspace ([e4d10cb](https://github.com/willdady/platypus/commit/e4d10cbc00344d26ad9efc7445bd062115e520c4))
- **ui:** added copy-to-clipboard buttons to workspace settings page ([aec9a1e](https://github.com/willdady/platypus/commit/aec9a1e9f10de91fffa76da99f7899c114dfe786))
- **ui:** added edit button to agent info dialog ([e8dd210](https://github.com/willdady/platypus/commit/e8dd210cb0b98afc495023027ca88fbe2d92884c))
- **ui:** added global command pallete ([9efb803](https://github.com/willdady/platypus/commit/9efb803e4a953c30d9899729f623e39a68629910))
- **ui:** added icons to app sidebar groups ([5287bd5](https://github.com/willdady/platypus/commit/5287bd507aa2861aa6d27567b22f68234b87ba4c))
- **ui:** added separator before footer in AppSidebar ([6546cc5](https://github.com/willdady/platypus/commit/6546cc5d8438e8e9193d0664bdda47ccd5b36f1e))
- **ui:** added TagCloud to workspace home page ([e72285c](https://github.com/willdady/platypus/commit/e72285cd32d1b0e69e2678fdf4b5108fd8262047))
- **ui:** added workspace home page; removed dedicated agents page ([e1be019](https://github.com/willdady/platypus/commit/e1be0195fa47bcf72532a8276d979b0da358986a))
- **ui:** AgentInfoDialog now shows provider ([9cc7e60](https://github.com/willdady/platypus/commit/9cc7e6022350e65b8ce9ecbd4f838b6722cb6a3f))
- **ui:** changed model picker component on chat page ([9e35596](https://github.com/willdady/platypus/commit/9e35596342eca8ae3328816933bbf6d39437a553))
- **ui:** chat input now vertically centred on empty chats ([0361d48](https://github.com/willdady/platypus/commit/0361d48cc12de3c057acce09f25b70c1f485e99a))
- **ui:** chat textarea now auto focuses ([aa7dd5a](https://github.com/willdady/platypus/commit/aa7dd5a46308192f5741f7e34f5396e97e689a16))
- **ui:** dedicated Back button which goes back in route history ([4336171](https://github.com/willdady/platypus/commit/4336171820d212fd9d7b77619fa3847cde8265bc))
- **ui:** implement organization management ([da941a9](https://github.com/willdady/platypus/commit/da941a93b400ef527dd350e39ea24b1388b4cc93))
- **ui:** major refactor of Chat component into sub components and hooks ([6dd983e](https://github.com/willdady/platypus/commit/6dd983e8bb87f55195eeb5a4323a0751e333fd3a))
- **ui:** message actions now use muted text colour ([f0beeaa](https://github.com/willdady/platypus/commit/f0beeaae4bc3cd2a9a1074c142f2537d0b43ba5b))
- **ui:** message text is now selected when clicking edit message button ([c08a93e](https://github.com/willdady/platypus/commit/c08a93e2ab38d5997c6048ac71ce003b8545cdd1))
- **ui:** now showing info toast when clicking copy-to-clipboard buttons ([a60e5bd](https://github.com/willdady/platypus/commit/a60e5bdd457851876c099a59c9d9efeaa4aabd0b))
- **ui:** prompt input now focuses when model selector is closed ([c72bc9a](https://github.com/willdady/platypus/commit/c72bc9a8664b289d4e756627f626625efc319b17))
- **ui:** updated app Home page ([54c3697](https://github.com/willdady/platypus/commit/54c369734218ea6af509310efeebafcaffb141df))
- **ui:** updated favicon ([a066a3c](https://github.com/willdady/platypus/commit/a066a3c959e29b19364d519cbdc9b9a518106f7d))
- update chat UI to use models from providers ([7971400](https://github.com/willdady/platypus/commit/79714003489091065ca21bcabbd46045ec071c9e))
- updated forms to show field errors and tweaked Zod validation schemas ([27cffc2](https://github.com/willdady/platypus/commit/27cffc2ec1a5872f40391bb5a3cb3628f196549c))
- updated workspace switcher UI ([345d670](https://github.com/willdady/platypus/commit/345d670597b506d38f7a58b53f64882218e15e8a))
- updates to Agent form ([e1517ad](https://github.com/willdady/platypus/commit/e1517ad29310392bc46bf81f422a2025aba265bb))
- updates to providers settings page ([8411473](https://github.com/willdady/platypus/commit/8411473c8bd7e5f8be346afaa098cd7215f823a6))
- updates to workspace settings screen ([b7861a6](https://github.com/willdady/platypus/commit/b7861a6c21d14e1aae51d433ab2328015b54bfa9))
- using official vercel ai-elements ([0dc183b](https://github.com/willdady/platypus/commit/0dc183bb6463d86776f97d45a558b534d4617cf3))

### Bug Fixes

- adding `modelId` field to Agent zod schemas ([66429b8](https://github.com/willdady/platypus/commit/66429b8e0e25298505a3f7edec9d03572706ee0e))
- **app-sidebar:** long chat titles now truncate ([150a94b](https://github.com/willdady/platypus/commit/150a94bf73b8219e85802bda3dc5a01b66853927))
- **backend:** compose file incorrectly calling `/tools` endpoint with missing required parameter. ([d165071](https://github.com/willdady/platypus/commit/d16507151c79056e8fbb7374b2663234feaed676))
- **backend:** missing chat message id generation required for chat persistance ([e7d0831](https://github.com/willdady/platypus/commit/e7d08312beabe84cacc466282be995479487a34c))
- broken model input on AgentForm ([0cc43d3](https://github.com/willdady/platypus/commit/0cc43d3f950f9445ab1c8dc0b6f18b948abcae61))
- chat page responsiveness ([1a0fbe4](https://github.com/willdady/platypus/commit/1a0fbe4e7a7a78e1901734d9e119ca37e62a8666))
- **chat-ui:** model select now correctly renders model ids which contain ":" ([2b10241](https://github.com/willdady/platypus/commit/2b10241b99bfd81293ae877df41bf65f06856b83))
- correctly use the selected agent's provider id when generating metadata ([53d69d8](https://github.com/willdady/platypus/commit/53d69d84c464fed1608d087b9c387ad6fa6cd318))
- **css:** muted and secondary colours no longer identical ([7f0f726](https://github.com/willdady/platypus/commit/7f0f7265a44fe6d4a61b24f273b73521e3af5b07))
- **frontend:** no longer regenerate chat title uneccssarily ([fbb1da5](https://github.com/willdady/platypus/commit/fbb1da50819b8c573dbcbd213b789595ece3c1d8))
- incorrect `use*` hook ordering ([e5a08ca](https://github.com/willdady/platypus/commit/e5a08cacef2fcccbf1ed2a22e3d0fefb3fabaeac))
- message persistance now working correctly ([ab23f5f](https://github.com/willdady/platypus/commit/ab23f5f64df8538d37333e74653b05db87f45d0e))
- missing await ([5f6a4ec](https://github.com/willdady/platypus/commit/5f6a4ec6e4437f1d4297443b53d226d1031df705))
- navigating to a non-existant workspace now returns 404 ([c7d0993](https://github.com/willdady/platypus/commit/c7d0993856c9a92c648e5d55b8a2227df82d101a))
- no longer render 0 sources on chat component ([64eed0b](https://github.com/willdady/platypus/commit/64eed0b24cf78c87d3f5b1f337b715c9a45e6880))
- selecting models containing ":" now works correctly on AgentForm ([1fdeb74](https://github.com/willdady/platypus/commit/1fdeb7485a88366762a1f4db88d864deb3d59ae3))
- **ui:** AgentInfoDialog content padding ([31008ca](https://github.com/willdady/platypus/commit/31008cad8c6f888be8867675d6f5f9e12ee56aae))
- **ui:** AgentList now warns if no Providers are defined before warning about no Agents being defined ([c29371d](https://github.com/willdady/platypus/commit/c29371d633a08fdc26dd23057eeb9cfd9ef84bdb))
- **ui:** AgentsList no longer renders alert when there are 0 agents ([a44341e](https://github.com/willdady/platypus/commit/a44341e7e8f724e939f1c78899a304da6465d514))
- **ui:** broken code styling in chat UI ([dbd7e81](https://github.com/willdady/platypus/commit/dbd7e813b94d9686b27e35db6bb6632a3669ec76))
- **ui:** home page is now a client component as fetch failed at build-time ([295ff8b](https://github.com/willdady/platypus/commit/295ff8b2b659da49a2e9740d8139f0d643b98d36))
- **ui:** prevent message code blocks with long lines from breaking conversation layout ([9a5fdda](https://github.com/willdady/platypus/commit/9a5fddac5674d364bdddb94692bf3e24064f37f0))

### Miscellaneous Chores

- release 1.0.1 ([7f7c808](https://github.com/willdady/platypus/commit/7f7c808794edfd23572048d46f1d87e8245afbd4))

## 1.0.0 (2025-12-21)

### Features

- `generate-title` endpoint now also generates up-to 5 tags ([7edc4a7](https://github.com/willdady/platypus/commit/7edc4a7e9478d18eda49dcd8f68dc29588c5ee8f))
- `title` field removed from `chatUpdateSchema` ([d37fc17](https://github.com/willdady/platypus/commit/d37fc1711dd316c083c346a7c563fae5d0b88e2b))
- added "tags" field to chat table ([e4e0dee](https://github.com/willdady/platypus/commit/e4e0dee58c3e467c6bb6a37b557259a5fcaefa61))
- added "Test Connection" button to MCP form ([432ab2f](https://github.com/willdady/platypus/commit/432ab2f6dce2fe7e85a2bd57417cb9fe967b6db9))
- added `description` field to agent table and added agents list screen ([0b1bc6f](https://github.com/willdady/platypus/commit/0b1bc6f296ea58fc112ef1dc89749591631dc817))
- added `headers` field to provider form ([f8cbea3](https://github.com/willdady/platypus/commit/f8cbea3b26cc13595f27f2cb0fd4fbbf79eb2194))
- added `modelId` field to `Agent` table ([84a7451](https://github.com/willdady/platypus/commit/84a74514c9764cedb41dfc7d761416990333af5e))
- added `modelIds` field to provider schema ([7e56999](https://github.com/willdady/platypus/commit/7e56999dce5e5e5dc1e9a75a37e49d7bd2a7ab92))
- added `taskModelId` field to provider table ([d68ee33](https://github.com/willdady/platypus/commit/d68ee33f4c5fee40d995eb5cd68a47dd33b00899))
- added 2x additional fields to agent table, schemas and ui ([fd59496](https://github.com/willdady/platypus/commit/fd594963b4aedd96e91648f1d1aa442ca5af2471))
- added 2x additional OpenAI-specific fields to the Provider table ([99adebb](https://github.com/willdady/platypus/commit/99adebb28725b5cbdf2830cd4d005448c0545bf7))
- added agent create button to AgentsList ([076790e](https://github.com/willdady/platypus/commit/076790eadfa358bb1846cf34e11ab6b8878574b7))
- added agent edit page ([f48a55e](https://github.com/willdady/platypus/commit/f48a55e23139571614371b2928a0c59f73f0e014))
- added Bedrock provider ([c05f379](https://github.com/willdady/platypus/commit/c05f379e3cd3078e1173eda32c2b47b7fc34cc11))
- added delete chat functionality ([0656896](https://github.com/willdady/platypus/commit/065689672b7e081734d2edc209c3137fa8a18628))
- added delete confirmation dialogs to provider and mcp forms ([714d8af](https://github.com/willdady/platypus/commit/714d8af43ed7b79f98304eba0f5bdd290983d2c2))
- added Docker Compose config and initial Drizzle migration files ([c31eb67](https://github.com/willdady/platypus/commit/c31eb6785a32fc1d9cf86aea9d1db4069603749a))
- added model picker to Chat component ([07eddfc](https://github.com/willdady/platypus/commit/07eddfce1e626b4ca1ab948c75a60b165223a6be))
- added new workspace list on org page ([f0735d8](https://github.com/willdady/platypus/commit/f0735d824571febdc0e95972b1c807c9df8ab901))
- added providers endpoints ([ac67d87](https://github.com/willdady/platypus/commit/ac67d87a30f2cc15f22b6b9c76b9b1cf7db7af1e))
- added Reasoning to Chat component ([f10c7f0](https://github.com/willdady/platypus/commit/f10c7f0e87cdf93f1cc87e4b50efe1b0aa5816e5))
- added tools jsonb field to Agent table ([1c66e97](https://github.com/willdady/platypus/commit/1c66e9726197356538fea26e63f8a2bfec6c2a8b))
- added workspace select to sidebar ([0dd5c7b](https://github.com/willdady/platypus/commit/0dd5c7b18d2eb07ea0d46abc0dec3480dc3ebe04))
- adding 4 fields to Agent table ([411c9c0](https://github.com/willdady/platypus/commit/411c9c05954606319b764661c7c7502eba5b0f77))
- adding AGENTS.md derived from CLAUDE.md ([16495ca](https://github.com/willdady/platypus/commit/16495ca8c737df12fb47e2203cf4e09edf98ed38))
- additional fields on chat table ([8cf8bc1](https://github.com/willdady/platypus/commit/8cf8bc1a01815ab02e0cc16a0d6e80af4fdd25fb))
- **agent-form:** added missing seed field and updated layout ([9b000db](https://github.com/willdady/platypus/commit/9b000db68fb386bda59f27297fc5233ce92f6d2e))
- all existing forms now auto-focus first text input ([11f003b](https://github.com/willdady/platypus/commit/11f003bb48b17753cc5f4a78f80a07a9dde54f24))
- backend now creates tables at startup ([6afe804](https://github.com/willdady/platypus/commit/6afe80450ae0dc24bd6899e7f82f42e0606e554b))
- backend routes now take query parameters ([b8d1240](https://github.com/willdady/platypus/commit/b8d12400096ff59a9a0fec951a50ee1c37c78aa8))
- **backend:** added `/chat/tags` endpoint ([c3dfb84](https://github.com/willdady/platypus/commit/c3dfb8496a00fbce13d0021b50a095e76f798e8b))
- **backend:** added chat list route ([b026440](https://github.com/willdady/platypus/commit/b026440dbbb120ab6b9dd6a7b674dc758fba759c))
- **backend:** added chat PUT endpoint ([f59c465](https://github.com/willdady/platypus/commit/f59c4656e933f1e6e9a0edf69fa6d9114993f96e))
- **backend:** added Dockerfile for backend app ([e3ecceb](https://github.com/willdady/platypus/commit/e3ecceb4ceec89ac9f8a3460496cef7385c31cd7))
- **backend:** added max length to generated chat title ([89edc0c](https://github.com/willdady/platypus/commit/89edc0c85fd9264a054dd599229b19c01933e8fa))
- **backend:** improved "default" Org and Workspace creation ([7227549](https://github.com/willdady/platypus/commit/7227549e2a5bbbe03ca52e86b1679e44830402fb))
- **backend:** removed validation from `generate-metadata` LLM call ([7940735](https://github.com/willdady/platypus/commit/79407351e384d1021aa6caa95495f5639b48f005))
- base url field now pre-fills when switching to OpenRouter provider ([e1767df](https://github.com/willdady/platypus/commit/e1767dfcfa03d8464d106fb33d821b7bcdf53231))
- can now "star" chats ([8aebb7e](https://github.com/willdady/platypus/commit/8aebb7e4065e24c64886e379951d5d2badcfae0a))
- can now categorise tools ([14b819f](https://github.com/willdady/platypus/commit/14b819fbf0cc6d098d84f595c273965a391f34e8))
- can now configure chat settings from chat screen ([ac07398](https://github.com/willdady/platypus/commit/ac073985acfb0303a83a94d5dbae1f147b30fabb))
- can now edit existing user messages ([7b00158](https://github.com/willdady/platypus/commit/7b00158dd31df1ecc4e5d2b5724ae0736c315bac))
- can now renamed Workspace from settings page ([a2dbde1](https://github.com/willdady/platypus/commit/a2dbde1b1869691c73c1c5cc9127771e47804b4e))
- can now select agent from chat screen ([db2efca](https://github.com/willdady/platypus/commit/db2efca24324c282d57c13a82297fa136505ef6c))
- chat component now renders sources ([aab19a9](https://github.com/willdady/platypus/commit/aab19a9c7f89943624063c10c93b63ae3d70ccb8))
- chat component now shows alert if no providers are configured ([49644ef](https://github.com/willdady/platypus/commit/49644efb37ccd181dda7d955bb7e939ecf56a4aa))
- chat list now revalidates after first chat response ([368ae7d](https://github.com/willdady/platypus/commit/368ae7d4378331340ce0cd9917bd66287144061e))
- chat now uses models from providers ([b10f688](https://github.com/willdady/platypus/commit/b10f6881826a646919d2beb122a8414ab5576f52))
- chat UI now supports attachments ([64de7e0](https://github.com/willdady/platypus/commit/64de7e0b8d2b1d52654f886c0fbd24ff3d57a5a2))
- **chat-ui:** added regenerate action to last assistant message ([e5823d8](https://github.com/willdady/platypus/commit/e5823d80760a7e6df5b466ac9733f160ec3a5b45))
- chats are now filtered and sorted by `createdAt` ([1971d4f](https://github.com/willdady/platypus/commit/1971d4fcf6e86d693670ee1d27e373c27f51c41a))
- chats now group in sidebar ([09c8bf4](https://github.com/willdady/platypus/commit/09c8bf404d79201093e928b31becd6df157b0e7e))
- chats now persist to the database ([a1729a6](https://github.com/willdady/platypus/commit/a1729a6e5cb0fa5ec4b7939358f6f8e42028451b))
- deleted 2x unneeded provider fields ([81241cc](https://github.com/willdady/platypus/commit/81241ccb9eba59850f23d77a41e3976220d0c53d))
- deleted the `agent_tool` m2m table as it's not needed ([fcbfc53](https://github.com/willdady/platypus/commit/fcbfc53483e1075f139151b53f0c868641ed22c6))
- fixed position settings menu on workspace settings layout ([e29af5b](https://github.com/willdady/platypus/commit/e29af5ba6fe5267a49bcd89888001814ef8af4d7))
- frontend now reads backend URL from env ([6a7512b](https://github.com/willdady/platypus/commit/6a7512b882dbad91fc47a3fc7dce2a3b9c9b5ecf))
- **frontend:** added docker build scripts ([51e81bd](https://github.com/willdady/platypus/commit/51e81bdbd0f189c5e39b689cd76cf82fd71a6715))
- **frontend:** adding pointer state to buttons ([dc81f5e](https://github.com/willdady/platypus/commit/dc81f5e21f8ba10d636364fa806ecbe45476ab8a))
- **frontend:** backend url now set via context on root layout ([aebe4cc](https://github.com/willdady/platypus/commit/aebe4ccb37f5786ef3a359682801b9f859c10c42))
- **frontend:** chat screen now has responsive width ([f97feb1](https://github.com/willdady/platypus/commit/f97feb1723498e462af99c10535d3556c19a62c7))
- **frontend:** improved style on workspace picker page ([730d69b](https://github.com/willdady/platypus/commit/730d69b2c034be6493b088cf0d7acc2866cd08cd))
- **frontend:** moved chat to it's own component ([985d124](https://github.com/willdady/platypus/commit/985d124b97eea77cc110eb529e5d45e0ce8b5c20))
- **frontend:** stubbed initial pages ([49e1090](https://github.com/willdady/platypus/commit/49e1090a4c664ba2918b1d7810bb494b4f90a89e))
- **frontend:** stubbed MCP page ([b2a319c](https://github.com/willdady/platypus/commit/b2a319c6923d95c44bd781681947f920510d5cc4))
- implemented mcp routes and UI ([46bf4d8](https://github.com/willdady/platypus/commit/46bf4d8a01632ee9710d45373ba093d0e433e91e))
- implemented title generation endpoint ([3128491](https://github.com/willdady/platypus/commit/3128491d245e921cc5a995b5ce220270326f7603))
- implementing tools list endpoint ([1dfde35](https://github.com/willdady/platypus/commit/1dfde350984e74f5e135410cce77ba8edcec9758))
- improved chat rename error handling ([3ccbb6d](https://github.com/willdady/platypus/commit/3ccbb6ded6216c468e6f55430dfd6ba04169af78))
- improved prompt input styling ([3bfc913](https://github.com/willdady/platypus/commit/3bfc9138b7ed481885cdc3501cec90f2e0a66a2f))
- list item margins ([fd4e375](https://github.com/willdady/platypus/commit/fd4e3757240a41e29515b922b879510b03944604))
- MCP servers can now be enabled on agents ([a243122](https://github.com/willdady/platypus/commit/a243122001856e216518a2f4ad44def445adce07))
- more consistent Alert styling ([1a6b71c](https://github.com/willdady/platypus/commit/1a6b71c9e735057b378ce7ddd16fe5bfe7fe2463))
- moved fetches to server components ([c8161a5](https://github.com/willdady/platypus/commit/c8161a587440cd9f9aa829542040519771e25f88))
- moved provider headers field inside collapsible component ([1bb8601](https://github.com/willdady/platypus/commit/1bb8601c5b6281a5ad8648d5ffea307c6717341e))
- navigating to `/{orgId}/workspace` now redirects to `/{orgId}` ([2dd6d78](https://github.com/willdady/platypus/commit/2dd6d7802d21e40648b37719e21787cb91604308))
- pinning Postgres to v17 due to issue with Drizzle on Postgres v18 ([3ff9603](https://github.com/willdady/platypus/commit/3ff960325501efd01369592ad142ed6f67e37957))
- provider and mcp list components now show alert when none are configured ([3237c89](https://github.com/willdady/platypus/commit/3237c898002b788bb7627a633abb4746bfd5a031))
- provider and model ids now persist to chat table ([bd03bf5](https://github.com/willdady/platypus/commit/bd03bf5593414aaf4d886647157bb2cc0daff235))
- **provider:** added `extraBody` field to provider table for use with OpenRouter ([c61c326](https://github.com/willdady/platypus/commit/c61c326dc0a31f07839463de0d0349bc52198af4))
- **provider:** added Google provider ([6546cc5](https://github.com/willdady/platypus/commit/6546cc5d8438e8e9193d0664bdda47ccd5b36f1e))
- quick chat endpoint now uses the model from the request ([83fc187](https://github.com/willdady/platypus/commit/83fc187797a10fbe923c9e3077214ca2dfa5210f))
- reduced the max width of the chat UI ([2e99392](https://github.com/willdady/platypus/commit/2e993924fc880b60cd0a756f18e6dc9d2fa837b5))
- removed `shadcn-io` ai components ([81d9a95](https://github.com/willdady/platypus/commit/81d9a95d454b73109d21501dd641632edc16af15))
- removed models routes and updated AgentForm to use providers ([b180a03](https://github.com/willdady/platypus/commit/b180a03712f3dd85de7fd93651cca255b662587c))
- removing Tool table ([ef4093f](https://github.com/willdady/platypus/commit/ef4093ff34796e664d568e6ed5d1df96244eaf67))
- render errors returned from `useChat` ([d259221](https://github.com/willdady/platypus/commit/d259221232504926a4ef8024725d2d40929ed908))
- **search:** added search toggle ([cd452fe](https://github.com/willdady/platypus/commit/cd452fe57b97ecc7198bfafe32c349cc40964fcb))
- sort model ids before writing to provider table ([7a149bf](https://github.com/willdady/platypus/commit/7a149bf099a82908510858a10a63a25688a61675))
- starting a chat from the agent list now works as expected ([72fc86c](https://github.com/willdady/platypus/commit/72fc86c2f75c01843222cb38553b5dcd900b5c78))
- stubbed Agent form ([3b86cee](https://github.com/willdady/platypus/commit/3b86cee37c26524258a548a65600c7e4fe897108))
- stubbed providers form ([ab8b4d9](https://github.com/willdady/platypus/commit/ab8b4d98650260a8823afab7a460f0d42c00b4c5))
- style and formatting updates ([b674d2d](https://github.com/willdady/platypus/commit/b674d2d4079ae61f4c4e53beb0863a734e6002f7))
- style updates ([116b232](https://github.com/willdady/platypus/commit/116b232a88b2b89eb9a0f7f4bc6667b586120bf6))
- tool calls now render in chat ([c92fcd3](https://github.com/willdady/platypus/commit/c92fcd32f0dd7cf3268bd8a7181fc9bc5a9d0110))
- tools are now defined as sets, not individual tools ([973fdaf](https://github.com/willdady/platypus/commit/973fdaf2e26c19e9a51a53ede426ba294ba94a57))
- **ui:** "advanced" fields on chat settings dialog are now collapsed by default ([343c2e4](https://github.com/willdady/platypus/commit/343c2e45540c83a059c43d5db2586a40b8dff53e))
- **ui:** accordion on app home page now open by default when there is only 1 Org ([6255283](https://github.com/willdady/platypus/commit/6255283ea367f70211132b749950fa707ea79a82))
- **ui:** add accordion layout to app home page ([45684d0](https://github.com/willdady/platypus/commit/45684d0978e817788c338474ed46de254fb41993))
- **ui:** added agent info dialog to Chat component ([2fa607f](https://github.com/willdady/platypus/commit/2fa607fdef8e7d279c044931d5edb1d6580b905c))
- **ui:** added confirmation dialog for deleting workspace ([e4d10cb](https://github.com/willdady/platypus/commit/e4d10cbc00344d26ad9efc7445bd062115e520c4))
- **ui:** added copy-to-clipboard buttons to workspace settings page ([aec9a1e](https://github.com/willdady/platypus/commit/aec9a1e9f10de91fffa76da99f7899c114dfe786))
- **ui:** added edit button to agent info dialog ([e8dd210](https://github.com/willdady/platypus/commit/e8dd210cb0b98afc495023027ca88fbe2d92884c))
- **ui:** added global command pallete ([9efb803](https://github.com/willdady/platypus/commit/9efb803e4a953c30d9899729f623e39a68629910))
- **ui:** added icons to app sidebar groups ([5287bd5](https://github.com/willdady/platypus/commit/5287bd507aa2861aa6d27567b22f68234b87ba4c))
- **ui:** added separator before footer in AppSidebar ([6546cc5](https://github.com/willdady/platypus/commit/6546cc5d8438e8e9193d0664bdda47ccd5b36f1e))
- **ui:** added TagCloud to workspace home page ([e72285c](https://github.com/willdady/platypus/commit/e72285cd32d1b0e69e2678fdf4b5108fd8262047))
- **ui:** added workspace home page; removed dedicated agents page ([e1be019](https://github.com/willdady/platypus/commit/e1be0195fa47bcf72532a8276d979b0da358986a))
- **ui:** AgentInfoDialog now shows provider ([9cc7e60](https://github.com/willdady/platypus/commit/9cc7e6022350e65b8ce9ecbd4f838b6722cb6a3f))
- **ui:** changed model picker component on chat page ([9e35596](https://github.com/willdady/platypus/commit/9e35596342eca8ae3328816933bbf6d39437a553))
- **ui:** chat input now vertically centred on empty chats ([0361d48](https://github.com/willdady/platypus/commit/0361d48cc12de3c057acce09f25b70c1f485e99a))
- **ui:** chat textarea now auto focuses ([aa7dd5a](https://github.com/willdady/platypus/commit/aa7dd5a46308192f5741f7e34f5396e97e689a16))
- **ui:** dedicated Back button which goes back in route history ([4336171](https://github.com/willdady/platypus/commit/4336171820d212fd9d7b77619fa3847cde8265bc))
- **ui:** implement organization management ([da941a9](https://github.com/willdady/platypus/commit/da941a93b400ef527dd350e39ea24b1388b4cc93))
- **ui:** major refactor of Chat component into sub components and hooks ([6dd983e](https://github.com/willdady/platypus/commit/6dd983e8bb87f55195eeb5a4323a0751e333fd3a))
- **ui:** message actions now use muted text colour ([f0beeaa](https://github.com/willdady/platypus/commit/f0beeaae4bc3cd2a9a1074c142f2537d0b43ba5b))
- **ui:** message text is now selected when clicking edit message button ([c08a93e](https://github.com/willdady/platypus/commit/c08a93e2ab38d5997c6048ac71ce003b8545cdd1))
- **ui:** now showing info toast when clicking copy-to-clipboard buttons ([a60e5bd](https://github.com/willdady/platypus/commit/a60e5bdd457851876c099a59c9d9efeaa4aabd0b))
- **ui:** prompt input now focuses when model selector is closed ([c72bc9a](https://github.com/willdady/platypus/commit/c72bc9a8664b289d4e756627f626625efc319b17))
- **ui:** updated app Home page ([54c3697](https://github.com/willdady/platypus/commit/54c369734218ea6af509310efeebafcaffb141df))
- **ui:** updated favicon ([a066a3c](https://github.com/willdady/platypus/commit/a066a3c959e29b19364d519cbdc9b9a518106f7d))
- update chat UI to use models from providers ([7971400](https://github.com/willdady/platypus/commit/79714003489091065ca21bcabbd46045ec071c9e))
- updated forms to show field errors and tweaked Zod validation schemas ([27cffc2](https://github.com/willdady/platypus/commit/27cffc2ec1a5872f40391bb5a3cb3628f196549c))
- updated workspace switcher UI ([345d670](https://github.com/willdady/platypus/commit/345d670597b506d38f7a58b53f64882218e15e8a))
- updates to Agent form ([e1517ad](https://github.com/willdady/platypus/commit/e1517ad29310392bc46bf81f422a2025aba265bb))
- updates to providers settings page ([8411473](https://github.com/willdady/platypus/commit/8411473c8bd7e5f8be346afaa098cd7215f823a6))
- updates to workspace settings screen ([b7861a6](https://github.com/willdady/platypus/commit/b7861a6c21d14e1aae51d433ab2328015b54bfa9))
- using official vercel ai-elements ([0dc183b](https://github.com/willdady/platypus/commit/0dc183bb6463d86776f97d45a558b534d4617cf3))

### Bug Fixes

- adding `modelId` field to Agent zod schemas ([66429b8](https://github.com/willdady/platypus/commit/66429b8e0e25298505a3f7edec9d03572706ee0e))
- **app-sidebar:** long chat titles now truncate ([150a94b](https://github.com/willdady/platypus/commit/150a94bf73b8219e85802bda3dc5a01b66853927))
- **backend:** compose file incorrectly calling `/tools` endpoint with missing required parameter. ([d165071](https://github.com/willdady/platypus/commit/d16507151c79056e8fbb7374b2663234feaed676))
- **backend:** missing chat message id generation required for chat persistance ([e7d0831](https://github.com/willdady/platypus/commit/e7d08312beabe84cacc466282be995479487a34c))
- broken model input on AgentForm ([0cc43d3](https://github.com/willdady/platypus/commit/0cc43d3f950f9445ab1c8dc0b6f18b948abcae61))
- chat page responsiveness ([1a0fbe4](https://github.com/willdady/platypus/commit/1a0fbe4e7a7a78e1901734d9e119ca37e62a8666))
- **chat-ui:** model select now correctly renders model ids which contain ":" ([2b10241](https://github.com/willdady/platypus/commit/2b10241b99bfd81293ae877df41bf65f06856b83))
- correctly use the selected agent's provider id when generating metadata ([53d69d8](https://github.com/willdady/platypus/commit/53d69d84c464fed1608d087b9c387ad6fa6cd318))
- **css:** muted and secondary colours no longer identical ([7f0f726](https://github.com/willdady/platypus/commit/7f0f7265a44fe6d4a61b24f273b73521e3af5b07))
- **frontend:** no longer regenerate chat title uneccssarily ([fbb1da5](https://github.com/willdady/platypus/commit/fbb1da50819b8c573dbcbd213b789595ece3c1d8))
- incorrect `use*` hook ordering ([e5a08ca](https://github.com/willdady/platypus/commit/e5a08cacef2fcccbf1ed2a22e3d0fefb3fabaeac))
- message persistance now working correctly ([ab23f5f](https://github.com/willdady/platypus/commit/ab23f5f64df8538d37333e74653b05db87f45d0e))
- missing await ([5f6a4ec](https://github.com/willdady/platypus/commit/5f6a4ec6e4437f1d4297443b53d226d1031df705))
- navigating to a non-existant workspace now returns 404 ([c7d0993](https://github.com/willdady/platypus/commit/c7d0993856c9a92c648e5d55b8a2227df82d101a))
- no longer render 0 sources on chat component ([64eed0b](https://github.com/willdady/platypus/commit/64eed0b24cf78c87d3f5b1f337b715c9a45e6880))
- selecting models containing ":" now works correctly on AgentForm ([1fdeb74](https://github.com/willdady/platypus/commit/1fdeb7485a88366762a1f4db88d864deb3d59ae3))
- **ui:** AgentInfoDialog content padding ([31008ca](https://github.com/willdady/platypus/commit/31008cad8c6f888be8867675d6f5f9e12ee56aae))
- **ui:** AgentList now warns if no Providers are defined before warning about no Agents being defined ([c29371d](https://github.com/willdady/platypus/commit/c29371d633a08fdc26dd23057eeb9cfd9ef84bdb))
- **ui:** AgentsList no longer renders alert when there are 0 agents ([a44341e](https://github.com/willdady/platypus/commit/a44341e7e8f724e939f1c78899a304da6465d514))
- **ui:** broken code styling in chat UI ([dbd7e81](https://github.com/willdady/platypus/commit/dbd7e813b94d9686b27e35db6bb6632a3669ec76))
- **ui:** home page is now a client component as fetch failed at build-time ([295ff8b](https://github.com/willdady/platypus/commit/295ff8b2b659da49a2e9740d8139f0d643b98d36))
- **ui:** prevent message code blocks with long lines from breaking conversation layout ([9a5fdda](https://github.com/willdady/platypus/commit/9a5fddac5674d364bdddb94692bf3e24064f37f0))

## 1.0.0 (2025-12-21)

### Features

- `generate-title` endpoint now also generates up-to 5 tags ([7edc4a7](https://github.com/willdady/platypus/commit/7edc4a7e9478d18eda49dcd8f68dc29588c5ee8f))
- `title` field removed from `chatUpdateSchema` ([d37fc17](https://github.com/willdady/platypus/commit/d37fc1711dd316c083c346a7c563fae5d0b88e2b))
- added "tags" field to chat table ([e4e0dee](https://github.com/willdady/platypus/commit/e4e0dee58c3e467c6bb6a37b557259a5fcaefa61))
- added "Test Connection" button to MCP form ([432ab2f](https://github.com/willdady/platypus/commit/432ab2f6dce2fe7e85a2bd57417cb9fe967b6db9))
- added `description` field to agent table and added agents list screen ([0b1bc6f](https://github.com/willdady/platypus/commit/0b1bc6f296ea58fc112ef1dc89749591631dc817))
- added `headers` field to provider form ([f8cbea3](https://github.com/willdady/platypus/commit/f8cbea3b26cc13595f27f2cb0fd4fbbf79eb2194))
- added `modelId` field to `Agent` table ([84a7451](https://github.com/willdady/platypus/commit/84a74514c9764cedb41dfc7d761416990333af5e))
- added `modelIds` field to provider schema ([7e56999](https://github.com/willdady/platypus/commit/7e56999dce5e5e5dc1e9a75a37e49d7bd2a7ab92))
- added `taskModelId` field to provider table ([d68ee33](https://github.com/willdady/platypus/commit/d68ee33f4c5fee40d995eb5cd68a47dd33b00899))
- added 2x additional fields to agent table, schemas and ui ([fd59496](https://github.com/willdady/platypus/commit/fd594963b4aedd96e91648f1d1aa442ca5af2471))
- added 2x additional OpenAI-specific fields to the Provider table ([99adebb](https://github.com/willdady/platypus/commit/99adebb28725b5cbdf2830cd4d005448c0545bf7))
- added agent create button to AgentsList ([076790e](https://github.com/willdady/platypus/commit/076790eadfa358bb1846cf34e11ab6b8878574b7))
- added agent edit page ([f48a55e](https://github.com/willdady/platypus/commit/f48a55e23139571614371b2928a0c59f73f0e014))
- added Bedrock provider ([c05f379](https://github.com/willdady/platypus/commit/c05f379e3cd3078e1173eda32c2b47b7fc34cc11))
- added delete chat functionality ([0656896](https://github.com/willdady/platypus/commit/065689672b7e081734d2edc209c3137fa8a18628))
- added delete confirmation dialogs to provider and mcp forms ([714d8af](https://github.com/willdady/platypus/commit/714d8af43ed7b79f98304eba0f5bdd290983d2c2))
- added Docker Compose config and initial Drizzle migration files ([c31eb67](https://github.com/willdady/platypus/commit/c31eb6785a32fc1d9cf86aea9d1db4069603749a))
- added model picker to Chat component ([07eddfc](https://github.com/willdady/platypus/commit/07eddfce1e626b4ca1ab948c75a60b165223a6be))
- added new workspace list on org page ([f0735d8](https://github.com/willdady/platypus/commit/f0735d824571febdc0e95972b1c807c9df8ab901))
- added providers endpoints ([ac67d87](https://github.com/willdady/platypus/commit/ac67d87a30f2cc15f22b6b9c76b9b1cf7db7af1e))
- added Reasoning to Chat component ([f10c7f0](https://github.com/willdady/platypus/commit/f10c7f0e87cdf93f1cc87e4b50efe1b0aa5816e5))
- added tools jsonb field to Agent table ([1c66e97](https://github.com/willdady/platypus/commit/1c66e9726197356538fea26e63f8a2bfec6c2a8b))
- added workspace select to sidebar ([0dd5c7b](https://github.com/willdady/platypus/commit/0dd5c7b18d2eb07ea0d46abc0dec3480dc3ebe04))
- adding 4 fields to Agent table ([411c9c0](https://github.com/willdady/platypus/commit/411c9c05954606319b764661c7c7502eba5b0f77))
- adding AGENTS.md derived from CLAUDE.md ([16495ca](https://github.com/willdady/platypus/commit/16495ca8c737df12fb47e2203cf4e09edf98ed38))
- additional fields on chat table ([8cf8bc1](https://github.com/willdady/platypus/commit/8cf8bc1a01815ab02e0cc16a0d6e80af4fdd25fb))
- **agent-form:** added missing seed field and updated layout ([9b000db](https://github.com/willdady/platypus/commit/9b000db68fb386bda59f27297fc5233ce92f6d2e))
- all existing forms now auto-focus first text input ([11f003b](https://github.com/willdady/platypus/commit/11f003bb48b17753cc5f4a78f80a07a9dde54f24))
- backend now creates tables at startup ([6afe804](https://github.com/willdady/platypus/commit/6afe80450ae0dc24bd6899e7f82f42e0606e554b))
- backend routes now take query parameters ([b8d1240](https://github.com/willdady/platypus/commit/b8d12400096ff59a9a0fec951a50ee1c37c78aa8))
- **backend:** added `/chat/tags` endpoint ([c3dfb84](https://github.com/willdady/platypus/commit/c3dfb8496a00fbce13d0021b50a095e76f798e8b))
- **backend:** added chat list route ([b026440](https://github.com/willdady/platypus/commit/b026440dbbb120ab6b9dd6a7b674dc758fba759c))
- **backend:** added chat PUT endpoint ([f59c465](https://github.com/willdady/platypus/commit/f59c4656e933f1e6e9a0edf69fa6d9114993f96e))
- **backend:** added Dockerfile for backend app ([e3ecceb](https://github.com/willdady/platypus/commit/e3ecceb4ceec89ac9f8a3460496cef7385c31cd7))
- **backend:** added max length to generated chat title ([89edc0c](https://github.com/willdady/platypus/commit/89edc0c85fd9264a054dd599229b19c01933e8fa))
- **backend:** improved "default" Org and Workspace creation ([7227549](https://github.com/willdady/platypus/commit/7227549e2a5bbbe03ca52e86b1679e44830402fb))
- **backend:** removed validation from `generate-metadata` LLM call ([7940735](https://github.com/willdady/platypus/commit/79407351e384d1021aa6caa95495f5639b48f005))
- base url field now pre-fills when switching to OpenRouter provider ([e1767df](https://github.com/willdady/platypus/commit/e1767dfcfa03d8464d106fb33d821b7bcdf53231))
- can now "star" chats ([8aebb7e](https://github.com/willdady/platypus/commit/8aebb7e4065e24c64886e379951d5d2badcfae0a))
- can now categorise tools ([14b819f](https://github.com/willdady/platypus/commit/14b819fbf0cc6d098d84f595c273965a391f34e8))
- can now configure chat settings from chat screen ([ac07398](https://github.com/willdady/platypus/commit/ac073985acfb0303a83a94d5dbae1f147b30fabb))
- can now edit existing user messages ([7b00158](https://github.com/willdady/platypus/commit/7b00158dd31df1ecc4e5d2b5724ae0736c315bac))
- can now renamed Workspace from settings page ([a2dbde1](https://github.com/willdady/platypus/commit/a2dbde1b1869691c73c1c5cc9127771e47804b4e))
- can now select agent from chat screen ([db2efca](https://github.com/willdady/platypus/commit/db2efca24324c282d57c13a82297fa136505ef6c))
- chat component now renders sources ([aab19a9](https://github.com/willdady/platypus/commit/aab19a9c7f89943624063c10c93b63ae3d70ccb8))
- chat component now shows alert if no providers are configured ([49644ef](https://github.com/willdady/platypus/commit/49644efb37ccd181dda7d955bb7e939ecf56a4aa))
- chat list now revalidates after first chat response ([368ae7d](https://github.com/willdady/platypus/commit/368ae7d4378331340ce0cd9917bd66287144061e))
- chat now uses models from providers ([b10f688](https://github.com/willdady/platypus/commit/b10f6881826a646919d2beb122a8414ab5576f52))
- chat UI now supports attachments ([64de7e0](https://github.com/willdady/platypus/commit/64de7e0b8d2b1d52654f886c0fbd24ff3d57a5a2))
- **chat-ui:** added regenerate action to last assistant message ([e5823d8](https://github.com/willdady/platypus/commit/e5823d80760a7e6df5b466ac9733f160ec3a5b45))
- chats are now filtered and sorted by `createdAt` ([1971d4f](https://github.com/willdady/platypus/commit/1971d4fcf6e86d693670ee1d27e373c27f51c41a))
- chats now group in sidebar ([09c8bf4](https://github.com/willdady/platypus/commit/09c8bf404d79201093e928b31becd6df157b0e7e))
- chats now persist to the database ([a1729a6](https://github.com/willdady/platypus/commit/a1729a6e5cb0fa5ec4b7939358f6f8e42028451b))
- deleted 2x unneeded provider fields ([81241cc](https://github.com/willdady/platypus/commit/81241ccb9eba59850f23d77a41e3976220d0c53d))
- deleted the `agent_tool` m2m table as it's not needed ([fcbfc53](https://github.com/willdady/platypus/commit/fcbfc53483e1075f139151b53f0c868641ed22c6))
- fixed position settings menu on workspace settings layout ([e29af5b](https://github.com/willdady/platypus/commit/e29af5ba6fe5267a49bcd89888001814ef8af4d7))
- frontend now reads backend URL from env ([6a7512b](https://github.com/willdady/platypus/commit/6a7512b882dbad91fc47a3fc7dce2a3b9c9b5ecf))
- **frontend:** added docker build scripts ([51e81bd](https://github.com/willdady/platypus/commit/51e81bdbd0f189c5e39b689cd76cf82fd71a6715))
- **frontend:** adding pointer state to buttons ([dc81f5e](https://github.com/willdady/platypus/commit/dc81f5e21f8ba10d636364fa806ecbe45476ab8a))
- **frontend:** backend url now set via context on root layout ([aebe4cc](https://github.com/willdady/platypus/commit/aebe4ccb37f5786ef3a359682801b9f859c10c42))
- **frontend:** chat screen now has responsive width ([f97feb1](https://github.com/willdady/platypus/commit/f97feb1723498e462af99c10535d3556c19a62c7))
- **frontend:** improved style on workspace picker page ([730d69b](https://github.com/willdady/platypus/commit/730d69b2c034be6493b088cf0d7acc2866cd08cd))
- **frontend:** moved chat to it's own component ([985d124](https://github.com/willdady/platypus/commit/985d124b97eea77cc110eb529e5d45e0ce8b5c20))
- **frontend:** stubbed initial pages ([49e1090](https://github.com/willdady/platypus/commit/49e1090a4c664ba2918b1d7810bb494b4f90a89e))
- **frontend:** stubbed MCP page ([b2a319c](https://github.com/willdady/platypus/commit/b2a319c6923d95c44bd781681947f920510d5cc4))
- implemented mcp routes and UI ([46bf4d8](https://github.com/willdady/platypus/commit/46bf4d8a01632ee9710d45373ba093d0e433e91e))
- implemented title generation endpoint ([3128491](https://github.com/willdady/platypus/commit/3128491d245e921cc5a995b5ce220270326f7603))
- implementing tools list endpoint ([1dfde35](https://github.com/willdady/platypus/commit/1dfde350984e74f5e135410cce77ba8edcec9758))
- improved chat rename error handling ([3ccbb6d](https://github.com/willdady/platypus/commit/3ccbb6ded6216c468e6f55430dfd6ba04169af78))
- improved prompt input styling ([3bfc913](https://github.com/willdady/platypus/commit/3bfc9138b7ed481885cdc3501cec90f2e0a66a2f))
- list item margins ([fd4e375](https://github.com/willdady/platypus/commit/fd4e3757240a41e29515b922b879510b03944604))
- MCP servers can now be enabled on agents ([a243122](https://github.com/willdady/platypus/commit/a243122001856e216518a2f4ad44def445adce07))
- more consistent Alert styling ([1a6b71c](https://github.com/willdady/platypus/commit/1a6b71c9e735057b378ce7ddd16fe5bfe7fe2463))
- moved fetches to server components ([c8161a5](https://github.com/willdady/platypus/commit/c8161a587440cd9f9aa829542040519771e25f88))
- moved provider headers field inside collapsible component ([1bb8601](https://github.com/willdady/platypus/commit/1bb8601c5b6281a5ad8648d5ffea307c6717341e))
- navigating to `/{orgId}/workspace` now redirects to `/{orgId}` ([2dd6d78](https://github.com/willdady/platypus/commit/2dd6d7802d21e40648b37719e21787cb91604308))
- pinning Postgres to v17 due to issue with Drizzle on Postgres v18 ([3ff9603](https://github.com/willdady/platypus/commit/3ff960325501efd01369592ad142ed6f67e37957))
- provider and mcp list components now show alert when none are configured ([3237c89](https://github.com/willdady/platypus/commit/3237c898002b788bb7627a633abb4746bfd5a031))
- provider and model ids now persist to chat table ([bd03bf5](https://github.com/willdady/platypus/commit/bd03bf5593414aaf4d886647157bb2cc0daff235))
- **provider:** added `extraBody` field to provider table for use with OpenRouter ([c61c326](https://github.com/willdady/platypus/commit/c61c326dc0a31f07839463de0d0349bc52198af4))
- **provider:** added Google provider ([6546cc5](https://github.com/willdady/platypus/commit/6546cc5d8438e8e9193d0664bdda47ccd5b36f1e))
- quick chat endpoint now uses the model from the request ([83fc187](https://github.com/willdady/platypus/commit/83fc187797a10fbe923c9e3077214ca2dfa5210f))
- reduced the max width of the chat UI ([2e99392](https://github.com/willdady/platypus/commit/2e993924fc880b60cd0a756f18e6dc9d2fa837b5))
- removed `shadcn-io` ai components ([81d9a95](https://github.com/willdady/platypus/commit/81d9a95d454b73109d21501dd641632edc16af15))
- removed models routes and updated AgentForm to use providers ([b180a03](https://github.com/willdady/platypus/commit/b180a03712f3dd85de7fd93651cca255b662587c))
- removing Tool table ([ef4093f](https://github.com/willdady/platypus/commit/ef4093ff34796e664d568e6ed5d1df96244eaf67))
- render errors returned from `useChat` ([d259221](https://github.com/willdady/platypus/commit/d259221232504926a4ef8024725d2d40929ed908))
- **search:** added search toggle ([cd452fe](https://github.com/willdady/platypus/commit/cd452fe57b97ecc7198bfafe32c349cc40964fcb))
- sort model ids before writing to provider table ([7a149bf](https://github.com/willdady/platypus/commit/7a149bf099a82908510858a10a63a25688a61675))
- starting a chat from the agent list now works as expected ([72fc86c](https://github.com/willdady/platypus/commit/72fc86c2f75c01843222cb38553b5dcd900b5c78))
- stubbed Agent form ([3b86cee](https://github.com/willdady/platypus/commit/3b86cee37c26524258a548a65600c7e4fe897108))
- stubbed providers form ([ab8b4d9](https://github.com/willdady/platypus/commit/ab8b4d98650260a8823afab7a460f0d42c00b4c5))
- style and formatting updates ([b674d2d](https://github.com/willdady/platypus/commit/b674d2d4079ae61f4c4e53beb0863a734e6002f7))
- style updates ([116b232](https://github.com/willdady/platypus/commit/116b232a88b2b89eb9a0f7f4bc6667b586120bf6))
- tool calls now render in chat ([c92fcd3](https://github.com/willdady/platypus/commit/c92fcd32f0dd7cf3268bd8a7181fc9bc5a9d0110))
- tools are now defined as sets, not individual tools ([973fdaf](https://github.com/willdady/platypus/commit/973fdaf2e26c19e9a51a53ede426ba294ba94a57))
- **ui:** "advanced" fields on chat settings dialog are now collapsed by default ([343c2e4](https://github.com/willdady/platypus/commit/343c2e45540c83a059c43d5db2586a40b8dff53e))
- **ui:** accordion on app home page now open by default when there is only 1 Org ([6255283](https://github.com/willdady/platypus/commit/6255283ea367f70211132b749950fa707ea79a82))
- **ui:** add accordion layout to app home page ([45684d0](https://github.com/willdady/platypus/commit/45684d0978e817788c338474ed46de254fb41993))
- **ui:** added agent info dialog to Chat component ([2fa607f](https://github.com/willdady/platypus/commit/2fa607fdef8e7d279c044931d5edb1d6580b905c))
- **ui:** added confirmation dialog for deleting workspace ([e4d10cb](https://github.com/willdady/platypus/commit/e4d10cbc00344d26ad9efc7445bd062115e520c4))
- **ui:** added copy-to-clipboard buttons to workspace settings page ([aec9a1e](https://github.com/willdady/platypus/commit/aec9a1e9f10de91fffa76da99f7899c114dfe786))
- **ui:** added edit button to agent info dialog ([e8dd210](https://github.com/willdady/platypus/commit/e8dd210cb0b98afc495023027ca88fbe2d92884c))
- **ui:** added global command pallete ([9efb803](https://github.com/willdady/platypus/commit/9efb803e4a953c30d9899729f623e39a68629910))
- **ui:** added icons to app sidebar groups ([5287bd5](https://github.com/willdady/platypus/commit/5287bd507aa2861aa6d27567b22f68234b87ba4c))
- **ui:** added separator before footer in AppSidebar ([6546cc5](https://github.com/willdady/platypus/commit/6546cc5d8438e8e9193d0664bdda47ccd5b36f1e))
- **ui:** added TagCloud to workspace home page ([e72285c](https://github.com/willdady/platypus/commit/e72285cd32d1b0e69e2678fdf4b5108fd8262047))
- **ui:** added workspace home page; removed dedicated agents page ([e1be019](https://github.com/willdady/platypus/commit/e1be0195fa47bcf72532a8276d979b0da358986a))
- **ui:** AgentInfoDialog now shows provider ([9cc7e60](https://github.com/willdady/platypus/commit/9cc7e6022350e65b8ce9ecbd4f838b6722cb6a3f))
- **ui:** changed model picker component on chat page ([9e35596](https://github.com/willdady/platypus/commit/9e35596342eca8ae3328816933bbf6d39437a553))
- **ui:** chat input now vertically centred on empty chats ([0361d48](https://github.com/willdady/platypus/commit/0361d48cc12de3c057acce09f25b70c1f485e99a))
- **ui:** chat textarea now auto focuses ([aa7dd5a](https://github.com/willdady/platypus/commit/aa7dd5a46308192f5741f7e34f5396e97e689a16))
- **ui:** dedicated Back button which goes back in route history ([4336171](https://github.com/willdady/platypus/commit/4336171820d212fd9d7b77619fa3847cde8265bc))
- **ui:** implement organization management ([da941a9](https://github.com/willdady/platypus/commit/da941a93b400ef527dd350e39ea24b1388b4cc93))
- **ui:** major refactor of Chat component into sub components and hooks ([6dd983e](https://github.com/willdady/platypus/commit/6dd983e8bb87f55195eeb5a4323a0751e333fd3a))
- **ui:** message actions now use muted text colour ([f0beeaa](https://github.com/willdady/platypus/commit/f0beeaae4bc3cd2a9a1074c142f2537d0b43ba5b))
- **ui:** message text is now selected when clicking edit message button ([c08a93e](https://github.com/willdady/platypus/commit/c08a93e2ab38d5997c6048ac71ce003b8545cdd1))
- **ui:** now showing info toast when clicking copy-to-clipboard buttons ([a60e5bd](https://github.com/willdady/platypus/commit/a60e5bdd457851876c099a59c9d9efeaa4aabd0b))
- **ui:** prompt input now focuses when model selector is closed ([c72bc9a](https://github.com/willdady/platypus/commit/c72bc9a8664b289d4e756627f626625efc319b17))
- **ui:** updated app Home page ([54c3697](https://github.com/willdady/platypus/commit/54c369734218ea6af509310efeebafcaffb141df))
- **ui:** updated favicon ([a066a3c](https://github.com/willdady/platypus/commit/a066a3c959e29b19364d519cbdc9b9a518106f7d))
- update chat UI to use models from providers ([7971400](https://github.com/willdady/platypus/commit/79714003489091065ca21bcabbd46045ec071c9e))
- updated forms to show field errors and tweaked Zod validation schemas ([27cffc2](https://github.com/willdady/platypus/commit/27cffc2ec1a5872f40391bb5a3cb3628f196549c))
- updated workspace switcher UI ([345d670](https://github.com/willdady/platypus/commit/345d670597b506d38f7a58b53f64882218e15e8a))
- updates to Agent form ([e1517ad](https://github.com/willdady/platypus/commit/e1517ad29310392bc46bf81f422a2025aba265bb))
- updates to providers settings page ([8411473](https://github.com/willdady/platypus/commit/8411473c8bd7e5f8be346afaa098cd7215f823a6))
- updates to workspace settings screen ([b7861a6](https://github.com/willdady/platypus/commit/b7861a6c21d14e1aae51d433ab2328015b54bfa9))
- using official vercel ai-elements ([0dc183b](https://github.com/willdady/platypus/commit/0dc183bb6463d86776f97d45a558b534d4617cf3))

### Bug Fixes

- adding `modelId` field to Agent zod schemas ([66429b8](https://github.com/willdady/platypus/commit/66429b8e0e25298505a3f7edec9d03572706ee0e))
- **app-sidebar:** long chat titles now truncate ([150a94b](https://github.com/willdady/platypus/commit/150a94bf73b8219e85802bda3dc5a01b66853927))
- **backend:** compose file incorrectly calling `/tools` endpoint with missing required parameter. ([d165071](https://github.com/willdady/platypus/commit/d16507151c79056e8fbb7374b2663234feaed676))
- **backend:** missing chat message id generation required for chat persistance ([e7d0831](https://github.com/willdady/platypus/commit/e7d08312beabe84cacc466282be995479487a34c))
- broken model input on AgentForm ([0cc43d3](https://github.com/willdady/platypus/commit/0cc43d3f950f9445ab1c8dc0b6f18b948abcae61))
- chat page responsiveness ([1a0fbe4](https://github.com/willdady/platypus/commit/1a0fbe4e7a7a78e1901734d9e119ca37e62a8666))
- **chat-ui:** model select now correctly renders model ids which contain ":" ([2b10241](https://github.com/willdady/platypus/commit/2b10241b99bfd81293ae877df41bf65f06856b83))
- correctly use the selected agent's provider id when generating metadata ([53d69d8](https://github.com/willdady/platypus/commit/53d69d84c464fed1608d087b9c387ad6fa6cd318))
- **css:** muted and secondary colours no longer identical ([7f0f726](https://github.com/willdady/platypus/commit/7f0f7265a44fe6d4a61b24f273b73521e3af5b07))
- **frontend:** no longer regenerate chat title uneccssarily ([fbb1da5](https://github.com/willdady/platypus/commit/fbb1da50819b8c573dbcbd213b789595ece3c1d8))
- incorrect `use*` hook ordering ([e5a08ca](https://github.com/willdady/platypus/commit/e5a08cacef2fcccbf1ed2a22e3d0fefb3fabaeac))
- message persistance now working correctly ([ab23f5f](https://github.com/willdady/platypus/commit/ab23f5f64df8538d37333e74653b05db87f45d0e))
- missing await ([5f6a4ec](https://github.com/willdady/platypus/commit/5f6a4ec6e4437f1d4297443b53d226d1031df705))
- navigating to a non-existant workspace now returns 404 ([c7d0993](https://github.com/willdady/platypus/commit/c7d0993856c9a92c648e5d55b8a2227df82d101a))
- no longer render 0 sources on chat component ([64eed0b](https://github.com/willdady/platypus/commit/64eed0b24cf78c87d3f5b1f337b715c9a45e6880))
- selecting models containing ":" now works correctly on AgentForm ([1fdeb74](https://github.com/willdady/platypus/commit/1fdeb7485a88366762a1f4db88d864deb3d59ae3))
- **ui:** AgentInfoDialog content padding ([31008ca](https://github.com/willdady/platypus/commit/31008cad8c6f888be8867675d6f5f9e12ee56aae))
- **ui:** AgentList now warns if no Providers are defined before warning about no Agents being defined ([c29371d](https://github.com/willdady/platypus/commit/c29371d633a08fdc26dd23057eeb9cfd9ef84bdb))
- **ui:** AgentsList no longer renders alert when there are 0 agents ([a44341e](https://github.com/willdady/platypus/commit/a44341e7e8f724e939f1c78899a304da6465d514))
- **ui:** broken code styling in chat UI ([dbd7e81](https://github.com/willdady/platypus/commit/dbd7e813b94d9686b27e35db6bb6632a3669ec76))
- **ui:** home page is now a client component as fetch failed at build-time ([295ff8b](https://github.com/willdady/platypus/commit/295ff8b2b659da49a2e9740d8139f0d643b98d36))
- **ui:** prevent message code blocks with long lines from breaking conversation layout ([9a5fdda](https://github.com/willdady/platypus/commit/9a5fddac5674d364bdddb94692bf3e24064f37f0))
