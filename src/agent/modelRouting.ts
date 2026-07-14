export type ModelWorkKind = "fix" | "investigate" | "review";
export type ModelTier = "easy" | "deep";
export type ModelRouteSource = "default" | "tier-override" | "global-override";

export interface ModelParameterValue {
  id: string;
  value: string;
}

export interface ModelSelection {
  id: string;
  params?: ModelParameterValue[];
}

export interface CatalogModel {
  id: string;
  aliases?: string[];
  parameters?: Array<{ id: string; values: Array<{ value: string }> }>;
  variants?: Array<{ params: ModelParameterValue[] }>;
}

export interface ModelRoutingReceipt {
  version: 1;
  status: "selected" | "blocked";
  workKind: ModelWorkKind;
  tier: ModelTier;
  reason: string;
  requestedModel: string;
  selectedModel?: string;
  params: ModelParameterValue[];
  source: ModelRouteSource;
  catalog: "unverified" | "verified" | "unavailable";
  blockedReason?: string;
  sdkResolvedModel?: ModelSelection;
}

export interface PlannedModelRoute {
  selection?: ModelSelection;
  receipt: ModelRoutingReceipt;
}

const APPROVED_MODELS = new Set(["composer-2.5", "claude-fable-5"]);
const TIER_MODELS: Record<ModelTier, Set<string>> = {
  easy: new Set(["composer-2.5"]),
  deep: new Set(["claude-fable-5"]),
};

const DEFAULT_ROUTES: Record<ModelWorkKind, {
  tier: ModelTier;
  reason: string;
  selection: ModelSelection;
}> = {
  fix: {
    tier: "easy",
    reason: "bounded-remediation",
    selection: {
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    },
  },
  investigate: {
    tier: "deep",
    reason: "open-ended-security-investigation",
    selection: {
      id: "claude-fable-5",
      params: [
        { id: "thinking", value: "true" },
        { id: "context", value: "300k" },
        { id: "effort", value: "high" },
      ],
    },
  },
  review: {
    tier: "deep",
    reason: "independent-security-review",
    selection: {
      id: "claude-fable-5",
      params: [
        { id: "thinking", value: "true" },
        { id: "context", value: "300k" },
        { id: "effort", value: "high" },
      ],
    },
  },
};

function copyParams(params: ModelParameterValue[] | undefined): ModelParameterValue[] {
  return (params ?? []).map((param) => ({ ...param }));
}

function blocked(
  workKind: ModelWorkKind,
  tier: ModelTier,
  reason: string,
  requestedModel: string,
  params: ModelParameterValue[],
  source: ModelRouteSource,
  blockedReason: string,
  catalog: ModelRoutingReceipt["catalog"] = "unverified",
): PlannedModelRoute {
  return {
    receipt: {
      version: 1,
      status: "blocked",
      workKind,
      tier,
      reason,
      requestedModel,
      params,
      source,
      catalog,
      blockedReason,
    },
  };
}

export function planModelRoute(
  workKind: ModelWorkKind,
  env: NodeJS.ProcessEnv = process.env,
): PlannedModelRoute {
  const policy = DEFAULT_ROUTES[workKind];
  if (!policy) {
    throw new Error(`Unsupported Sentinel work kind: ${String(workKind)}`);
  }

  const globalOverride = env.SENTINEL_MODEL?.trim();
  const tierOverride = (policy.tier === "easy"
    ? env.SENTINEL_MODEL_EASY
    : env.SENTINEL_MODEL_DEEP)?.trim();
  const requestedModel = globalOverride || tierOverride || policy.selection.id;
  const source: ModelRouteSource = globalOverride
    ? "global-override"
    : tierOverride
      ? "tier-override"
      : "default";
  const params = requestedModel === policy.selection.id
    ? copyParams(policy.selection.params)
    : [];

  if (!APPROVED_MODELS.has(requestedModel)) {
    return blocked(
      workKind,
      policy.tier,
      policy.reason,
      requestedModel,
      params,
      source,
      `Model ${requestedModel} is not in Sentinel's approved routing policy.`,
    );
  }
  if (!TIER_MODELS[policy.tier].has(requestedModel) && env.SENTINEL_BREAK_GLASS !== "1") {
    return blocked(
      workKind,
      policy.tier,
      policy.reason,
      requestedModel,
      params,
      source,
      `Model ${requestedModel} is not approved for Sentinel's ${policy.tier} tier. Set SENTINEL_BREAK_GLASS=1 only for an explicit demo override.`,
    );
  }

  return {
    selection: { id: requestedModel, ...(params.length ? { params } : {}) },
    receipt: {
      version: 1,
      status: "selected",
      workKind,
      tier: policy.tier,
      reason: policy.reason,
      requestedModel,
      selectedModel: requestedModel,
      params,
      source,
      catalog: "unverified",
    },
  };
}

