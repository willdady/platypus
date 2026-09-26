# Custom backend image with a third-party Plugin

The published backend image can only load the Plugins it ships with. To add a
third-party Plugin, build your own image on top of it. This example installs
the repository's example Plugin (`@platypus-examples/tool-set`, which
contributes a **Greeting** Tool set) on top of `willdady/platypus-backend:3.10.2`
and runs it with the stock `compose.yaml`.

| File                    | What it does                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`            | Installs the Plugin on top of the pinned base image. Entrypoint, command, `/data` and health check are unchanged. |
| `compose.override.yaml` | Builds the custom backend image, pins the frontend to the same version, and enables the Plugin.                   |

## Build and run

You need Docker, Node.js 26 and pnpm. Run every command from the repository root.

1. Install the workspace and build the example Plugin:

   ```bash
   pnpm install
   pnpm --filter @platypus-examples/tool-set build
   ```

2. Pack it into this directory. The example Plugin is not on npm, so the image
   installs it from this tarball:

   ```bash
   pnpm --filter @platypus-examples/tool-set pack --pack-destination "$PWD/examples/custom-image"
   ```

   Pack with pnpm, not npm. Only pnpm points the packed package at its built
   `dist/index.js` and replaces the `workspace:*` dependency on
   `@platypuschat/plugin-sdk` with a real version. Check the result:

   ```bash
   tar -xzOf examples/custom-image/platypus-examples-tool-set-0.1.0.tgz package/package.json
   ```

   `main` must be `dist/index.js`, and `@platypuschat/plugin-sdk` must be a
   version number.

3. Configure the stack as in
   [Deploy with Docker Compose](https://docs.platypus.chat/self-hosting/docker-compose):

   ```bash
   cp .env.example .env
   ```

4. Build the image and start the stack with the override:

   ```bash
   docker compose -f compose.yaml -f examples/custom-image/compose.override.yaml up -d --build
   ```

   Naming files with `-f` turns off the automatic pickup of a root
   `compose.override.yaml`. If you have one, add it as a third `-f`.

## Check the Plugin loaded

The backend logs one line per Plugin at boot:

```bash
docker compose -f compose.yaml -f examples/custom-image/compose.override.yaml logs backend | grep "Loaded plugin example"
```

You should see
`Loaded plugin example@0.1.0 (third-party): 1 tool set(s), 0 sandbox backend(s), 0 web backend(s)`. A
Plugin that fails to load stops the backend from booting, and the log names the
Plugin and the reason.

In the app, open **Organization settings → Plugins**. `example` is listed as
**Third-party** with the Tool set `example.greeting`. Edit an Agent to attach the
**Greeting** Tool set.

## `PLATYPUS_PLUGINS` is replaced, not extended

The override sets `PLATYPUS_PLUGINS` for the backend, and that value wins over
the one in `.env`. Setting it to only the new Plugin silently turns off every
other Plugin you listed in `.env`. List them all in the override.

## Install a Plugin from npm instead

For a published Plugin, replace the tarball path on the `npm install` line of
the `Dockerfile` with the package and version:

```dockerfile
    npm install --omit=dev --no-audit --no-fund --cache /tmp/npm-cache \
      @acme/platypus-plugin@1.2.0 && \
```

Then list the same package name in `PLATYPUS_PLUGINS`. To install several
Plugins, name them all on the one `npm install` line.

## How the Plugin is installed

The backend loads a third-party Plugin by importing its package name, so the
package has to be in a `node_modules` directory above the backend's code.

The image's own `node_modules` belongs to pnpm. Running `npm install` in `/app` or
the backend's directory makes npm reinstall everything that `package.json`
lists. It fails on pnpm-only `workspace:*` dependencies, and would rewrite
pnpm's `node_modules` if it got further. So the `Dockerfile` installs Plugins into a
separate npm project, `/opt/platypus-plugins`, and links
`/app/apps/node_modules` to that project's `node_modules`. pnpm does not use
that directory, and Node looks there when the backend imports a Plugin.

Each Plugin gets its own dependencies, including its own copy of
`@platypuschat/plugin-sdk`, separate from the backend's. That is expected. The
backend checks a Plugin's manifest, not which SDK copy it came from.

Everything the `Dockerfile` adds is owned by uid 1001, the account the backend
runs as.

## Upgrading Platypus

Rebuild this image for every Platypus release. Change the version in both
places together, because the backend and frontend images are released and
tested as a pair:

- the `FROM` tag in the `Dockerfile`
- the frontend `image` tag in `compose.override.yaml`

Then start the stack with `--build` again. Without it, Compose reuses the image
it built last time, and the new frontend runs against the old backend.
