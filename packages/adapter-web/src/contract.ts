// Phase 9: web adapter's InteractionKit declaration and OutcomeContract impl.
//
// InteractionKit: enumerate everything the web adapter can do, so the Judge
// sees the surface area and the goal-claim validator can flag goals that
// required a missing primitive.
//
// OutcomeContract: for `verified` goal claims, the contract returns a list of
// screenshot artifacts taken AFTER the last successful interaction in the
// goal window. The Judge is required to cite at least one of these as
// evidence; if the only "evidence" is a side-effect (panel-appeared
// vision_describe with no shape visible), the goal-claim validator downgrades.

import type {
  InteractionKit,
  OutcomeArtifact,
  OutcomeContract,
  OutcomeContractTraceEvent,
} from '@iris/adapter-types';

export const WEB_INTERACTION_KIT: InteractionKit = {
  kind: 'web',
  primitives: [
    { name: 'click', user_action: 'click' },
    { name: 'type', user_action: 'type-text' },
    { name: 'select_option', user_action: 'select-dropdown-option' },
    { name: 'press', user_action: 'press-single-key' },
    { name: 'key_chord', user_action: 'press-modifier-chord' },
    { name: 'paste', user_action: 'paste-text' },
    { name: 'hover', user_action: 'hover' },
    { name: 'hover_wait', user_action: 'hover-and-wait' },
    { name: 'right_click', user_action: 'right-click-context-menu' },
    { name: 'double_click', user_action: 'double-click' },
    { name: 'drag', user_action: 'click-drag-by-delta' },
    {
      name: 'vision_drag',
      user_action: 'click-drag-coords',
      coverage_note: 'required for canvas drawing — single click does NOT draw a shape',
    },
    { name: 'scroll', user_action: 'scroll' },
    { name: 'upload', user_action: 'file-upload' },
    { name: 'click_upload', user_action: 'click-file-upload' },
    { name: 'click_download', user_action: 'download-file' },
    { name: 'navigate', user_action: 'navigate-url' },
    { name: 'back', user_action: 'browser-back' },
    { name: 'forward', user_action: 'browser-forward' },
    { name: 'reload', user_action: 'browser-reload' },
    { name: 'screenshot', user_action: 'capture-screenshot' },
    { name: 'vision_describe', user_action: 'describe-screen' },
    { name: 'vision_click', user_action: 'click-coords' },
    { name: 'vision_paste', user_action: 'paste-coords' },
    { name: 'vision_right_click', user_action: 'right-click-coords' },
    { name: 'vision_double_click', user_action: 'double-click-coords' },
    { name: 'vision_hover_wait', user_action: 'hover-coords-wait' },
  ],
};

// Tools whose successful action_result is an interaction with the product
// (something a real user would do). screenshot/vision_describe are passive
// observation tools, not interactions — outcomes are produced by interactions
// not observations.
const INTERACTION_TOOLS = new Set([
  'click',
  'type',
  'select_option',
  'press',
  'key_chord',
  'paste',
  'hover',
  'hover_wait',
  'right_click',
  'double_click',
  'drag',
  'vision_drag',
  'scroll',
  'upload',
  'click_upload',
  'click_download',
  'vision_click',
  'vision_paste',
  'vision_right_click',
  'vision_double_click',
  'vision_hover_wait',
]);

// Pure: given the goal window, locate outcome-shaped artifacts. For web,
// outcomes are screenshots taken AFTER the last successful interaction.
// A screenshot taken before any interaction is a "before" snapshot and
// does not prove the goal succeeded.
export function collectWebOutcomeEvidence(
  goal_events: OutcomeContractTraceEvent[],
): OutcomeArtifact[] {
  // Find the index of the last successful interaction. We look at action_result
  // events with ok=true whose paired action used an interaction tool.
  let lastInteractionIdx = -1;
  for (let i = 0; i < goal_events.length; i++) {
    const e = goal_events[i];
    if (!e) continue;
    if (e.kind !== 'action_result') continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p.ok !== true) continue;
    const tool = String(p.tool ?? '');
    if (!INTERACTION_TOOLS.has(tool)) continue;
    lastInteractionIdx = i;
  }
  if (lastInteractionIdx === -1) return [];

  const artifacts: OutcomeArtifact[] = [];
  // Collect outcome evidence in events AT or AFTER the last interaction.
  // Walk forward and pick:
  //   - observation events (each carries a screenshot of post-interaction state)
  //   - explicit screenshot action_results
  //   - vision_describe action_results — these carry a `description` field
  //     naming what the vision model saw on the post-interaction page. The
  //     description IS the outcome evidence the Judge needs to cite.
  //   - ui_state / state_delta / notifications_visible probe_results with post-interaction browser/product state
  //     (hash, scroll, or matched visible selectors), useful for section-nav and
  //     selection-state goals where the state probe is the most precise proof.
  //   - the paired `action` events that produced the above results — the
  //     Judge often cites the `action` event id (not the action_result),
  //     so accept both as equivalent.
  for (let i = lastInteractionIdx; i < goal_events.length; i++) {
    const e = goal_events[i];
    if (!e) continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === 'observation') {
      const ssRef = (p.screenshot_ref as string | undefined) ?? '';
      if (ssRef) {
        artifacts.push({
          kind: 'screenshot',
          ref: ssRef,
          note: 'post-interaction observation screenshot',
        });
      }
      // Also accept the observation event_id itself as a citable ref — the
      // Judge often cites event IDs rather than file paths.
      artifacts.push({
        kind: 'screenshot',
        ref: e.id,
        note: 'post-interaction observation event',
      });
    }
    if (e.kind === 'action_result' && p.ok === true) {
      const tool = String(p.tool ?? '');
      if (tool === 'screenshot') {
        const refs = (p.evidence_refs as string[] | undefined) ?? [];
        for (const r of refs) {
          artifacts.push({ kind: 'screenshot', ref: r, note: 'explicit screenshot action' });
        }
        artifacts.push({ kind: 'screenshot', ref: e.id, note: 'screenshot action event' });
      }
      if (tool === 'vision_describe') {
        const description = (p.description as string | undefined) ?? '';
        artifacts.push({
          kind: 'screenshot',
          ref: e.id,
          note: description
            ? `vision_describe: ${description.slice(0, 120)}`
            : 'vision_describe action result',
        });
      }
      if (tool === 'click_download') {
        const refs = (p.evidence_refs as string[] | undefined) ?? [];
        for (const r of refs) {
          artifacts.push({ kind: 'file_download', ref: r, note: 'downloaded file evidence' });
        }
        artifacts.push({ kind: 'file_download', ref: e.id, note: 'download action result' });
      }
    }
    if (e.kind === 'probe_result' && isUiStateOutcomeProbe(p)) {
      artifacts.push({
        kind: 'screenshot',
        ref: e.id,
        note: uiStateOutcomeNote(p),
      });
    }
    // The Judge sometimes cites the `action` event id rather than the
    // corresponding action_result. Accept that only when the paired passive
    // action_result succeeded; a failed screenshot/vision request is not proof.
    if (e.kind === 'action') {
      const tool = String(p.tool ?? '');
      if (
        (tool === 'screenshot' || tool === 'vision_describe') &&
        hasSuccessfulPassiveActionResult(goal_events, i, tool)
      ) {
        artifacts.push({ kind: 'screenshot', ref: e.id, note: `${tool} action event` });
      }
    }
  }
  return artifacts;
}

