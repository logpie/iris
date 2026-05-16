const CATEGORY_DATA_PREFIX =
  /\b(labels?|notes?|topics?|headings?|headers?|stages?|steps?|items?|queries?|search queries?|terms?|names?|titles?|decisions?|outcomes?|captions?|annotations?|invite\s+contexts?|flow|arrow flow|inputs?|data|values?)\b/i;

const INSTRUCTION_PREFIX =
  /^(use|prefer|open|click|choose|select|change|duplicate|undo|redo|delete|remove|attempt|reach|complete|confirm|verify|inspect|start|perform|apply|create|make|draw|place|add|type|enter|follow|trigger|upload|import|embed|export|download|share|sign)\b/i;

const GENERIC_VISIBLE_DATA =
  /\b(example|sample|test|demo|todo|item|task|note|text|content|reference|current board|current artifact|current document)\b/i;

/**
 * Extract user-visible literal data from scenario test data.
 *
 * Discovery models often return a mix of real labels and procedural guidance:
 * "Rectangle labels: Backlog, In Review, Released" is literal scenario data,
 * while "Use the current board created in J1" is an instruction. Keeping this
 * distinction centralized prevents the Explorer from typing instructions into
 * products and prevents the Judge validator from requiring invisible prose.
 */
export function scenarioVisibleDataTokens(items: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of items ?? []) {
    const item = stripOuterPunctuation(raw.trim());
    if (!item) continue;
    if (isOptionalScenarioLine(item)) continue;

    const quoted = quotedPhrases(item);
    if (quoted.length > 0) {
      out.push(...quoted);
      continue;
    }

    const categoryValues = categoryDataValues(item);
    if (categoryValues.length > 0) {
      out.push(...categoryValues);
      continue;
    }

    const labeledValues = labeledObjectValues(item);
    if (labeledValues.length > 0) {
      out.push(...labeledValues);
      continue;
    }

    if (isNonLiteralScenarioLine(item)) continue;
    if (INSTRUCTION_PREFIX.test(item)) continue;
    if (isGenericVisibleData(item)) continue;
    out.push(item);
  }
  return uniqueStrings(out.filter((value) => !isGenericVisibleData(value)));
}

export function scenarioProofVisibleTextTokens(items: readonly string[] | undefined): string[] {
  return scenarioVisibleDataTokens(items).filter(isScenarioProofVisibleTextToken);
}

export function scenarioInstructionHints(items: readonly string[] | undefined): string[] {
  const visible = new Set(scenarioVisibleDataTokens(items).map(normalize));
  const out: string[] = [];
  for (const raw of items ?? []) {
    const item = stripOuterPunctuation(raw.trim());
    if (!item || isOptionalScenarioLine(item)) continue;
    const itemTokens = scenarioVisibleDataTokens([item]).map(normalize);
    if (itemTokens.length > 0 && itemTokens.every((token) => visible.has(token))) continue;
    out.push(item);
  }
  return uniqueStrings(out);
}

function categoryDataValues(item: string): string[] {
  if (/^(?:arrow|connector|line)\s+(?:connections?|between|from)\b/i.test(item)) return [];
  const connecting = item.match(
    /^(?:arrow|connector|line)\s+connecting\s+(.+?)\s+(?:to|and)\s+(.+)$/i,
  );
  if (connecting?.[1] && connecting[2]) {
    return splitVisibleDataList(`${connecting[1]}, ${connecting[2]}`, { filterInstruction: false });
  }
  const colon = item.indexOf(':');
  if (colon >= 0 && colon <= 48) {
    const prefix = item.slice(0, colon).trim();
    const rest = item.slice(colon + 1).trim();
    if (isNonLiteralScenarioPrefix(prefix)) return [];
    if (/\b(?:connector|connection|arrow|line)\s+meaning\b/i.test(prefix)) {
      const endpoints = rest.match(/\bfrom\s+(.+?)\s+to\s+(.+)$/i);
      if (endpoints?.[1] && endpoints[2]) {
        return splitVisibleDataList(`${endpoints[1]}, ${endpoints[2]}`, {
          filterInstruction: false,
        });
      }
      return [];
    }
    if (CATEGORY_DATA_PREFIX.test(prefix)) {
      return splitVisibleDataList(rest, { filterInstruction: false });
    }
  }
  if (item.includes('->')) return splitVisibleDataList(item, { filterInstruction: false });
  return [];
}

function labeledObjectValues(item: string): string[] {
  const match = item.match(/\b(?:labels?|labelled|labeled|named|titled)\s+(.+)$/i);
  if (!match?.[1]) return [];
  return splitVisibleDataList(match[1], { filterInstruction: false });
}

function splitVisibleDataList(
  value: string,
  opts: { filterInstruction?: boolean } = {},
): string[] {
  const filterInstruction = opts.filterInstruction ?? true;
  return value
    .split(/\s*(?:,|;|->|→|\/|\band\b)\s*/i)
    .map((part) => stripOuterPunctuation(part.trim()))
    .filter((part) => part.length >= 2)
    .filter((part) => !/\bor\b/i.test(part))
    .filter((part) => !filterInstruction || !INSTRUCTION_PREFIX.test(part))
    .filter((part) => !isGenericVisibleData(part));
}

function quotedPhrases(item: string): string[] {
  const phrases: string[] = [];
  const quotePattern = /["'“”‘’]([^"'“”‘’]{2,80})["'“”‘’]/g;
  let match = quotePattern.exec(item);
  while (match !== null) {
    if (match[1]) phrases.push(stripOuterPunctuation(match[1].trim()));
    match = quotePattern.exec(item);
  }
  return phrases;
}

function isOptionalScenarioLine(item: string): boolean {
  return /^optional\b/i.test(item);
}

function isNonLiteralScenarioLine(item: string): boolean {
  const colon = item.indexOf(':');
  const prefix = colon >= 0 && colon <= 48 ? item.slice(0, colon).trim() : item;
  return isNonLiteralScenarioPrefix(prefix);
}

function isNonLiteralScenarioPrefix(prefix: string): boolean {
  return (
    /\b(?:target|available)\s+surfaces?\b/i.test(prefix) ||
    /\b(?:connector|connection|arrow|line)\s+meaning\b/i.test(prefix) ||
    /\b(?:media\s+)?file\s*name\b.*\b(?:upload|available)\b/i.test(prefix) ||
    /\bmedia\s+filename\b/i.test(prefix)
  );
}

function isGenericVisibleData(item: string): boolean {
  const normalized = normalize(item);
  return (
    normalized.length < 2 ||
    GENERIC_VISIBLE_DATA.test(normalized) ||
    /\b(anonymous|visitor|auth|login|share|current)\b.*\bstate\b/.test(normalized) ||
    /^(arrow|connector|line)\s+(connections?|between|from)\b/.test(normalized) ||
    /\bor\b/.test(normalized)
  );
}

function isScenarioProofVisibleTextToken(item: string): boolean {
  const normalized = normalize(item);
  return (
    normalized.length >= 3 &&
    !isGenericVisibleData(normalized) &&
    !/\b(visible|visibly|non[- ]default|similar|shape|arrow|connector|media|image|embed|card|placeholder|object|dialog|download event|saved file|file evidence|generated[- ]file|artifact|state|styled|emphasized|color|fill|boundary|surface|prompt)\b/.test(
      normalized,
    )
  );
}

function stripOuterPunctuation(value: string): string {
  return value.replace(/^[\s"'“”‘’()[\]{}]+|[\s"'“”‘’()[\]{}.,;]+$/g, '');
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}
