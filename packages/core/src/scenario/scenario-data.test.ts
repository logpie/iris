import { describe, expect, it } from 'vitest';
import {
  scenarioEvidenceSatisfiesToken,
  scenarioInstructionHints,
  scenarioProofVisibleTextTokens,
  scenarioVisibleDataTokens,
  selectProductUseJobForGoal,
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
      scenarioInstructionHints(['Target surfaces: Share, Sign in to share, Export, Download']),
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

  it('extracts concrete examples from explanatory required-output prose', () => {
    expect(
      scenarioVisibleDataTokens([
        'Products or equivalent inventory heading',
        'At least one product name such as Sauce Labs Backpack',
        'Price low to high or equivalent selected option',
        'Multiple product prices visible',
        'Product cards remain accessible',
        'standard_user credentials submitted',
        'standard_user was used as input',
        'standard_user was entered before submit',
        'standard_user was used',
        'standard_user credentials were used',
        'locked_out_user submitted',
        'locked_out_user was entered before submit',
        'secret_sauce was used as password input',
        'secret_sauce was entered before submit',
        'secret_sauce was used',
        'customer information fields submitted',
        'completed-order confirmation message',
      ]),
    ).toEqual([
      'Products',
      'Sauce Labs Backpack',
      'Price low to high',
      'standard_user',
      'locked_out_user',
      'secret_sauce',
    ]);
  });

  it('keeps concrete auth values but drops abstract auth state assertions', () => {
    expect(
      scenarioVisibleDataTokens([
        'Username: standard_user',
        'Password: secret_sauce',
        'standard_user credentials submitted',
        'locked_out_user submitted',
        'Login page no longer blocks access',
        'Login action was submitted',
        'Login button was submitted',
        'Authenticated destination or app content visible',
        'The original username/password login form is not the only visible state',
        'No login error blocking the user',
        'Error message visible',
        'No authenticated app page visible',
        'Login form remains available',
        'post-action evidence shows the product outcome required by this capability',
        'Epic sadface: Sorry, this user has been locked out.',
      ]),
    ).toEqual([
      'standard_user',
      'secret_sauce',
      'locked_out_user',
      'Epic sadface: Sorry, this user has been locked out',
    ]);
  });

  it('extracts commerce and data-grid labels while dropping reversed absence claims', () => {
    expect(
      scenarioVisibleDataTokens([
        'Product: Sauce Labs Backpack',
        'Search: London',
        'Sort column: Age',
        'Login error absent',
      ]),
    ).toEqual(['Sauce Labs Backpack', 'London', 'Age']);
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

  it('keeps full code-like required outputs instead of reducing them to quoted selectors', () => {
    expect(
      scenarioProofVisibleTextTokens([
        "new DataTable('#example');",
        "Snippet: new DataTable('#orders')",
        "Initialization: new DataTable('#users');",
        "Code sample: $('#example').DataTable();",
      ]),
    ).toEqual([
      "new DataTable('#example');",
      "new DataTable('#orders')",
      "new DataTable('#users');",
      "$('#example').DataTable();",
    ]);
  });

  it('keeps concrete product/grid proof but does not treat inputs or absence as visible proof', () => {
    expect(
      scenarioProofVisibleTextTokens([
        'standard_user credentials submitted',
        'Authenticated product or inventory content visible',
        'Login error absent',
        'Product: Sauce Labs Backpack',
        'Sauce Labs Backpack visible in cart',
        'Search: London',
        'London rows visible',
        '25 entries per page',
        'Showing 1 to 25 of 57 entries',
        'Sort column: Age',
        'Employee rows reordered by Age',
        'Employee rows with ages ordered consistently',
        'Age column sorted',
        'changed employee row order visible',
        'Office London in visible rows',
        'Salary header active sort indicator',
        'A high salary such as $1,200,000 near the top when descending',
        '$1,200,000 or another extreme salary depending on direction',
        'Initial first row Airi Satou no longer proves the active order',
        'A changed first visible employee row compared with default Airi Satou',
      ]),
    ).toEqual([
      'Products',
      'Sauce Labs Backpack',
      'London',
      'Showing 1 to 25 of 57 entries',
      'Age',
      '$1,200,000',
    ]);
  });

  it('does not turn comparative data-grid proof prose into a literal requirement', () => {
    expect(
      scenarioProofVisibleTextTokens([
        'Salary',
        '$1,200,000 or another extreme salary depending on direction',
        'A changed first visible employee row compared with default Airi Satou',
        'Age column sorted',
        'changed row order visible',
      ]),
    ).toEqual(['Salary', '$1,200,000']);
  });
});

describe('scenarioEvidenceSatisfiesToken', () => {
  it('matches approximate BMI outputs against visible result text', () => {
    const observed =
      'Result BMI = 29.4 kg/m2 (Overweight) BMI = 29.4 Healthy BMI range: 18.5 kg/m2 - 25 kg/m2';

    expect(scenarioEvidenceSatisfiesToken(observed, 'BMI near 29.4 kg/m2')).toBe(true);
    expect(scenarioEvidenceSatisfiesToken(observed, 'BMI near 28.1 kg/m2')).toBe(false);
    expect(scenarioEvidenceSatisfiesToken(observed, 'Overweight category')).toBe(true);
  });

  it('uses structural unit-mode evidence instead of plain tab text', () => {
    const visible = 'US Units Metric Units Other Units Result BMI = 29.4 kg/m2';
    const structural = 'https://www.calculator.net/bmi-calculator.html?ctype=metric&x=Calculate';

    expect(scenarioEvidenceSatisfiesToken(visible, 'Metric Units tab active', structural)).toBe(
      true,
    );
    expect(scenarioEvidenceSatisfiesToken(visible, 'Other Units tab active', structural)).toBe(
      false,
    );
  });

  it('does not accept static BMI category table copy as a result category', () => {
    const staticTable =
      'BMI table for adults Classification BMI range Normal 18.5 - 25 Overweight 25 - 30';

    expect(scenarioEvidenceSatisfiesToken(staticTable, 'Overweight category')).toBe(false);
  });

  it('does not let structural metadata satisfy generic visible-proof text', () => {
    expect(
      scenarioEvidenceSatisfiesToken(
        '',
        'Checkout complete',
        'https://example.test/checkout-complete',
      ),
    ).toBe(false);
    expect(
      scenarioEvidenceSatisfiesToken('', 'Save', 'button.save[data-testid="save-button"]'),
    ).toBe(false);
  });

  it('limits approximate numeric matching to BMI-labeled requirements', () => {
    expect(scenarioEvidenceSatisfiesToken('Total: $29.50 Tax: $2.10', 'Total near 29.4')).toBe(
      false,
    );
  });
});

describe('selectProductUseJobForGoal', () => {
  const jobs = [
    {
      id: 'PU1',
      title: 'Filter the employee table to London rows',
      journey_id: 'J1',
      scenario_brief: 'Use table Search to filter the employee grid for London office rows.',
      required_outputs: ['London', 'filtered from 57 total entries'],
    },
    {
      id: 'PU2',
      title: 'Sort employees by age',
      journey_id: 'J1',
      scenario_brief: 'Sort the employee table by Age in ascending order.',
      required_outputs: ['Age', '19', '20', '21'],
    },
    {
      id: 'PU3',
      title: 'Change page length and move to the next page',
      journey_id: 'J1',
      scenario_brief: 'Change page length to 25 entries and navigate to page 2.',
      required_outputs: ['25 entries per page', 'Showing 26 to 50 of 57 entries'],
    },
  ];

  it('does not treat journey_id as a unique product-use job id', () => {
    expect(
      selectProductUseJobForGoal(jobs, {
        id: 'G2',
        description: 'Clear filters, sort the employee table by Age, and verify ascending ages.',
        journey_id: 'J1',
      })?.id,
    ).toBe('PU2');

    expect(
      selectProductUseJobForGoal(jobs, {
        id: 'G3',
        description: 'Set 25 entries per page, open page 2, and verify the 26 to 50 range.',
        journey_id: 'J1',
      })?.id,
    ).toBe('PU3');
  });

  it('returns undefined instead of guessing when duplicate journey jobs are ambiguous', () => {
    expect(
      selectProductUseJobForGoal(jobs, {
        id: 'G4',
        description: 'Use the employee table.',
        journey_id: 'J1',
      }),
    ).toBeUndefined();
  });
});
