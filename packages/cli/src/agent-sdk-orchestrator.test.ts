import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JudgeResponseParseError,
  formatJudgeErrorForFile,
  isTruncationShapedJudgeError,
  mergeTraceFiles,
} from './agent-sdk-orchestrator.js';

describe('Agent SDK Judge diagnostics', () => {
  it('formats truncation-shaped Judge parse failures with partial output', () => {
    const response = {
      text: '{"v":1,"findings":[{"rationale":"The donation banner copy continues',
      partial: true,
      partial_error: 'Query closed before response received',
      hit_output_cap: true,
    };
    const parseError = new SyntaxError(
      "Expected ',' or '}' after property value in JSON at position 8982 (line 1 column 8983)",
    );

    const message = formatJudgeErrorForFile(
      new JudgeResponseParseError('Judge', parseError, response),
    );

    expect(message).toContain(
      `Judge output was truncated at ${response.text.length} chars - likely hit model output cap.`,
    );
    expect(message).toContain('SingleShotInput.maxTokens is currently not forwarded');
    expect(message).toContain('SDK signal: max_output_tokens.');
    expect(message).toContain('SDK partial error: Query closed before response received');
    expect(message).toContain(response.text);
  });

  it('recognizes JSON parser messages and unterminated objects as truncation-shaped', () => {
    expect(
      isTruncationShapedJudgeError(
        new SyntaxError("Expected ',' or '}' after property value in JSON"),
      ),
    ).toBe(true);
    expect(
      isTruncationShapedJudgeError(new Error('schema mismatch'), {
        text: '{"v":1,"findings":[',
        partial: false,
      }),
    ).toBe(true);
    expect(
      isTruncationShapedJudgeError(new Error('schema mismatch'), {
        text: '{"v":1}',
        partial: false,
      }),
    ).toBe(false);
  });
});

describe('mergeTraceFiles', () => {
  it('annotates merged parallel trace events with source session_id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-merge-'));
    try {
      const main = join(dir, 'trace.jsonl');
      const sessionDir = join(dir, 'session-0');
      mkdirSync(sessionDir);
      const session = join(sessionDir, 'trace.jsonl');
      writeFileSync(
        main,
        `${JSON.stringify({
          v: 1,
          id: 'MAIN',
          ts: 2,
          step: 0,
          target_kind: 'web',
          kind: 'run_start',
          actor: 'system',
          payload: {},
        })}\n`,
      );
      writeFileSync(
        session,
        `${JSON.stringify({
          v: 1,
          id: 'S0',
          ts: 1,
          step: 0,
          target_kind: 'web',
          kind: 'observation',
          actor: 'adapter',
          payload: {},
        })}\n`,
      );

      mergeTraceFiles([main, session], main);

      const events = readFileSync(main, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((e) => e.id)).toEqual(['S0', 'MAIN']);
      expect(events[0]?.payload.session_id).toBe('session-0');
      expect(events[1]?.payload.session_id).toBe('main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
