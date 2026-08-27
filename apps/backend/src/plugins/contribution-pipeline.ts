import type { PluginConfigContext } from "@platypuschat/plugin-sdk";

// The one registration sequence every Extension point runs (ADR-0013).
//
// Tool sets, Sandbox backends, and Web-search backends differ in what a
// contribution must contain and in what core registers for it, but not in how
// one gets from "an entry in a manifest array" to "registered, owned, and
// reported": check the shape, check the id and name, namespace the id, refuse a
// collision naming both plugins, register with plugin attribution on failure.
// That sequence lives here once; a point supplies only what is genuinely its
// own, and a fourth point is a table entry in `extension-points.ts`, not a
// fourth copy of this loop.

/**
 * A contribution as it arrives from a manifest: past the shape check (a
 * non-null, non-array object), with every field still unknown. TypeScript
 * protects in-repo plugins; a third-party *JS* package can put any value in
 * these arrays, which is this module's whole justification.
 */
export type RawContribution = Record<string, unknown>;

/** What a point's `validate` is told about the contribution it is checking. */
export interface ContributionIdentity {
  /** The contributing plugin's manifest name, for error attribution. */
  pluginName: string;
  /**
   * The id as the plugin author wrote it — checked non-empty, but not yet
   * trimmed or namespaced, so a message reads with the id they would recognise.
   */
  rawId: string;
}

/** What a point's `prepare` is told about the contribution it is preparing. */
export interface ContributionContext {
  /** The contributing plugin's manifest name, for error attribution. */
  pluginName: string;
  /** The trimmed, namespaced id this contribution registers under. */
  id: string;
  /**
   * The plugin's boot-resolved deploy-time config/credentials — one shared
   * block per plugin, bound into every contribution factory.
   */
  plugin: PluginConfigContext;
  /**
   * Whether the contributing plugin is a core built-in — the loader's own
   * decision, carried rather than re-derived. It already shapes the id through
   * {@link RegisterContributionsOptions.contributionId}; the Tool-set point needs
   * the decision itself, because a third-party plugin's tool *names* are
   * namespaced too (issue #664).
   */
  isCore: boolean;
  /**
   * The major API version the plugin's manifest declares — carried for the same
   * reason {@link ContributionContext.isCore} is, rather than re-read from the
   * manifest a point does not otherwise hold.
   *
   * Core admits a window of `[OLDEST_SUPPORTED_API_VERSION, PLUGIN_API_VERSION]`
   * (ADR-0013's N and N−1), and a point needs the declared version where a
   * member changed *shape* across that window rather than being appended to. The
   * Sandbox point's `configSchema` factory is the one such member.
   */
  apiVersion: number;
}

/**
 * One Extension point's differences from every other. The shared steps are
 * {@link registerContributions}'s; a point adds the noun its errors read with,
 * the field it takes its id from, whatever else a valid contribution must
 * carry, and what core actually registers.
 */
export interface ExtensionPoint<TRegistration = unknown> {
  /** Lower-case noun for error messages — "tool set", "sandbox backend". */
  noun: string;
  /** The contribution field holding the id — "id", "backend". */
  idField: string;
  /**
   * Per-point shape checks beyond the shared id/name pair, run before the id is
   * namespaced (so their messages read with the id the plugin author wrote).
   * Throws a plugin-named error to abort the load.
   */
  validate?(
    contribution: RawContribution,
    identity: ContributionIdentity,
  ): void;
  /**
   * Build what core registers: bind the plugin's shared config block into the
   * contribution's factories, resolve per-point forms, and apply the checks
   * that only make sense once the namespaced id is known. Throws a plugin-named
   * error to abort the load.
   */
  prepare(
    contribution: RawContribution,
    context: ContributionContext,
  ): TRegistration;
  /** Hand the prepared registration to core's registry for this point. */
  register(id: string, registration: TRegistration): void;
}

