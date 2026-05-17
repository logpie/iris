const CATEGORY_DATA_PREFIX =
  /\b(labels?|notes?|topics?|headings?|headers?|stages?|steps?|items?|products?|queries?|search|search queries?|global search queries?|terms?|names?|titles?|usernames?|passwords?|decisions?|outcomes?|captions?|annotations?|invite\s+contexts?|flow|arrow flow|inputs?|data|values?|sort columns?|length selector values?|code tabs?|snippets?|dependencies?|navigation topics?|representative destinations?|sections?|pdf links?)\b/i;

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

    const exampleValues = exampleVisibleDataValues(item);
    if (exampleValues.length > 0) {
      out.push(...exampleValues);
      continue;
    }

    const equivalentValues = equivalentVisibleDataValues(item);
    if (equivalentValues.length > 0) {
      out.push(...equivalentValues);
      continue;
    }

    const submittedValues = submittedVisibleDataValues(item);
    if (submittedValues.length > 0) {
      out.push(...submittedValues);
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
  const out: string[] = [];
  for (const raw of items ?? []) {
    const item = stripOuterPunctuation(raw.trim());
    if (!item || isOptionalScenarioLine(item)) continue;
    if (isProofInputMetadataLine(item)) continue;

    const derived = derivedProofVisibleValues(item);
    if (derived.length > 0) {
      out.push(...derived);
      continue;
    }

    out.push(...scenarioVisibleDataTokens([item]));
  }
  return uniqueStrings(out.filter(isScenarioProofVisibleTextToken));
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

function exampleVisibleDataValues(item: string): string[] {
  const match = item.match(/\b(?:such as|for example|e\.g\.)\s+(.+)$/i);
  if (!match?.[1]) return [];
  return splitVisibleDataList(match[1], { filterInstruction: false });
}

function equivalentVisibleDataValues(item: string): string[] {
  const match = item.match(/^(.+?)\s+or equivalent\b/i);
  if (!match?.[1]) return [];
  return splitVisibleDataList(match[1], { filterInstruction: false });
}

function submittedVisibleDataValues(item: string): string[] {
  const submitted = item.match(
    /^([A-Za-z0-9_.@-]{3,})\s+(?:(?:credentials?|value|code)\s+)?submitted$/i,
  );
  if (submitted?.[1]) return [submitted[1]];
  const usedAsInput = item.match(
    /^([A-Za-z0-9_.@-]{3,})\s+(?:was\s+)?(?:used\s+as\s+)?(?:(?:password|username|user)\s+)?input$/i,
  );
  if (usedAsInput?.[1]) return [usedAsInput[1]];
  const enteredBeforeSubmit = item.match(
    /^([A-Za-z0-9_.@-]{3,})\s+was\s+entered\s+before\s+submit$/i,
  );
  if (enteredBeforeSubmit?.[1]) return [enteredBeforeSubmit[1]];
  const usedValue = item.match(/^([A-Za-z0-9_.@-]{3,})\s+was\s+used$/i);
  if (usedValue?.[1]) return [usedValue[1]];
  const credentialUsed = item.match(
    /^([A-Za-z0-9_.@-]{3,})\s+(?:(?:credentials?|username|password)\s+)?(?:was|were)\s+used$/i,
  );
  if (credentialUsed?.[1]) return [credentialUsed[1]];
  return [];
}

function derivedProofVisibleValues(item: string): string[] {
  const normalized = normalize(item);
  if (/\bauthenticated\b.*\b(product|products|inventory|catalog)\b.*\b(visible|content|area|page)\b/.test(normalized)) {
    return ['Products'];
  }
  const visiblePrefix = item.match(
    /^(.+?)\s+(?:is\s+|are\s+)?(?:visible|shown|present|appears?|loaded|displayed)\b/i,
  );
  if (visiblePrefix?.[1]) {
    return splitVisibleDataList(visiblePrefix[1], { filterInstruction: false });
  }
  return [];
}

function isProofInputMetadataLine(item: string): boolean {
  const normalized = normalize(item);
  const colon = item.indexOf(':');
  if (colon >= 0 && colon <= 48) {
    const prefix = normalize(item.slice(0, colon));
    if (/^(user ?name|password|credential|input|age|gender|height|weight)$/.test(prefix)) return true;
  }
  return (
    /^([a-z0-9_.@-]{3,})\s+(?:(?:credentials?|value|code)\s+)?submitted$/i.test(item) ||
    /^([a-z0-9_.@-]{3,})\s+(?:was\s+)?(?:used|entered)\b/i.test(item) ||
    /\bcredentials?\s+(submitted|used|entered)\b/.test(normalized)
  );
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
    /\b(submitted|submission|fields?|credentials?|confirmation message|message|line items?|view)\b/.test(
      normalized,
    ) ||
    /\b(error|validation|feedback)\s+(message|feedback)\s+(visible|appears?|shown)\b/.test(
      normalized,
    ) ||
    /\b(login|sign[- ]?in|auth|authenticated|unauthenticated|post[- ]login)\b.*\b(page|form|state|session|destination|content|access)\b/.test(
      normalized,
    ) ||
    /\boriginal\b.*\blogin\b.*\bform\b.*\bnot\b.*\bonly\b.*\bvisible\b.*\bstate\b/.test(
      normalized,
    ) ||
    /\b(login action|submit action|action)\b.*\b(submitted|performed|clicked)\b/.test(
      normalized,
    ) ||
    /\b(login|submit)\s+button\b.*\b(submitted|clicked|pressed)\b/.test(normalized) ||
    /\b(no|not|without|absent|absence|no longer)\b.*\b(visible|reached|present|available|content|page|access)\b/.test(
      normalized,
    ) ||
    /\b(no|not|without|absent|absence)\b.*\b(error|alert|warning|blocking|blocked|failure)\b/.test(
      normalized,
    ) ||
    /\b(error|alert|warning|blocking|blocked|failure)\b.*\b(absent|absence|not present|not visible|no longer visible)\b/.test(
      normalized,
    ) ||
    /\b(post[- ]action evidence|product outcome|required by this capability|concrete user[- ]visible outcome)\b/.test(
      normalized,
    ) ||
    /\b(page|form|destination|app content|content)\b.*\b(visible|available|reached|loaded|blocks access|no longer blocks)\b/.test(
      normalized,
    ) ||
    /\b(multiple|at least one|one or more)\b.*\b(visible|accessible|controls?|cards?|prices?|rows?)\b/.test(
      normalized,
    ) ||
    /\b(cards?|controls?|buttons?|fields?|rows?|prices?)\b.*\b(visible|accessible|remain|present)\b/.test(
      normalized,
    ) ||
    /\bor\b/.test(normalized)
  );
}

function isScenarioProofVisibleTextToken(item: string): boolean {
  const normalized = normalize(item);
  return (
    normalized.length >= 3 &&
    !isGenericVisibleData(normalized) &&
    !/^\d+\s+entries\s+per\s+page$/.test(normalized) &&
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