function isUiStateOutcomeProbe(payload: Record<string, unknown>): boolean {
  if (payload.ok !== true) return false;
  const probe = String(payload.probe ?? '');
  if (probe === 'state_delta') {
    const summary = asRecord(payload.summary);
    return summary.changed === true;
  }
  if (probe === 'notifications_visible') {
    const summary = asRecord(payload.summary);
    const count = typeof summary.count === 'number' ? summary.count : 0;
    return count > 0;
  }
  if (probe !== 'ui_state') return false;
  const summary = asRecord(payload.summary);
  if (typeof summary.hash === 'string' && summary.hash.trim()) return true;
  const scroll = asRecord(summary.scroll);
  const scrollY = typeof scroll.y === 'number' ? scroll.y : 0;
  const scrollX = typeof scroll.x === 'number' ? scroll.x : 0;
  if (scrollY > 0 || scrollX > 0) return true;
  const found = typeof summary.selectors_found === 'number' ? summary.selectors_found : 0;
  return found > 0;
}

function hasSuccessfulPassiveActionResult(
  events: OutcomeContractTraceEvent[],
  actionIndex: number,
  tool: string,
): boolean {
  for (let i = actionIndex + 1; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;
    if (event.kind === 'action') return false;
    if (event.kind !== 'action_result') continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (String(payload.tool ?? '') !== tool) continue;
    return payload.ok === true;
  }
  return false;
}

function uiStateOutcomeNote(payload: Record<string, unknown>): string {
  const summary = asRecord(payload.summary);
  if (String(payload.probe ?? '') === 'notifications_visible') {
    const count = typeof summary.count === 'number' ? summary.count : 0;
    const texts = notificationTexts(payload.data);
    const suffix = texts.length > 0 ? `: ${texts.join('; ')}` : '';
    return `post-interaction notifications_visible count=${count}${suffix}`;
  }
  if (String(payload.probe ?? '') === 'state_delta') {
    const parts = ['post-interaction state_delta'];
    if (summary.text_changed === true) parts.push('text_changed=true');
    const before =
      typeof summary.element_count_before === 'number' ? summary.element_count_before : undefined;
    const after =
      typeof summary.element_count_after === 'number' ? summary.element_count_after : undefined;
    if (before !== undefined && after !== undefined && before !== after) {
      parts.push(`elements=${before}->${after}`);
    }
    return parts.join(' ');
  }
  const parts: string[] = ['post-interaction ui_state'];
  if (typeof summary.hash === 'string' && summary.hash.trim()) parts.push(`hash=${summary.hash}`);
  const scroll = asRecord(summary.scroll);
  const scrollY = typeof scroll.y === 'number' ? scroll.y : 0;
  const scrollX = typeof scroll.x === 'number' ? scroll.x : 0;
  if (scrollY > 0 || scrollX > 0) parts.push(`scroll=(${scrollX},${scrollY})`);
  const found = typeof summary.selectors_found === 'number' ? summary.selectors_found : 0;
  const total = typeof summary.selectors_total === 'number' ? summary.selectors_total : undefined;
  if (found > 0) parts.push(`selectors_found=${found}${total === undefined ? '' : `/${total}`}`);
  return parts.join(' ');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function notificationTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const text = typeof record.text === 'string' ? record.text.replace(/\s+/g, ' ').trim() : '';
      const source =
        typeof record.source === 'string' ? record.source.replace(/\s+/g, ' ').trim() : '';
      if (!text) return '';
      return `${source ? `${source}: ` : ''}"${text.slice(0, 120)}"`;
    })
    .filter(Boolean)
    .slice(0, 3);
}

export const WEB_OUTCOME_CONTRACT: OutcomeContract = {
  kind: 'web',
  collectOutcomeEvidence: ({ goal_events }) => collectWebOutcomeEvidence(goal_events),
};
