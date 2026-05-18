const CATEGORY_DATA_PREFIX =
  /\b(labels?|notes?|topics?|headings?|headers?|stages?|steps?|items?|products?|queries?|search|search queries?|global search queries?|terms?|names?|titles?|usernames?|passwords?|decisions?|outcomes?|captions?|annotations?|invite\s+contexts?|flow|arrow flow|inputs?|data|values?|sort columns?|length selector values?|code tabs?|snippets?|dependencies?|navigation topics?|representative destinations?|sections?|pdf links?)\b/i;

const INSTRUCTION_PREFIX =
  /^(use|prefer|open|click|choose|select|change|duplicate|undo|redo|delete|remove|attempt|reach|complete|confirm|verify|inspect|start|perform|apply|create|make|draw|place|add|type|enter|follow|trigger|upload|import|embed|export|download|share|sign)\b/i;

const GENERIC_VISIBLE_DATA =
  /\b(example|sample|test|demo|todo|item|task|note|text|content|reference|current board|current artifact|current document)\b/i;

export interface ProductUseJobMatchLike {
  id?: string | undefined;
  title?: string | undefined;
  journey_id?: string | undefined;
  scenario_brief?: string | undefined;
  test_data?: readonly string[] | undefined;
  required_actions?: readonly string[] | undefined;
  proof_obligations?: readonly string[] | undefined;
  expected_artifact?: string | undefined;
  required_outputs?: readonly string[] | undefined;
  quality_bar?: readonly string[] | undefined;
}

export interface ProductUseGoalMatchLike {
  id?: string | undefined;
  description?: string | undefined;
  journey_id?: string | undefined;
}

