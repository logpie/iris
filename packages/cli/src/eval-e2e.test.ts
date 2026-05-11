import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebTargetAdapter } from '@iris/adapter-web';
import { llm, orchestrator } from '@iris/core';
import { loadBundledRubric } from '@iris/rubrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Inline fixture: a tiny form HTML page served from memory via Node http
// ---------------------------------------------------------------------------
async function startFormFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = `<!doctype html>
<html>
<head><title>Form</title></head>
<body>
  <h1>Sign in</h1>
  <form id="signin">
    <label for="email">Email</label>
    <input id="email" type="email">
    <label for="password">Password</label>
    <input id="password" type="password">
    <button id="submit" type="submit">Sign in</button>
  </form>
  <div id="result" role="status"></div>
  <script>
    document.getElementById('signin').addEventListener('submit', (e) => {
      e.preventDefault();
      document.getElementById('result').textContent = 'Signed in';
    });
  </script>
</body>
</html>`;

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

// ---------------------------------------------------------------------------
// Fake LLM response helpers
// ---------------------------------------------------------------------------
function fakeRsp(content: Array<Record<string, unknown>>) {
  return {
    id: 'msg',
    model: 'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    content,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function fakeText(text: string) {
  return {
    id: 'msg',
    model: 'claude-opus-4-7',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// E2E test
// ---------------------------------------------------------------------------
describe('iris eval — end-to-end against fixture site', () => {
  let outDir: string;
  let fixture: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'iris-e2e-'));
    fixture = await startFormFixture();
  });

  afterEach(async () => {
    await fixture.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('produces report.json + report.md + trace.jsonl with real Playwright + fake LLM', async () => {
    // Explorer plays a small script: type into email, password, click submit, note finding, done.
    let explorerCallCount = 0;
    const explorerTransport = vi.fn(async () => {
      explorerCallCount++;
      if (explorerCallCount === 1) {
        return fakeRsp([
          { type: 'text', text: 'I will type into the email field.' },
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'type',
            input: { selector: '#email', text: 'a@b.co' },
          },
        ]);
      }
      if (explorerCallCount === 2) {
        return fakeRsp([
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'type',
            input: { selector: '#password', text: 'pw' },
          },
        ]);
      }
      if (explorerCallCount === 3) {
        return fakeRsp([
          { type: 'tool_use', id: 'tu3', name: 'click', input: { selector: '#submit' } },
        ]);
      }
      // step 4: emit a tentative finding
      if (explorerCallCount === 4) {
        return fakeRsp([
          {
            type: 'tool_use',
            id: 'tu4',
            name: 'note_finding',
            input: {
              title: 'Result text appears slowly',
              category: 'ux',
              severity_hint: 'minor',
              evidence_event_ids: ['OBS-000001'],
              rationale: 'Result text took a moment after submit.',
            },
          },
        ]);
      }
      // step 5+: done
      return fakeRsp([{ type: 'tool_use', id: 'tudone', name: 'done', input: {} }]);
    });

    const judgeOutput = {
      v: 1,
      findings: [
        {
          id: 'F-001',
          title: 'Result text appears slowly',
          category: 'ux',
          severity: 'minor',
          evidence: ['OBS-000001'],
          rationale: 'Latency on submit feedback.',
          suggested_fix: { type: 'feedback', summary: 'Add inline spinner on submit.' },
        },
      ],
      discarded_findings: [],
      scores: {
        overall: { score: 7.5, weighted_from: ['usability'] },
        profiles: {
          usability: {
            score: 7.5,
            dimensions: {
              clarity: { score: 7.5, rationale: 'r', evidence: ['OBS-000001'] },
            },
          },
        },
      },
      spec_compliance: { applicable: false, goals: [], summary: 'no spec' },
      coverage_review: { surfaces_explored: 1, surfaces_unexplored: 0, judgement: 'thin' },
      meta: {
        confidence_overall: 0.7,
        confidence_caveats: ['only one surface explored'],
        would_re_explore_with: ['--persona keyboard_only'],
      },
    };
    const judgeTransport = vi.fn(async () => fakeText(JSON.stringify(judgeOutput)));

    const explorerClient = new llm.LlmClient({ transport: explorerTransport });
    const judgeClient = new llm.LlmClient({ transport: judgeTransport });
    const adapter = new WebTargetAdapter({ headless: true });
    const usability = await loadBundledRubric('web', 'usability');

    const orch = new orchestrator.Orchestrator({ adapter, explorerClient, judgeClient });
    const result = await orch.run({
      target: { kind: 'web', url: `${fixture.url}/index.html` },
      mode: 'free',
      out_dir: outDir,
      rubric_profiles: [usability],
      max_steps: 8,
      max_cost_usd: 1,
      timeout_s: 60,
      explorer_model: 'claude-sonnet-4-6',
      judge_model: 'claude-opus-4-7',
      no_html: false,
    });

    // Verify result
    expect(result.exit_code).toBe(0);
    expect(result.report.headline.score).toBe(7.5);
    expect(result.report.findings).toHaveLength(1);

    // All artifact files exist
    expect(existsSync(join(outDir, 'report.json'))).toBe(true);
    expect(existsSync(join(outDir, 'report.md'))).toBe(true);
    expect(existsSync(join(outDir, 'report.html'))).toBe(true);
    expect(existsSync(join(outDir, 'trace.jsonl'))).toBe(true);
    expect(existsSync(join(outDir, 'findings.json'))).toBe(true);
    expect(existsSync(join(outDir, 'scores.json'))).toBe(true);
    expect(existsSync(join(outDir, 'config.json'))).toBe(true);

    // report.json has Otto-feedback shape
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    expect(report.v).toBe(2);
    expect(report.tool.name).toBe('iris');
    expect(report.run.target.url).toBe(`${fixture.url}/index.html`);
    expect(report.next_actions.for_builder).toBeDefined();
    expect(report.next_actions.for_builder[0]?.finding_id).toBe('F-001');
    expect(report.next_actions.for_re_evaluation).toContain('--persona keyboard_only');

    // report.md has the score header
    const md = readFileSync(join(outDir, 'report.md'), 'utf8');
    expect(md).toMatch(/# Iris run — 7\.5/);

    // trace.jsonl has run_start + run_end + observation + action
    const trace = readFileSync(join(outDir, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const kinds = new Set(trace.map((e) => e.kind));
    expect(kinds.has('run_start')).toBe(true);
    expect(kinds.has('run_end')).toBe(true);
    expect(kinds.has('observation')).toBe(true);
    expect(kinds.has('action')).toBe(true);

    // Adapter actually drove a real browser
    expect(adapter.kind).toBe('web');
  }, 30000);
});
