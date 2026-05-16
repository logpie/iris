import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { fakeJudge, fakeRun } from './_fakes.js';
import { buildReportHtml } from './report-html.js';
import { buildReportJson } from './report-json.js';

describe('buildReportHtml', () => {
  it('produces well-formed HTML with the score in the TL;DR', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun(), threshold: 7.0 });
    const html = buildReportHtml(r);
    expect(html).toMatch(/<!doctype html>/i);
    // Score rendered as "6.5 / 10" in TL;DR
    expect(html).toContain('6.5');
    expect(html).toContain('Evidence confidence');
    // No Tailwind CDN reference (we use hand-crafted CSS)
    expect(html).not.toContain('cdn.tailwindcss');
  });

  it('labels partial-proof product scores as provisional in the hero', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.scores.overall.score = 7.5;
    judge.meta.confidence_overall = 0.8;
    judge.meta.confidence_caveats = [];
    judge.spec_compliance.goals = [
      { id: 'G1', description: 'create artifact', status: 'verified', evidence: ['T1'] },
      { id: 'G2', description: 'edit artifact', status: 'verified', evidence: ['T2'] },
      { id: 'G3', description: 'share artifact', status: 'verified', evidence: ['T3'] },
      { id: 'G4', description: 'download artifact', status: 'verified', evidence: ['T4'] },
      { id: 'G5', description: 'style artifact', status: 'partial', evidence: ['T5'] },
      { id: 'G6', description: 'duplicate artifact', status: 'partial', evidence: ['T6'] },
      { id: 'G7', description: 'insert media', status: 'partial', evidence: ['T7'] },
      { id: 'G8', description: 'export image', status: 'partial', evidence: ['T8'] },
    ];
    const html = buildReportHtml(buildReportJson({ judge, run: fakeRun() }));
    expect(html).toContain('Provisional product score');
    expect(html).toContain('No product defects were confirmed');
    expect(html).toContain('Iris proof gaps');
    expect(html).toContain('4 partial tasks indicate Iris did not fully prove outcomes');
  });

  it('does not show a second competing confidence percentage in caveats', () => {
    const judge = fakeJudge();
    judge.meta.confidence_overall = 0.62;
    judge.meta.confidence_caveats = ['Mobile was not tested.'];
    const html = buildReportHtml(buildReportJson({ judge, run: fakeRun() }));

    expect(html).toContain('Caveats and follow-up checks');
    expect(html).not.toContain('Caveats (confidence');
  });

  it('escapes HTML in titles and rationale', () => {
    const j = fakeJudge();
    const first = j.findings[0];
    if (!first) throw new Error('fake judge has no findings');
    first.title = '<script>alert("x")</script>';
    const r = buildReportJson({ judge: j, run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders findings with severity prefixes and category tags', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    // Severity tags appear inline (not in emoji form)
    expect(html).toMatch(/sev-tag sev-blocker/);
    expect(html).toMatch(/sev-tag sev-nit/);
    // No category emoji icons (we dropped them)
    expect(html).not.toContain('🐛');
  });

  it('renders a visible score matrix', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('Score matrix');
    expect(html).toContain('quality');
    expect(html).toContain('correctness');
    expect(html).toContain('usability');
    expect(html).toContain('class="score-profile-grid"');
    expect(html).toContain('class="score-profile-card"');
  });

  it('renders unscored rubric profiles as n/a instead of zero', () => {
    const judge = fakeJudge();
    judge.scores.profiles.frontend_correctness = {
      score: 0,
      dimensions: {
        interaction_outcomes: {
          score: null,
          rationale: 'Judge omitted this requested rubric profile.',
          evidence: [],
        },
      },
    };
    const r = buildReportJson({ judge, run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('profile-score is-missing');
    expect(html).toContain('n/a');
  });

  it('labels unresolved evidence references without exposing cryptic id tails', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('unresolved evidence');
    expect(html).not.toContain('source T2');
  });

  it('surfaces weighted profiles omitted from profile scores', () => {
    const judge = fakeJudge();
    judge.scores.overall.weighted_from.push('frontend_correctness');
    const r = buildReportJson({ judge, run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('Incomplete score report');
    expect(html).toContain('Score is incomplete.');
    expect(html).toContain('frontend correctness');
    expect(html).toContain('Listed in weighted_from but absent from scores.profiles.');
  });

  it('renders grouped tested goals with claim-scoped proof and labels raw recordings separately', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-report-html-'));
    mkdirSync(join(runDir, 'evidence', 'screenshots'), { recursive: true });
    mkdirSync(join(runDir, 'evidence', 'videos'), { recursive: true });
    mkdirSync(join(runDir, 'evidence', 'clips'), { recursive: true });
    writeFileSync(join(runDir, 'evidence', 'screenshots', 'step-0001.png'), 'not really png');
    writeFileSync(join(runDir, 'evidence', 'videos', 'page-a.webm'), '');
    writeFileSync(join(runDir, 'evidence', 'videos', 'page-b.webm'), '');
    const observationId = 'OBS_EVENT_1';
    writeFileSync(
      join(runDir, 'trace.jsonl'),
      `${JSON.stringify({
        v: 1,
        id: observationId,
        ts: 1,
        step: 1,
        target_kind: 'web',
        kind: 'observation',
        actor: 'adapter',
        payload: { ref: 'OBS-000001', summary: 'OpenAI - Wikipedia\nVisible text' },
      })}\n`,
    );
    const judge = fakeJudge();
    judge.spec_compliance.goals = [
      {
        id: 'G1',
        description: 'load article',
        status: 'verified',
        evidence: [observationId],
        notes: 'Article loaded.',
      },
      {
        id: 'G2',
        description: 'verify article namespace',
        status: 'verified',
        evidence: [observationId],
        notes: 'Article namespace loaded.',
      },
    ];
    judge.findings = [
      {
        id: 'F-001',
        title: 'Probe-only issue',
        category: 'a11y',
        severity: 'major',
        evidence: ['PROBE_EVENT'],
        rationale: 'Probe failed without a screenshot.',
      },
    ];

    const r = buildReportJson({
      judge,
      run: fakeRun(),
      artifacts: { clips: { G1: join(runDir, 'evidence', 'clips', 'clip-001.webm') } },
    });
    const html = buildReportHtml(r, { runDir });
    expect(html).toContain('Scenario audit');
    expect(html).not.toContain('Evidence by scenario');
    expect(html).toContain('Audit trail');
    expect(html).toContain('Screenshot storyboard');
    expect(html).not.toContain('<h2>Run walkthrough</h2>');
    expect(html).toContain('G1');
    expect(html).toContain('Task G1');
    expect(html).toContain('Task G2');
    expect(html).not.toContain('<span class="claim">Task G2</span>');
    expect(html).toContain('<span class="goal-proof-title">load article</span>');
    expect(html).not.toContain('<span class="goal-proof-title">OpenAI - Wikipedia</span>');
    expect(html).toContain('evidence/screenshots/step-0001.png');
    expect(html).toContain('evidence/clips/clip-001.webm');
    expect(html).toContain('poster="evidence/screenshots/step-0001.png"');
    expect(html).not.toContain('Sliced evidence clips');
    expect(html).not.toContain('class="claim-clip-strip"');
    expect(html).toContain('class="goal-proof-media"');
    expect(html).not.toContain('<details class="proof-clip"');
    expect(html).toContain('open full clip');
    expect(html).not.toContain('<summary class="ev-chip">play clip</summary>');
    expect(html).not.toContain(`${runDir}/evidence/clips/clip-001.webm`);
    expect(html).toContain('F-001');
    expect(html).toContain('Probe-only issue');
    expect(html).toContain('Raw debug recordings');
    expect(html).toContain('Raw recordings are unstitched browser-context files');
    expect(html).toContain('raw-video-scroll');
    expect(html).toContain('page-a.webm');
    expect(html).toContain('page-b.webm');
  });

  it('uses status-specific pills for partial goal evidence', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      {
        id: 'G1',
        description: 'Place a hidden shape on the canvas.',
        status: 'partial',
        evidence: [],
        notes: 'Only the default shape tool appeared.',
      },
    ];
    const html = buildReportHtml(buildReportJson({ judge, run: fakeRun() }));
    expect(html).toContain('class="status-pill status-partial">partial</span>');
    expect(html).toContain('class="goal-proof-row no-frame status-partial"');
    expect(html).not.toContain('class="status">partial</span>');
  });

  it('marks reused clips as shared windows instead of implying unique per-goal clips', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-report-html-sharedclip-'));
    mkdirSync(join(runDir, 'evidence', 'screenshots'), { recursive: true });
    mkdirSync(join(runDir, 'evidence', 'clips'), { recursive: true });
    writeFileSync(join(runDir, 'evidence', 'screenshots', 'step-0001.png'), 'png');
    writeFileSync(join(runDir, 'evidence', 'screenshots', 'step-0002.png'), 'png');
    const sharedClip = join(runDir, 'evidence', 'clips', 'shared.webm');
    writeFileSync(sharedClip, '');
    const events = [
      {
        v: 1,
        id: 'OBS_EVENT_1',
        ts: 1,
        step: 1,
        target_kind: 'web',
        kind: 'observation',
        actor: 'adapter',
        payload: { ref: 'OBS-000001', summary: 'Search page' },
      },
      {
        v: 1,
        id: 'OBS_EVENT_2',
        ts: 2,
        step: 2,
        target_kind: 'web',
        kind: 'observation',
        actor: 'adapter',
        payload: { ref: 'OBS-000002', summary: 'Login page' },
      },
    ];
    writeFileSync(
      join(runDir, 'trace.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      {
        id: 'G1',
        description: 'Search for content',
        status: 'verified',
        evidence: ['OBS_EVENT_1'],
      },
      {
        id: 'G2',
        description: 'Log in to account',
        status: 'verified',
        evidence: ['OBS_EVENT_2'],
      },
    ];
    const report = buildReportJson({
      judge,
      run: fakeRun(),
      artifacts: { clips: { G1: sharedClip, G2: sharedClip } },
    });
    const html = buildReportHtml(report, { runDir });
    expect(html).toContain('clip (shared window)');
  });

  it('links findings to overlapping goal evidence instead of replaying duplicate finding media', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-report-html-linked-finding-'));
    mkdirSync(join(runDir, 'evidence', 'screenshots'), { recursive: true });
    mkdirSync(join(runDir, 'evidence', 'clips'), { recursive: true });
    writeFileSync(join(runDir, 'evidence', 'screenshots', 'step-0001.png'), 'png');
    writeFileSync(join(runDir, 'evidence', 'clips', 'goal.webm'), '');
    writeFileSync(join(runDir, 'evidence', 'clips', 'finding.webm'), '');
    const events = [
      {
        v: 1,
        id: 'OBS1',
        ts: 1,
        step: 1,
        target_kind: 'web',
        kind: 'observation',
        actor: 'adapter',
        payload: { ref: 'OBS-000001', summary: 'Insert dialog open' },
      },
      {
        v: 1,
        id: 'OBS2',
        ts: 2,
        step: 2,
        target_kind: 'web',
        kind: 'observation',
        actor: 'adapter',
        payload: { ref: 'OBS-000002', summary: 'Canvas unchanged after insert attempt' },
      },
    ];
    writeFileSync(
      join(runDir, 'trace.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    const judge = fakeJudge();
    judge.findings = [
      {
        id: 'F-001',
        title: 'Extended insert did not create an artifact',
        category: 'bug',
        severity: 'major',
        evidence: ['OBS1', 'OBS2'],
        rationale: 'The insert path opened but the canvas stayed unchanged.',
      },
    ];
    judge.spec_compliance.goals = [
      {
        id: 'G3',
        description: 'Use extended insert and see a non-default object on canvas.',
        status: 'partial',
        evidence: ['OBS1', 'OBS2'],
        notes: 'Insert surfaced, but no non-default artifact became visible.',
      },
    ];
    const report = buildReportJson({
      judge,
      run: fakeRun(),
      artifacts: {
        clips: {
          G3: join(runDir, 'evidence', 'clips', 'goal.webm'),
          'F-001': join(runDir, 'evidence', 'clips', 'finding.webm'),
        },
      },
    });
    const html = buildReportHtml(report, { runDir });

    expect(html.indexOf('Findings (1)')).toBeLessThan(html.indexOf('Scenario audit'));
    expect(html).toContain('Issue from this evidence');
    expect(html).toContain('Explains tested task');
    expect(html).toContain('#goal-G3');
    expect(html).toContain('#finding-F-001');
    expect(html).toContain('Evidence is shown with');
    expect(html).not.toContain(
      '<video controls preload="metadata" src="evidence/clips/finding.webm"></video>',
    );
  });

  it('rewrites repo-relative run artifact clip paths for reports served from runDir', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-report-html-relclip-'));
    mkdirSync(join(runDir, 'evidence', 'screenshots'), { recursive: true });
    mkdirSync(join(runDir, 'evidence', 'clips'), { recursive: true });
    writeFileSync(join(runDir, 'evidence', 'screenshots', 'step-0001.png'), 'not really png');
    writeFileSync(join(runDir, 'evidence', 'clips', 'clip-001.webm'), '');
    const observationId = 'OBS_EVENT_1';
    writeFileSync(
      join(runDir, 'trace.jsonl'),
      `${JSON.stringify({
        v: 1,
        id: observationId,
        ts: 1,
        step: 1,
        target_kind: 'web',
        kind: 'observation',
        actor: 'adapter',
        payload: { ref: 'OBS-000001', summary: 'OpenAI - Wikipedia\nVisible text' },
      })}\n`,
    );
    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      {
        id: 'G1',
        description: 'load article',
        status: 'verified',
        evidence: [observationId],
        notes: 'Article loaded.',
      },
    ];
    const repoRelativeClip = join(
      relative(process.cwd(), runDir),
      'evidence',
      'clips',
      'clip-001.webm',
    );
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      artifacts: { clips: { G1: repoRelativeClip } },
    });
    const html = buildReportHtml(r, { runDir });
    expect(html).toContain('src="evidence/clips/clip-001.webm"');
    expect(html).not.toContain(`src="${repoRelativeClip}"`);
  });

  it('keeps goal storyboard clips visible even when no standalone screenshot is resolved', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-report-html-cliponly-'));
    mkdirSync(join(runDir, 'evidence', 'clips'), { recursive: true });
    const clipPath = join(runDir, 'evidence', 'clips', 'story-G2.webm');
    writeFileSync(clipPath, '');

    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      {
        id: 'G2',
        description: 'Style a canvas object and verify the changed artifact remains visible.',
        status: 'verified',
        evidence: ['ACTION_RESULT_WITH_SCREENSHOT_REF'],
        notes: 'The styled canvas object remained visible.',
      },
    ];
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      artifacts: { clips: { G2: clipPath } },
    });
    const html = buildReportHtml(r, { runDir });

    expect(html).toContain('src="evidence/clips/story-G2.webm"');
    expect(html).toContain('source clip');
    expect(html).not.toContain('needs better visual evidence');
  });

  it('keeps inline claim media visible in a real browser layout', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-report-html-cliprail-'));
    mkdirSync(join(runDir, 'evidence', 'screenshots'), { recursive: true });
    mkdirSync(join(runDir, 'evidence', 'clips'), { recursive: true });

    const events = [];
    const goals = [];
    const clips: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
      const ref = `OBS-${String(i).padStart(6, '0')}`;
      const eventId = `OBS_EVENT_${i}`;
      const goalId = `G${i}`;
      events.push({
        v: 1,
        id: eventId,
        ts: i,
        step: i,
        target_kind: 'web',
        kind: 'observation',
        actor: 'adapter',
        payload: { ref, summary: `Article ${i} - Wikipedia\nVisible text` },
      });
      goals.push({
        id: goalId,
        description: `Verify article surface ${i}`,
        status: 'verified' as const,
        evidence: [eventId],
        notes: `Article surface ${i} loaded.`,
      });
      writeFileSync(
        join(runDir, 'evidence', 'screenshots', `step-${String(i).padStart(4, '0')}.png`),
        'png',
      );
      const clipPath = join(runDir, 'evidence', 'clips', `clip-${String(i).padStart(3, '0')}.webm`);
      writeFileSync(clipPath, '');
      clips[goalId] = clipPath;
    }
    writeFileSync(
      join(runDir, 'trace.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );

    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = goals;
    const report = buildReportJson({ judge, run: fakeRun(), artifacts: { clips } });
    const html = buildReportHtml(report, { runDir });

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      const metrics = await page.evaluate(() => {
        type BrowserElement = {
          getBoundingClientRect(): { width: number };
          getAttribute(name: string): string | null;
        };
        type BrowserDocument = {
          querySelectorAll(selector: string): ArrayLike<BrowserElement>;
        };
        const doc = (globalThis as unknown as { document: BrowserDocument }).document;
        const mediaCards = Array.from(doc.querySelectorAll('.goal-proof-media'));
        const videos = Array.from(doc.querySelectorAll('.goal-proof-media video'));
        return {
          mediaCount: mediaCards.length,
          mediaMinWidth: Math.min(...mediaCards.map((card) => card.getBoundingClientRect().width)),
          inlineVideoCount: videos.length,
          videosWithPoster: videos.filter((video) => video.getAttribute('poster')).length,
          detachedClipCount: doc.querySelectorAll(
            '.claim-clip-rail, .claim-clip-strip, .proof-clip',
          ).length,
        };
      });

      expect(metrics.mediaCount).toBe(5);
      expect(metrics.mediaMinWidth).toBeGreaterThan(260);
      expect(metrics.inlineVideoCount).toBe(5);
      expect(metrics.videosWithPoster).toBe(5);
      expect(metrics.detachedClipCount).toBe(0);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it('translates raw axe rule ids into user-readable finding titles', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-report-html-axe-'));
    const probeId = 'PROBE_AXE_1';
    writeFileSync(
      join(runDir, 'trace.jsonl'),
      `${JSON.stringify({
        v: 1,
        id: probeId,
        ts: 1,
        step: 4,
        target_kind: 'web',
        kind: 'probe_result',
        actor: 'system',
        payload: {
          probe: 'axe',
          ok: true,
          summary: { violations: 1 },
          data: {
            violations: [
              {
                id: 'select-name',
                impact: 'critical',
                help: 'Select element must have an accessible name',
                description: 'Ensure select element has an accessible name',
                help_url: 'https://dequeuniversity.com/rules/axe/4.11/select-name',
                nodes: [
                  { target: ['#languages-dropdown'], html: '<select id="languages-dropdown">' },
                ],
              },
            ],
          },
        },
      })}\n`,
    );
    const judge = fakeJudge();
    judge.findings = [
      {
        id: 'F-001',
        title: 'Axe found select-name issue',
        category: 'a11y',
        severity: 'major',
        evidence: [probeId],
        rationale: 'Axe reported select-name on the language selector.',
      },
    ];
    const r = buildReportJson({ judge, run: fakeRun() });
    const html = buildReportHtml(r, { runDir });

    expect(html).toContain('Language selector is missing an accessible name');
    expect(html).not.toContain('Axe found select-name issue');
    expect(html).toContain('Select element must have an accessible name');
    expect(html).toContain('#languages-dropdown');
  });

  it('renders tested goals with plain-English status labels', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toMatch(/Scenario audit/);
    expect(html).toContain('G1');
    expect(html).toContain('G2');
    // Plain-English status labels: "verified", "partial", "broken", "untested"
    expect(html).toMatch(/verified|partial|broken|untested/);
  });

  it('keeps evidence cards in scenario order instead of alphabetizing titles', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      { id: 'G1', description: 'Create board content', status: 'verified', evidence: [] },
      { id: 'G2', description: 'Add annotation', status: 'verified', evidence: [] },
      { id: 'G3', description: 'Export board', status: 'verified', evidence: [] },
    ];
    const html = buildReportHtml(buildReportJson({ judge, run: fakeRun() }));
    expect(html.indexOf('Task G1')).toBeLessThan(html.indexOf('Task G2'));
    expect(html.indexOf('Task G2')).toBeLessThan(html.indexOf('Task G3'));
  });

  it('renders goal scope and observed result without product-specific inference', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      {
        id: 'G5',
        description:
          'Open create-account or log-in and verify the authentication page loads with the expected return target.',
        status: 'verified',
        evidence: [],
        notes: 'Login page loaded with a return target for the current article.',
      },
    ];
    const r = buildReportJson({ judge, run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('Checked');
    expect(html).toContain('Result');
    expect(html).toContain('verify the authentication page loads with the expected return target');
    expect(html).toContain('Login page loaded with a return target');
    expect(html).not.toContain('no credentials were submitted');
  });

  it('groups article tools separately from language editions', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      {
        id: 'G3',
        description:
          'Open an article and confirm its talk, history, edit, or language-selection surfaces are reachable.',
        status: 'verified',
        evidence: [],
      },
    ];
    const r = buildReportJson({ judge, run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('Open an article and confirm its talk');
    expect(html).not.toContain('Language editions');
  });

  it('renders Discovery surface and journey context beside tested goals', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      {
        id: 'G1',
        description: 'Search for OpenAI and verify content loads.',
        status: 'verified',
        evidence: ['OBS_EVENT_1'],
        notes: 'OpenAI content loaded.',
      },
    ];
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      trace_events: [
        {
          v: 1,
          id: 'DISCOVERY_1',
          ts: 1,
          step: 0,
          target_kind: 'web',
          kind: 'discovery',
          actor: 'system',
          payload: {
            product_description: 'A searchable content product.',
            goals: [
              {
                id: 'G1',
                description: 'Search for OpenAI and verify content loads.',
                priority: 'must',
                journey_id: 'J1',
                surface_ids: ['S1'],
              },
            ],
            surfaces: [
              {
                id: 'S1',
                label: 'Search',
                kind: 'search',
                url: 'https://example.com',
                source: 'initial',
                value: 'core',
                confidence: 0.9,
                evidence: [],
              },
            ],
            journeys: [
              {
                id: 'J1',
                title: 'Search content',
                priority: 'must',
                surface_ids: ['S1'],
                user_intent: 'Find content',
                suggested_goal: 'Search for OpenAI and verify content loads.',
                expected_evidence: ['Article title'],
                risk: 'high',
              },
            ],
            capabilities: [
              {
                id: 'C1',
                label: 'Search for specific content',
                product_kind: 'search_content',
                importance: 'core',
                status: 'selected',
                confidence: 0.9,
                source: 'product_kind_prior',
                scenario_ids: ['G1'],
                journey_ids: ['J1'],
                surface_ids: ['S1'],
                evidence: [],
                denominator_reason: 'Search is core.',
                coverage_gap: '',
              },
              {
                id: 'C2',
                label: 'Navigate within content',
                product_kind: 'search_content',
                importance: 'important',
                status: 'deferred',
                confidence: 0.8,
                source: 'surface',
                scenario_ids: [],
                journey_ids: [],
                surface_ids: [],
                evidence: [],
                denominator_reason: 'Article navigation is visible.',
                coverage_gap: 'Not selected for this run.',
              },
            ],
            coverage_plan: {
              selected_journey_ids: ['J1'],
              deferred_surface_ids: [],
              rationale: 'Search is the core journey.',
              coverage_risk: 'low',
            },
            product_use_contract: {
              product_kinds: ['search_content'],
              primary_value_loop: 'Search, open, and read a relevant content page.',
              core_artifacts: ['loaded content page'],
              value_loops: [
                {
                  id: 'VL1',
                  title: 'Find relevant content',
                  artifact: 'loaded content page',
                  required_capabilities: ['search', 'navigation'],
                  proof_obligations: ['content page loaded after selecting result'],
                  weak_evidence: ['search box visible'],
                },
              ],
              user_jobs: [
                {
                  id: 'PU1',
                  title: 'Find and read content',
                  journey_id: 'J1',
                  required_actions: ['enter query', 'open result'],
                  expected_artifact: 'result content visible after navigation',
                  acceptable_evidence: ['post-search content page'],
                  weak_evidence: ['search box visible'],
                  risk: 'high',
                },
              ],
            },
          },
        },
      ],
    });
    const html = buildReportHtml(r);
    expect(html).toContain('Discovery map (debug)');
    expect(html).toContain('1 UI items observed -&gt; 1 candidate workflows -&gt; 1 tasks');
    expect(html).toContain('1/1 UI areas covered');
    expect(html).toContain('Coverage map');
    expect(html).toContain('Task checked');
    expect(html).toContain('UI areas covered');
    expect(html).toContain('UI inventory (1)');
    expect(html).toContain('What Iris tried to prove');
    expect(html).toContain('Overall mission');
    expect(html).not.toContain('Tested scenarios');
    expect(html).not.toContain('User journeys checked');
    expect(html).toContain('Proof standard');
    expect(html).toContain('Product abilities Iris counted');
    expect(html).toContain('3/3 core covered');
    expect(html).toContain('Navigate within content');
    expect(html).toContain('Scenario map');
    expect(html).toContain('Search, open, and read a relevant content page.');
    expect(html).toContain('Find relevant content');
    expect(html).toContain('Find and read content');
    expect(html).toContain('enter query, open result');
    expect(html).toContain('search box visible');
    expect(html).toContain('<span class="goal-id-badge">Task G1</span>');
    expect(html).toContain(
      '<span class="goal-proof-title">Search for OpenAI and verify content loads.</span>',
    );
    expect(html).not.toContain(
      '<div class="goal-proof-title">Search for OpenAI and verify content loads.</div>',
    );
    expect(html).not.toContain(
      '<div class="goal-proof-scope"><span class="label">Checked</span>G1: Search for OpenAI and verify content loads.</div>',
    );
    expect(html).toContain('<code>J1</code>Search content');
    expect(html).toContain('<code>G1</code>Search for OpenAI and verify content loads.');
    expect(html).toContain('<code>S1</code>Search');
  });

  it('uses Discovery journey labels for tested-goal groups instead of keyword buckets', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      {
        id: 'G4',
        description:
          'Open the page menu and verify export, preferences, language, help, feedback, and legal destinations are available.',
        status: 'verified',
        evidence: [],
        notes: 'Page menu exposed the destination groups.',
      },
    ];
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      trace_events: [
        {
          v: 1,
          id: 'DISCOVERY_1',
          ts: 1,
          step: 0,
          target_kind: 'web',
          kind: 'discovery',
          actor: 'system',
          payload: {
            product_description: 'A canvas product.',
            goals: [
              {
                id: 'G4',
                description:
                  'Open the page menu and verify export, preferences, language, help, feedback, and legal destinations are available.',
                priority: 'should',
                journey_id: 'J4',
                surface_ids: ['S005', 'S018'],
              },
            ],
            surfaces: [
              {
                id: 'S005',
                label: 'Page menu',
                kind: 'menu',
                url: 'https://example.com',
                source: 'initial',
                value: 'important_secondary',
                confidence: 0.9,
                evidence: [],
              },
              {
                id: 'S018',
                label: 'Page menu details',
                kind: 'menu',
                url: 'https://example.com',
                source: 'menu_peek',
                value: 'important_secondary',
                confidence: 0.9,
                evidence: [],
              },
            ],
            journeys: [
              {
                id: 'J4',
                title: 'Open page menu workflows',
                priority: 'should',
                surface_ids: ['S005', 'S018'],
                user_intent: 'Use app-level menu actions.',
                suggested_goal:
                  'Open the page menu and verify downstream menu options are available.',
                expected_evidence: ['Menu opens'],
                risk: 'medium',
              },
            ],
          },
        },
      ],
    });
    const html = buildReportHtml(r);
    expect(html).toContain('Open page menu workflows');
    expect(html).not.toContain('Language editions');
  });

  it('omits meaningless zero-cost report metrics', () => {
    const r = buildReportJson({
      judge: fakeJudge(),
      run: { ...fakeRun(), cost_usd: 0 },
    });
    const html = buildReportHtml(r);
    expect(html).not.toContain('$0.00');
    expect(html).not.toContain('provider reported');
    expect(html).not.toContain('<span>Cost</span>');
  });

  it('renders provider-neutral model and reasoning-effort metadata in the overview', () => {
    const r = buildReportJson({
      judge: fakeJudge(),
      run: {
        ...fakeRun(),
        transport: 'codex-appserver',
        models: {
          discovery: 'gpt-5.4-mini',
          explorer: 'gpt-5.4-mini',
          judge: 'gpt-5.4-mini',
        },
        reasoning_efforts: {
          discovery: 'low',
          explorer: 'low',
          judge: 'low',
        },
      },
    });
    const html = buildReportHtml(r);
    expect(html).toContain('Run setup');
    expect(html).toContain('codex-appserver');
    expect(html).toContain('Discovery');
    expect(html).toContain('gpt-5.4-mini');
    expect(html).toContain('effort low');
  });

  it('renders missing reasoning effort honestly instead of hiding the field', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('effort not recorded');
  });

  it('renders an executive overview summarizing the run', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('class="report-hero tldr');
    expect(html).toContain('Verdict');
    expect(html).toContain('Tasks tested');
    expect(html).toContain('Findings');
  });
});
