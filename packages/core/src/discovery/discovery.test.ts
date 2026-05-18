import { describe, expect, it } from 'vitest';
import {
  deriveDiscoveryCapabilitiesForReport,
  formatDiscoveryExplorerContext,
  runDiscovery,
} from './discovery.js';
import { DISCOVERY_SYSTEM } from './prompts.js';

describe('DISCOVERY_SYSTEM', () => {
  it('asks artifact editors for named, inspectable primary artifacts', () => {
    expect(DISCOVERY_SYSTEM).toContain('named, inspectable artifact');
    expect(DISCOVERY_SYSTEM).toContain('draw/place + label/type + style/move/resize');
    expect(DISCOVERY_SYSTEM).toContain('single trivial object');
    expect(DISCOVERY_SYSTEM).toContain('value_loops');
    expect(DISCOVERY_SYSTEM).toContain('proof_obligations');
    expect(DISCOVERY_SYSTEM).toContain('scenario_brief');
    expect(DISCOVERY_SYSTEM).toContain('test_data');
    expect(DISCOVERY_SYSTEM).toContain('required_outputs');
    expect(DISCOVERY_SYSTEM).toContain('quality_bar');
    expect(DISCOVERY_SYSTEM).toContain('"toolbar"');
  });

  it('asks discovery to synthesize material scenarios instead of surface goals', () => {
    expect(DISCOVERY_SYSTEM).toContain('scenario-native testing plan');
    expect(DISCOVERY_SYSTEM).toContain('A journey is a broad user workflow area');
    expect(DISCOVERY_SYSTEM).toContain('A scenario is the executable user story');
    expect(DISCOVERY_SYSTEM).toContain('surfaces are not automatically goals');
    expect(DISCOVERY_SYSTEM).toContain('Journey records group related scenarios');
    expect(DISCOVERY_SYSTEM).toContain('goal_class');
    expect(DISCOVERY_SYSTEM).toContain('Only "core" and selected "secondary_workflow"');
    expect(DISCOVERY_SYSTEM).toContain('A word editor should type a real paragraph');
    expect(DISCOVERY_SYSTEM).toContain('normally perform as setup before a material goal');
    expect(DISCOVERY_SYSTEM).toContain('one coherent state transition');
    expect(DISCOVERY_SYSTEM).toContain('support/reference coverage crowd out primary');
  });
});

describe('formatDiscoveryExplorerContext', () => {
  it('puts discovery out-of-scope constraints in a high-priority do-not-do section', () => {
    const context = formatDiscoveryExplorerContext({
      v: 2,
      target_kind_hint: 'web',
      product_description: 'A checkout demo.',
      goals: [],
      surfaces: [],
      journeys: [],
      capabilities: [],
      focus_areas: [],
      hints: [],
      out_of_scope: ['Do not submit real payment.'],
    });

    expect(context).toContain('OUT OF SCOPE / DO NOT DO:');
    expect(context).toContain('- Do not submit real payment.');
  });

  it('preserves selected user-job acceptance fields before lower-priority inventory', () => {
    const context = formatDiscoveryExplorerContext({
      v: 2,
      target_kind_hint: 'web',
      product_description: 'A planning board.',
      product_use_contract: {
        product_kinds: ['canvas_editor'],
        primary_value_loop: 'Create a realistic board.',
        core_artifacts: ['board artifact'],
        value_loops: [],
        user_jobs: Array.from({ length: 9 }, (_, index) => ({
          id: `PU${index + 1}`,
          title: `Job ${index + 1}`,
          journey_id: `J${index + 1}`,
          scenario_brief: `Scenario ${index + 1}`,
          required_actions: [],
          proof_obligations: [],
          expected_artifact: 'visible outcome',
          acceptable_evidence: [],
          test_data:
            index === 8 ? ['Column labels: Backlog, In Review, Released'] : [`Data ${index + 1}`],
          required_outputs:
            index === 8 ? ['Backlog', 'In Review', 'Released'] : [`Output ${index + 1}`],
          quality_bar: index === 8 ? ['Represents a realistic workflow'] : [`Quality ${index + 1}`],
          weak_evidence: index === 8 ? ['toolbar selected only'] : [`Weak evidence ${index + 1}`],
          risk: 'medium' as const,
        })),
      },
      goals: [],
      surfaces: Array.from({ length: 40 }, (_, index) => ({
        id: `S${index + 1}`,
        label: `Lower priority surface ${index + 1} ${'x'.repeat(240)}`,
        kind: 'content' as const,
        url: 'https://example.test',
        source: 'initial' as const,
        value: 'peripheral' as const,
        confidence: 0.5,
        evidence: [],
        controls: [],
        prerequisites: [],
      })),
      journeys: [],
      capabilities: [
        {
          id: 'C1',
          label: `Lower priority capability ${'x'.repeat(240)}`,
          product_kind: 'canvas_editor',
          importance: 'secondary',
          status: 'discovered',
          confidence: 0.5,
          source: 'model',
          evidence: [],
          scenario_ids: [],
          journey_ids: [],
          surface_ids: [],
          denominator_reason: '',
          coverage_gap: '',
        },
      ],
      coverage_plan: {
        selected_journey_ids: ['J9'],
        deferred_surface_ids: [],
        rationale: 'Prefer the selected scenario.',
        coverage_risk: 'medium',
      },
      focus_areas: [],
      hints: [],
      out_of_scope: [],
    });

    expect(context).toContain('- PU9 (J9): Job 9');
    expect(context).toContain('exact visible content/data to use: Backlog; In Review; Released');
    expect(context).toContain('required visible outputs: Backlog; In Review; Released');
    expect(context).toContain('quality bar: Represents a realistic workflow');
    expect(context).toContain('weak evidence that must NOT verify: toolbar selected only');
  });
});

