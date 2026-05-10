export interface TentativeFinding {
  event_id: string;
  title: string;
  category: string;
  severity_hint: string;
  evidence_event_ids: string[];
  rationale: string;
  where?: { url?: string; selector?: string };
}

export interface FindingGroup {
  signature: string;
  members: TentativeFinding[];
  merged_evidence_event_ids: string[];
}

export function dedupFindings(tentatives: TentativeFinding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const t of tentatives) {
    const sig = signature(t);
    let g = groups.get(sig);
    if (!g) {
      g = { signature: sig, members: [], merged_evidence_event_ids: [] };
      groups.set(sig, g);
    }
    g.members.push(t);
    for (const id of t.evidence_event_ids) {
      if (!g.merged_evidence_event_ids.includes(id)) g.merged_evidence_event_ids.push(id);
    }
  }
  return [...groups.values()];
}

function signature(t: TentativeFinding): string {
  const url = t.where?.url ?? '';
  const sel = t.where?.selector ?? '';
  const titleNorm = t.title.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${t.category}|${url}|${sel}|${titleNorm}`;
}
