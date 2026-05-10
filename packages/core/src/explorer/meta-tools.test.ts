import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace as iristrace } from '../index.js';
import {
  done,
  give_up,
  mark_surface_seen,
  newExplorerState,
  note_finding,
  note_hypothesis,
  note_surface_unexplored,
  push_subgoal,
  revisit,
  step_done,
  try_weirdness,
} from './meta-tools.js';

describe('meta-tools', () => {
  let dir: string;
  let writer: iristrace.TraceWriter;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-meta-'));
    path = join(dir, 'trace.jsonl');
    writer = new iristrace.TraceWriter(path);
  });

  afterEach(async () => {
    await writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ids = () => 'T0000001';

  it('note_finding emits tentative_finding event', async () => {
    const state = newExplorerState();
    const r = await note_finding(
      writer,
      state,
      {
        title: 'X',
        category: 'bug',
        severity_hint: 'major',
        evidence_event_ids: ['T1'],
        rationale: 'r',
      },
      ids,
      1,
      'web',
    );
    expect(r.ok).toBe(true);
    await writer.close();
    const events = await iristrace.readTraceArray(path);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('tentative_finding');
    expect((events[0]?.payload as { title: string }).title).toBe('X');
  });

  it('note_finding rejects empty evidence', async () => {
    const state = newExplorerState();
    const r = await note_finding(
      writer,
      state,
      {
        title: 'X',
        category: 'bug',
        severity_hint: 'major',
        evidence_event_ids: [],
        rationale: 'r',
      },
      ids,
      1,
      'web',
    );
    expect(r.ok).toBe(false);
  });

  it('mark_surface_seen moves from unexplored→seen', async () => {
    const state = newExplorerState();
    state.surfaces_unexplored.push({ id: 'settings', where_seen: 'sidebar' });
    const r = await mark_surface_seen(
      writer,
      state,
      { surface_id: 'settings', summary: 'settings page' },
      ids,
      1,
      'web',
    );
    expect(r.ok).toBe(true);
    expect(state.surfaces_seen).toHaveLength(1);
    expect(state.surfaces_unexplored).toHaveLength(0);
  });

  it('note_surface_unexplored skips if already seen', async () => {
    const state = newExplorerState();
    state.surfaces_seen.push({ id: 'home', summary: 'home page' });
    const r = await note_surface_unexplored(
      writer,
      state,
      { surface_id: 'home', where_seen: 'top' },
      ids,
      1,
      'web',
    );
    expect(r.ok).toBe(true);
    expect(state.surfaces_unexplored).toHaveLength(0);
  });

  it('step_done adds to goals_done', async () => {
    const state = newExplorerState();
    await step_done(writer, state, { goal_id: 'G1', evidence_event_ids: ['T1'] }, ids, 1, 'web');
    expect(state.goals_done.has('G1')).toBe(true);
  });

  it('give_up sets give_up_reason', async () => {
    const state = newExplorerState();
    await give_up(writer, state, { reason: 'stuck' }, ids, 1, 'web');
    expect(state.give_up_reason).toBe('stuck');
  });

  it('done sets done flag', async () => {
    const state = newExplorerState();
    await done(writer, state, {}, ids, 1, 'web');
    expect(state.done).toBe(true);
  });

  it('push_subgoal pushes to plan_stack', async () => {
    const state = newExplorerState();
    await push_subgoal(writer, state, { description: 'try mobile view' }, ids, 1, 'web');
    expect(state.plan_stack).toEqual(['try mobile view']);
  });

  it('try_weirdness emits action event with try_weirdness tool', async () => {
    const state = newExplorerState();
    const r = await try_weirdness(writer, state, { kind: 'empty_submit' }, ids, 1, 'web');
    expect(r.ok).toBe(true);
    await writer.close();
    const events = await iristrace.readTraceArray(path);
    expect(events[0]?.kind).toBe('action');
    expect((events[0]?.payload as { tool: string }).tool).toBe('try_weirdness');
  });

  it('revisit emits action event', async () => {
    const state = newExplorerState();
    const r = await revisit(writer, state, { event_id: 'T123' }, ids, 1, 'web');
    expect(r.ok).toBe(true);
  });

  it('note_hypothesis adds to state', async () => {
    const state = newExplorerState();
    await note_hypothesis(
      writer,
      state,
      { claim: 'CRM tool', confidence: 0.7, evidence_event_ids: ['T1'] },
      ids,
      1,
      'web',
    );
    expect(state.hypotheses).toHaveLength(1);
    expect(state.hypotheses[0]?.claim).toBe('CRM tool');
  });
});