export interface RegisterContributionsOptions<TRegistration> {
  point: ExtensionPoint<TRegistration>;
  /** This plugin's slice of the manifest for the point — values are unknown. */
  contributions: readonly unknown[];
  /** The contributing plugin's manifest name. */
  pluginName: string;
  /** The plugin's boot-resolved deploy-time config/credentials. */
  plugin: PluginConfigContext;
  /** Applies the origin's id-namespacing rule (core bare, third-party prefixed). */
  contributionId: (id: string) => string;
  /** Whether this plugin is a core built-in, passed through to every `prepare`. */
  isCore: boolean;
  /** The manifest's declared major API version, passed through to every `prepare`. */
  apiVersion: number;
  /**
   * Point-wide id → owning plugin map, carried across plugins so a collision
   * can name both sides. Mutated as each contribution registers.
   */
  owners: Map<string, string>;
}

// "tool set" → "Tool set", for the collision message that leads with the noun.
const sentenceCase = (noun: string): string =>
  noun.charAt(0).toUpperCase() + noun.slice(1);

/**
 * Validate and register one plugin's contributions to one Extension point,
 * returning the ids registered (in manifest order) for the boot log.
 *
 * Fail-loud and all-or-nothing (ADR-0013): the first bad contribution throws a
 * plugin-named error and aborts boot. Entries validate and register in the same
 * pass, so contributions ahead of a bad one are already registered — not a leak,
 * since the throw means the half-filled registry never serves a turn.
 */
export const registerContributions = <TRegistration>(
  options: RegisterContributionsOptions<TRegistration>,
): string[] => {
  const {
    point,
    contributions,
    pluginName,
    plugin,
    contributionId,
    isCore,
    apiVersion,
    owners,
  } = options;
  const registeredIds: string[] = [];

  for (const [index, contribution] of contributions.entries()) {
    // Identity is checked before it is namespaced: `contributionId(undefined)`
    // otherwise mints a plausible-looking `"acme.undefined"` and registers it,
    // so a JS plugin's missing field surfaces as a mystery id in the catalog
    // rather than a boot error naming the plugin.
    //
    // The two checks that run before an id is known carry the array index — on
    // a plugin contributing several entries it is the only thing an Operator
    // can use to find the offending one.
    if (
      typeof contribution !== "object" ||
      contribution === null ||
      Array.isArray(contribution)
    ) {
      throw new Error(
        `Plugin "${pluginName}": every ${point.noun} contribution must be an object (at index ${index}).`,
      );
    }

    const raw = contribution as RawContribution;
    const rawId = raw[point.idField];
    if (typeof rawId !== "string" || rawId.trim() === "") {
      throw new Error(
        `Plugin "${pluginName}": every ${point.noun} must declare a non-empty "${point.idField}" (at index ${index}).`,
      );
    }
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new Error(
        `Plugin "${pluginName}": ${point.noun} "${rawId}" must declare a non-empty "name".`,
      );
    }

    point.validate?.(raw, { pluginName, rawId });

    // Trimmed before namespacing: the id is half of a composed
    // `${manifest.name}.${id}` that gets persisted (into `agent.toolSetIds`,
    // `sandbox.backend`, `provider.searchSource`), and the other half is held to a
    // url-safe slug for exactly that reason.
    const id = contributionId(rawId.trim());

    const existingOwner = owners.get(id);
    if (existingOwner) {
      throw new Error(
        `${sentenceCase(point.noun)} id "${id}" is contributed by both "${existingOwner}" and "${pluginName}".`,
      );
    }

    const registration = point.prepare(raw, {
      pluginName,
      id,
      plugin,
      isCore,
      apiVersion,
    });

    try {
      point.register(id, registration);
    } catch (cause) {
      // A collision with something registered outside the loader (a core
      // built-in, a legacy static registration) surfaces here — the registry
      // does not know which plugin asked, so attribution is added.
      throw new Error(
        `Plugin "${pluginName}": failed to register ${point.noun} "${id}" (${
          cause instanceof Error ? cause.message : String(cause)
        }).`,
        { cause },
      );
    }

    owners.set(id, pluginName);
    registeredIds.push(id);
  }

  return registeredIds;
};
