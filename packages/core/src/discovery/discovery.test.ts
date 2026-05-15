import { describe, expect, it } from 'vitest';
import { formatDiscoveryExplorerContext, runDiscovery } from './discovery.js';
import { DISCOVERY_SYSTEM } from './prompts.js';

describe('DISCOVERY_SYSTEM', () => {
  it('asks artifact editors for minimally meaningful primary artifacts', () => {
    expect(DISCOVERY_SYSTEM).toContain('minimally meaningful artifact');
    expect(DISCOVERY_SYSTEM).toContain('draw/place + label/type + style/move/resize');
    expect(DISCOVERY_SYSTEM).toContain('single trivial object');
  });

  it('asks discovery to synthesize material scenarios instead of surface goals', () => {
    expect(DISCOVERY_SYSTEM).toContain('surfaces are not automatically goals');
    expect(DISCOVERY_SYSTEM).toContain('goal_class');
    expect(DISCOVERY_SYSTEM).toContain('Only "core" and selected "secondary_workflow"');
    expect(DISCOVERY_SYSTEM).toContain('A word editor should type a real paragraph');
    expect(DISCOVERY_SYSTEM).toContain('normally perform as setup before a material goal');
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

  it('preserves product-use contracts and includes them in explorer context', async () => {
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
            user_jobs: [
              {
                id: 'PU1',
                title: 'Create board content',
                journey_id: 'J1',
                required_actions: ['choose drawing tool', 'drag on canvas', 'add text'],
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
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected discovery result');
    const explorerContext = formatDiscoveryExplorerContext(result.output);
    expect(explorerContext).toContain('PRODUCT USE CONTRACT');
    expect(explorerContext).toContain('weak evidence that must NOT verify');
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
    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1']);
    expect(result?.output.coverage_plan?.deferred_surface_ids).toContain('S2');
    expect(result?.output.goals.map((goal) => goal.description).join('\n')).not.toMatch(
      /SDK promo|Dismiss/,
    );
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

    expect(result?.output.coverage_plan?.selected_journey_ids).toEqual(['J1']);
    expect(result?.output.coverage_plan?.deferred_surface_ids).toContain('S3');
    expect(result?.output.goals).toHaveLength(1);
    expect(result?.output.goals[0]?.description).toContain('Search for OpenAI');
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
});
