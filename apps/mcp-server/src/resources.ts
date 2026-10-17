import { z } from "zod";
import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/server";
import { REFERENCE_VERSION } from "@odft/contracts";
import { PACE_PROFILES } from "@odft/domain";
import { countReferenceCoverage, listReferenceManifests } from "@odft/persistence";
import type { McpHostContext } from "./app.js";

/**
 * Phase 04 MCP resources (plan §3.4): static reference documents plus the
 * delegation-scoped scenario manifest template. Static resources are readable
 * by every authenticated identity; the manifest resource follows the same
 * snapshot authorization as the travel-data tools (a non-revoked delegation of
 * the caller for exactly that snapshot).
 */

const PACE_PROFILES_VERSION = "pace-v1" as const;

export function registerResources(
  server: McpServer,
  context: McpHostContext,
  identity: string,
  endpoint: "geography" | "itineraryTools",
): void {
  void identity;
  if (endpoint === "geography") {
    server.registerResource(
      "geography-coverage",
      "odft://geography/coverage",
      { title: "Reference coverage", mimeType: "application/json" },
      async (uri) => {
        const coverage = await countReferenceCoverage(context.readPool);
        const manifests = await listReferenceManifests(context.readPool);
        const value = {
          referenceVersion: REFERENCE_VERSION,
          ...coverage,
          manifests: manifests.map((manifest) => ({
            source: manifest.source,
            revision: manifest.revision,
            retrievedAt: manifest.retrievedAt,
            recordCount: manifest.recordCount,
            transformVersion: manifest.transformVersion,
          })),
        };
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }],
        };
      },
    );

    server.registerResource(
      "geography-licenses",
      "odft://geography/licenses",
      { title: "Reference licences", mimeType: "application/json" },
      async (uri) => {
        const manifests = await listReferenceManifests(context.readPool);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                manifests.map((manifest) => ({
                  source: manifest.source,
                  url: manifest.url,
                  license: manifest.license,
                  licenseUrl: manifest.licenseUrl,
                  attribution: manifest.attribution,
                  sha256: manifest.sha256,
                })),
              ),
            },
          ],
        };
      },
    );
  }

  if (endpoint === "itineraryTools") {
    server.registerResource(
      "pace-profiles",
      "odft://itinerary/pace-profiles",
      { title: "Pace profiles", mimeType: "application/json" },
      async (uri) => {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ version: PACE_PROFILES_VERSION, profiles: PACE_PROFILES }),
            },
          ],
        };
      },
    );
  }

}

/** Delegation-scoped manifest resource (travel-data endpoint). */
export function registerScenarioManifestResource(
  server: McpServer,
  context: McpHostContext,
  identity: string,
): void {
  const template = new ResourceTemplate("odft://scenario/{snapshotId}/manifest", { list: undefined });
  server.registerResource(
    "scenario-manifest",
    template,
    { title: "Scenario manifest", mimeType: "application/json" },
    async (uri, variables) => {
      const snapshotId = z.string().uuid().parse(variables.snapshotId);
      // Same snapshot authorization as the tools: the caller must hold a
      // non-revoked delegation for exactly this snapshot.
      await context.authorize({
        identity,
        endpoint: "travelData",
        delegationId: await context.delegationForSnapshot(identity, snapshotId),
        snapshotId,
      });
      const metadata = await context.snapshotRead.readScenarioMetadata(snapshotId);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(metadata) }],
      };
    },
  );
}