export function resolveModelRoute(
  planned: PlannedModelRoute,
  catalog: CatalogModel[],
): PlannedModelRoute {
  if (!planned.selection || planned.receipt.status === "blocked") return planned;
  if (!Array.isArray(catalog)) {
    return blocked(
      planned.receipt.workKind,
      planned.receipt.tier,
      planned.receipt.reason,
      planned.receipt.requestedModel,
      planned.receipt.params,
      planned.receipt.source,
      "Cursor model catalog is unavailable.",
      "unavailable",
    );
  }

  const requested = planned.selection.id;
  const model = catalog.find((item) => item.id === requested || item.aliases?.includes(requested));
  if (!model) {
    return blocked(
      planned.receipt.workKind,
      planned.receipt.tier,
      planned.receipt.reason,
      requested,
      planned.receipt.params,
      planned.receipt.source,
      `Requested model ${requested} is not available to this Cursor account.`,
      "verified",
    );
  }

  for (const param of planned.selection.params ?? []) {
    const definition = model.parameters?.find((item) => item.id === param.id);
    if (!definition || !definition.values.some((item) => item.value === param.value)) {
      return blocked(
        planned.receipt.workKind,
        planned.receipt.tier,
        planned.receipt.reason,
        requested,
        planned.receipt.params,
        planned.receipt.source,
        `Model ${model.id} does not support ${param.id}=${param.value}.`,
        "verified",
      );
    }
  }
  if (planned.selection.params?.length && model.variants?.length) {
    const signature = (params: ModelParameterValue[]) => params
      .map((param) => `${param.id}=${param.value}`)
      .sort()
      .join("|");
    const requestedVariant = signature(planned.selection.params);
    if (!model.variants.some((variant) => signature(variant.params) === requestedVariant)) {
      return blocked(
        planned.receipt.workKind,
        planned.receipt.tier,
        planned.receipt.reason,
        requested,
        planned.receipt.params,
        planned.receipt.source,
        `Model ${model.id} does not advertise the requested parameter combination.`,
        "verified",
      );
    }
  }

  return {
    selection: { id: model.id, ...(planned.selection.params?.length ? { params: copyParams(planned.selection.params) } : {}) },
    receipt: {
      ...planned.receipt,
      status: "selected",
      selectedModel: model.id,
      catalog: "verified",
      blockedReason: undefined,
    },
  };
}

export function withActualModel(
  receipt: ModelRoutingReceipt,
  sdkResolvedModel: ModelSelection | undefined,
): ModelRoutingReceipt {
  return {
    ...receipt,
    ...(sdkResolvedModel
      ? { sdkResolvedModel: { id: sdkResolvedModel.id, ...(sdkResolvedModel.params?.length ? { params: copyParams(sdkResolvedModel.params) } : {}) } }
      : {}),
  };
}

export function routingSummary(receipt: ModelRoutingReceipt): string {
  if (receipt.status === "blocked") {
    return `${receipt.workKind} blocked · ${receipt.blockedReason ?? "model unavailable"}`;
  }
  const model = receipt.sdkResolvedModel?.id ?? receipt.selectedModel ?? receipt.requestedModel;
  return `${receipt.tier} ${receipt.workKind} → ${model} · ${receipt.source}`;
}
