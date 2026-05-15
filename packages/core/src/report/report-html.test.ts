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
    // No Tailwind CDN reference (we use hand-crafted CSS)
    expect(html).not.toContain('cdn.tailwindcss');
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
    expect(html).toMatch(/<table class="score-matrix"/);
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
    expect(html).toContain('Tested goals &amp; evidence');
    expect(html).toContain('Search &amp; articles');
    expect(html).toContain('Audit trail');
    expect(html).toContain('Screenshot storyboard');
    expect(html).not.toContain('<h2>Run walkthrough</h2>');
    expect(html).toContain('G1');
    expect(html).toContain('Goal G1, Goal G2');
    expect(html).not.toContain('<span class="claim">Goal G2</span>');
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
    const repoRelativeClip = join(relative(process.cwd(), runDir), 'evidence', 'clips', 'clip-001.webm');
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      artifacts: { clips: { G1: repoRelativeClip } },
    });
    const html = buildReportHtml(r, { runDir });
    expect(html).toContain('src="evidence/clips/clip-001.webm"');
    expect(html).not.toContain(`src="${repoRelativeClip}"`);
  });

  it(
    'keeps inline claim media visible in a real browser layout',
    async () => {
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
        writeFileSync(join(runDir, 'evidence', 'screenshots', `step-${String(i).padStart(4, '0')}.png`), 'png');
        const clipPath = join(runDir, 'evidence', 'clips', `clip-${String(i).padStart(3, '0')}.webm`);
        writeFileSync(clipPath, '');
        clips[goalId] = clipPath;
      }
      writeFileSync(join(runDir, 'trace.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

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
          const doc = (globalThis as unknown as { document: any }).document;
          const mediaCards = Array.from(doc.querySelectorAll('.goal-proof-media')) as any[];
          const videos = Array.from(doc.querySelectorAll('.goal-proof-media video')) as any[];
          return {
            mediaCount: mediaCards.length,
            mediaMinWidth: Math.min(
              ...mediaCards.map((card) => card.getBoundingClientRect().width),
            ),
            inlineVideoCount: videos.length,
            videosWithPoster: videos.filter((video) => video.getAttribute('poster')).length,
            detachedClipCount: doc.querySelectorAll('.claim-clip-rail, .claim-clip-strip, .proof-clip').length,
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
    },
    20_000,
  );

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
                nodes: [{ target: ['#languages-dropdown'], html: '<select id="languages-dropdown">' }],
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
    expect(html).toMatch(/Tested goals/);
    expect(html).toContain('G1');
    expect(html).toContain('G2');
    // Plain-English status labels: "works", "partial", "broken", "untested"
    expect(html).toMatch(/works|partial|broken|untested/);
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
            coverage_plan: {
              selected_journey_ids: ['J1'],
              deferred_surface_ids: [],
              rationale: 'Search is the core journey.',
              coverage_risk: 'low',
            },
          },
        },
      ],
    });
    const html = buildReportHtml(r);
    expect(html).toContain('Discovery v2 coverage plan');
    expect(html).toContain('1 surfaces discovered');
    expect(html).toContain('Selected journeys');
    expect(html).toContain('J1 Search content');
    expect(html).toContain('S1 Search');
  });

  it('renders an executive overview summarizing the run', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('class="report-hero tldr');
    expect(html).toContain('Verdict');
    expect(html).toContain('Goals');
    expect(html).toContain('Findings');
  });
});