export function selectProductUseJobForGoal<T extends ProductUseJobMatchLike>(
  jobs: readonly T[] | undefined,
  goal: ProductUseGoalMatchLike,
  options: { fallbackIndex?: number; allowAmbiguousFallback?: boolean } = {},
): T | undefined {
  const allJobs = jobs ?? [];
  if (allJobs.length === 0) return undefined;
  const scopedJobs = goal.journey_id
    ? allJobs.filter((job) => job.journey_id === goal.journey_id)
    : [];
  const candidates = scopedJobs.length > 0 ? scopedJobs : allJobs;
  if (candidates.length === 1) return candidates[0];
  const fallback = options.fallbackIndex === undefined ? undefined : allJobs[options.fallbackIndex];
  const fallbackIsCandidate = fallback ? candidates.includes(fallback) : false;
  const goalText = `${goal.id ?? ''} ${goal.description ?? ''}`;
  const scored = candidates
    .map((job) => ({ job, score: productUseJobGoalMatchScore(job, goalText) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (best && best.score > 0 && (!second || second.score < best.score)) {
    return best.job;
  }
  if (!options.allowAmbiguousFallback) return undefined;
  return fallbackIsCandidate ? fallback : candidates[0];
}

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
    const trimmed = raw.trim();
    const item = stripOuterPunctuation(trimmed);
    if (!item || isOptionalScenarioLine(item)) continue;
    if (isProofInputMetadataLine(item)) continue;

    const codeLikeOutput = codeLikeProofVisibleOutput(trimmed) ?? codeLikeProofVisibleOutput(item);
    if (codeLikeOutput) {
      out.push(codeLikeOutput);
      continue;
    }

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

export function scenarioEvidenceSatisfiesToken(
  observedText: string,
  required: string,
  structuralText = '',
): boolean {
  const needle = normalizeEvidenceText(required);
  if (!needle) return true;
  const observed = normalizeEvidenceText(observedText);
  if (containsVisiblePhrase(observed, needle)) return true;
  const structuralObserved = structuralText || observedText;
  if (activeTabRequirementSatisfied(structuralObserved, required)) return true;
  if (numericRequirementSatisfied(observedText, required)) return true;
  if (bmiCategoryRequirementSatisfied(observedText, required)) return true;
  return false;
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
  const currencyValues = Array.from(item.matchAll(/\$[\d,]+(?:\.\d+)?/g)).map((match) => match[0]);
  if (currencyValues.length > 0) return currencyValues;
  if (
    /\bauthenticated\b.*\b(product|products|inventory|catalog)\b.*\b(visible|content|area|page)\b/.test(
      normalized,
    )
  ) {
    return ['Products'];
  }
  const visiblePrefix = item.match(
    /^(.+?)\s+(?:is\s+|are\s+)?(?:visible|shown|present|appears?|loaded|displayed)\b/i,
  );
  if (visiblePrefix?.[1]) {
    const prefix = visiblePrefix[1].trim();
    if (isAbstractVisibleProofPrefix(prefix)) return [];
    return splitVisibleDataList(prefix, { filterInstruction: false }).map((value) =>
      value.replace(/\s+rows?$/i, '').trim(),
    );
  }
  return [];
}

function isAbstractVisibleProofPrefix(prefix: string): boolean {
  const normalized = normalize(prefix);
  return (
    /\b(changed|updated|reordered|sorted|ordered|different|default|compared)\b/.test(normalized) &&
    /\b(first|rows?|row order|state|result|outcome|employee)\b/.test(normalized)
  );
}

function codeLikeProofVisibleOutput(raw: string): string | null {
  const item = stripOuterWrappingPunctuation(raw.trim());
  if (!item) return null;
  const colon = item.indexOf(':');
  if (colon >= 0 && colon <= 48) {
    const prefix = item.slice(0, colon).trim();
    const rest = stripOuterWrappingPunctuation(item.slice(colon + 1).trim());
    if (
      isCodeLikeVisibleOutput(rest) &&
      (CATEGORY_DATA_PREFIX.test(prefix) || !INSTRUCTION_PREFIX.test(prefix))
    ) {
      return rest;
    }
  }
  return isCodeLikeVisibleOutput(item) ? item : null;
}

function isCodeLikeVisibleOutput(value: string): boolean {
  return /\b[A-Za-z_$][\w$]*\s*\([^)]*\)\s*;?$/.test(value);
}

function isProofInputMetadataLine(item: string): boolean {
  const normalized = normalize(item);
  const colon = item.indexOf(':');
  if (colon >= 0 && colon <= 48) {
    const prefix = normalize(item.slice(0, colon));
    if (/^(user ?name|password|credential|input|age|gender|height|weight)$/.test(prefix))
      return true;
  }
  return (
    /^([a-z0-9_.@-]{3,})\s+(?:(?:credentials?|value|code)\s+)?submitted$/i.test(item) ||
    /^([a-z0-9_.@-]{3,})\s+(?:was\s+)?(?:used|entered)\b/i.test(item) ||
    /\bcredentials?\s+(submitted|used|entered)\b/.test(normalized)
  );
}

function splitVisibleDataList(value: string, opts: { filterInstruction?: boolean } = {}): string[] {
  const filterInstruction = opts.filterInstruction ?? true;
  const protectedValue = value.replace(/(\d),(?=\d{3}\b)/g, '$1§');
  return protectedValue
    .split(/\s*(?:,|;|->|→|\/|\band\b)\s*/i)
    .map((part) => simplifyVisibleDataPart(stripOuterPunctuation(part.replace(/§/g, ',').trim())))
    .filter((part) => part.length >= 2)
    .filter((part) => !/\bor\b/i.test(part))
    .filter((part) => !filterInstruction || !INSTRUCTION_PREFIX.test(part))
    .filter((part) => !isGenericVisibleData(part));
}

function simplifyVisibleDataPart(part: string): string {
  const currency = part.match(/\$[\d,]+(?:\.\d+)?/);
  if (currency?.[0]) return currency[0];
  const office = part.match(/^Office\s+([A-Za-z][A-Za-z -]*?)(?:\s+in)?$/i);
  if (office?.[1]) return office[1].trim();
  return part;
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
    /\b(login action|submit action|action)\b.*\b(submitted|performed|clicked)\b/.test(normalized) ||
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
    /\b(active sort indicator|sort indicator|proves the active order|no longer proves|near the top when descending)\b/.test(
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
    /\b(rows?|row order|employee rows?|columns?|ages?)\b.*\b(reordered|sorted|ordered|changed|updated|consistent|monotonic)\b/.test(
      normalized,
    ) ||
    /\b(reordered|sorted|ordered|changed|updated|consistent|monotonic)\b.*\b(rows?|row order|employee rows?|columns?|ages?)\b/.test(
      normalized,
    ) ||
    /\bor\b/.test(normalized)
  );
}

function isScenarioProofVisibleTextToken(item: string): boolean {
  if (isCodeLikeVisibleOutput(item)) return true;
  const normalized = normalize(item);
  const shortNumericOutput = /^\d{2,}$/.test(normalized);
  return (
    (normalized.length >= 3 || shortNumericOutput) &&
    !isGenericVisibleData(normalized) &&
    !/^\d+\s+entries\s+per\s+page$/.test(normalized) &&
    !/\b(visible|visibly|non[- ]default|similar|shape|arrow|connector|media|image|embed|card|placeholder|object|dialog|download event|saved file|file evidence|generated[- ]file|artifact|state|styled|emphasized|color|fill|boundary|surface|prompt)\b/.test(
      normalized,
    )
  );
}

function containsVisiblePhrase(observed: string, required: string): boolean {
  let index = observed.indexOf(required);
  while (index >= 0) {
    const before = index > 0 ? observed.charAt(index - 1) : '';
    const afterIndex = index + required.length;
    const after = afterIndex < observed.length ? observed.charAt(afterIndex) : '';
    if (!isTokenChar(before) && !isTokenChar(after)) return true;
    index = observed.indexOf(required, index + 1);
  }
  return false;
}

function numericRequirementSatisfied(observedText: string, required: string): boolean {
  const requiredNorm = normalizeEvidenceText(required);
  if (!/\b(near|around|about|approx|approximately|~)\b/.test(requiredNorm)) return false;
  if (!/\bbmi\b/.test(requiredNorm)) return false;
  const expected = extractDecimalNumbers(required).filter((value) => value >= 3);
  if (expected.length === 0) return false;
  const observedRaw = normalizeRawEvidenceText(observedText);
  const expectedCategories = bmiCategories(required);
  for (const value of expected) {
    const numericOk = observedNumberNearLabel(observedRaw, value, /\bbmi\b/);
    if (!numericOk) return false;
  }
  if (expectedCategories.length === 0) return true;
  return expectedCategories.every((category) => bmiCategoryAppearsInResult(observedRaw, category));
}

function activeTabRequirementSatisfied(observedText: string, required: string): boolean {
  const requiredNorm = normalizeEvidenceText(required);
  const match = requiredNorm.match(/\b(us|metric|other)\s+units?\s+tab\s+active\b/);
  if (!match?.[1]) return false;
  const unit = match[1];
  const observed = normalizeRawEvidenceText(observedText);
  if (unit === 'metric') {
    return (
      /\bctype=metric\b/.test(observed) ||
      /\bmetric units\b.{0,80}\b(menuon|active|selected|current|aria selected true)\b/.test(
        observed,
      )
    );
  }
  if (unit === 'other') {
    return (
      /\bctype=other\b/.test(observed) ||
      /\bother units\b.{0,80}\b(menuon|active|selected|current|aria selected true)\b/.test(observed)
    );
  }
  return (
    /\bctype=(us|standard)\b/.test(observed) ||
    /\bus units\b.{0,80}\b(menuon|active|selected|current|aria selected true)\b/.test(observed)
  );
}

function bmiCategoryRequirementSatisfied(observedText: string, required: string): boolean {
  const requiredCategories = bmiCategories(required);
  if (requiredCategories.length === 0) return false;
  const requiredNorm = normalizeEvidenceText(required);
  if (!/\bbmi\b|\bcategory\b|\bclassification\b/.test(requiredNorm)) return false;
  const observed = normalizeRawEvidenceText(observedText);
  return requiredCategories.every((category) => bmiCategoryAppearsInResult(observed, category));
}

function bmiCategories(text: string): string[] {
  const normalized = normalizeEvidenceText(text);
  const categories: string[] = [];
  if (/\bunderweight\b/.test(normalized)) categories.push('underweight');
  if (/\boverweight\b/.test(normalized)) categories.push('overweight');
  if (/\bobese|obesity\b/.test(normalized)) categories.push('obese');
  if (/\bnormal\b/.test(normalized)) categories.push('normal');
  return uniqueStrings(categories);
}

function bmiCategoryAppearsInResult(observed: string, category: string): boolean {
  const resultWindows = bmiResultWindows(observed);
  if (resultWindows.length === 0) return false;
  return resultWindows.some((window) => {
    if (category === 'obese') return /\bobese|obesity\b/.test(window);
    return new RegExp(`\\b${category}\\b`).test(window);
  });
}

function bmiResultWindows(observed: string): string[] {
  const windows: string[] = [];
  const resultPattern = /\bbmi\s*(?:=|:)?\s*\d+(?:\.\d+)?/g;
  let match = resultPattern.exec(observed);
  while (match !== null) {
    windows.push(observed.slice(match.index, Math.min(observed.length, match.index + 180)));
    match = resultPattern.exec(observed);
  }
  return windows;
}

function observedNumberNearLabel(observed: string, expected: number, label?: RegExp): boolean {
  for (const match of observed.matchAll(/(?<![a-z])\d+(?:\.\d+)?(?![a-z])/g)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const actual = Number(raw);
    if (!Number.isFinite(actual)) continue;
    const tolerance = expected >= 20 ? 0.25 : 0.05;
    if (Math.abs(actual - expected) > tolerance) continue;
    if (!label) return true;
    const context = observed.slice(Math.max(0, index - 80), Math.min(observed.length, index + 80));
    if (label.test(context)) return true;
  }
  return false;
}

function extractDecimalNumbers(text: string): number[] {
  return Array.from(normalizeRawEvidenceText(text).matchAll(/(?<![a-z])\d+(?:\.\d+)?(?![a-z])/g))
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
}

function normalizeEvidenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRawEvidenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[“”‘’]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTokenChar(value: string): boolean {
  return /^[a-z0-9]$/i.test(value);
}

function stripOuterPunctuation(value: string): string {
  return value.replace(/^[\s"'“”‘’()[\]{}]+|[\s"'“”‘’()[\]{}.,;]+$/g, '');
}

function stripOuterWrappingPunctuation(value: string): string {
  return value.replace(/^[\s"'“”‘’]+|[\s"'“”‘’.,]+$/g, '');
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

function productUseJobGoalMatchScore(job: ProductUseJobMatchLike, goalText: string): number {
  const normalizedGoal = normalizeJobMatchText(goalText);
  if (!normalizedGoal) return 0;
  let score = 0;
  const id = normalizeJobMatchText(job.id ?? '');
  if (id && tokenSetForJobMatch(normalizedGoal).has(id)) score += 40;
  const title = normalizeJobMatchText(job.title ?? '');
  const scenario = normalizeJobMatchText(job.scenario_brief ?? '');
  const artifact = normalizeJobMatchText(job.expected_artifact ?? '');
  if (title && normalizedGoal.includes(title)) score += 25;
  if (scenario && normalizedGoal.includes(scenario)) score += 25;
  if (artifact && normalizedGoal.includes(artifact)) score += 8;

  const goalTokens = tokenSetForJobMatch(normalizedGoal);
  for (const token of productUseJobWeightedMatchTokens(job)) {
    if (!goalTokens.has(token.token)) continue;
    score += token.weight;
  }
  return score;
}

function productUseJobWeightedMatchTokens(
  job: ProductUseJobMatchLike,
): Array<{ token: string; weight: number }> {
  const weighted = new Map<string, number>();
  const add = (text: string | undefined, weight: number) => {
    for (const token of tokenSetForJobMatch(text ?? '')) {
      weighted.set(token, Math.max(weighted.get(token) ?? 0, weight));
    }
  };
  add(job.id, 12);
  add(job.title, 6);
  add(job.scenario_brief, 5);
  add(job.expected_artifact, 4);
  for (const text of job.required_actions ?? []) add(text, 4);
  for (const text of job.required_outputs ?? []) add(text, 4);
  for (const text of job.test_data ?? []) add(text, 3);
  for (const text of job.proof_obligations ?? []) add(text, 3);
  for (const text of job.quality_bar ?? []) add(text, 2);
  return Array.from(weighted, ([token, weight]) => ({ token, weight }));
}

function tokenSetForJobMatch(text: string): Set<string> {
  const stop = new Set([
    'and',
    'the',
    'for',
    'from',
    'with',
    'that',
    'this',
    'page',
    'open',
    'verify',
    'loads',
    'load',
    'works',
    'use',
    'using',
    'check',
    'confirm',
    'visible',
    'result',
    'results',
    'required',
    'scenario',
    'table',
    'grid',
    'employee',
    'employees',
    'control',
    'controls',
    'state',
    'data',
    'rows',
    'row',
    'field',
    'content',
    'value',
    'values',
  ]);
  return new Set(
    normalizeJobMatchText(text)
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 2 && !stop.has(token)),
  );
}

function normalizeJobMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
