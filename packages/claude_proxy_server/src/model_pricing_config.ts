/** Prices in US dollars per million tokens. */
export interface ModelTokenPrices {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export type ModelPricingTable = Map<string, ModelTokenPrices>;

export interface MessageTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  cacheReadInputTokens: number;
}

/** Validates the parsed contents of `pricing.yml`. */
export function parseModelPricingConfig(yamlValue: unknown): ModelPricingTable {
  const modelEntries = (yamlValue as { models?: unknown } | null)?.models;
  if (modelEntries === null || modelEntries === undefined) return new Map();
  if (typeof modelEntries !== 'object' || Array.isArray(modelEntries)) throw new Error('models must be a mapping');

  const modelPricingTable: ModelPricingTable = new Map();
  for (const [modelIdPrefix, priceEntry] of Object.entries(modelEntries as Record<string, Record<string, unknown>>)) {
    const readPrice = (fieldName: string): number => {
      const fieldValue = priceEntry?.[fieldName];
      if (typeof fieldValue !== 'number') throw new Error(`models.${modelIdPrefix}.${fieldName} must be a number`);
      return fieldValue;
    };
    modelPricingTable.set(modelIdPrefix, {
      input: readPrice('input'),
      output: readPrice('output'),
      cacheWrite5m: readPrice('cache_write_5m'),
      cacheWrite1h: readPrice('cache_write_1h'),
      cacheRead: readPrice('cache_read'),
    });
  }
  return modelPricingTable;
}

/**
 * Finds the prices for a model ID. An exact entry wins; otherwise the longest entry that is a prefix
 * of the model ID wins, so `claude-haiku-4-5` matches `claude-haiku-4-5-20251001`.
 */
export function findModelTokenPrices(modelPricingTable: ModelPricingTable, modelId: string): ModelTokenPrices | null {
  const exactPrices = modelPricingTable.get(modelId);
  if (exactPrices) return exactPrices;
  let longestMatchingPrefix: string | null = null;
  for (const modelIdPrefix of modelPricingTable.keys()) {
    if (modelId.startsWith(modelIdPrefix) && modelIdPrefix.length > (longestMatchingPrefix?.length ?? 0)) {
      longestMatchingPrefix = modelIdPrefix;
    }
  }
  return longestMatchingPrefix === null ? null : modelPricingTable.get(longestMatchingPrefix)!;
}

export function estimateMessageCostUsd(modelTokenPrices: ModelTokenPrices, tokenUsage: MessageTokenUsage): number {
  const costPerMillionTokens =
    tokenUsage.inputTokens * modelTokenPrices.input +
    tokenUsage.outputTokens * modelTokenPrices.output +
    tokenUsage.cacheCreation5mInputTokens * modelTokenPrices.cacheWrite5m +
    tokenUsage.cacheCreation1hInputTokens * modelTokenPrices.cacheWrite1h +
    tokenUsage.cacheReadInputTokens * modelTokenPrices.cacheRead;
  return costPerMillionTokens / 1_000_000;
}

/**
 * Reads the `usage` object of a Messages API response. When the response has no per-TTL breakdown,
 * all cache-creation tokens count as 5-minute cache writes.
 */
export function readMessageTokenUsage(usage: unknown): MessageTokenUsage | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const usageFields = usage as Record<string, unknown>;
  const readCount = (fieldValue: unknown): number => (typeof fieldValue === 'number' ? fieldValue : 0);
  const cacheCreationBreakdown = usageFields.cache_creation as Record<string, unknown> | undefined;
  const cacheCreation1hInputTokens = readCount(cacheCreationBreakdown?.ephemeral_1h_input_tokens);
  const cacheCreation5mInputTokens = cacheCreationBreakdown
    ? readCount(cacheCreationBreakdown.ephemeral_5m_input_tokens)
    : readCount(usageFields.cache_creation_input_tokens);
  return {
    inputTokens: readCount(usageFields.input_tokens),
    outputTokens: readCount(usageFields.output_tokens),
    cacheCreation5mInputTokens,
    cacheCreation1hInputTokens,
    cacheReadInputTokens: readCount(usageFields.cache_read_input_tokens),
  };
}