describe('runDiscovery', () => {
  it('parses a well-formed discoverer response', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'Example Domain',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 1,
          target_kind_hint: 'web',
          product_description: 'Placeholder example page.',
          goals: [
            { id: 'G1', description: 'Read the description', priority: 'must' },
            { id: 'G2', description: 'Click the More info link', priority: 'should' },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0.05,
      }),
    });
    expect(result).not.toBeNull();
    expect(result?.output.v).toBe(1);
    expect(result?.output.surfaces).toHaveLength(0);
    expect(result?.output.journeys).toHaveLength(0);
    expect(result?.output.goals).toHaveLength(2);
    expect(result?.cost_usd).toBeCloseTo(0.05);
  });

  it('returns null on unparseable response (caller falls back to free mode)', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: '...',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({ text: 'sorry, I cannot help with that', cost_usd: 0 }),
    });
    expect(result).toBeNull();
  });

  it('returns null on schema mismatch (missing required goal fields)', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: '...',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({ v: 1, goals: [{ id: 'G1' }] }),
        cost_usd: 0,
      }),
    });
    expect(result).toBeNull();
  });

  it('synthesizes a canvas-editor capability denominator from product kind and surfaces', async () => {
    const result = await runDiscovery({
      url: 'https://www.tldraw.com/',
      observation_summary:
        'tldraw whiteboard canvas with toolbar, shape, text, arrow, color, export, and share controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard and diagram editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and refine a visible whiteboard artifact.',
            core_artifacts: ['visible canvas diagram'],
            value_loops: [
              {
                id: 'VL1',
                title: 'Create a useful board',
                artifact: 'styled diagram with labels and connectors',
                required_capabilities: ['create shapes', 'add labels', 'connect objects'],
                proof_obligations: ['canvas contains a named diagram'],
                weak_evidence: ['toolbar selected only'],
              },
            ],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Create a launch planning board',
                journey_id: 'J1',
                scenario_brief:
                  'Create a launch planning board with two labeled steps, an arrow, and a style change.',
                test_data: ['Launch plan', 'Draft', 'Review'],
                required_actions: ['place shapes', 'add labels', 'draw connector', 'change color'],
                proof_obligations: ['named board content appears on canvas'],
                expected_artifact: 'styled launch planning diagram',
                required_outputs: [
                  'Launch plan',
                  'Draft',
                  'Review',
                  'visible connector',
                  'visible style change',
                ],
                quality_bar: ['the result reads as a diagram'],
                acceptable_evidence: ['post-action screenshot of diagram'],
                weak_evidence: ['shape tool selected'],
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Blank whiteboard canvas',
              kind: 'content',
              url: 'https://www.tldraw.com/',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'Primary drawing toolbar with shape, text, arrow, draw, color, fill, size',
              kind: 'toolbar',
              url: 'https://www.tldraw.com/',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S3',
              label: 'Export and download menu',
              kind: 'menu',
              url: 'https://www.tldraw.com/',
              source: 'menu_peek',
              value: 'important_secondary',
              confidence: 0.8,
            },
            {
              id: 'S4',
              label: 'Share and sign in to share',
              kind: 'account',
              url: 'https://www.tldraw.com/',
              source: 'initial',
              value: 'important_secondary',
              confidence: 0.8,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a launch planning diagram',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Create a named diagram on the canvas.',
              suggested_goal:
                'Create a launch planning board with two labeled shapes, an arrow, and a style change.',
              sample_input: 'Launch plan; Draft; Review',
              expected_evidence: ['readable labels', 'connector', 'style change'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: ['S3', 'S4'],
            rationale: 'Start with core board creation.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description:
                'Create a launch planning board with two labeled shapes, an arrow, and a style change.',
              priority: 'must',
              goal_class: 'core',
              journey_id: 'J1',
              surface_ids: ['S1', 'S2'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected discovery result');
    const labels = result.output.capabilities.map((capability) => capability.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Create visible canvas content',
        'Add readable text or notes',
        'Connect or draw relationships',
        'Style or format canvas objects',
        'Use shape-library objects',
        'Export or save the board',
        'Share or collaborate on the board',
      ]),
    );
    expect(
      result.output.capabilities.find(
        (capability) => capability.label === 'Create visible canvas content',
      )?.status,
    ).toBe('selected');
    expect(
      result.output.capabilities.find((capability) => capability.label === 'Import media or embeds')
        ?.status,
    ).toBe('discovered');
    expect(formatDiscoveryExplorerContext(result.output)).toContain('PRODUCT CAPABILITY COVERAGE');
  });

  it('relinks product-use jobs with stale declared journey ids to matching selected journeys', async () => {
    const result = await runDiscovery({
      url: 'https://example.test/',
      observation_summary: 'Planning board app with a visible board surface.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A planning board.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create a launch planning board.',
            core_artifacts: ['visible board'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Create a launch board',
                journey_id: 'J99',
                scenario_brief: 'Create a launch board with Backlog and Released columns.',
                test_data: ['Backlog', 'Released'],
                required_actions: ['create columns'],
                proof_obligations: [],
                expected_artifact: 'visible board',
                required_outputs: ['Backlog', 'Released'],
                quality_bar: [],
                acceptable_evidence: [],
                weak_evidence: [],
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Board',
              kind: 'content',
              url: 'https://example.test/',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a launch board',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Create a launch board.',
              suggested_goal: 'Create a launch board with Backlog and Released columns.',
              sample_input: 'Backlog; Released',
              expected_evidence: ['Backlog', 'Released'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Core journey.',
            coverage_risk: 'medium',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.product_use_contract?.user_jobs[0]?.journey_id).toBe('J1');
    expect(result?.output.goals[0]?.journey_id).toBe('J1');
  });

  it('synthesizes a content-product capability denominator without canvas-specific rules', async () => {
    const result = await runDiscovery({
      url: 'https://example.com/search',
      observation_summary:
        'Search input, article results, table of contents, and language selector.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A searchable encyclopedia.',
          product_use_contract: {
            product_kinds: ['search_content', 'content_site'],
            primary_value_loop: 'Search for a topic, open a result, and read content.',
            core_artifacts: ['loaded article page'],
            value_loops: [],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Search input',
              kind: 'search',
              url: 'https://example.com/search',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'Article result page',
              kind: 'content',
              url: 'https://example.com/wiki/OpenAI',
              source: 'primary_journey',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S3',
              label: 'Article table of contents and references',
              kind: 'nav',
              url: 'https://example.com/wiki/OpenAI',
              source: 'primary_journey',
              value: 'important_secondary',
              confidence: 0.8,
            },
            {
              id: 'S4',
              label: 'Language selector',
              kind: 'menu',
              url: 'https://example.com/wiki/OpenAI',
              source: 'menu_peek',
              value: 'important_secondary',
              confidence: 0.8,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Search and read an article',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Find and consume content.',
              suggested_goal:
                'Search for OpenAI, open the article, and verify readable article content appears.',
              sample_input: 'OpenAI',
              expected_evidence: ['OpenAI article content'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: ['S3', 'S4'],
            rationale: 'Search/read is primary; article tools are deferred.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description:
                'Search for OpenAI, open the article, and verify readable article content appears.',
              priority: 'must',
              goal_class: 'core',
              journey_id: 'J1',
              surface_ids: ['S1', 'S2'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });
    const labels = result?.output.capabilities.map((capability) => capability.label) ?? [];
    expect(labels).toEqual(
      expect.arrayContaining([
        'Search for specific content',
        'Consume visible content',
        'Navigate within content',
        'Use visible content tools',
      ]),
    );
    expect(labels).not.toContain('Create visible canvas content');
    expect(
      result?.output.capabilities.find(
        (capability) => capability.label === 'Navigate within content',
      )?.status,
    ).toBe('selected');
    expect(result?.output.goals.map((goal) => goal.description).join('\n')).toMatch(
      /Search for OpenAI|OpenAI/,
    );
  });

  it('keeps supporting content/search from becoming core when an app workflow is primary', async () => {
    const result = await runDiscovery({
      url: 'https://calculator.example/mortgage',
      observation_summary:
        'Mortgage calculator page with loan inputs, Calculate button, result table, amortization schedule, article text, related calculator links, and site search.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A mortgage calculator with supporting educational content.',
          product_use_contract: {
            product_kinds: ['dashboard_filtering', 'content_site', 'search_content'],
            primary_value_loop:
              'Calculate mortgage payment and inspect amortization for a concrete loan scenario.',
            core_artifacts: ['changed mortgage payment result', 'amortization table'],
            value_loops: [],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Mortgage input form with Calculate',
              kind: 'form',
              url: 'https://calculator.example/mortgage',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'Mortgage result and amortization table',
              kind: 'content',
              url: 'https://calculator.example/mortgage',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S3',
              label: 'Educational article and related calculator links',
              kind: 'nav',
              url: 'https://calculator.example/mortgage',
              source: 'scroll',
              value: 'important_secondary',
              confidence: 0.8,
            },
            {
              id: 'S4',
              label: 'Site search',
              kind: 'search',
              url: 'https://calculator.example/mortgage',
              source: 'scroll',
              value: 'important_secondary',
              confidence: 0.8,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Calculate a mortgage scenario',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Estimate payment for a concrete mortgage.',
              suggested_goal:
                'Enter a $525,000 home purchase with 15% down and 6.25% interest, calculate, and verify monthly payment and amortization output.',
              expected_evidence: ['monthly payment result', 'amortization row'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Read supporting mortgage article',
              priority: 'could',
              goal_class: 'secondary_workflow',
              surface_ids: ['S3'],
              user_intent: 'Read educational context.',
              suggested_goal: 'Read the supporting mortgage article.',
              expected_evidence: ['article text visible'],
              risk: 'low',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: ['S3', 'S4'],
            rationale: 'Calculation is primary; article/search are supporting.',
            coverage_risk: 'medium',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.product_use_contract?.product_kinds).toEqual(['calculator_tool']);
    const capabilityLabels = result.output.capabilities.map((capability) => capability.label);
    expect(capabilityLabels).toContain('Calculate a concrete result');
    expect(capabilityLabels).not.toContain('Change a dashboard view');
    expect(capabilityLabels).not.toContain('Search for specific content');
    expect(capabilityLabels).not.toContain('Consume visible content');
    expect(result.output.goals.map((goal) => goal.description).join('\n')).not.toMatch(
      /filter|sort|drilldown/i,
    );
    expect(result.output.goals.map((goal) => goal.description).join('\n')).toContain(
      '$525,000 home purchase',
    );
  });

  it('promotes form calculators out of content/search scaffolds', async () => {
    const result = await runDiscovery({
      url: 'https://calculator.example/bmi',
      observation_summary:
        'BMI calculator page with age, gender, height, weight fields, Calculate button, BMI result panel, educational article, and site search.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A BMI calculator with supporting article content.',
          product_use_contract: {
            product_kinds: ['content_site', 'search_content'],
            primary_value_loop:
              'Enter age, gender, height, and weight, calculate BMI, and inspect the BMI result category.',
            core_artifacts: ['BMI result value and weight-status category'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Calculate a BMI result',
                journey_id: 'J1',
                scenario_brief:
                  'Enter age 38, height 5 ft 4 in, weight 185 lb, calculate, and verify BMI around 31.8 with obesity category.',
                required_actions: [],
                required_outputs: ['BMI around 31.8 kg/m2', 'Obesity category'],
                expected_artifact: 'Updated BMI result panel',
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'BMI calculator form and result panel',
              kind: 'form',
              url: 'https://calculator.example/bmi',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'BMI article and site search',
              kind: 'content',
              url: 'https://calculator.example/bmi',
              source: 'scroll',
              value: 'important_secondary',
              confidence: 0.8,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Calculate BMI',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Calculate a personal BMI result.',
              suggested_goal: 'Calculate BMI around 31.8 and verify the obesity category appears.',
              expected_evidence: ['BMI around 31.8 kg/m2', 'Obesity category'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: ['S2'],
            rationale: 'The calculation is primary.',
            coverage_risk: 'medium',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.product_use_contract?.product_kinds).toEqual(['calculator_tool']);
    expect(result.output.product_use_contract?.user_jobs[0]?.test_data).not.toContain('OpenAI');
    expect(
      result.output.product_use_contract?.user_jobs[0]?.required_actions.join('\n'),
    ).not.toMatch(/open and consume a content result/i);
  });

  it('strips a leading prose preamble before the JSON object', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: '...',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: `Here is my analysis. {\n  "v": 1,\n  "target_kind_hint": "web",\n  "product_description": "x",\n  "goals": [{"id":"G1","description":"y","priority":"must"}],\n  "focus_areas": [],\n  "hints": [],\n  "out_of_scope": []\n}`,
        cost_usd: 0,
      }),
    });
    expect(result).not.toBeNull();
    expect(result?.output.goals[0]?.id).toBe('G1');
  });

  it('skips stray provider JSON and parses the valid discovery payload', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'search page',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: [
          'debug wrapper:',
          '{"note":"not the schema"}',
          'actual:',
          JSON.stringify({
            v: 2,
            target_kind_hint: 'web',
            product_description: 'A searchable site.',
            goals: [
              {
                id: 'G1',
                description: 'Search for a topic and open a result.',
                priority: 'must',
              },
            ],
            focus_areas: ['search'],
            hints: [],
            out_of_scope: [],
          }),
        ].join('\n'),
        cost_usd: 0,
      }),
    });

    expect(result?.output.product_description).toBe('A searchable site.');
    expect(result?.output.goals[0]?.description).toContain('Search for a topic');
  });

  it('accepts toolbar as a first-class discovery surface kind', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'Whiteboard canvas with a tool selector toolbar.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A whiteboard editor.',
          surfaces: [
            {
              id: 'S001',
              label: 'Tool selector toolbar',
              kind: 'toolbar',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [{ ref: 'C001', note: 'visible creation tools' }],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a drawing',
              priority: 'must',
              surface_ids: ['S001'],
              user_intent: 'Create visible canvas content',
              suggested_goal: 'Use the toolbar to create and style visible board content.',
              expected_evidence: ['visible edited board content'],
              risk: 'high',
              goal_class: 'core',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Test the primary editor creation loop.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Use the toolbar to create and style visible board content.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S001'],
              goal_class: 'core',
            },
          ],
          focus_areas: ['toolbar'],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result).not.toBeNull();
    expect(result?.output.surfaces[0]?.kind).toBe('toolbar');
    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1']);
  });

  it('passes bounded survey observations to the discoverer prompt', async () => {
    let userPrompt = '';
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'initial viewport',
      survey_summary: 'hidden menu: Billing; footer: Privacy Policy',
      screenshot_path: '/tmp/x.png',
      discoverer: async (input) => {
        userPrompt = input.userPrompt;
        return {
          text: JSON.stringify({
            v: 1,
            target_kind_hint: 'web',
            product_description: 'x',
            goals: [{ id: 'G1', description: 'Open billing from the menu', priority: 'should' }],
            focus_areas: [],
            hints: [],
            out_of_scope: [],
          }),
          cost_usd: 0,
        };
      },
    });
    expect(result).not.toBeNull();
    expect(userPrompt).toContain('BOUNDED DISCOVERY SURVEY');
    expect(userPrompt).toContain('Billing');
  });

  it('passes structured survey payloads and preserves surface-to-journey goal refs', async () => {
    let userPrompt = '';
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'initial viewport',
      survey_payload: {
        v: 2,
        surfaces: [
          {
            id: 'S001',
            label: 'Search',
            kind: 'search',
            url: 'https://example.com',
            source: 'initial',
            value: 'core',
            confidence: 0.9,
            evidence: [{ ref: 'C001', note: 'initial viewport' }],
          },
          {
            id: 'S002',
            label: 'Settings',
            kind: 'settings',
            url: 'https://example.com/settings',
            source: 'sample_nav',
            value: 'important_secondary',
            confidence: 0.8,
            evidence: [{ ref: 'C002', note: 'sample nav' }],
          },
        ],
        captures: [],
      },
      screenshot_path: '/tmp/x.png',
      discoverer: async (input) => {
        userPrompt = input.userPrompt;
        return {
          text: JSON.stringify({
            v: 2,
            target_kind_hint: 'web',
            product_description: 'A searchable content product.',
            surfaces: [
              {
                id: 'S001',
                label: 'Search',
                kind: 'search',
                url: 'https://example.com',
                source: 'initial',
                value: 'core',
                confidence: 0.9,
                evidence: [{ ref: 'C001', note: 'initial viewport' }],
              },
              {
                id: 'S002',
                label: 'Settings',
                kind: 'settings',
                url: 'https://example.com/settings',
                source: 'sample_nav',
                value: 'important_secondary',
                confidence: 0.8,
                evidence: [{ ref: 'C002', note: 'sample nav' }],
              },
            ],
            journeys: [
              {
                id: 'J1',
                title: 'Search content',
                priority: 'must',
                surface_ids: ['S001'],
                user_intent: 'Find a topic',
                suggested_goal: 'Search for OpenAI and verify content loads.',
                expected_evidence: ['result page or article title'],
                risk: 'high',
              },
            ],
            coverage_plan: {
              selected_journey_ids: ['J1'],
              deferred_surface_ids: ['S002'],
              rationale: 'Settings is secondary to content search.',
              coverage_risk: 'low',
            },
            goals: [
              {
                id: 'G1',
                description: 'Search for OpenAI and verify content loads.',
                priority: 'must',
                journey_id: 'J1',
                surface_ids: ['S001'],
              },
            ],
            focus_areas: ['search'],
            hints: [],
            out_of_scope: [],
          }),
          cost_usd: 0,
        };
      },
    });

    expect(result?.output.v).toBe(2);
    expect(result?.output.surfaces.map((surface) => surface.id)).toEqual(['S001', 'S002']);
    expect(result?.output.journeys[0]?.surface_ids).toEqual(['S001']);
    expect(result?.output.coverage_plan?.deferred_surface_ids).toEqual(['S002']);
    expect(result?.output.goals[0]).toMatchObject({ journey_id: 'J1', surface_ids: ['S001'] });
    expect(userPrompt).toContain('STRUCTURED DISCOVERY SURVEY PAYLOAD');
    expect(userPrompt).toContain('"S001"');
  });

  it('preserves scenario acceptance criteria and includes them in explorer context', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'canvas app with tool palette and blank board',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A canvas editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and modify a visible drawing artifact on the board.',
            core_artifacts: ['visible shape or text on the canvas'],
            value_loops: [
              {
                id: 'VL1',
                title: 'Create drawing artifact',
                artifact: 'visible edited drawing',
                required_capabilities: ['draw/place visible content', 'style or edit content'],
                proof_obligations: ['the canvas contains edited visible content'],
                weak_evidence: ['toolbar selected'],
              },
            ],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Create board content',
                value_loop_id: 'VL1',
                journey_id: 'J1',
                required_actions: ['choose drawing tool', 'drag on canvas', 'add text'],
                proof_obligations: ['visible shape and readable text remain on the canvas'],
                expected_artifact: 'a visible created object remains on the canvas',
                acceptable_evidence: ['post-action screenshot showing shape/text'],
                weak_evidence: ['toolbar selected', 'properties panel opened'],
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Canvas',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create board content',
              priority: 'must',
              surface_ids: ['S1'],
              user_intent: 'Draw something useful',
              suggested_goal: 'Draw a shape on the canvas and add text.',
              expected_evidence: ['visible shape/text'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Creation is the core value loop.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Draw a shape on the canvas and add text.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: ['canvas creation'],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.product_use_contract?.product_kinds).toEqual(['canvas_editor']);
    expect(result?.output.product_use_contract?.user_jobs[0]?.weak_evidence).toContain(
      'toolbar selected',
    );
    expect(result?.output.product_use_contract?.user_jobs[0]?.required_actions).toContain(
      'drag on canvas',
    );
    expect(result?.output.product_use_contract?.value_loops[0]?.proof_obligations).toContain(
      'the canvas contains edited visible content',
    );
    expect(result?.output.product_use_contract?.user_jobs[0]?.proof_obligations).toContain(
      'visible shape and readable text remain on the canvas',
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected discovery result');
    const explorerContext = formatDiscoveryExplorerContext(result.output);
    expect(explorerContext).toContain('SCENARIO ACCEPTANCE CRITERIA');
    expect(explorerContext).toContain('journey group VL1');
    expect(explorerContext).toContain('proof obligations');
    expect(explorerContext).toContain('weak evidence that must NOT verify');
  });

  it('normalizes shallow artifact-editor contracts into material proof obligations', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A whiteboard with canvas, drawing toolbar, SDK promo, export, share.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create visible canvas content.',
            core_artifacts: ['visible shape on canvas'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Create a simple drawing',
                journey_id: 'J1',
                required_actions: ['draw on canvas'],
                expected_artifact: 'visible shape on canvas',
                acceptable_evidence: ['post-action screenshot'],
                weak_evidence: ['toolbar selected'],
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Blank whiteboard canvas',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Primary drawing toolbar',
              kind: 'menu',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S3',
              label: 'Dismiss SDK promo',
              kind: 'banner',
              url: 'https://draw.example',
              source: 'initial',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create canvas artifact',
              priority: 'must',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Make a useful board artifact',
              suggested_goal: 'Create a diagram on the canvas.',
              expected_evidence: ['visible diagram'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Dismiss SDK promo',
              priority: 'should',
              surface_ids: ['S3'],
              user_intent: 'Close a promo',
              suggested_goal: 'Dismiss the SDK promo.',
              expected_evidence: ['promo disappears'],
              risk: 'low',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1', 'J2'],
            deferred_surface_ids: [],
            rationale: 'Try editor and promo.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Create a diagram on the canvas.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1', 'S2'],
            },
            {
              id: 'G2',
              description: 'Dismiss the SDK promo.',
              priority: 'should',
              journey_id: 'J2',
              surface_ids: ['S3'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const contract = result?.output.product_use_contract;
    expect(contract?.value_loops[0]?.proof_obligations.join('\n')).toMatch(/composed artifact/);
    expect(contract?.user_jobs[0]?.required_actions.join('\n')).toMatch(
      /readable text|second object/,
    );
    expect(contract?.user_jobs[0]?.proof_obligations.join('\n')).toMatch(/activated tool/);
    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1', 'J3', 'J4', 'J5']);
    expect(result?.output.coverage_plan?.deferred_surface_ids).toContain('S3');
    expect(result?.output.goals.map((goal) => goal.description).join('\n')).not.toMatch(
      /SDK promo/,
    );
  });

  it('does not mistake shareable artifact wording for a share/auth scenario', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A whiteboard canvas for creating a shareable board artifact.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create a shareable board artifact.',
            core_artifacts: ['shareable board artifact'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Create a shareable board artifact',
                journey_id: 'J1',
                scenario_brief: 'Create a shareable planning board with readable labels.',
                required_actions: ['choose a drawing tool', 'place an object', 'type labels'],
                proof_obligations: ['A labeled board artifact appears on the canvas'],
                expected_artifact: 'shareable labeled board artifact',
                acceptable_evidence: ['post-action screenshot showing labeled board content'],
                weak_evidence: ['toolbar selected'],
                test_data: ['Launch plan', 'Draft'],
                required_outputs: ['Launch plan', 'Draft'],
                quality_bar: ['readable labeled board content'],
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Whiteboard canvas',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.95,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a shareable board artifact',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Create labeled board content.',
              suggested_goal: 'Create a shareable planning board with readable labels.',
              expected_evidence: ['labeled board content appears'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Primary creation path.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Create a shareable planning board with readable labels.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const job = result?.output.product_use_contract?.user_jobs[0];
    expect(job?.required_actions.join('\n')).not.toMatch(/share|collaboration|auth/i);
    expect(job?.expected_artifact).not.toMatch(/share, collaboration, or auth/i);
    expect(job?.required_outputs).toContain('Launch plan');
  });

  it('does not merge scenario data from a different inferred scaffold', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A whiteboard canvas with text and note tools.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create labeled board content.',
            core_artifacts: ['readable note on board'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Create a launch planning board',
                journey_id: 'J1',
                scenario_brief:
                  'Add a readable note labeled "Risk: dependency" to the board and verify it remains visible.',
                required_actions: ['choose a text or note tool', 'enter readable text'],
                proof_obligations: ['The readable note remains visible'],
                expected_artifact: 'board with a readable note',
                acceptable_evidence: ['post-action screenshot showing readable note'],
                weak_evidence: ['text tool selected only'],
                test_data: ['Risk: dependency'],
                required_outputs: ['readable note "Risk: dependency"'],
                quality_bar: ['the note must be meaningful board content'],
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Text and note tools',
              kind: 'toolbar',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.95,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a launch planning board',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Add a risk note.',
              suggested_goal:
                'Add a readable note labeled "Risk: dependency" to the board and verify it remains visible.',
              expected_evidence: ['readable risk note visible'],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Primary note path.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description:
                'Add a readable note labeled "Risk: dependency" to the board and verify it remains visible.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const job = result?.output.product_use_contract?.user_jobs[0];
    expect(job?.test_data).toEqual(['Risk: dependency']);
    expect(job?.required_outputs.join('\n')).not.toContain('Launch plan');
    expect(job?.required_actions.join('\n')).not.toMatch(/connector|style|resize/);
  });

  it('does not classify literal test data as product capability intent', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A whiteboard canvas with text and note tools.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create readable board notes.',
            core_artifacts: ['readable annotation on board'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Add a readable annotation',
                journey_id: 'J1',
                scenario_brief:
                  'Add a standalone text or sticky-note annotation describing a meeting outcome.',
                required_actions: ['click Text or Note tool', 'type provided content'],
                proof_obligations: ['The annotation remains visible on the board'],
                expected_artifact: 'readable annotation on the whiteboard',
                acceptable_evidence: ['post-action screenshot showing readable annotation'],
                weak_evidence: ['text tool selected only'],
                test_data: ['Decision: ship SDK docs', 'Next step: export board'],
                required_outputs: ['Decision: ship SDK docs', 'Next step: export board'],
                quality_bar: ['text must be meaningful and board-specific'],
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Text and note tools',
              kind: 'toolbar',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.95,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Add a readable annotation',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Add a readable board note.',
              suggested_goal:
                'Add a standalone text or sticky-note annotation describing a meeting outcome.',
              expected_evidence: ['readable annotation visible'],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Primary note path.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description:
                'Add a standalone text or sticky-note annotation describing a meeting outcome.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const job = result?.output.product_use_contract?.user_jobs[0];
    expect(job?.test_data).toContain('Next step: export board');
    expect(job?.required_actions.join('\n')).not.toMatch(/export|download|save/);
    expect(job?.expected_artifact).not.toMatch(/export|download|save/);
  });

  it('expands rich artifact-editor surfaces instead of collapsing them into a few broad goals', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary:
        'A whiteboard with canvas, primary toolbar, shape picker, style controls, media, export, and share.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor', 'communication_tool'],
            primary_value_loop: 'Create and edit a visible whiteboard artifact.',
            core_artifacts: ['visible shapes, text, connectors, or media on canvas'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Create a first visible canvas object',
                journey_id: 'J1',
                required_actions: ['choose a drawing tool', 'place an object'],
                proof_obligations: ['A visible object appears on the canvas'],
                expected_artifact: 'visible object on canvas',
                acceptable_evidence: ['post-action screenshot showing object'],
                weak_evidence: ['toolbar selected'],
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Blank whiteboard canvas',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
              controls: [],
            },
            {
              id: 'S2',
              label: 'Primary drawing toolbar',
              kind: 'toolbar',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
              controls: [
                { role: 'button', tag: 'button', name: 'Draw — D' },
                { role: 'button', tag: 'button', name: 'Arrow — A' },
                { role: 'button', tag: 'button', name: 'Text — T' },
                { role: 'button', tag: 'button', name: 'Note — N' },
                { role: 'button', tag: 'button', name: 'Media — ⌘ U' },
                { role: 'button', tag: 'button', name: 'Rectangle — R' },
                { role: 'button', tag: 'button', name: 'More' },
              ],
            },
            {
              id: 'S3',
              label: 'Shape picker submenu',
              kind: 'menu',
              url: 'https://draw.example',
              source: 'menu_peek',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
              controls: [
                { role: 'button', tag: 'button', name: 'Diamond' },
                { role: 'button', tag: 'button', name: 'Cloud' },
              ],
            },
            {
              id: 'S4',
              label: 'Color and fill style controls',
              kind: 'menu',
              url: 'https://draw.example',
              source: 'menu_peek',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
              controls: [
                { role: 'radio', tag: 'button', name: 'Color — Blue' },
                { role: 'radio', tag: 'button', name: 'Fill — Solid' },
              ],
            },
            {
              id: 'S5',
              label: 'Edit actions toolbar',
              kind: 'toolbar',
              url: 'https://draw.example',
              source: 'menu_peek',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
              controls: [
                { role: 'button', tag: 'button', name: 'Undo — ⌘ Z' },
                { role: 'button', tag: 'button', name: 'Delete — ⌫' },
                { role: 'button', tag: 'button', name: 'Duplicate — ⌘ D' },
              ],
            },
            {
              id: 'S6',
              label: 'Page menu utilities',
              kind: 'menu',
              url: 'https://draw.example',
              source: 'menu_peek',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
              controls: [
                { role: 'button', tag: 'button', name: 'Export' },
                { role: 'button', tag: 'button', name: 'Upload media…' },
                { role: 'button', tag: 'button', name: 'Insert embed…' },
                { role: 'button', tag: 'button', name: 'Download' },
                { role: 'button', tag: 'button', name: 'Preferences' },
                { role: 'button', tag: 'button', name: 'Language' },
                { role: 'button', tag: 'button', name: 'Keyboard shortcuts…' },
              ],
            },
            {
              id: 'S7',
              label: 'Share',
              kind: 'menu',
              url: 'https://draw.example',
              source: 'initial',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
              controls: [{ role: 'button', tag: 'button', name: 'Share' }],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a first visible canvas object',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Place an object on the blank board.',
              suggested_goal: 'Create a visible whiteboard object on the canvas.',
              expected_evidence: ['visible object on canvas'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Style a board object',
              priority: 'should',
              goal_class: 'core',
              surface_ids: ['S2', 'S4'],
              user_intent: 'Change a created object style.',
              suggested_goal: 'Style a created object and confirm the visual change.',
              expected_evidence: ['object visibly changes color or fill'],
              risk: 'medium',
            },
            {
              id: 'J3',
              title: 'Correct mistakes with edit actions',
              priority: 'should',
              goal_class: 'core',
              surface_ids: ['S5'],
              user_intent: 'Use undo/delete/duplicate.',
              suggested_goal: 'Use undo, delete, or duplicate and verify board state changes.',
              expected_evidence: ['board state changes visibly'],
              risk: 'medium',
            },
            {
              id: 'J4',
              title: 'Open collaboration share flow',
              priority: 'should',
              goal_class: 'secondary_workflow',
              surface_ids: ['S7'],
              user_intent: 'Share the board.',
              suggested_goal: 'Open the share flow and reach a sharing state.',
              expected_evidence: ['share or sign-in state appears'],
              risk: 'medium',
            },
            {
              id: 'J5',
              title: 'Access page utilities and app-level options',
              priority: 'could',
              goal_class: 'secondary_workflow',
              surface_ids: ['S6'],
              user_intent: 'Inspect utilities.',
              suggested_goal:
                'Open the page menu and reach a utility destination such as preferences, export, language, or keyboard shortcuts.',
              expected_evidence: ['utility destination visible'],
              risk: 'low',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1', 'J2', 'J3', 'J4', 'J5'],
            deferred_surface_ids: [],
            rationale: 'Compressed plan from model.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Create a visible whiteboard object on the canvas.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1', 'S2'],
              goal_class: 'core',
            },
            {
              id: 'G2',
              description: 'Style a created object and confirm the visual change.',
              priority: 'should',
              journey_id: 'J2',
              surface_ids: ['S2', 'S4'],
              goal_class: 'core',
            },
            {
              id: 'G3',
              description: 'Use undo, delete, or duplicate and verify board state changes.',
              priority: 'should',
              journey_id: 'J3',
              surface_ids: ['S5'],
              goal_class: 'core',
            },
            {
              id: 'G4',
              description: 'Open the share flow and reach a sharing state.',
              priority: 'should',
              journey_id: 'J4',
              surface_ids: ['S7'],
              goal_class: 'secondary_workflow',
            },
            {
              id: 'G5',
              description:
                'Open the page menu and reach a utility destination such as preferences, export, language, or keyboard shortcuts.',
              priority: 'should',
              journey_id: 'J5',
              surface_ids: ['S6'],
              goal_class: 'secondary_workflow',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const descriptions = result?.output.goals.map((goal) => goal.description).join('\n') ?? '';
    expect(result?.output.goals.length).toBeGreaterThanOrEqual(8);
    expect(descriptions).toMatch(/Launch plan/);
    expect(descriptions).toMatch(/non-default shape/);
    expect(descriptions).toMatch(/readable text|note/);
    expect(descriptions).toMatch(/arrow|freehand|connector/);
    expect(descriptions).toMatch(/media|upload|embed/);
    expect(descriptions).toMatch(/Export|download/);
    expect(descriptions).not.toMatch(/utility destination such as preferences/);
    expect(result?.output.coverage_plan?.selected_journey_ids.length).toBeGreaterThanOrEqual(8);
  });

  it('does not attach canvas artifact obligations to settings value loops', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A canvas editor with page menu settings and help links.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and configure a whiteboard.',
            core_artifacts: ['visible canvas artifact', 'configured editor state'],
            value_loops: [
              {
                id: 'VL1',
                title: 'Configure editing environment and board presentation',
                artifact: 'Changed editor preferences or view state',
                required_capabilities: ['open page menu', 'toggle minimap'],
                proof_obligations: ['A preference or view control visibly changes state'],
                weak_evidence: ['menu opened'],
              },
            ],
            user_jobs: [],
          },
          goals: [
            {
              id: 'G1',
              description: 'Open preferences and verify a real settings destination or change.',
              priority: 'should',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const loopProof = result?.output.product_use_contract?.value_loops[0]?.proof_obligations ?? [];
    expect(loopProof.join('\n')).toContain('settings/help/configuration');
    expect(loopProof.join('\n')).not.toContain('composed artifact');
  });

  it('uses state-revision obligations for artifact edit/history loops', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A canvas editor with duplicate, delete, undo, and redo controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and revise a whiteboard.',
            core_artifacts: ['changed board state'],
            value_loops: [
              {
                id: 'VL1',
                title: 'Revise board state and history',
                artifact: 'Object count changes through duplicate, delete, undo, or redo.',
                required_capabilities: ['use duplicate or undo'],
                proof_obligations: ['Object count or arrangement changes on the canvas'],
                weak_evidence: ['history button clicked only'],
              },
            ],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Duplicate, delete, or undo a board object',
                value_loop_id: 'VL1',
                journey_id: 'J1',
                required_actions: ['use Duplicate, Delete, Undo, or Redo'],
                proof_obligations: ['the object count changes on the canvas'],
                expected_artifact: 'changed board state',
                acceptable_evidence: ['post-action board state change'],
                weak_evidence: ['button clicked only'],
                risk: 'low',
              },
            ],
          },
          goals: [
            {
              id: 'G1',
              description: 'Duplicate an object and confirm the board state changes.',
              priority: 'must',
              journey_id: 'J1',
              goal_class: 'core',
              surface_ids: [],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const loopProof = result?.output.product_use_contract?.value_loops[0]?.proof_obligations ?? [];
    const jobActions = result?.output.product_use_contract?.user_jobs[0]?.required_actions ?? [];
    expect(loopProof.join('\n')).toContain('visibly reflects the edit or history action');
    expect(loopProof.join('\n')).not.toContain('composed artifact');
    expect(jobActions.join('\n')).toContain('visible edit, history');
    expect(jobActions.join('\n')).not.toContain('readable text');
  });

  it('normalizes over-specific artifact history sequences into outcome-shaped goals', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A canvas editor with duplicate, delete, undo, and redo controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and revise a whiteboard.',
            core_artifacts: ['changed board state'],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Canvas and edit toolbar',
              kind: 'toolbar',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
              controls: [
                { role: 'button', tag: 'button', name: 'Duplicate' },
                { role: 'button', tag: 'button', name: 'Delete' },
                { role: 'button', tag: 'button', name: 'Undo' },
              ],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Duplicate, undo, then delete one copy',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Test board history.',
              suggested_goal:
                'Duplicate an object, undo the change, then delete one copy and verify the canvas state updates.',
              expected_evidence: [
                'duplicate appears',
                'undo restores state',
                'delete removes copy',
              ],
              risk: 'medium',
            },
          ],
          goals: [
            {
              id: 'G1',
              description:
                'Duplicate an object, undo the change, then delete one copy and verify the canvas state updates.',
              priority: 'must',
              journey_id: 'J1',
              goal_class: 'core',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.journeys[0]?.suggested_goal).toContain(
      'Duplicate, delete, undo, or redo',
    );
    expect(result?.output.goals[0]?.description).toContain('Duplicate, delete, undo, or redo');
    expect(result?.output.goals[0]?.description).not.toContain('then delete one copy');
  });

  it('keeps media insertion obligations distinct from edit/history obligations', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A canvas editor with upload media and insert embed actions.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and import board content.',
            core_artifacts: ['inserted image on board'],
            value_loops: [
              {
                id: 'VL1',
                title: 'Rich content insertion',
                artifact: 'A board that contains an uploaded image or embed',
                required_capabilities: ['upload media', 'insert embed'],
                proof_obligations: ['the inserted asset is visible on the board'],
                weak_evidence: ['file picker opened'],
              },
            ],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Canvas',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Media upload',
              kind: 'toolbar',
              url: 'https://draw.example',
              source: 'initial',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Insert media onto the board',
              priority: 'should',
              goal_class: 'core',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Add external media content.',
              suggested_goal: 'Insert media onto the board and verify it appears.',
              expected_evidence: ['inserted media is visible on the board'],
              risk: 'medium',
            },
          ],
          goals: [
            {
              id: 'G1',
              description: 'Insert media or an embed and confirm it appears.',
              priority: 'should',
              journey_id: 'J1',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const loop = result?.output.product_use_contract?.value_loops[0];
    expect(loop?.proof_obligations.join('\n')).toContain('inserted asset is visible');
    expect(loop?.proof_obligations.join('\n')).not.toContain('edit or history action');
    expect(loop?.required_capabilities.join('\n')).not.toContain('undo');
    expect(result?.output.journeys.find((journey) => journey.id === 'J1')?.suggested_goal).toBe(
      'Insert media onto the board and verify it appears.',
    );
  });

  it('does not attach media import obligations to non-media canvas jobs', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A canvas editor with shape library and media controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and edit board content.',
            core_artifacts: ['visible shapes on board'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Use a non-default shape from the shape library',
                required_actions: [
                  'create or place visible content on the canvas',
                  'add readable text, a label, a connector, media, or a second object',
                  'modify an existing object with style, size, position, or structure change',
                ],
                proof_obligations: [
                  'The canvas contains a composed artifact, not just an activated tool or empty board.',
                ],
                expected_artifact: 'A non-default shape is visible on the canvas',
                acceptable_evidence: ['A non-default shape is visible on the canvas'],
                weak_evidence: ['toolbar selected'],
                risk: 'medium',
              },
            ],
          },
          goals: [
            {
              id: 'G1',
              description: 'Place a non-default shape on the canvas.',
              priority: 'should',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const jobActions = result?.output.product_use_contract?.user_jobs[0]?.required_actions ?? [];
    expect(jobActions.join('\n')).not.toContain('confirm the inserted asset');
  });

  it('does not attach settings obligations to canvas style loops that mention tool settings', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A canvas editor with shape and style controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor', 'settings_tool'],
            primary_value_loop: 'Create and edit canvas content.',
            core_artifacts: ['styled canvas object'],
            value_loops: [
              {
                id: 'VL1',
                title: 'Create and edit a whiteboard canvas',
                artifact: 'Visible canvas content made of shapes and text',
                required_capabilities: ['select a tool', 'change object color'],
                proof_obligations: ['Object styling reflects the chosen tool/settings'],
                weak_evidence: ['tool selected only'],
              },
            ],
            user_jobs: [],
          },
          goals: [
            {
              id: 'G1',
              description: 'Create and style a shape on the board.',
              priority: 'must',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const loopProof = result?.output.product_use_contract?.value_loops[0]?.proof_obligations ?? [];
    expect(loopProof.join('\n')).toContain('composed artifact');
    expect(loopProof.join('\n')).not.toContain('settings/help/configuration');
  });

  it('keeps text-block creation journeys as core product goals', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'A whiteboard with canvas and drawing toolbar.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create visible canvas content.',
            core_artifacts: ['visible text block on canvas'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Create a text block on the canvas',
                journey_id: 'J1',
                required_actions: ['select text tool', 'type label'],
                proof_obligations: ['A text block remains visible on the canvas'],
                expected_artifact: 'visible text block',
                acceptable_evidence: ['post-action screenshot showing text block'],
                weak_evidence: ['text tool selected only'],
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Canvas',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Dismiss overlay',
              kind: 'banner',
              url: 'https://draw.example',
              source: 'initial',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a new text block on the canvas',
              priority: 'must',
              goal_class: 'setup',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Start from a blank board and make a first visible artifact.',
              suggested_goal: 'Create a text block and verify it appears on the canvas.',
              expected_evidence: ['a persistent new text block is visible'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Exercise creation.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Create a text block and verify it appears on the canvas.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1', 'S2'],
              goal_class: 'setup',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.journeys[0]?.goal_class).toBe('core');
    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1', 'J2', 'J3']);
    expect(result?.output.goals[0]?.goal_class).toBe('core');
  });

  it('attaches page-container surfaces to same-page journeys and goals', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'initial viewport',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A searchable homepage.',
          surfaces: [
            {
              id: 'S000',
              label: 'Home page',
              kind: 'page',
              url: 'https://example.com',
              source: 'initial',
              value: 'core',
              confidence: 0.95,
              evidence: [{ ref: 'C000', note: 'initial page' }],
            },
            {
              id: 'S001',
              label: 'Search',
              kind: 'search',
              url: 'https://example.com',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [{ ref: 'C001', note: 'initial viewport' }],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Search content',
              priority: 'must',
              surface_ids: ['S001'],
              user_intent: 'Find a topic',
              suggested_goal: 'Search for OpenAI and verify content loads.',
              expected_evidence: ['article title'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Search is the primary homepage journey.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Search for OpenAI and verify content loads.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S001'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.journeys[0]?.surface_ids).toEqual(['S000', 'S001']);
    expect(result?.output.goals[0]?.surface_ids).toEqual(['S001', 'S000']);
    expect(result?.output.coverage_plan?.deferred_surface_ids).toEqual([]);
  });

  it('synthesizes v2 surfaces, journeys, and coverage when the model returns flat goals', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary:
        'Homepage with search, article content, account links, and footer links.',
      survey_payload: {
        v: 2,
        surfaces: [
          {
            id: 'S001',
            label: 'Search box',
            kind: 'search',
            url: 'https://example.com',
            source: 'initial',
            value: 'core',
            confidence: 0.9,
            evidence: [{ ref: 'C001', note: 'initial viewport' }],
          },
          {
            id: 'S002',
            label: 'OpenAI article content with Contents and References',
            kind: 'content',
            url: 'https://example.com/wiki/OpenAI',
            source: 'primary_journey',
            value: 'core',
            confidence: 0.85,
            evidence: [{ ref: 'C002', note: 'after primary search journey' }],
          },
          {
            id: 'S003',
            label: 'Create account',
            kind: 'account',
            url: 'https://example.com/create-account',
            source: 'scroll',
            value: 'important_secondary',
            confidence: 0.75,
            evidence: [{ ref: 'C003', note: 'scroll sample' }],
          },
          {
            id: 'S004',
            label: 'Privacy Policy',
            kind: 'footer',
            url: 'https://example.com/privacy',
            source: 'scroll',
            value: 'peripheral',
            confidence: 0.7,
            evidence: [{ ref: 'C004', note: 'footer' }],
          },
          {
            id: 'S005',
            label: 'Apple App Store',
            kind: 'external',
            url: 'https://apps.apple.com/example',
            source: 'scroll',
            value: 'peripheral',
            confidence: 0.7,
            evidence: [{ ref: 'C005', note: 'mobile app link' }],
          },
        ],
        captures: [],
      },
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 1,
          target_kind_hint: 'web',
          product_description: 'A content product.',
          goals: [
            {
              id: 'G1',
              description:
                'Use search to find the OpenAI article and verify article content loads.',
              priority: 'must',
            },
            {
              id: 'G2',
              description: 'Open Create account and verify the account entry destination loads.',
              priority: 'should',
            },
            {
              id: 'G3',
              description: 'Open Privacy Policy and verify the legal page loads.',
              priority: 'should',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.v).toBe(2);
    expect(result?.output.surfaces.map((surface) => surface.id)).toEqual([
      'S001',
      'S002',
      'S003',
      'S004',
      'S005',
    ]);
    expect(result?.output.journeys).toHaveLength(3);
    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1', 'J2']);
    expect(result?.output.coverage_plan?.deferred_surface_ids).toEqual(['S004', 'S005']);
    expect(
      result?.output.goals.every((goal) => goal.journey_id && goal.surface_ids.length > 0),
    ).toBe(true);
    expect(result?.output.goals[0]?.surface_ids).toContain('S002');
    expect(result?.output.goals[1]?.surface_ids).toContain('S003');
    expect(result?.output.goals).toHaveLength(2);
  });

  it('does not report selected material journey surfaces as deferred', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'initial viewport',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A content product with footer links.',
          surfaces: [
            {
              id: 'S001',
              label: 'Search',
              kind: 'search',
              url: 'https://example.com',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S002',
              label: 'Settings',
              kind: 'settings',
              url: 'https://example.com/settings',
              source: 'scroll',
              value: 'important_secondary',
              confidence: 0.8,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Search content',
              priority: 'must',
              surface_ids: ['S001'],
              user_intent: 'Find a topic',
              suggested_goal: 'Search for OpenAI and verify content loads.',
              expected_evidence: ['article title'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Configure settings',
              priority: 'should',
              surface_ids: ['S002'],
              user_intent: 'Change a preference',
              suggested_goal: 'Open Settings and verify a configurable preference panel appears.',
              expected_evidence: ['Settings panel'],
              risk: 'low',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1', 'J2'],
            deferred_surface_ids: ['S002'],
            rationale: 'All journeys selected.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Search for OpenAI and verify content loads.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S001'],
            },
            {
              id: 'G2',
              description: 'Open Settings and verify a configurable preference panel appears.',
              priority: 'should',
              journey_id: 'J2',
              surface_ids: ['S002'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1', 'J2']);
    expect(result?.output.coverage_plan?.deferred_surface_ids).toEqual([]);
  });

  it('demotes selected setup/banner journeys instead of making them seed goals', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'Canvas editor with a promo banner and drawing tools.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create a visible diagram on the canvas.',
            core_artifacts: ['styled shape plus text on the canvas'],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Canvas and creation toolbar',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'SDK promo banner dismissal',
              kind: 'banner',
              url: 'https://draw.example',
              source: 'initial',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a diagram',
              priority: 'must',
              surface_ids: ['S1'],
              user_intent: 'Make useful board content',
              suggested_goal:
                'Create a small diagram with a rectangle, a label, and a visible style change.',
              expected_evidence: ['visible styled diagram artifact'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Dismiss the SDK promo',
              priority: 'should',
              surface_ids: ['S2'],
              user_intent: 'Clear a promotional banner',
              suggested_goal: 'Dismiss the SDK promo and verify it no longer obstructs the canvas.',
              expected_evidence: ['promo banner disappears'],
              risk: 'low',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1', 'J2'],
            deferred_surface_ids: [],
            rationale: 'Selected core diagramming and banner dismissal.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description:
                'Create a small diagram with a rectangle, a label, and a visible style change.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
            {
              id: 'G2',
              description: 'Dismiss the SDK promo and verify it no longer obstructs the canvas.',
              priority: 'should',
              journey_id: 'J2',
              surface_ids: ['S2'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.journeys.find((journey) => journey.id === 'J2')?.goal_class).toBe(
      'setup',
    );
    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1', 'J3', 'J4']);
    expect(result?.output.coverage_plan?.deferred_surface_ids).toContain('S2');
    expect(result?.output.goals.map((goal) => goal.description).join('\n')).not.toMatch(
      /SDK promo|Dismiss/,
    );
  });

  it('prunes incidental product kinds from a primary canvas editor denominator', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary:
        'A whiteboard canvas with drawing tools, media upload, share/sign-in, settings, and an SDK promo link.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description:
            'A browser whiteboard editor with a developer SDK promo and supporting account/settings surfaces.',
          product_use_contract: {
            product_kinds: [
              'canvas_editor',
              'media_tool',
              'auth_account',
              'settings_tool',
              'developer_tool',
            ],
            primary_value_loop: 'Create and refine a visible whiteboard artifact on the canvas.',
            core_artifacts: ['labeled shapes, notes, connectors, and visible board styling'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Build a launch board',
                journey_id: 'J1',
                scenario_brief:
                  'Create a launch planning board with shapes, labels, an arrow, and a style change.',
                required_actions: ['place shapes', 'add labels', 'connect objects', 'change color'],
                expected_artifact: 'styled launch planning board',
                acceptable_evidence: ['post-action screenshot showing a styled board'],
                weak_evidence: ['toolbar selected'],
                risk: 'high',
              },
            ],
          },
          capabilities: [
            {
              id: 'C-dev',
              label: 'Configure and run a developer workflow',
              product_kind: 'developer_tool',
              importance: 'core',
              status: 'selected',
              confidence: 0.9,
              source: 'model',
              evidence: ['Build with the SDK promo'],
              scenario_ids: [],
              journey_ids: ['J2'],
              surface_ids: ['S2'],
              denominator_reason: 'SDK promo was visible.',
              coverage_gap: '',
            },
            {
              id: 'C-media',
              label: 'Load or transform media',
              product_kind: 'media_tool',
              importance: 'core',
              status: 'selected',
              confidence: 0.9,
              source: 'model',
              evidence: ['Media upload control was visible'],
              scenario_ids: [],
              journey_ids: ['J3'],
              surface_ids: ['S3'],
              denominator_reason: 'Media upload was visible.',
              coverage_gap: '',
            },
          ],
          surfaces: [
            {
              id: 'S1',
              label: 'Blank whiteboard canvas and drawing toolbar',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Build with the SDK promo link',
              kind: 'external',
              url: 'https://draw.example',
              source: 'initial',
              value: 'peripheral',
              confidence: 0.8,
              evidence: [],
            },
            {
              id: 'S3',
              label: 'Media upload',
              kind: 'toolbar',
              url: 'https://draw.example',
              source: 'initial',
              value: 'important_secondary',
              confidence: 0.8,
              evidence: [],
            },
            {
              id: 'S4',
              label: 'Settings and sign-in',
              kind: 'settings',
              url: 'https://draw.example',
              source: 'menu_peek',
              value: 'important_secondary',
              confidence: 0.7,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a styled launch board',
              priority: 'must',
              surface_ids: ['S1'],
              user_intent: 'Make useful board content',
              suggested_goal:
                'Create a launch planning board with shapes, labels, an arrow, and a style change.',
              expected_evidence: ['styled launch planning board'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Visit SDK docs',
              priority: 'could',
              surface_ids: ['S2'],
              user_intent: 'Inspect developer marketing',
              suggested_goal: 'Open the SDK promo link.',
              expected_evidence: ['SDK docs open'],
              risk: 'low',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: ['S2'],
            rationale: 'Focus on the editor value loop.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description:
                'Create a launch planning board with shapes, labels, an arrow, and a style change.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.product_use_contract?.product_kinds).toEqual(['canvas_editor']);
    const capabilityLabels =
      result?.output.capabilities.map((capability) => capability.label) ?? [];
    expect(capabilityLabels).toContain('Create visible canvas content');
    expect(capabilityLabels).toContain('Import media or embeds');
    expect(capabilityLabels).not.toContain('Configure and run a developer workflow');
    expect(capabilityLabels).not.toContain('Load or transform media');
    expect(capabilityLabels).not.toContain('Change or inspect settings');
  });

  it('keeps a standalone developer tool denominator when developer workflow is primary', async () => {
    const result = await runDiscovery({
      url: 'https://devtool.example',
      observation_summary:
        'Developer console with API project setup, build/run controls, deploy button, and logs.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A developer console for configuring and running projects.',
          product_use_contract: {
            product_kinds: ['developer_tool'],
            primary_value_loop: 'Configure a project, run a build, and inspect the resulting logs.',
            core_artifacts: ['project run result and visible log output'],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Project configuration, Run build, Deploy, and Logs console',
              kind: 'toolbar',
              url: 'https://devtool.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [],
          coverage_plan: {
            selected_journey_ids: [],
            deferred_surface_ids: [],
            rationale: 'Model underselected developer workflow.',
            coverage_risk: 'high',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.product_use_contract?.product_kinds).toEqual(['developer_tool']);
    const capabilityLabels =
      result?.output.capabilities.map((capability) => capability.label) ?? [];
    expect(capabilityLabels).toContain('Configure and run a developer workflow');
    expect(capabilityLabels).toContain('Inspect logs, output, or errors');
  });

  it('keeps content-site legal/footer samples out of seed goals when core content remains selected', async () => {
    const result = await runDiscovery({
      url: 'https://content.example',
      observation_summary:
        'Content site with search, article, account link, and footer legal links.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A searchable content site.',
          product_use_contract: {
            product_kinds: ['content_site', 'search_content'],
            primary_value_loop: 'Search for and consume article content.',
            core_artifacts: ['loaded article or result page'],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Search',
              kind: 'search',
              url: 'https://content.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Article page with contents and references',
              kind: 'content',
              url: 'https://content.example/article',
              source: 'primary_journey',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S3',
              label: 'Privacy and Terms footer links',
              kind: 'footer',
              url: 'https://content.example/privacy',
              source: 'scroll',
              value: 'peripheral',
              confidence: 0.8,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Search and read article',
              priority: 'must',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Find and consume content',
              suggested_goal:
                'Search for OpenAI and verify an article page loads with readable content.',
              expected_evidence: ['article title and body content'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Sample footer legal links',
              priority: 'should',
              surface_ids: ['S3'],
              user_intent: 'Review legal info',
              suggested_goal: 'Sample footer legal links and verify a policy page opens.',
              expected_evidence: ['policy heading'],
              risk: 'low',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1', 'J2'],
            deferred_surface_ids: [],
            rationale: 'Selected core content and representative footer.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description:
                'Search for OpenAI and verify an article page loads with readable content.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1', 'S2'],
            },
            {
              id: 'G2',
              description: 'Sample footer legal links and verify a policy page opens.',
              priority: 'should',
              journey_id: 'J2',
              surface_ids: ['S3'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1', 'J3']);
    expect(result?.output.coverage_plan?.deferred_surface_ids).toContain('S3');
    expect(result?.output.goals).toHaveLength(2);
    expect(result?.output.goals[0]?.description).toContain('Search for OpenAI');
    expect(result?.output.goals.map((goal) => goal.description).join('\n')).not.toMatch(
      /legal|policy|footer/i,
    );
  });

  it('accepts primary_journey as capability evidence source from discovery models', async () => {
    const result = await runDiscovery({
      url: 'https://content.example',
      observation_summary: 'Search portal with a primary journey to an article page.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A searchable content site.',
          product_use_contract: {
            product_kinds: ['search_content', 'content_site'],
            primary_value_loop: 'Search for and read article content.',
            core_artifacts: ['loaded article page'],
            user_jobs: [],
          },
          capabilities: [
            {
              id: 'C1',
              label: 'Read an article reached from search',
              product_kind: 'content_site',
              importance: 'core',
              status: 'selected',
              confidence: 0.9,
              source: 'primary_journey',
              evidence: ['Search journey reached the article page'],
              scenario_ids: ['PU1'],
              journey_ids: ['J1'],
              surface_ids: ['S1'],
              denominator_reason: 'Primary search journey reached readable content.',
              coverage_gap: '',
            },
          ],
          surfaces: [
            {
              id: 'S1',
              label: 'Article page from search',
              kind: 'content',
              url: 'https://content.example/article',
              source: 'primary_journey',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Search and read article',
              priority: 'must',
              surface_ids: ['S1'],
              user_intent: 'Find and consume content',
              suggested_goal: 'Search for OpenAI and verify the article content loads.',
              expected_evidence: ['article title and lead text'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Primary content journey.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Search for OpenAI and verify the article content loads.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result).not.toBeNull();
    expect(result?.output.goals[0]?.description).toContain('Search for OpenAI');
    expect(result?.output.capabilities.length).toBeGreaterThan(0);
  });

  it('does not treat editable content-site surfaces as a standalone document editor', async () => {
    const result = await runDiscovery({
      url: 'https://wiki.example',
      observation_summary:
        'Encyclopedia portal with search, article pages, edit links, view history, and account links.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A searchable encyclopedia with article edit and history controls.',
          product_use_contract: {
            product_kinds: ['search_content', 'content_site', 'document_editor'],
            primary_value_loop: 'Search for and read encyclopedia article content.',
            core_artifacts: ['loaded article page with title, lead text, and body content'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Search and read article',
                journey_id: 'J1',
                scenario_brief: 'Search for OpenAI and read the article content.',
                required_actions: ['search for OpenAI', 'open result', 'read lead paragraph'],
                expected_artifact: 'loaded encyclopedia article',
                acceptable_evidence: ['article title and lead paragraph visible'],
                weak_evidence: ['search box focused only'],
                risk: 'high',
              },
              {
                id: 'PU2',
                title: 'Inspect history',
                journey_id: 'J2',
                scenario_brief: 'Open article revision history without editing.',
                required_actions: ['open View history'],
                expected_artifact: 'revision history page',
                acceptable_evidence: ['revision entries visible'],
                weak_evidence: ['history link visible only'],
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Search Wikipedia and article content',
              kind: 'search',
              url: 'https://wiki.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Edit and View history article tabs',
              kind: 'nav',
              url: 'https://wiki.example/article',
              source: 'primary_journey',
              value: 'important_secondary',
              confidence: 0.8,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Search and read article',
              priority: 'must',
              surface_ids: ['S1'],
              user_intent: 'Find encyclopedia content',
              suggested_goal: 'Search for OpenAI and verify the article content loads.',
              expected_evidence: ['OpenAI article text'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Inspect article history',
              priority: 'should',
              surface_ids: ['S2'],
              user_intent: 'Inspect article metadata',
              suggested_goal: 'Open View history and verify revision entries.',
              expected_evidence: ['revision entries'],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1', 'J2'],
            deferred_surface_ids: [],
            rationale: 'Article reading and history are material.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Search for OpenAI and verify the article content loads.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
            {
              id: 'G2',
              description: 'Open View history and verify revision entries.',
              priority: 'should',
              journey_id: 'J2',
              surface_ids: ['S2'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.product_use_contract?.product_kinds).toEqual([
      'search_content',
      'content_site',
    ]);
    expect(result?.output.capabilities.map((capability) => capability.label)).not.toContain(
      'Compose substantive document content',
    );
  });

  it('does not keep stale model-selected capability status when its journey is not tested', async () => {
    const result = await runDiscovery({
      url: 'https://content.example',
      observation_summary:
        'Article site with search and a table of contents, but only search is selected.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A searchable article site.',
          product_use_contract: {
            product_kinds: ['search_content', 'content_site'],
            primary_value_loop: 'Search for and read article content.',
            core_artifacts: ['loaded article page'],
            user_jobs: [],
          },
          capabilities: [
            {
              id: 'C1',
              label: 'Navigate within article sections using the contents table',
              product_kind: 'content_site',
              importance: 'important',
              status: 'selected',
              confidence: 0.9,
              source: 'model',
              evidence: ['Contents table was visible'],
              scenario_ids: ['PU2'],
              journey_ids: ['J2'],
              surface_ids: ['S2'],
              denominator_reason: 'Long articles need section navigation.',
              coverage_gap: '',
            },
          ],
          surfaces: [
            {
              id: 'S1',
              label: 'Search',
              kind: 'search',
              url: 'https://content.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Article contents table',
              kind: 'nav',
              url: 'https://content.example/article',
              source: 'primary_journey',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Search and read article',
              priority: 'must',
              surface_ids: ['S1'],
              user_intent: 'Find content',
              suggested_goal: 'Search for OpenAI and verify article content loads.',
              expected_evidence: ['article content'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Navigate article contents',
              priority: 'should',
              surface_ids: ['S2'],
              user_intent: 'Jump to a section',
              suggested_goal: 'Use the contents table to jump to a section.',
              expected_evidence: ['section heading'],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: ['S2'],
            rationale: 'Only search is selected.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Search for OpenAI and verify article content loads.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const navigationCapability = result?.output.capabilities.find((capability) =>
      capability.label.includes('Navigate within'),
    );
    expect(navigationCapability).toBeDefined();
    expect(navigationCapability?.scenario_ids).not.toContain('PU2');
    expect(navigationCapability?.scenario_ids.every((id) => id.startsWith('G'))).toBe(true);
    expect(navigationCapability?.status).toBe('selected');
    const navigationGoals =
      result?.output.goals.filter((goal) => navigationCapability?.scenario_ids.includes(goal.id)) ??
      [];
    expect(navigationGoals).toHaveLength(1);
    expect(navigationGoals[0]?.description).toMatch(/contents|section/i);
    expect(navigationGoals[0]?.description).not.toContain('Search for OpenAI');
  });

  it('does not keep covered-sounding coverage text on deferred capabilities', async () => {
    const result = await runDiscovery({
      url: 'https://content.example',
      observation_summary: 'Article site with search and a visible View history tab.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A searchable article site.',
          product_use_contract: {
            product_kinds: ['search_content', 'content_site'],
            primary_value_loop: 'Search for and read article content.',
            core_artifacts: ['loaded article page'],
            user_jobs: [],
          },
          capabilities: [
            {
              id: 'C1',
              label: 'Donate or dismiss fundraising prompts',
              product_kind: 'search_content',
              importance: 'secondary',
              status: 'deferred',
              confidence: 0.9,
              source: 'model',
              evidence: ['Fundraising prompt was visible'],
              scenario_ids: [],
              journey_ids: [],
              surface_ids: ['S2'],
              denominator_reason: 'Donation prompts are secondary to article reading.',
              coverage_gap: 'Covers donation messaging in this run.',
            },
          ],
          surfaces: [
            {
              id: 'S1',
              label: 'Search',
              kind: 'search',
              url: 'https://content.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Donate now',
              kind: 'banner',
              url: 'https://content.example/article',
              source: 'primary_journey',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Search and read article',
              priority: 'must',
              surface_ids: ['S1'],
              user_intent: 'Find content',
              suggested_goal: 'Search for OpenAI and verify article content loads.',
              expected_evidence: ['article content'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: ['S2'],
            rationale: 'Only search is selected.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Search for OpenAI and verify article content loads.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const donationCapability = result?.output.capabilities.find((capability) =>
      capability.label.includes('fundraising'),
    );
    expect(donationCapability?.status).toBe('deferred');
    expect(donationCapability?.coverage_gap).toBe(
      'Peripheral, setup-only, external, or diagnostic scope is not normally tested unless it blocks product use.',
    );
    expect(donationCapability?.selection_expectation).toBe('not_normally_tested');
  });

  it('does not count a contradictory selected capability gap as covered', () => {
    const capabilities = deriveDiscoveryCapabilitiesForReport({
      capabilities: [
        {
          id: 'C1',
          label: 'Read manual/reference documentation beyond examples',
          product_kind: 'developer_tool',
          importance: 'important',
          status: 'selected',
          selection_expectation: 'should_test_or_explain',
          confidence: 0.9,
          source: 'model',
          evidence: ['Manual and Reference links are visible.'],
          scenario_ids: ['G1'],
          journey_ids: ['J1'],
          surface_ids: ['S1'],
          denominator_reason: 'Developer documentation should support deeper lookup.',
          coverage_gap:
            'Manual/reference article consumption should be covered in a deeper documentation audit.',
        },
      ],
      product_use_contract: {
        product_kinds: ['developer_tool'],
        primary_value_loop: 'Use a developer example.',
        core_artifacts: ['visible implementation snippet'],
        value_loops: [],
        user_jobs: [],
      },
      journeys: [
        {
          id: 'J1',
          title: 'Inspect example code tabs',
          priority: 'must',
          surface_ids: ['S1'],
          user_intent: 'Read implementation code',
          suggested_goal: 'Inspect Javascript, HTML, and CSS tabs.',
          expected_evidence: ['visible code snippet'],
          risk: 'medium',
        },
      ],
      surfaces: [
        {
          id: 'S1',
          label: 'Code tabs',
          kind: 'content',
          url: 'https://docs.example',
          source: 'initial',
          value: 'core',
          confidence: 0.9,
          evidence: [],
          controls: [],
          prerequisites: [],
        },
      ],
      coverage_plan: {
        selected_journey_ids: ['J1'],
        deferred_surface_ids: [],
        rationale: 'Code tabs selected.',
        coverage_risk: 'medium',
      },
      goals: [
        {
          id: 'G1',
          description: 'Inspect Javascript, HTML, and CSS tabs.',
          priority: 'must',
          journey_id: 'J1',
          surface_ids: ['S1'],
        },
      ],
    });

    const docsCapability = capabilities.find((capability) =>
      capability.label.includes('manual/reference'),
    );
    expect(docsCapability?.status).toBe('deferred');
    expect(docsCapability?.scenario_ids).toEqual([]);
    expect(docsCapability?.coverage_gap).toContain('deeper documentation audit');
  });

  it('adds a scenario for an uncovered must-test capability even when adjacent journeys were selected', async () => {
    const result = await runDiscovery({
      url: 'https://docs.example',
      observation_summary:
        'Developer example page with a live table, search box, and visible Javascript source tabs.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A developer documentation example.',
          product_use_contract: {
            product_kinds: ['developer_tool'],
            primary_value_loop: 'Use the live example and learn how to implement it.',
            core_artifacts: ['filtered example state', 'visible implementation snippet'],
            value_loops: [],
            user_jobs: [],
          },
          capabilities: [
            {
              id: 'C1',
              label: 'Read implementation guidance and source-code snippets for the example',
              product_kind: 'developer_tool',
              importance: 'core',
              status: 'deferred',
              selection_expectation: 'must_test',
              confidence: 0.9,
              source: 'model',
              evidence: ['Javascript source tab is visible.'],
              scenario_ids: [],
              journey_ids: ['J1'],
              surface_ids: ['S2'],
              denominator_reason: 'A developer example must prove how to reproduce the behavior.',
              coverage_gap: 'Source-code snippets should be covered in a deeper audit.',
            },
          ],
          surfaces: [
            {
              id: 'S1',
              label: 'Live example table search',
              kind: 'search',
              url: 'https://docs.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Javascript source-code tab',
              kind: 'content',
              url: 'https://docs.example',
              source: 'primary_journey',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Filter the live example',
              priority: 'must',
              surface_ids: ['S1'],
              user_intent: 'Use the live example',
              suggested_goal: 'Filter the example table and verify the result count changes.',
              expected_evidence: ['filtered table state'],
              risk: 'high',
              goal_class: 'core',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Live example selected.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Filter the example table and verify the result count changes.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    const sourceGoal = result.output.goals.find((goal) =>
      /implementation|source-code|snippet/i.test(goal.description),
    );
    expect(sourceGoal).toBeDefined();
    const sourceCapability = result.output.capabilities.find(
      (capability) =>
        capability.label.includes('implementation guidance') ||
        capability.label === 'Read implementation code or dependencies',
    );
    expect(sourceCapability?.status).toBe('selected');
    expect(sourceCapability?.scenario_ids).toContain(sourceGoal?.id);
    expect(sourceCapability?.coverage_gap).toContain('Selected for this run');
  });

  it('uses data-grid and documentation scaffolds for DataTables-style example pages', async () => {
    const result = await runDiscovery({
      url: 'https://datatables.example',
      observation_summary:
        'Developer example page with DataTables live employee table, table Search input, entries-per-page selector, sortable Age column, and visible Javascript source-code tab.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A DataTables developer example with a live data grid.',
          product_use_contract: {
            product_kinds: ['developer_tool', 'dashboard_filtering'],
            primary_value_loop:
              'Use the live DataTables employee grid and read source code needed to reproduce it.',
            core_artifacts: ['filtered table state', 'visible implementation snippet'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Filter the employee table',
                journey_id: 'J1',
                scenario_brief:
                  'Use the in-table Search field to find London employees and verify rows/count update.',
                test_data: ['Search query: London'],
                required_actions: [],
                required_outputs: ['Search: London', 'filtered from 57 total entries'],
                expected_artifact: 'Filtered DataTable state',
                risk: 'high',
              },
              {
                id: 'PU2',
                title: 'Inspect the initialization code',
                journey_id: 'J2',
                scenario_brief:
                  'Use the Javascript example area to confirm the initialization snippet and CDN dependency.',
                test_data: [
                  "Snippet: new DataTable('#example');",
                  'Dependency: https://cdn.datatables.net/2.3.8/js/dataTables.js',
                ],
                required_actions: ['Open or confirm the Javascript tab.'],
                required_outputs: ["new DataTable('#example');"],
                expected_artifact: 'Visible DataTables implementation instructions',
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Employee DataTable with Search, Age column, and entries selector',
              kind: 'table',
              url: 'https://datatables.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'Javascript source-code tab and CDN dependencies',
              kind: 'content',
              url: 'https://datatables.example',
              source: 'primary_journey',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Filter employee table',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Filter grid rows.',
              suggested_goal:
                'Search London and verify the DataTable filtered count and rows update.',
              expected_evidence: ['London', 'filtered from 57 total entries'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Read implementation code',
              priority: 'should',
              goal_class: 'secondary_workflow',
              surface_ids: ['S2'],
              user_intent: 'Learn how to reproduce the table.',
              suggested_goal:
                "Inspect Javascript code and verify new DataTable('#example'); is visible.",
              expected_evidence: ["new DataTable('#example');"],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1', 'J2'],
            deferred_surface_ids: [],
            rationale: 'Live grid and source code are both material.',
            coverage_risk: 'medium',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.product_use_contract?.product_kinds).toEqual(
      expect.arrayContaining(['data_grid', 'developer_documentation']),
    );
    const docsJob = result.output.product_use_contract?.user_jobs.find((job) =>
      /new DataTable|javascript|dependency|implementation/i.test(
        [job.title, job.scenario_brief, job.expected_artifact, ...job.required_outputs].join(' '),
      ),
    );
    expect(docsJob).toBeDefined();
    expect(docsJob?.required_actions.join('\n')).not.toMatch(/settings|preferences|help/i);
    expect(docsJob?.proof_obligations.join('\n')).toContain('developer-facing instructions');
    expect(
      [docsJob?.expected_artifact, ...(docsJob?.required_outputs ?? [])].join('\n'),
    ).not.toMatch(/changed table rows|changed data-grid/i);
    const selectedJourneyIds = result.output.coverage_plan?.selected_journey_ids ?? [];
    expect(selectedJourneyIds[0]).toBe('J1');
    expect(selectedJourneyIds).toEqual(expect.arrayContaining(['J1', 'J2']));
    const selectedJourneyText = result.output.journeys
      .filter((journey) => selectedJourneyIds.includes(journey.id))
      .map((journey) => `${journey.title} ${journey.suggested_goal}`)
      .join('\n');
    expect(selectedJourneyText).toMatch(/table|filter|implementation|code/i);
    expect(result.output.coverage_plan?.deferred_surface_ids).not.toContain('S2');
    const goalDescriptions = result.output.goals.map((goal) => goal.description).join('\n');
    expect(goalDescriptions).toMatch(/implementation|javascript|new DataTable|dependency/i);
    expect(goalDescriptions).not.toMatch(/visible content navigation|section anchors|citations/i);
    expect(goalDescriptions).toMatch(/table|row|count|order|range/i);
    const explorerContext = formatDiscoveryExplorerContext(result.output);
    expect(explorerContext).toContain('Filter the employee table');
    expect(explorerContext).toMatch(/sort|page|entries|pagination|row order|salary/i);
    expect(explorerContext).toContain('Inspect implementation documentation');
    expect(explorerContext).toContain('Read implementation code');
    expect(result.output.coverage_plan?.rationale).not.toMatch(
      /Closed Discovery capability gaps.*implementation|source-code|documentation/i,
    );
    expect(result.output.capabilities.map((capability) => capability.label)).toContain(
      'Filter data-grid rows',
    );
  });

  it('keeps same-journey data-grid scenarios attached to their own product-use jobs', async () => {
    const result = await runDiscovery({
      url: 'https://datatables.example',
      observation_summary:
        'DataTables employee table with table Search, sortable Age column, entries selector, and pagination.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A live employee data grid.',
          product_use_contract: {
            product_kinds: ['data_grid'],
            primary_value_loop: 'Use employee table controls and verify changed grid state.',
            core_artifacts: ['changed employee table state'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Filter the employee table to London rows',
                journey_id: 'J1',
                scenario_brief: 'Use table Search to filter London office rows.',
                required_actions: [],
                required_outputs: ['London', 'filtered from 57 total entries'],
                expected_artifact: 'Filtered employee rows',
                risk: 'high',
              },
              {
                id: 'PU2',
                title: 'Sort employees by age',
                journey_id: 'J1',
                scenario_brief: 'Sort the employee table by Age ascending.',
                required_actions: [],
                required_outputs: ['Age', '19', '20', '21'],
                expected_artifact: 'Age-sorted employee rows',
                risk: 'high',
              },
              {
                id: 'PU3',
                title: 'Change page length and move to the next page',
                journey_id: 'J1',
                scenario_brief: 'Set page length to 25 and navigate to page 2.',
                required_actions: [],
                required_outputs: ['25 entries per page', 'Showing 26 to 50 of 57 entries'],
                expected_artifact: 'Second page of employee rows',
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Employee data grid controls',
              kind: 'table',
              url: 'https://datatables.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Use employee grid controls',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Change the employee table state.',
              suggested_goal: 'Use table controls and verify changed rows.',
              expected_evidence: ['changed row state'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Grid controls are the product.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Filter the employee table for London rows.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
            {
              id: 'G2',
              description: 'Sort the employee table by Age and verify ascending ages.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
            {
              id: 'G3',
              description: 'Set 25 entries per page and verify Showing 26 to 50 of 57 entries.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
            {
              id: 'G4',
              description: 'Use employee grid controls and verify the table changes.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const descriptions = result?.output.goals.map((goal) => goal.description) ?? [];
    expect(descriptions[1]).toContain('Sort the employee table by Age ascending');
    expect(descriptions[1]).not.toContain('London');
    expect(descriptions[2]).toContain('Showing 26 to 50 of 57 entries');
    expect(descriptions[2]).not.toContain('London');
    expect(descriptions).toHaveLength(3);
    expect(descriptions.join('\n')).not.toContain('Use employee grid controls');
  });

  it('uses selected product-use jobs to avoid duplicate data-grid capability repair goals', async () => {
    const result = await runDiscovery({
      url: 'https://datatables.example',
      observation_summary:
        'DataTables employee table with London rows, sortable Salary column, entries selector, and pagination.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A live employee data grid.',
          product_use_contract: {
            product_kinds: ['data_grid'],
            primary_value_loop: 'Use employee table controls and verify changed grid state.',
            core_artifacts: ['changed employee table state'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Filter the employee table to London rows',
                journey_id: 'J1',
                scenario_brief: 'Use table Search to filter London office rows.',
                required_actions: [],
                required_outputs: ['London', 'filtered from 57 total entries'],
                expected_artifact: 'Filtered employee rows',
                risk: 'high',
              },
              {
                id: 'PU2',
                title: 'Sort employees by salary',
                journey_id: 'J1',
                scenario_brief: 'Sort the Salary column descending and verify salary-ordered rows.',
                required_actions: [],
                required_outputs: ['Salary', '$1,200,000'],
                expected_artifact: 'Salary-sorted employee rows',
                risk: 'high',
              },
              {
                id: 'PU3',
                title: 'Change page length and move to the next page',
                journey_id: 'J1',
                scenario_brief: 'Set page length to 25 and navigate to page 2.',
                required_actions: [],
                required_outputs: ['25', 'Showing 26 to 50 of 57 entries'],
                expected_artifact: 'Second page of employee rows',
                risk: 'medium',
              },
            ],
          },
          capabilities: [
            {
              id: 'C1',
              label: 'Filter data-grid rows',
              product_kind: 'data_grid',
              importance: 'core',
              status: 'selected',
              confidence: 0.9,
              source: 'model',
              evidence: [],
              scenario_ids: ['G1'],
              journey_ids: ['J1'],
              surface_ids: ['S1'],
              denominator_reason: 'Filtering is core table use.',
              coverage_gap: '',
            },
            {
              id: 'C2',
              label: 'Sort data-grid rows by a numeric column',
              product_kind: 'data_grid',
              importance: 'core',
              status: 'deferred',
              confidence: 0.9,
              source: 'model',
              evidence: [],
              scenario_ids: [],
              journey_ids: [],
              surface_ids: ['S1'],
              denominator_reason: 'Sorting is core table use.',
              coverage_gap: 'Covered by selected product-use job.',
            },
            {
              id: 'C3',
              label: 'Change page length and pagination',
              product_kind: 'data_grid',
              importance: 'core',
              status: 'deferred',
              confidence: 0.9,
              source: 'model',
              evidence: [],
              scenario_ids: [],
              journey_ids: [],
              surface_ids: ['S1'],
              denominator_reason: 'Pagination is core table use.',
              coverage_gap: 'Covered by selected product-use job.',
            },
          ],
          surfaces: [
            {
              id: 'S1',
              label: 'Employee data grid controls',
              kind: 'table',
              url: 'https://datatables.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Filter the employee table to London rows',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Filter the employee table.',
              suggested_goal:
                'Use the table Search field for London and verify London rows plus filtered count.',
              expected_evidence: ['London rows', 'filtered count'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Grid controls are the product.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description:
                'Use the table Search field for London and verify London rows plus filtered count.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const descriptions = result?.output.goals.map((goal) => goal.description) ?? [];
    const joined = descriptions.join('\n');
    expect(descriptions).toHaveLength(3);
    expect(descriptions.filter((description) => /London/.test(description))).toHaveLength(1);
    expect(joined).toMatch(/Salary|\$1,200,000/);
    expect(joined).toMatch(/25|Showing 26 to 50/);
    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1']);
  });

  it('repairs underselected developer data-grid plans instead of accepting one paginated goal', async () => {
    const result = await runDiscovery({
      url: 'https://datatables.example',
      observation_summary:
        'DataTables employee grid with Search, sortable Salary and Age columns, page length selector, pagination, and Javascript code tabs.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A developer example page for an interactive data grid.',
          product_use_contract: {
            product_kinds: ['data_grid', 'developer_documentation'],
            primary_value_loop: 'Verify live grid behavior and inspect implementation code.',
            core_artifacts: ['changed table state', 'implementation snippet'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Filter and sort the live demo table',
                journey_id: 'J1',
                scenario_brief:
                  'Filter the employee table for London and sort the filtered rows by Salary.',
                required_actions: [],
                required_outputs: ['London', '$1,200,000'],
                expected_artifact: 'Filtered or sorted rows',
                risk: 'high',
              },
              {
                id: 'PU2',
                title: 'Change page size and paginate the employee table',
                journey_id: 'J2',
                scenario_brief: 'Select 25 entries per page, go to page 2, and verify row range.',
                required_actions: [],
                required_outputs: ['Showing 26 to 50 of 57 entries'],
                expected_artifact: 'Paginated rows',
                risk: 'high',
              },
              {
                id: 'PU3',
                title: 'Inspect implementation code for the example',
                journey_id: 'J3',
                scenario_brief:
                  "Open the Javascript code tab and verify new DataTable('#example'); is visible.",
                required_actions: [],
                required_outputs: ["new DataTable('#example');", 'dataTables.js'],
                expected_artifact: 'Implementation snippet',
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Employee DataTable with Search, Salary, page length, and pagination',
              kind: 'table',
              url: 'https://datatables.example',
              source: 'initial',
              value: 'core',
              confidence: 0.95,
            },
            {
              id: 'S2',
              label: 'Javascript code tab and dependency links',
              kind: 'content',
              url: 'https://datatables.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Filter and sort the live demo table',
              priority: 'must',
              goal_class: 'sample',
              surface_ids: ['S1'],
              user_intent: 'Validate search and sort behavior.',
              suggested_goal: 'Filter the employee table for London and sort by Salary.',
              expected_evidence: ['London rows', '$1,200,000'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Change page size and paginate the employee table',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Validate pagination.',
              suggested_goal: 'Select 25 entries per page and go to page 2.',
              expected_evidence: ['Showing 26 to 50 of 57 entries'],
              risk: 'high',
            },
            {
              id: 'J3',
              title: 'Inspect implementation code for the example',
              priority: 'should',
              goal_class: 'sample',
              surface_ids: ['S2'],
              user_intent: 'Learn implementation details.',
              suggested_goal:
                "Open the Javascript code tab and verify new DataTable('#example'); is visible.",
              expected_evidence: ["new DataTable('#example');", 'dataTables.js'],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J2'],
            deferred_surface_ids: [],
            rationale: 'Model selected only pagination.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Select 25 entries per page and go to page 2.',
              priority: 'must',
              journey_id: 'J2',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const selected = result?.output.coverage_plan?.selected_journey_ids ?? [];
    expect(selected).toEqual(expect.arrayContaining(['J1', 'J2', 'J3']));
    const goals = result?.output.goals.map((goal) => goal.description).join('\n') ?? '';
    expect(goals).toContain('Filter the employee table for London');
    expect(goals).toContain("new DataTable('#example');");
  });

  it('drops generic calculator priors from developer data-grid pages', async () => {
    const result = await runDiscovery({
      url: 'https://datatables.example',
      observation_summary:
        'DataTables developer example with a live employee table, Search field, sortable Salary column, pagination, and Javascript code tabs.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description:
            'A DataTables developer documentation page with a live searchable, sortable employee table.',
          product_use_contract: {
            product_kinds: ['developer_documentation', 'calculator_tool'],
            primary_value_loop:
              'Developers inspect a live DataTables example and its implementation code.',
            core_artifacts: ['changed employee table state', 'implementation snippet'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Filter the employee table to London records',
                journey_id: 'J1',
                scenario_brief: 'Use the demo table Search field to show London rows.',
                required_actions: [],
                required_outputs: ['London', 'filtered from 57 total entries'],
                expected_artifact: 'Filtered employee table rows',
                risk: 'high',
              },
              {
                id: 'PU2',
                title: 'Read the zero-configuration implementation code',
                journey_id: 'J2',
                scenario_brief:
                  "Open the Javascript tab and verify new DataTable('#example'); plus dataTables.js.",
                required_actions: [],
                required_outputs: ["new DataTable('#example');", 'dataTables.js'],
                expected_artifact: 'Visible implementation snippet',
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Employee DataTable Search Salary pagination',
              kind: 'table',
              url: 'https://datatables.example',
              source: 'initial',
              value: 'core',
              confidence: 0.95,
            },
            {
              id: 'S2',
              label: 'Javascript code tab and dependency links',
              kind: 'content',
              url: 'https://datatables.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Filter the employee table to London records',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Filter table rows.',
              suggested_goal: 'Search for London and verify filtered table rows.',
              expected_evidence: ['London', 'filtered from 57 total entries'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Read the zero-configuration implementation code',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S2'],
              user_intent: 'Inspect implementation details.',
              suggested_goal:
                "Open the Javascript tab and verify new DataTable('#example'); plus dataTables.js.",
              expected_evidence: ["new DataTable('#example');", 'dataTables.js'],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Model selected one table goal.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Search for London and verify filtered table rows.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.product_use_contract?.product_kinds).not.toContain('calculator_tool');
    expect(result?.output.goals.map((goal) => goal.description).join('\n')).not.toMatch(
      /calculate|computed result|non-default values/i,
    );
    expect(result?.output.goals.map((goal) => goal.description).join('\n')).toContain(
      "new DataTable('#example');",
    );
  });

  it('keeps generic data-grid scaffolds domain-neutral unless employee data is present', async () => {
    const result = await runDiscovery({
      url: 'https://inventory.example',
      observation_summary:
        'Inventory data grid with Search, sortable Age column for item age in days, and an entries-per-page selector.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'An inventory data grid.',
          product_use_contract: {
            product_kinds: ['data_grid'],
            primary_value_loop: 'Inspect and sort inventory rows.',
            core_artifacts: ['changed inventory row state'],
            value_loops: [],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Inventory grid with Search, Age column, and page length selector',
              kind: 'table',
              url: 'https://inventory.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Sort inventory by age',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Sort inventory rows.',
              suggested_goal: 'Sort the Age column and verify row order changes.',
              expected_evidence: ['Age column sorted'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Sorting is core.',
            coverage_risk: 'low',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const text = [
      ...(result?.output.product_use_contract?.user_jobs ?? []).flatMap((job) => [
        job.title,
        job.scenario_brief,
        ...job.required_outputs,
      ]),
      ...(result?.output.goals ?? []).map((goal) => goal.description),
    ].join('\n');
    expect(text).toMatch(/Sort the Age column|Age column sorted/i);
    expect(text).not.toMatch(/employee|London|Page length option: 25/i);
  });

  it('drops invalid product-use journey ids and still shows unlinked jobs in Explorer context', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'Table product with a search control.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A searchable table.',
          product_use_contract: {
            product_kinds: ['data_grid'],
            primary_value_loop: 'Filter table rows.',
            core_artifacts: ['filtered rows'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Filter table rows',
                journey_id: 'J-missing',
                scenario_brief: 'Filter table rows by a concrete query.',
                required_actions: [],
                proof_obligations: [],
                expected_artifact: 'filtered rows',
                acceptable_evidence: [],
                test_data: ['Query: Alpha'],
                required_outputs: ['Alpha'],
                quality_bar: [],
                weak_evidence: [],
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Searchable data table',
              kind: 'table',
              url: 'https://example.com',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Filter table rows',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Filter rows.',
              suggested_goal: 'Filter table rows by Alpha and verify row output changes.',
              expected_evidence: ['Alpha'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Primary row filtering.',
            coverage_risk: 'low',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    const job = result.output.product_use_contract?.user_jobs.find(
      (candidate) => candidate.id === 'PU1',
    );
    expect(job?.journey_id).toBe('J1');
    expect(job?.journey_id).not.toBe('J-missing');
    expect(formatDiscoveryExplorerContext(result.output)).toContain('Filter table rows');
  });

  it('keeps calculator reference and related-link coverage out of seed goals', async () => {
    const result = await runDiscovery({
      url: 'https://calculator.example/bmi',
      observation_summary:
        'BMI Calculator with US Units, Metric Units, Other Units, adult BMI table, child/teen reference tables, CDC PDF charts, related Body Fat calculator link, and site search.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A BMI calculator with supporting reference content.',
          product_use_contract: {
            product_kinds: ['calculator_tool', 'developer_documentation'],
            primary_value_loop:
              'A user enters height and weight, calculates BMI, and sees the resulting BMI value and category.',
            core_artifacts: ['BMI result value and category'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Calculate BMI in US units',
                journey_id: 'J1',
                scenario_brief:
                  'Calculate BMI for a 32-year-old adult who is 6 feet 0 inches and 210 pounds.',
                required_actions: [],
                required_outputs: ['BMI', 'Overweight'],
                expected_artifact: 'BMI result panel',
                risk: 'high',
              },
              {
                id: 'PU2',
                title: 'Read BMI reference content',
                journey_id: 'J2',
                scenario_brief:
                  'Scroll to the adult BMI table and child/teen section, then sample a Chart for boys PDF link.',
                required_actions: [],
                required_outputs: [
                  'Metric Units tab active',
                  'BMI table for adults',
                  'Chart for boys',
                ],
                expected_artifact: 'Readable BMI reference content',
                risk: 'medium',
              },
              {
                id: 'PU3',
                title: 'Find related calculator',
                journey_id: 'J3',
                scenario_brief:
                  'Use a related calculator link to open the Body Fat Calculator page.',
                required_actions: [],
                required_outputs: ['Other Units tab active', 'Body Fat Calculator'],
                expected_artifact: 'Related calculator destination',
                risk: 'medium',
              },
              {
                id: 'PU4',
                title: 'Clear calculator form',
                journey_id: 'J4',
                scenario_brief:
                  'After entering non-default values, click Clear and verify the form resets to default state.',
                required_actions: [],
                required_outputs: ['Inputs reset or defaults restored'],
                expected_artifact: 'Reset calculator form',
                risk: 'medium',
              },
            ],
          },
          capabilities: [
            {
              id: 'C1',
              label: 'Use BMI result and reference table to interpret category',
              product_kind: 'calculator_tool',
              importance: 'important',
              status: 'deferred',
              confidence: 0.8,
              source: 'model',
              evidence: ['BMI table is visible below the calculator.'],
              scenario_ids: [],
              journey_ids: ['J2'],
              surface_ids: ['S2'],
              denominator_reason:
                'Reference tables can help users interpret a calculated BMI result.',
              coverage_gap: 'Reference content can be deferred after primary calculation proof.',
            },
            {
              id: 'C2',
              label: 'Print or save a calculation result',
              product_kind: 'calculator_tool',
              importance: 'important',
              status: 'deferred',
              confidence: 0.7,
              source: 'model',
              evidence: ['Print link is visible near results.'],
              scenario_ids: [],
              journey_ids: [],
              surface_ids: ['S2'],
              denominator_reason: 'Printing is a support utility for calculated results.',
              coverage_gap: 'Print/save can be deferred for a normal calculator-user audit.',
            },
            {
              id: 'C3',
              label:
                'Interpret calculated BMI with category, healthy range, BMI Prime, and Ponderal Index',
              product_kind: 'calculator_tool',
              importance: 'important',
              status: 'deferred',
              confidence: 0.8,
              source: 'model',
              evidence: ['BMI result details are visible after calculation.'],
              scenario_ids: [],
              journey_ids: [],
              surface_ids: ['S1'],
              denominator_reason:
                'BMI calculators should explain the computed number with category and range details.',
              coverage_gap: 'Covered by selected calculation scenarios.',
            },
            {
              id: 'C4',
              label: 'Find a related BMR calculator from the BMI page',
              product_kind: 'calculator_tool',
              importance: 'important',
              status: 'deferred',
              confidence: 0.7,
              source: 'model',
              evidence: ['Related calculator links are visible.'],
              scenario_ids: [],
              journey_ids: [],
              surface_ids: ['S3'],
              denominator_reason: 'Related calculators are support navigation.',
              coverage_gap: 'Related calculators can be deferred after primary calculation proof.',
            },
          ],
          surfaces: [
            {
              id: 'S1',
              label: 'BMI calculator form and result panel',
              kind: 'form',
              url: 'https://calculator.example/bmi',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'Adult BMI table and child teen CDC chart PDFs',
              kind: 'content',
              url: 'https://calculator.example/bmi#reference',
              source: 'scroll',
              value: 'important_secondary',
              confidence: 0.8,
            },
            {
              id: 'S3',
              label: 'Related calculators and Body Fat link',
              kind: 'nav',
              url: 'https://calculator.example/bmi#related',
              source: 'scroll',
              value: 'important_secondary',
              confidence: 0.8,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Calculate BMI in US units',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Calculate a personal BMI result.',
              suggested_goal:
                'Calculate BMI for a 32-year-old adult who is 6 feet 0 inches and 210 pounds, then verify BMI and Overweight category.',
              expected_evidence: ['BMI', 'Overweight'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Use BMI reference content',
              priority: 'should',
              goal_class: 'secondary_workflow',
              surface_ids: ['S2'],
              user_intent: 'Interpret BMI using reference tables.',
              suggested_goal:
                'Scroll to the adult BMI table and child/teen section, verify category ranges, and sample the Chart for boys PDF link.',
              expected_evidence: ['BMI table for adults', 'Chart for boys'],
              risk: 'medium',
            },
            {
              id: 'J3',
              title: 'Find a related health calculator',
              priority: 'should',
              goal_class: 'secondary_workflow',
              surface_ids: ['S3'],
              user_intent: 'Navigate to related calculator content.',
              suggested_goal:
                'Find the Body Fat Calculator using the related calculator link and verify the destination page matches.',
              expected_evidence: ['Body Fat Calculator'],
              risk: 'medium',
            },
            {
              id: 'J4',
              title: 'Clear calculator form',
              priority: 'should',
              goal_class: 'secondary_workflow',
              surface_ids: ['S1'],
              user_intent: 'Reset calculator inputs.',
              suggested_goal:
                'After entering non-default values, click Clear and verify the form resets to default state.',
              expected_evidence: ['Inputs reset or defaults restored'],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1', 'J2', 'J3', 'J4'],
            deferred_surface_ids: [],
            rationale: 'Calculator, reference, and related calculator coverage selected.',
            coverage_risk: 'medium',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.product_use_contract?.product_kinds).toEqual(['calculator_tool']);
    expect(result.output.coverage_plan?.selected_journey_ids).toEqual(['J1']);
    expect(result.output.coverage_plan?.deferred_surface_ids).toEqual(
      expect.arrayContaining(['S2', 'S3']),
    );
    expect(result.output.goals).toHaveLength(1);
    expect(result.output.goals[0]?.description).toContain('Calculate BMI');
    expect(result.output.goals.map((goal) => goal.description).join('\n')).not.toMatch(
      /reference|child|teen|chart|pdf|related|body fat|clear|reset/i,
    );
    expect(
      result.output.product_use_contract?.user_jobs
        .flatMap((job) => job.required_outputs)
        .join('\n'),
    ).not.toMatch(/units tab active/i);
    expect(
      result.output.capabilities.find((capability) =>
        /related bmr|related calculator/i.test(capability.label),
      )?.status,
    ).not.toBe('selected');
    expect(
      result.output.capabilities.find((capability) => /clear calculator/i.test(capability.label))
        ?.status,
    ).not.toBe('selected');
  });

  it('does not silently drop product-native content tools when the model labels them setup', async () => {
    const result = await runDiscovery({
      url: 'https://wiki.example',
      observation_summary:
        'Searchable article product with article content, references, and View history.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A searchable article site.',
          product_use_contract: {
            product_kinds: ['search_content', 'content_site'],
            primary_value_loop: 'Search for and read article content.',
            core_artifacts: ['loaded article'],
            value_loops: [],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Search input and article content',
              kind: 'search',
              url: 'https://wiki.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'References and View history article tools',
              kind: 'nav',
              url: 'https://wiki.example/article',
              source: 'primary_journey',
              value: 'important_secondary',
              confidence: 0.85,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Search and read article',
              priority: 'must',
              surface_ids: ['S1'],
              user_intent: 'Find and read a topic.',
              suggested_goal: 'Search for OpenAI and verify article content loads.',
              expected_evidence: ['article title and body text'],
              risk: 'high',
              goal_class: 'core',
            },
            {
              id: 'J2',
              title: 'Inspect article history',
              priority: 'should',
              surface_ids: ['S2'],
              user_intent: 'Inspect article provenance.',
              suggested_goal: 'Open View history and verify revision entries.',
              expected_evidence: ['revision entries'],
              risk: 'medium',
              goal_class: 'setup',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: ['S2'],
            rationale: 'Model selected only the search path.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Search for OpenAI and verify article content loads.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    const contentTools = result.output.capabilities.find(
      (capability) => capability.label === 'Use visible content tools',
    );
    expect(contentTools?.selection_expectation).toBe('should_test_or_explain');
    expect(contentTools?.status).toBe('selected');
    expect(contentTools?.scenario_ids.length).toBeGreaterThan(0);
    expect(result.output.goals.map((goal) => goal.description).join('\n')).toMatch(
      /history|edit|talk/i,
    );
  });

  it('keeps search and open-result capabilities distinct when deriving report coverage', () => {
    const capabilities = deriveDiscoveryCapabilitiesForReport({
      product_use_contract: {
        product_kinds: ['search_content', 'content_site'],
        primary_value_loop: 'Search for and read article content.',
        core_artifacts: ['loaded article page'],
        value_loops: [
          {
            id: 'VL1',
            title: 'Find and read content',
            artifact: 'loaded article',
            required_capabilities: [
              'search, navigate, or choose content',
              'open and consume a content result',
            ],
            proof_obligations: ['article body visible'],
            weak_evidence: ['homepage only'],
          },
        ],
        user_jobs: [],
      },
      capabilities: [
        {
          id: 'C1',
          label: 'Open and read a content result',
          product_kind: 'search_content',
          importance: 'core',
          status: 'selected',
          confidence: 0.9,
          source: 'model',
          evidence: ['article loaded'],
          scenario_ids: ['G1'],
          journey_ids: ['J1'],
          surface_ids: ['S2'],
          denominator_reason: 'Search result must be readable.',
          coverage_gap: '',
        },
        {
          id: 'C2',
          label: 'Use visible content tools',
          product_kind: 'search_content',
          importance: 'core',
          status: 'selected',
          confidence: 0.9,
          source: 'model',
          evidence: ['language selector visible'],
          scenario_ids: ['G1'],
          journey_ids: ['J1'],
          surface_ids: ['S3'],
          denominator_reason: 'Visible content tools support reading.',
          coverage_gap: '',
        },
      ],
      journeys: [
        {
          id: 'J1',
          title: 'Search and read article',
          priority: 'must',
          surface_ids: ['S1', 'S2'],
          user_intent: 'Find content',
          suggested_goal: 'Search for OpenAI and verify article content loads.',
          expected_evidence: ['article content'],
          risk: 'high',
          goal_class: 'core',
        },
      ],
      surfaces: [
        {
          id: 'S1',
          label: 'Search input',
          kind: 'search',
          url: 'https://content.example',
          source: 'initial',
          value: 'core',
          confidence: 0.9,
          evidence: [],
          controls: [],
          prerequisites: [],
        },
        {
          id: 'S2',
          label: 'Article content result',
          kind: 'content',
          url: 'https://content.example/article',
          source: 'primary_journey',
          value: 'core',
          confidence: 0.9,
          evidence: [],
          controls: [],
          prerequisites: [],
        },
        {
          id: 'S3',
          label: 'Language selector',
          kind: 'menu',
          url: 'https://content.example/article',
          source: 'primary_journey',
          value: 'important_secondary',
          confidence: 0.9,
          evidence: [],
          controls: [],
          prerequisites: [],
        },
      ],
      coverage_plan: {
        selected_journey_ids: ['J1'],
        deferred_surface_ids: [],
        rationale: 'Search and reading selected.',
        coverage_risk: 'low',
      },
      goals: [
        {
          id: 'G1',
          description: 'Search for OpenAI and verify article content loads.',
          priority: 'must',
          journey_id: 'J1',
          surface_ids: ['S1', 'S2'],
          goal_class: 'core',
        },
      ],
    });

    expect(
      capabilities.filter((capability) => capability.label === 'Search for specific content'),
    ).toHaveLength(1);
    expect(
      capabilities.filter((capability) => capability.label === 'Open and read a content result'),
    ).toHaveLength(1);
    expect(
      capabilities.filter((capability) => capability.label === 'Use visible content tools'),
    ).toHaveLength(1);
  });

  it('keeps non-could core and contract-backed journeys selected when coverage under-selects', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'Canvas editor with shape, text, export, and share controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor', 'auth_account'],
            primary_value_loop: 'Create and share a visible board artifact.',
            core_artifacts: ['styled board objects', 'share/auth surface for the board'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Enter sharing flow',
                journey_id: 'J3',
                required_actions: ['click Share'],
                expected_artifact: 'share or sign-in surface tied to the board',
                acceptable_evidence: ['share/auth surface opens'],
                weak_evidence: ['Share button focused only'],
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Canvas and creation toolbar',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Expanded shape palette',
              kind: 'menu',
              url: 'https://draw.example',
              source: 'menu_peek',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
            {
              id: 'S3',
              label: 'Share',
              kind: 'account',
              url: 'https://draw.example',
              source: 'initial',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a diagram',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Make useful board content',
              suggested_goal: 'Create a diagram with a rectangle and label.',
              expected_evidence: ['visible diagram artifact'],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Add a non-default shape',
              priority: 'should',
              goal_class: 'core',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Use richer creation tools',
              suggested_goal: 'Add a non-default shape such as a cloud or star.',
              expected_evidence: ['non-default shape appears on the board'],
              risk: 'medium',
            },
            {
              id: 'J3',
              title: 'Enter sharing flow',
              priority: 'should',
              goal_class: 'setup',
              surface_ids: ['S3'],
              user_intent: 'Share the board with another person',
              suggested_goal: 'Click Share and verify a share or sign-in surface opens.',
              expected_evidence: ['share or sign-in surface opens for the board'],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Under-selected only the first journey.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Create a diagram with a rectangle and label.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(['core', 'secondary_workflow']).toContain(
      result?.output.journeys.find((journey) => journey.id === 'J3')?.goal_class,
    );
    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1', 'J2', 'J3']);
    expect(result?.output.goals.map((goal) => goal.journey_id)).toEqual(['J1', 'J2', 'J3']);
  });

  it('uses detailed survey surfaces when the model summarizes a rich artifact editor', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'Canvas editor with a summarized toolbar.',
      survey_payload: {
        v: 2,
        surfaces: [
          {
            id: 'S001',
            label: 'Whiteboard canvas',
            kind: 'content',
            url: 'https://draw.example',
            source: 'initial',
            value: 'core',
            confidence: 0.95,
            evidence: [],
          },
          {
            id: 'S010',
            label: 'Text — T',
            kind: 'toolbar',
            url: 'https://draw.example',
            source: 'initial',
            value: 'important_secondary',
            confidence: 0.9,
            evidence: [],
          },
          {
            id: 'S011',
            label: 'Note — N',
            kind: 'toolbar',
            url: 'https://draw.example',
            source: 'initial',
            value: 'important_secondary',
            confidence: 0.9,
            evidence: [],
          },
          {
            id: 'S012',
            label: 'Arrow — A',
            kind: 'toolbar',
            url: 'https://draw.example',
            source: 'initial',
            value: 'important_secondary',
            confidence: 0.9,
            evidence: [],
          },
          {
            id: 'S013',
            label: 'Media — command U',
            kind: 'toolbar',
            url: 'https://draw.example',
            source: 'initial',
            value: 'important_secondary',
            confidence: 0.9,
            evidence: [],
          },
          {
            id: 'S014',
            label: 'Duplicate — command D',
            kind: 'toolbar',
            url: 'https://draw.example',
            source: 'initial',
            value: 'important_secondary',
            confidence: 0.9,
            evidence: [],
          },
          {
            id: 'S015',
            label: 'Export',
            kind: 'menu',
            url: 'https://draw.example',
            source: 'menu_peek',
            value: 'important_secondary',
            confidence: 0.9,
            evidence: [],
          },
          {
            id: 'S016',
            label: 'Share',
            kind: 'account',
            url: 'https://draw.example',
            source: 'initial',
            value: 'important_secondary',
            confidence: 0.9,
            evidence: [],
          },
        ],
      },
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and preserve a visible board artifact.',
            core_artifacts: ['styled board content'],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Create a styled shape',
                journey_id: 'J1',
                required_actions: ['draw a shape', 'change color'],
                expected_artifact: 'styled shape on canvas',
                acceptable_evidence: ['visible styled shape'],
                weak_evidence: ['toolbar selected only'],
                risk: 'high',
              },
              {
                id: 'PU2',
                title: 'Draw or connect two points on the canvas',
                required_actions: ['switch to Draw or Arrow', 'drag on the canvas'],
                expected_artifact: 'visible freehand stroke, arrow, or connector',
                acceptable_evidence: ['visible drawn line or arrow'],
                weak_evidence: ['draw tool highlighted only'],
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S001',
              label: 'Whiteboard canvas',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.95,
              evidence: [],
            },
            {
              id: 'S002',
              label: 'Primary drawing toolbar',
              kind: 'toolbar',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a styled shape',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S001', 'S002'],
              user_intent: 'Create visible board content',
              suggested_goal: 'Create a styled shape on the board.',
              expected_evidence: ['visible styled shape'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'The model only selected the summarized primary journey.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Create a styled shape on the board.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S001', 'S002'],
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const descriptions = result?.output.goals.map((goal) => goal.description).join('\n') ?? '';
    const labels = result?.output.surfaces.map((surface) => surface.label).join('\n') ?? '';
    expect(labels).toContain('Text — T');
    expect(descriptions).toContain('Launch plan');
    expect(descriptions).toContain('Risk: dependency');
    expect(descriptions).toContain('Draft');
    expect(descriptions).toContain('Review');
    expect(descriptions).toContain('Insert or upload a supporting media item');
    expect(descriptions).toContain('Export, download, or save');
    expect(result?.output.coverage_plan?.selected_journey_ids.length).toBeGreaterThanOrEqual(5);
  });

  it('does not let a could-priority page-menu utility suppress export coverage', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'Canvas editor with page menu export and download controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A browser whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and preserve board content.',
            core_artifacts: ['exported board artifact'],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Whiteboard canvas',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.95,
              evidence: [],
            },
            {
              id: 'S2',
              label: 'Page menu with Export, Download, Preferences, and Help',
              kind: 'menu',
              url: 'https://draw.example',
              source: 'menu_peek',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Reach page-menu destinations',
              priority: 'could',
              goal_class: 'core',
              surface_ids: ['S2'],
              user_intent: 'Inspect app-level destinations.',
              suggested_goal:
                'Open the Page menu and confirm representative export, download, settings, and help destinations are reachable.',
              expected_evidence: ['menu destinations are visible'],
              risk: 'low',
            },
          ],
          coverage_plan: {
            selected_journey_ids: [],
            deferred_surface_ids: [],
            rationale: 'Model treated the menu as utility.',
            coverage_risk: 'medium',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const descriptions = result?.output.goals.map((goal) => goal.description).join('\n') ?? '';
    expect(descriptions).toContain('Export, download, or save the current artifact');
    expect(descriptions).not.toContain('Page menu');
    expect(result?.output.coverage_plan?.selected_journey_ids).toContain(
      result?.output.goals.find((goal) => goal.description.includes('Export, download'))
        ?.journey_id,
    );
  });

  it('tells discovery to include downstream primary-journey product surfaces', async () => {
    let systemPrompt = '';
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'Homepage with search',
      survey_summary:
        '### after primary search journey\nOpenAI article\nContents\nReferences\nView history\nEdit',
      screenshot_path: '/tmp/x.png',
      discoverer: async (input) => {
        systemPrompt = input.systemPrompt;
        return {
          text: JSON.stringify({
            v: 1,
            target_kind_hint: 'web',
            product_description: 'x',
            goals: [
              {
                id: 'G1',
                description: 'Open article sections and verify article navigation works',
                priority: 'must',
              },
            ],
            focus_areas: [],
            hints: [],
            out_of_scope: [],
          }),
          cost_usd: 0,
        };
      },
    });
    expect(result).not.toBeNull();
    expect(systemPrompt).toContain('downstream pages from a primary journey');
    expect(systemPrompt).toContain('article section navigation');
    expect(systemPrompt).toContain('history/edit/talk affordances');
    expect(systemPrompt).toContain('fewer than several material scenarios');
  });

  it('supplements high-value article and account surfaces when discovery over-compresses', async () => {
    const result = await runDiscovery({
      url: 'https://www.wikipedia.org/',
      observation_summary: 'Wikipedia search homepage with donation and language links',
      survey_summary: [
        '### after primary search journey',
        'OpenAI',
        'Jump to content',
        'Contents hide',
        'Founding',
        'Services',
        'Article',
        'Talk',
        'Read',
        'Edit',
        'View history',
        'Create account',
        'Log in',
      ].join('\n'),
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 1,
          target_kind_hint: 'web',
          product_description: 'Wikipedia landing page.',
          goals: [
            {
              id: 'G1',
              description:
                'Find and open a specific article or topic from the main search entry point.',
              priority: 'must',
            },
            {
              id: 'G2',
              description: 'Choose a top-language link and verify the localized site opens.',
              priority: 'must',
            },
            {
              id: 'G3',
              description: 'Use the fundraiser prompt and verify the page state changes.',
              priority: 'should',
            },
            {
              id: 'G4',
              description:
                'Sample an article page’s core navigation surfaces, such as contents, section links, language switcher, and history/edit/talk tools.',
              priority: 'should',
            },
            {
              id: 'G5',
              description: 'Open a representative Wikimedia sister-project destination.',
              priority: 'should',
            },
            {
              id: 'G6',
              description: 'Check a representative legal/footer link.',
              priority: 'should',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const descriptions = result?.output.goals.map((goal) => goal.description).join('\n') ?? '';
    expect(descriptions).toContain('Create account or Log in');
    expect(descriptions).toContain('table-of-contents or section links');
    expect(descriptions).toContain('Talk, Edit, or View history');
  });

  it('instructs default discovery to value-rank surfaces instead of exploding peripheral links', async () => {
    let systemPrompt = '';
    let userPrompt = '';
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'Google Play Apple App Store Commons Wikivoyage Privacy Policy Terms',
      screenshot_path: '/tmp/x.png',
      discoverer: async (input) => {
        systemPrompt = input.systemPrompt;
        userPrompt = input.userPrompt;
        return {
          text: JSON.stringify({
            v: 1,
            target_kind_hint: 'web',
            product_description: 'x',
            goals: [
              { id: 'G1', description: 'Open Google Play', priority: 'should' },
              { id: 'G2', description: 'Open Apple App Store', priority: 'should' },
            ],
            focus_areas: [],
            hints: [],
            out_of_scope: [],
          }),
          cost_usd: 0,
        };
      },
    });
    expect(result).not.toBeNull();
    expect(systemPrompt).toContain('Default discovery is value-ranked');
    expect(systemPrompt).toContain('Google Play');
    expect(systemPrompt).toContain('Apple App Store');
    expect(systemPrompt).toContain('Privacy');
    expect(systemPrompt).toContain('Terms');
    expect(systemPrompt).toContain('usually one app-download coverage goal');
    expect(systemPrompt).toContain(
      'usually group them as one low-priority legal/footer coverage goal',
    );
    expect(userPrompt).toContain('value-rank');
    expect(userPrompt).toContain('group or defer peripheral destinations');
  });

  it('keeps grouped peripheral destination goals grouped', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary:
        'Footer links: Creative Commons License, Terms of Use, Privacy Policy. App links: Google Play Store, Apple App Store.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 1,
          target_kind_hint: 'web',
          product_description: 'x',
          goals: [
            {
              id: 'G1',
              description:
                'Open the Creative Commons license, Terms of Use, and Privacy Policy destinations from the footer and verify each legal page loads.',
              priority: 'should',
            },
            {
              id: 'G2',
              description:
                'Open the Google Play Store and Apple App Store links and verify each destination loads.',
              priority: 'should',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.goals.map((goal) => goal.id)).toEqual(['G1', 'G2']);
    expect(result?.output.goals.map((goal) => goal.description)).toEqual([
      'Open the Creative Commons license, Terms of Use, and Privacy Policy destinations from the footer and verify each legal page loads.',
      'Open the Google Play Store and Apple App Store links and verify each destination loads.',
    ]);
  });

  it('dedupes near-duplicate destination goals after normalization', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'App links: Google Play Store, Apple App Store.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 1,
          target_kind_hint: 'web',
          product_description: 'x',
          goals: [
            {
              id: 'G1',
              description:
                'Open the Apple App Store link and verify the App Store destination loads.',
              priority: 'should',
            },
            {
              id: 'G2',
              description:
                'Open the Apple App Store link for the Wikipedia app and verify the app store destination loads.',
              priority: 'should',
            },
            {
              id: 'G3',
              description:
                'Open the Google Play Store link and verify the Google Play destination loads.',
              priority: 'should',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    expect(result?.output.goals.map((goal) => goal.id)).toEqual(['G1', 'G2']);
    expect(result?.output.goals.map((goal) => goal.description)).toEqual([
      'Open the Apple App Store link and verify the App Store destination loads.',
      'Open the Google Play Store link and verify the Google Play destination loads.',
    ]);
  });

  it('carries exact visible scenario data into seed goal descriptions and Explorer context', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'Canvas editor with rectangle, arrow, export, and share controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A diagramming board.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create a diagram.',
            core_artifacts: ['diagram board'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Build a process diagram',
                journey_id: 'J1',
                scenario_brief:
                  'Create a release workflow board with labeled rectangles and connecting arrows.',
                test_data: [
                  'Rectangle labels: Backlog, In Review, Released',
                  'Arrow flow: Backlog -> In Review -> Released',
                  'Optional board title text: Release flow',
                ],
                required_outputs: ['Backlog', 'In Review', 'Released', 'Visible arrows'],
                quality_bar: ['Represents a realistic workflow, not a toy doodle'],
                required_actions: [],
                proof_obligations: [],
                expected_artifact: 'release workflow diagram',
                acceptable_evidence: [],
                weak_evidence: [],
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Canvas',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
              controls: [],
              prerequisites: [],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a process diagram',
              priority: 'must',
              surface_ids: ['S1'],
              user_intent: 'Create a visible workflow diagram.',
              suggested_goal: 'Create a release flow with three labeled stages and arrows.',
              expected_evidence: ['visible workflow diagram'],
              risk: 'high',
              goal_class: 'core',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Primary workflow.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Create a release flow with three labeled stages and arrows.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const description = result?.output.goals[0]?.description ?? '';
    expect(description).toContain('Backlog');
    expect(description).toContain('In Review');
    expect(description).toContain('Released');
    expect(description).not.toContain('Optional board title');

    if (!result) throw new Error('expected discovery result');
    const explorerContext = formatDiscoveryExplorerContext(result.output);
    expect(explorerContext).toContain(
      'exact visible content/data to use: Backlog; In Review; Released',
    );
    expect(explorerContext).not.toContain('use this concrete data/content');
  });

  it('dedupes duplicate artifact export scenarios after model and synthetic planning merge', async () => {
    const result = await runDiscovery({
      url: 'https://draw.example',
      observation_summary: 'Canvas editor with page menu, Export, Download, and Share controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A whiteboard editor.',
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and export a board.',
            core_artifacts: ['board artifact'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Export or download the created board',
                journey_id: 'J1',
                scenario_brief:
                  'Use the page menu to reach export or download for the board created in-session.',
                test_data: ['Use the current board created in the session'],
                required_outputs: ['visible export/download option, dialog, or file event'],
                quality_bar: ['Bound to created canvas content'],
                required_actions: ['open export or download'],
                proof_obligations: ['export path is tied to the board'],
                expected_artifact: 'board export',
                acceptable_evidence: [],
                weak_evidence: [],
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Canvas workspace',
              kind: 'content',
              url: 'https://draw.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
              evidence: [],
              controls: [],
              prerequisites: [],
            },
            {
              id: 'S2',
              label: 'Page menu with Export Download Share',
              kind: 'menu',
              url: 'https://draw.example',
              source: 'menu_peek',
              value: 'important_secondary',
              confidence: 0.9,
              evidence: [],
              controls: [],
              prerequisites: ['S1'],
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Export or download the board artifact',
              priority: 'should',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Take the created board out of the editor.',
              suggested_goal: 'Reach and trigger the export or download path.',
              expected_evidence: ['export/download option or file event'],
              risk: 'medium',
              goal_class: 'core',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Export is a core output path.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Reach and trigger the export or download path.',
              priority: 'should',
              journey_id: 'J1',
              surface_ids: ['S1', 'S2'],
              goal_class: 'core',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    const exportGoals = result?.output.goals.filter((goal) =>
      /export|download|save/i.test(goal.description),
    );
    expect(exportGoals).toHaveLength(1);
  });

  it('repairs underselected discovery plans with learned core capability journeys', async () => {
    const result = await runDiscovery({
      url: 'https://dashboard.example',
      observation_summary:
        'Analytics dashboard with visible metric cards, chart, date filter, segment filter, table rows, and detail drilldown.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A dashboard for filtering and inspecting product metrics.',
          product_use_contract: {
            product_kinds: ['dashboard_filtering'],
            primary_value_loop: 'Inspect metrics by changing dashboard views.',
            core_artifacts: ['changed dashboard view'],
            value_loops: [],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Metric dashboard chart and table',
              kind: 'content',
              url: 'https://dashboard.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'Date filter, segment filter, sort, and drilldown details',
              kind: 'toolbar',
              url: 'https://dashboard.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [],
          coverage_plan: {
            selected_journey_ids: [],
            deferred_surface_ids: [],
            rationale: 'Model underselected the dashboard.',
            coverage_risk: 'high',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.journeys.map((journey) => journey.title)).toContain(
      'Change the dashboard view with a real filter',
    );
    expect(result.output.goals.map((goal) => goal.description)).toContain(
      'Apply a visible filter, sort, or drilldown and verify the chart, table, metric, or result set changes.',
    );
    expect(
      result.output.capabilities.find(
        (capability) => capability.label === 'Change a dashboard view',
      )?.status,
    ).toBe('selected');
    expect(result.output.product_use_contract?.user_jobs[0]?.required_outputs).toContain(
      'changed chart, table, metric, or filtered data view',
    );
  });

  it('repairs underselected CRUD products into saved-entity scenarios', async () => {
    const result = await runDiscovery({
      url: 'https://work.example',
      observation_summary:
        'Issue tracker with New issue form, title input, status selector, assignee, labels, issue list, filters, and table rows.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A workflow tracker for creating and updating issues.',
          product_use_contract: {
            product_kinds: ['crud_workflow'],
            primary_value_loop: 'Create, update, and find work items.',
            core_artifacts: ['saved issue'],
            value_loops: [],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'New issue form with title, status, assignee, labels, and save',
              kind: 'form',
              url: 'https://work.example/issues/new',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'Issue list table with filter and sort controls',
              kind: 'table',
              url: 'https://work.example/issues',
              source: 'primary_journey',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [],
          coverage_plan: {
            selected_journey_ids: [],
            deferred_surface_ids: [],
            rationale: 'Model underselected the workflow product.',
            coverage_risk: 'high',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    const descriptions = result.output.goals.map((goal) => goal.description).join('\n');
    expect(descriptions).toContain('Create or update a realistic item named "Follow up with Maya"');
    expect(descriptions).not.toContain('open a form');
    expect(
      result.output.capabilities.find(
        (capability) => capability.label === 'Create a record or item',
      )?.status,
    ).toBe('selected');
    expect(
      result.output.capabilities.find((capability) => capability.label === 'Update existing state')
        ?.status,
    ).toBe('selected');
  });

  it('does not misclassify product-native clear/edit CRUD journeys as setup dismissal', async () => {
    const result = await runDiscovery({
      url: 'https://todo.example',
      observation_summary:
        'Todo app with What needs to be done input, todo list rows, item checkbox toggles, Active and Completed filters, double-click edit, delete buttons, and Clear completed.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A todo workflow app.',
          product_use_contract: {
            product_kinds: ['crud_workflow'],
            primary_value_loop:
              'Create todo records, update completion or title, filter the list, and clear completed work.',
            core_artifacts: [
              'visible todo rows',
              'completed and active state',
              'edited todo title',
              'removed completed todo',
            ],
            value_loops: [],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'New todo input',
              kind: 'form',
              url: 'https://todo.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'Todo rows with checkbox, inline edit, delete, filters, and Clear completed',
              kind: 'content',
              url: 'https://todo.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Create a named todo list',
              priority: 'must',
              goal_class: 'setup',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Capture work as visible todo records.',
              suggested_goal:
                'Create two todos named Draft launch checklist and Email beta testers and verify both appear as list items.',
              expected_evidence: [
                'Both exact task labels appear in visible todo rows.',
                'The input is clear or ready for another todo after submission.',
              ],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Complete and filter todos',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S2'],
              user_intent: 'Track done and remaining work.',
              suggested_goal:
                'Mark Draft launch checklist complete, then use Active and Completed filters to verify the right tasks appear.',
              expected_evidence: [
                'Active filter shows only the active task.',
                'Completed filter shows only the completed task.',
              ],
              risk: 'medium',
            },
            {
              id: 'J3',
              title: 'Edit and clean up todo records',
              priority: 'should',
              goal_class: 'setup',
              surface_ids: ['S2'],
              user_intent: 'Correct an existing task and remove completed work.',
              suggested_goal:
                'Edit Email beta testers to Email 20 beta testers, then use Clear completed to remove Draft launch checklist.',
              expected_evidence: [
                'Email 20 beta testers is visible.',
                'Email beta testers is no longer visible.',
                'Draft launch checklist is removed after Clear completed.',
              ],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J2'],
            deferred_surface_ids: [],
            rationale:
              'Model underselected create and cleanup because it thought clear/edit were setup.',
            coverage_risk: 'high',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.coverage_plan?.selected_journey_ids).toEqual(
      expect.arrayContaining(['J1', 'J2', 'J3']),
    );
    const goals = result.output.goals.map((goal) => goal.description).join('\n');
    expect(goals).toContain('Create two todos named Draft launch checklist and Email beta testers');
    expect(goals).toContain('Edit Email beta testers to Email 20 beta testers');
    expect(goals).toContain('Clear completed');
    expect(goals).not.toContain('Follow up with Maya');
    expect(
      result.output.capabilities.find((capability) => capability.label === 'Update existing state')
        ?.status,
    ).toBe('selected');
  });

  it('repairs commerce products to the cart or checkout boundary without requiring payment', async () => {
    const result = await runDiscovery({
      url: 'https://shop.example',
      observation_summary:
        'Storefront with catalog products, product detail page, variant option, Add to cart, cart drawer, checkout button, and payment provider step.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A commerce storefront.',
          product_use_contract: {
            product_kinds: ['commerce_checkout'],
            primary_value_loop: 'Select a product and reach cart or checkout boundary.',
            core_artifacts: ['selected product in cart'],
            value_loops: [],
            user_jobs: [],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Product catalog cards with price and detail links',
              kind: 'content',
              url: 'https://shop.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'Add to cart, cart drawer, checkout button, payment boundary',
              kind: 'form',
              url: 'https://shop.example/cart',
              source: 'primary_journey',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [],
          coverage_plan: {
            selected_journey_ids: [],
            deferred_surface_ids: [],
            rationale: 'Model underselected commerce.',
            coverage_risk: 'high',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: ['Do not submit real payment.'],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    const descriptions = result.output.goals.map((goal) => goal.description).join('\n');
    expect(descriptions).toContain('Choose a concrete product or option');
    expect(descriptions).toContain('item-specific cart or checkout state');
    expect(descriptions).not.toMatch(/\bsubmit real payment\b/i);
    expect(
      result.output.capabilities.find(
        (capability) => capability.label === 'Reach cart or checkout with a selected item',
      )?.status,
    ).toBe('selected');
  });

  it('keeps learned product-native user jobs in the selected scenario denominator', async () => {
    const result = await runDiscovery({
      url: 'https://shop.example',
      observation_summary:
        'Storefront with login, product catalog, sort menu, cart, checkout form, and a locked-out user error state.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A commerce storefront.',
          product_use_contract: {
            product_kinds: ['commerce_checkout'],
            primary_value_loop:
              'Sign in, choose products from the catalog, and reach the checkout boundary.',
            core_artifacts: ['authenticated catalog', 'selected product in cart'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Buy an in-stock product',
                journey_id: 'J1',
                scenario_brief:
                  'Log in, add Sauce Labs Backpack to the cart, and complete checkout to the confirmation boundary.',
                required_actions: [
                  'Log in as a valid shopper',
                  'Add a product to cart',
                  'Complete checkout form',
                ],
                proof_obligations: ['Order confirmation is visible'],
                expected_artifact: 'completed checkout confirmation',
                acceptable_evidence: ['Confirmation page for the selected product'],
                required_outputs: ['Sauce Labs Backpack', 'Thank you for your order'],
                risk: 'high',
              },
              {
                id: 'PU2',
                title: 'Verify locked user cannot sign in',
                journey_id: 'J2',
                scenario_brief:
                  'Attempt login as a locked-out shopper and verify the product shows the blocked-account error.',
                required_actions: ['Submit locked-out shopper credentials'],
                proof_obligations: ['Locked-out user error is visible'],
                expected_artifact: 'visible blocked-account error state',
                acceptable_evidence: ['Locked-out user error message'],
                required_outputs: ['locked out'],
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Login form with username and password fields',
              kind: 'form',
              url: 'https://shop.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S2',
              label: 'Product catalog cards with price, sort menu, and Add to cart buttons',
              kind: 'content',
              url: 'https://shop.example/inventory',
              source: 'primary_journey',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S3',
              label: 'Locked-out shopper login error',
              kind: 'form',
              url: 'https://shop.example',
              source: 'primary_journey',
              value: 'important_secondary',
              confidence: 0.8,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Buy an in-stock product',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1', 'S2'],
              user_intent: 'Reach a checkout confirmation for a selected product.',
              suggested_goal:
                'Log in, add Sauce Labs Backpack to the cart, and complete checkout to the confirmation boundary.',
              expected_evidence: [
                'Sauce Labs Backpack is selected',
                'Thank you for your order is visible',
              ],
              risk: 'high',
            },
            {
              id: 'J2',
              title: 'Verify locked user cannot sign in',
              priority: 'should',
              goal_class: 'secondary_workflow',
              surface_ids: ['S1', 'S3'],
              user_intent: 'Check an important negative auth path exposed by the product.',
              suggested_goal:
                'Attempt login as a locked-out shopper and verify the blocked-account error appears.',
              expected_evidence: ['Locked-out user error is visible'],
              risk: 'medium',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Model selected only the happy-path checkout.',
            coverage_risk: 'medium',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: ['Do not submit real payment.'],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.coverage_plan?.selected_journey_ids).toEqual(
      expect.arrayContaining(['J1', 'J2']),
    );
    expect(result.output.coverage_plan?.selected_journey_ids).not.toContain('J3');
    expect(result.output.goals.map((goal) => goal.description).join('\n')).toContain(
      'locked-out shopper',
    );
  });

  it('does not synthesize vague capability-gap goals without a concrete surface', async () => {
    const result = await runDiscovery({
      url: 'https://shop.example',
      observation_summary:
        'Login-gated demo shop with standard_user, locked_out_user, shared password, and an inferred shopping surface after login.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A login-gated demo shop.',
          product_use_contract: {
            product_kinds: ['commerce_checkout'],
            primary_value_loop: 'Log in, then use the authenticated shopping surface.',
            core_artifacts: ['authenticated shopping state'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Log in as the standard demo user',
                journey_id: 'J1',
                scenario_brief: 'Log in as standard_user and reach the authenticated app.',
                required_actions: [],
                proof_obligations: [],
                expected_artifact: 'authenticated app state',
                acceptable_evidence: [],
                required_outputs: ['standard_user was entered before submit'],
                risk: 'high',
              },
              {
                id: 'PU2',
                title: 'Verify locked-out account denial',
                journey_id: 'J2',
                scenario_brief: 'Use locked_out_user and verify the app blocks access.',
                required_actions: [],
                proof_obligations: [],
                expected_artifact: 'locked-out error state',
                acceptable_evidence: [],
                required_outputs: ['locked_out_user was entered before submit'],
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Login form with published demo credentials',
              kind: 'form',
              url: 'https://shop.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Standard user signs in',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Enter the demo shop.',
              suggested_goal: 'Log in as standard_user and verify authenticated state appears.',
              expected_evidence: ['Authenticated state appears'],
              risk: 'high',
            },
          ],
          capabilities: [
            {
              id: 'C-shop',
              label: 'Reach and use the authenticated shopping surface',
              product_kind: 'commerce_checkout',
              importance: 'core',
              status: 'discovered',
              confidence: 0.8,
              source: 'model',
              evidence: ['Shopping surface is expected after successful login'],
              scenario_ids: [],
              journey_ids: [],
              surface_ids: [],
              denominator_reason: 'Shopping is the product value after login.',
              coverage_gap: '',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Model selected only login.',
            coverage_risk: 'medium',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.goals.map((goal) => goal.description).join('\n')).not.toMatch(
      /Exercise|authenticated shopping surface/i,
    );
    expect(result.output.coverage_plan?.selected_journey_ids).toContain('J1');
    const lockedOutJourneyId = result.output.product_use_contract?.user_jobs.find(
      (job) => job.id === 'PU2',
    )?.journey_id;
    expect(lockedOutJourneyId).toBeTruthy();
    expect(lockedOutJourneyId).not.toBe('J1');
  });

  it('drops generic data-grid kind from dashboard pages without concrete grid controls', async () => {
    const result = await runDiscovery({
      url: 'https://dashboard.example',
      observation_summary:
        'A revenue dashboard with charts, summary metrics, and a static regional summary table.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A dashboard for reviewing revenue metrics.',
          product_use_contract: {
            product_kinds: ['dashboard_filtering', 'data_grid'],
            primary_value_loop: 'Change dashboard filters and inspect revenue metrics.',
            core_artifacts: ['filtered dashboard metrics', 'summary table'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Change dashboard date range',
                journey_id: 'J1',
                scenario_brief: 'Apply a new date range and verify revenue metrics update.',
                required_actions: ['Use date range control'],
                required_outputs: ['Revenue metric updates'],
                expected_artifact: 'Updated dashboard',
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Revenue dashboard charts and static regional summary table',
              kind: 'table',
              url: 'https://dashboard.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Change dashboard date range',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Inspect metrics for a different period.',
              suggested_goal: 'Apply a new date range and verify revenue metrics update.',
              expected_evidence: ['Revenue metric updates'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Dashboard filter is primary.',
            coverage_risk: 'low',
          },
          goals: [],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.product_use_contract?.product_kinds).toEqual(['dashboard_filtering']);
    expect(result.output.capabilities.map((capability) => capability.product_kind)).not.toContain(
      'data_grid',
    );
  });

  it('dedupes final goals that collapse onto the same product-use job', async () => {
    const result = await runDiscovery({
      url: 'https://calculator.example/bmi',
      observation_summary: 'BMI calculator with height and weight inputs and a Calculate button.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A BMI calculator.',
          product_use_contract: {
            product_kinds: ['calculator_tool'],
            primary_value_loop: 'Calculate BMI from user inputs.',
            core_artifacts: ['BMI result'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Calculate BMI',
                journey_id: 'J1',
                scenario_brief:
                  'Enter adult height and weight values, calculate BMI, and verify the BMI result and category.',
                required_actions: ['Enter height and weight', 'Click Calculate'],
                required_outputs: ['BMI result', 'BMI category'],
                expected_artifact: 'BMI result panel',
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'BMI calculator form',
              kind: 'form',
              url: 'https://calculator.example/bmi',
              source: 'initial',
              value: 'core',
              confidence: 0.95,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Calculate BMI',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Calculate BMI.',
              suggested_goal: 'Use the BMI calculator and verify the result.',
              expected_evidence: ['BMI result', 'BMI category'],
              risk: 'high',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: [],
            rationale: 'Primary calculator workflow.',
            coverage_risk: 'low',
          },
          goals: [
            {
              id: 'G1',
              description: 'Use the calculator and verify the result.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
            {
              id: 'G2',
              description: 'Calculate a result from user inputs.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.goals).toHaveLength(1);
    expect(result.output.goals[0]?.description).toContain('Enter adult height and weight values');
  });

  it('keeps normalized surface and journey ids unique and rewrites report refs', async () => {
    const result = await runDiscovery({
      url: 'https://grid.example',
      observation_summary: 'A data grid page with table search and page length controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'A data grid.',
          product_use_contract: {
            product_kinds: ['data_grid'],
            primary_value_loop: 'Search and page data rows.',
            core_artifacts: ['changed table rows'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Search rows',
                journey_id: 'J1',
                scenario_brief: 'Search table rows and verify filtered entries.',
                required_outputs: ['filtered entries'],
                expected_artifact: 'Filtered table',
                risk: 'high',
              },
            ],
          },
          surfaces: [
            {
              id: 'S1',
              label: 'Data grid table search',
              kind: 'table',
              url: 'https://grid.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S1',
              label: 'Data grid page length',
              kind: 'toolbar',
              url: 'https://grid.example',
              source: 'initial',
              value: 'core',
              confidence: 0.85,
            },
            {
              id: 'S2',
              label: 'Footer',
              kind: 'footer',
              url: 'https://grid.example',
              source: 'initial',
              value: 'peripheral',
              confidence: 0.4,
            },
          ],
          journeys: [
            {
              id: 'J1',
              title: 'Search rows',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S1'],
              user_intent: 'Search rows.',
              suggested_goal: 'Search table rows and verify filtered entries.',
              expected_evidence: ['filtered entries'],
              risk: 'high',
            },
            {
              id: 'J1',
              title: 'Change page length',
              priority: 'should',
              goal_class: 'secondary_workflow',
              surface_ids: ['S2'],
              user_intent: 'Change page length.',
              suggested_goal: 'Change entries per page and verify row range updates.',
              expected_evidence: ['row range updates'],
              risk: 'medium',
            },
            {
              id: 'J2',
              title: 'Footer links',
              priority: 'could',
              goal_class: 'peripheral',
              surface_ids: ['S2'],
              user_intent: 'Read footer links.',
              suggested_goal: 'Open footer links.',
              expected_evidence: ['Footer link destination'],
              risk: 'low',
            },
          ],
          capabilities: [
            {
              id: 'C1',
              label: 'Search rows',
              product_kind: 'data_grid',
              importance: 'core',
              status: 'selected',
              confidence: 0.8,
              source: 'model',
              evidence: [],
              scenario_ids: [],
              journey_ids: ['J1'],
              surface_ids: ['S1'],
              denominator_reason: 'Search is core.',
              coverage_gap: '',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: ['S2'],
            rationale: 'Search is selected.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Search table rows and verify filtered entries.',
              priority: 'must',
              journey_id: 'J1',
              surface_ids: ['S1'],
              goal_class: 'core',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    const surfaceIds = result.output.surfaces.map((surface) => surface.id);
    const journeyIds = result.output.journeys.map((journey) => journey.id);
    expect(new Set(surfaceIds).size).toBe(surfaceIds.length);
    expect(new Set(journeyIds).size).toBe(journeyIds.length);
    const knownSurfaceIds = new Set(surfaceIds);
    const knownJourneyIds = new Set(journeyIds);
    expect(result.output.goals.flatMap((goal) => goal.surface_ids)).toEqual(
      expect.arrayContaining(['S1']),
    );
    expect(
      result.output.coverage_plan?.selected_journey_ids.every((id) => knownJourneyIds.has(id)),
    ).toBe(true);
    expect(
      result.output.coverage_plan?.deferred_surface_ids.every((id) => knownSurfaceIds.has(id)),
    ).toBe(true);
    expect(
      result.output.capabilities.every((capability) =>
        capability.surface_ids.every((id) => knownSurfaceIds.has(id)),
      ),
    ).toBe(true);
  });

  it('remaps semantic duplicate surface and journey ids to the kept canonical ids', async () => {
    const result = await runDiscovery({
      url: 'https://grid.example',
      observation_summary: 'Employee table with search and page length controls.',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 2,
          target_kind_hint: 'web',
          product_description: 'Employee data grid.',
          product_use_contract: {
            product_kinds: ['data_grid'],
            primary_value_loop: 'Filter and page employee rows.',
            core_artifacts: ['changed table state'],
            value_loops: [],
            user_jobs: [
              {
                id: 'PU1',
                title: 'Filter London rows',
                journey_id: 'J_DUP',
                scenario_brief: 'Search for London rows.',
                test_data: ['London'],
                required_actions: ['type London into Search'],
                proof_obligations: ['London row visible'],
                expected_artifact: 'filtered table',
                required_outputs: ['London'],
                quality_bar: ['Filtered rows remain visible'],
                acceptable_evidence: ['post-action observation'],
                weak_evidence: ['input text only'],
                risk: 'medium',
              },
            ],
          },
          surfaces: [
            {
              id: 'S_CANON',
              label: 'Employee table',
              kind: 'table',
              url: 'https://grid.example',
              source: 'initial',
              value: 'core',
              confidence: 0.9,
            },
            {
              id: 'S_DUP',
              label: 'Employee table',
              kind: 'table',
              url: 'https://grid.example',
              source: 'initial',
              value: 'core',
              confidence: 0.8,
            },
          ],
          journeys: [
            {
              id: 'J_CANON',
              title: 'Filter rows',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S_CANON'],
              user_intent: 'Filter rows.',
              suggested_goal: 'Filter employee rows for London and verify London output.',
              expected_evidence: ['London output'],
              risk: 'high',
            },
            {
              id: 'J_DUP',
              title: 'Filter duplicate rows',
              priority: 'must',
              goal_class: 'core',
              surface_ids: ['S_DUP'],
              user_intent: 'Filter rows.',
              suggested_goal: 'Filter employee rows for London and verify London output.',
              expected_evidence: ['London output'],
              risk: 'high',
            },
          ],
          capabilities: [
            {
              id: 'C1',
              label: 'Search rows',
              product_kind: 'data_grid',
              importance: 'core',
              status: 'selected',
              confidence: 0.8,
              source: 'model',
              evidence: [],
              scenario_ids: [],
              journey_ids: ['J_DUP'],
              surface_ids: ['S_DUP'],
              denominator_reason: 'Search is core.',
              coverage_gap: '',
            },
          ],
          coverage_plan: {
            selected_journey_ids: ['J_DUP'],
            deferred_surface_ids: ['S_DUP'],
            rationale: 'Filter is selected.',
            coverage_risk: 'medium',
          },
          goals: [
            {
              id: 'G1',
              description: 'Filter employee rows for London and verify London output.',
              priority: 'must',
              journey_id: 'J_DUP',
              surface_ids: ['S_DUP'],
              goal_class: 'core',
            },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0,
      }),
    });

    if (!result) throw new Error('expected discovery result');
    expect(result.output.surfaces.map((surface) => surface.id)).toEqual(['S_CANON']);
    expect(result.output.journeys.map((journey) => journey.id)).toEqual(['J_CANON']);
    expect(result.output.goals[0]).toMatchObject({
      journey_id: 'J_CANON',
      surface_ids: ['S_CANON'],
    });
    expect(result.output.product_use_contract?.user_jobs[0]?.journey_id).toBe('J_CANON');
    expect(result.output.capabilities[0]?.journey_ids).toEqual(['J_CANON']);
    expect(
      result.output.capabilities.flatMap((capability) => capability.journey_ids),
    ).not.toContain('J_DUP');
    expect(
      result.output.capabilities.flatMap((capability) => capability.surface_ids),
    ).not.toContain('S_DUP');
    expect(result.output.coverage_plan?.selected_journey_ids).toEqual(['J_CANON']);
    expect(result.output.coverage_plan?.deferred_surface_ids).not.toContain('S_DUP');
  });
});
