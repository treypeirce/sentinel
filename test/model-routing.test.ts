import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  planModelRoute,
  resolveModelRoute,
  routingSummary,
  withActualModel,
  type CatalogModel,
} from "../src/agent/modelRouting.ts";

const catalog: CatalogModel[] = [
  {
    id: "composer-2.5",
    aliases: ["composer"],
    parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
    variants: [
      { params: [{ id: "fast", value: "true" }] },
      { params: [{ id: "fast", value: "false" }] },
    ],
  },
  {
    id: "claude-fable-5",
    aliases: ["fable"],
    parameters: [
      { id: "thinking", values: [{ value: "true" }, { value: "false" }] },
      { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
      { id: "effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
    ],
    variants: [
      {
        params: [
          { id: "thinking", value: "true" },
          { id: "context", value: "300k" },
          { id: "effort", value: "high" },
        ],
      },
    ],
  },
];

describe("Sentinel model routing", () => {
  it("routes bounded fixes to fast Composer", () => {
    const route = resolveModelRoute(planModelRoute("fix", {}), catalog);

    assert.equal(route.receipt.status, "selected");
    assert.equal(route.receipt.tier, "easy");
    assert.equal(route.selection?.id, "composer-2.5");
    assert.deepEqual(route.selection?.params, [{ id: "fast", value: "true" }]);
  });

  it("routes investigations and reviews to high-effort Fable", () => {
    for (const kind of ["investigate", "review"] as const) {
      const route = resolveModelRoute(planModelRoute(kind, {}), catalog);

      assert.equal(route.receipt.status, "selected");
      assert.equal(route.receipt.tier, "deep");
      assert.equal(route.selection?.id, "claude-fable-5");
      assert.deepEqual(route.selection?.params, [
        { id: "thinking", value: "true" },
        { id: "context", value: "300k" },
        { id: "effort", value: "high" },
      ]);
    }
  });

  it("applies override precedence without silently crossing tiers", () => {
    const tier = planModelRoute("fix", { SENTINEL_MODEL_EASY: "composer-2.5" });
    assert.equal(tier.receipt.source, "tier-override");

    const blockedGlobal = planModelRoute("fix", {
      SENTINEL_MODEL: "claude-fable-5",
      SENTINEL_MODEL_EASY: "composer-2.5",
    });
    assert.equal(blockedGlobal.receipt.source, "global-override");
    assert.equal(blockedGlobal.receipt.status, "blocked");
    assert.match(blockedGlobal.receipt.blockedReason ?? "", /easy tier/);

    const breakGlass = planModelRoute("fix", {
      SENTINEL_MODEL: "claude-fable-5",
      SENTINEL_BREAK_GLASS: "1",
    });
    assert.equal(breakGlass.selection?.id, "claude-fable-5");
  });

  it("blocks unapproved overrides instead of silently falling back", () => {
    const route = planModelRoute("review", { SENTINEL_MODEL_DEEP: "unknown-model" });

    assert.equal(route.selection, undefined);
    assert.equal(route.receipt.status, "blocked");
    assert.match(route.receipt.blockedReason ?? "", /approved routing policy/);
  });

  it("blocks unavailable models and unsupported parameters", () => {
    const unavailable = resolveModelRoute(planModelRoute("review", {}), catalog.slice(0, 1));
    assert.equal(unavailable.receipt.status, "blocked");
    assert.equal(unavailable.receipt.catalog, "verified");

    const unsupportedCatalog: CatalogModel[] = [
      catalog[0],
      {
        id: "claude-fable-5",
        parameters: [{ id: "effort", values: [{ value: "low" }] }],
      },
    ];
    const unsupported = resolveModelRoute(planModelRoute("review", {}), unsupportedCatalog);
    assert.equal(unsupported.receipt.status, "blocked");
    assert.match(unsupported.receipt.blockedReason ?? "", /does not support/);

    const invalidVariantCatalog: CatalogModel[] = [
      catalog[0],
      {
        ...catalog[1],
        variants: [{ params: [{ id: "effort", value: "low" }] }],
      },
    ];
    const invalidVariant = resolveModelRoute(planModelRoute("review", {}), invalidVariantCatalog);
    assert.equal(invalidVariant.receipt.status, "blocked");
    assert.match(invalidVariant.receipt.blockedReason ?? "", /parameter combination/);
  });

  it("records the effective model without mutating the routing receipt", () => {
    const route = resolveModelRoute(planModelRoute("fix", {}), catalog);
    const receipt = route.receipt;
    const completed = withActualModel(receipt, {
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });

    assert.deepEqual(completed.sdkResolvedModel, {
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
    assert.equal("sdkResolvedModel" in receipt, false);
    assert.match(routingSummary(receipt), /easy fix/);
  });
});
