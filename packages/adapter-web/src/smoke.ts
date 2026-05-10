import { join } from 'node:path';
import { trace as iristrace } from '@iris/core';
import { ulid } from 'ulid';
import { WebTargetAdapter } from './index.js';

export interface SmokeOptions {
  target: string;
  out_dir: string;
  headless?: boolean;
}

/**
 * Smoke driver: programmatically exercise the WebTargetAdapter against a target
 * and write a trace.jsonl. Replaces the role of the Explorer agent (Phase 3)
 * for testing purposes only — uses a hard-coded action sequence.
 */
export async function runSmoke(opts: SmokeOptions): Promise<void> {
  const tracePath = join(opts.out_dir, 'trace.jsonl');
  const writer = new iristrace.TraceWriter(tracePath);
  let step = 0;
  const ids = () => ulid();

  await writer.append({
    v: 1,
    id: ids(),
    ts: Date.now() / 1000,
    step: step++,
    target_kind: 'web',
    kind: 'run_start',
    actor: 'system',
    payload: { target: opts.target },
  });

  const adapter = new WebTargetAdapter({ headless: opts.headless ?? true });
  await adapter.start({ kind: 'web', target: opts.target, out_dir: opts.out_dir });

  const obs1 = await adapter.observe();
  await writer.append({
    v: 1,
    id: ids(),
    ts: Date.now() / 1000,
    step: step++,
    target_kind: 'web',
    kind: 'observation',
    actor: 'adapter',
    payload: { ref: obs1.observation_ref, summary: obs1.summary.slice(0, 200) },
  });

  for (const action of [
    { tool: 'type', args: { selector: '#email', text: 'a@b.co' } },
    { tool: 'type', args: { selector: '#password', text: 'pw' } },
    { tool: 'click', args: { selector: '#submit' } },
  ]) {
    const r = await adapter.callTool(action.tool, action.args);
    await writer.append({
      v: 1,
      id: ids(),
      ts: Date.now() / 1000,
      step: step++,
      target_kind: 'web',
      kind: 'action',
      actor: 'explorer',
      payload: { tool: action.tool, args: action.args, result_ok: r.ok },
    });
  }

  const obs2 = await adapter.observe();
  await writer.append({
    v: 1,
    id: ids(),
    ts: Date.now() / 1000,
    step: step++,
    target_kind: 'web',
    kind: 'observation',
    actor: 'adapter',
    payload: { ref: obs2.observation_ref, summary: obs2.summary.slice(0, 200) },
  });

  const axe = await adapter.runProbe('axe', {});
  await writer.append({
    v: 1,
    id: ids(),
    ts: Date.now() / 1000,
    step: step++,
    target_kind: 'web',
    kind: 'probe_result',
    actor: 'probe',
    payload: { probe: 'axe', summary: axe.ok ? axe.summary : { error: axe.error } },
  });

  const artifacts = await adapter.stop();
  await writer.append({
    v: 1,
    id: ids(),
    ts: Date.now() / 1000,
    step: step++,
    target_kind: 'web',
    kind: 'run_end',
    actor: 'system',
    payload: { artifacts: artifacts.artifact_files },
  });

  await writer.close();
}
