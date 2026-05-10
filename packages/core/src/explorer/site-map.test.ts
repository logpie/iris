import { describe, expect, it } from 'vitest';
import { SiteMap } from './site-map.js';

describe('SiteMap', () => {
  it('starts empty with 0 coverage', () => {
    const sm = new SiteMap();
    expect(sm.serialize()).toEqual({
      surfaces_seen: [],
      surfaces_unexplored: [],
      coverage_estimate: 0,
    });
  });

  it('markSeen adds to seen', () => {
    const sm = new SiteMap();
    sm.markSeen('home', 'home page', '/');
    const snap = sm.serialize();
    expect(snap.surfaces_seen).toHaveLength(1);
    expect(snap.surfaces_seen[0]?.id).toBe('home');
    expect(snap.coverage_estimate).toBe(1);
  });

  it('noteUnexplored adds to unexplored', () => {
    const sm = new SiteMap();
    sm.noteUnexplored('settings', 'sidebar', 'destructive');
    const snap = sm.serialize();
    expect(snap.surfaces_unexplored).toHaveLength(1);
    expect(snap.surfaces_unexplored[0]?.reason_skipped).toBe('destructive');
    expect(snap.coverage_estimate).toBe(0);
  });

  it('markSeen on previously-unexplored moves it', () => {
    const sm = new SiteMap();
    sm.noteUnexplored('settings', 'sidebar');
    expect(sm.size()).toEqual({ seen: 0, unexplored: 1 });
    sm.markSeen('settings', 'opened the page');
    expect(sm.size()).toEqual({ seen: 1, unexplored: 0 });
    expect(sm.serialize().coverage_estimate).toBe(1);
  });

  it('noteUnexplored skips if already seen', () => {
    const sm = new SiteMap();
    sm.markSeen('home');
    sm.noteUnexplored('home', 'top');
    expect(sm.size()).toEqual({ seen: 1, unexplored: 0 });
  });

  it('noteUnexplored skips duplicates', () => {
    const sm = new SiteMap();
    sm.noteUnexplored('settings', 'sidebar');
    sm.noteUnexplored('settings', 'top');
    expect(sm.size()).toEqual({ seen: 0, unexplored: 1 });
  });

  it('coverage_estimate is fraction seen/(seen+unexplored)', () => {
    const sm = new SiteMap();
    sm.markSeen('a');
    sm.markSeen('b');
    sm.markSeen('c');
    sm.noteUnexplored('d', 'somewhere');
    sm.noteUnexplored('e', 'somewhere');
    const snap = sm.serialize();
    expect(snap.coverage_estimate).toBeCloseTo(0.6);
  });
});
