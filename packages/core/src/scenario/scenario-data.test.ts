import { describe, expect, it } from 'vitest';
import {
  scenarioInstructionHints,
  scenarioProofVisibleTextTokens,
  scenarioVisibleDataTokens,
} from './scenario-data.js';

describe('scenarioVisibleDataTokens', () => {
  it('extracts literal labels from model-authored scenario data', () => {
    expect(
      scenarioVisibleDataTokens([
        'Rectangle labels: Backlog, In Review, Released',
        'Arrow flow: Backlog -> In Review -> Released',
        'Optional board title text: Release flow',
        'Use the current board created in J1 or J2',
      ]),
    ).toEqual(['Backlog', 'In Review', 'Released']);
  });

  it('keeps meaningful colon labels and filters procedural guidance', () => {
    expect(
      scenarioVisibleDataTokens([
        'Sticky note text: Owner: Mia',
        'Heading: Sprint Retro',
        'Board topic: Launch ideas',
        'Risk: dependency',
        'Arrow connecting Kickoff to Launch',
        'Arrow connection from rectangle to note',
        'Arrow connections between each step',
        'Change one stage box to Blue or Violet',
        'Prefer Download or an export format surfaced by the menu',
        'Anonymous visitor state',
        'Upload a sample image if local chooser is available',
        'Risks or Wow',
      ]),
    ).toEqual([
      'Owner: Mia',
      'Sprint Retro',
      'Launch ideas',
      'Risk: dependency',
      'Kickoff',
      'Launch',
    ]);
  });

  it('separates non-literal scenario instructions for Explorer context', () => {
    expect(
      scenarioInstructionHints([
        'Notes: Ideas, Risks, Next steps',
        'Use a non-default color for at least one note or stroke',
      ]),
    ).toEqual(['Use a non-default color for at least one note or stroke']);
  });

  it('does not require procedural surface or connector prose as visible text', () => {
    expect(
      scenarioVisibleDataTokens([
        'Rectangle label: Ideas',
        'Rectangle label: Next Steps',
        'Connector meaning: flow from Ideas to Next Steps',
        'Target surfaces: Share, Sign in to share, Export, Download',
      ]),
    ).toEqual(['Ideas', 'Next Steps']);

    expect(
      scenarioInstructionHints([
        'Target surfaces: Share, Sign in to share, Export, Download',
      ]),
    ).toEqual(['Target surfaces: Share, Sign in to share, Export, Download']);
  });

  it('extracts labels from object-labeled phrases without requiring object prose', () => {
    expect(
      scenarioVisibleDataTokens([
        'Rectangle labeled Start',
        'Rectangle or note labeled Draft spec',
        'A diamond decision node named Approve?',
      ]),
    ).toEqual(['Start', 'Draft spec', 'Approve?']);
  });

  it('extracts visible values from scenario role prefixes and skips upload metadata', () => {
    expect(
      scenarioVisibleDataTokens([
        'Title: Support Triage Flow',
        'Decision: Customer blocked?',
        'Outcomes: Escalate, Close',
        'Caption: Activation trend',
        'Annotation: Check onboarding drop-off',
        'Invite context: Design review',
        'Media filename if upload is available: launch-chart.png',
      ]),
    ).toEqual([
      'Support Triage Flow',
      'Customer blocked?',
      'Escalate',
      'Close',
      'Activation trend',
      'Check onboarding drop-off',
      'Design review',
    ]);
  });
});

describe('scenarioProofVisibleTextTokens', () => {
  it('keeps literal text outputs and drops visual-only proof prose', () => {
    expect(
      scenarioProofVisibleTextTokens([
        'Project Phoenix kickoff',
        'Goal: launch beta',
        'Design complete',
        'Beta launch',
        'visible arrow between milestone objects',
        'visible media, image, embed card, or placeholder object',
        'one artifact element visibly styled or emphasized',
        'readable label "Approve?"',
        'visible export dialog, download event, or saved file evidence',
      ]),
    ).toEqual([
      'Project Phoenix kickoff',
      'Goal: launch beta',
      'Design complete',
      'Beta launch',
      'Approve?',
    ]);
  });
});
