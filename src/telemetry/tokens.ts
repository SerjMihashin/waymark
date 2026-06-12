export interface TokenUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  hubLlmInputTokens?: number | null;
  hubLlmOutputTokens?: number | null;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;

  const bytes = Buffer.byteLength(text, 'utf8');
  return Math.max(1, Math.ceil(bytes / 4));
}

export function totalModelTokens(usage: TokenUsage): number | null {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.hubLlmInputTokens ?? 0,
    usage.hubLlmOutputTokens ?? 0,
  ];

  if (usage.inputTokens == null && usage.outputTokens == null) {
    return null;
  }

  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
