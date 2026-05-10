export interface Surface {
  id: string;
  url?: string;
  summary?: string;
  where_seen?: string;
  reason_skipped?: string;
}

export interface SiteMapSnapshot {
  surfaces_seen: Surface[];
  surfaces_unexplored: Surface[];
  coverage_estimate: number;
}

export class SiteMap {
  private seen: Surface[] = [];
  private unexplored: Surface[] = [];

  markSeen(id: string, summary?: string, url?: string): void {
    const idx = this.unexplored.findIndex((s) => s.id === id);
    if (idx >= 0) this.unexplored.splice(idx, 1);
    if (!this.seen.some((s) => s.id === id)) {
      const surface: Surface = { id };
      if (summary !== undefined) surface.summary = summary;
      if (url !== undefined) surface.url = url;
      this.seen.push(surface);
    }
  }

  noteUnexplored(id: string, where_seen: string, reason_skipped?: string): void {
    if (this.seen.some((s) => s.id === id)) return;
    if (this.unexplored.some((s) => s.id === id)) return;
    const surface: Surface = { id, where_seen };
    if (reason_skipped !== undefined) surface.reason_skipped = reason_skipped;
    this.unexplored.push(surface);
  }

  serialize(): SiteMapSnapshot {
    const total = this.seen.length + this.unexplored.length;
    return {
      surfaces_seen: [...this.seen],
      surfaces_unexplored: [...this.unexplored],
      coverage_estimate: total === 0 ? 0 : this.seen.length / total,
    };
  }

  size(): { seen: number; unexplored: number } {
    return { seen: this.seen.length, unexplored: this.unexplored.length };
  }
}
