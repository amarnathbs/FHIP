// Admin A0.2 Wave 5 — in-product task help registry (§17).
//
// Before this Wave there was no Help affordance anywhere in Admin: an
// administrator who did not already know what a page did had nothing to
// read on the page itself, and the operator manuals lived only in the
// repository (which operators cannot open, and which must never be linked
// from the product — §17: "do not expose filesystem or repository paths to
// users").
//
// This registry is the single source the in-product Help disclosure renders
// from, and it is deliberately the SAME content, in the same order, as the
// corresponding manual entry in docs/admin/A02_WAVE5_ADMIN_TASK_MANUALS.md.
// Keeping them in one shape is what makes §16's manual-coverage matrix
// checkable rather than aspirational: a task with no entry here has no Help,
// and a Help entry whose `taskId` has no manual section is a documentation
// defect, not a silent gap.
//
// Deliberately NOT built here (§17's own boundary): no new documentation
// platform, no separate Help route, no external links, no search. This is a
// per-page disclosure rendered from static copy — nothing more.

export type TaskAvailability = 'operational' | 'not_operational';

export interface AdminTaskHelp {
  /** Stable identifier, matching the manual's own task index. */
  taskId: string;
  /** Task name, in the same words the manual and the UI use. */
  name: string;
  /** What the administrator accomplishes, in one sentence. */
  purpose: string;
  /** Who may perform it, in role names an operator recognises. */
  eligibleRoles: string;
  /** What must already be true before starting. Empty array = nothing. */
  prerequisites: string[];
  /** The steps, using the exact control labels rendered on the page. */
  steps: string[];
  /** How the administrator knows it worked. */
  successEvidence: string;
  /** How to undo it, or an explicit statement that it cannot be undone. */
  reversal: string;
  /** The logical next task. */
  nextStep: string;
  /** Whether the task is operational today. */
  availability: TaskAvailability;
  /** Shown when availability is 'not_operational'. */
  unavailableReason?: string;
}

export const ADMIN_TASK_HELP: Record<string, AdminTaskHelp> = {
  'ADM-01': {
    taskId: 'ADM-01',
    name: 'Approve, suspend or reinstate a benchmark source',
    purpose:
      'Move a benchmark source through its governance lifecycle so that datasets citing it can pass activation checks.',
    eligibleRoles: 'Super Admin only.',
    prerequisites: ['The source already exists. Create it first with Add source on the Sources tab.'],
    steps: [
      'Open the Sources tab.',
      'Find the source in the table and read its Status column.',
      'For a Draft or Under review source, select Approve.',
      'For an Approved or Active source, select Suspend and confirm. Datasets citing it will fail validation until it is reinstated.',
      'For a Suspended source, select Reinstate to return it to Approved.',
    ],
    successEvidence:
      'A confirmation message appears above the table and the row’s Status column shows the new value after the table reloads from the server.',
    reversal:
      'Suspend is reversed by Reinstate. There is no control that returns an approved source to draft — approval is intended to move forward only.',
    nextStep: 'Validate or activate a dataset that cites this source (Datasets tab).',
    availability: 'operational',
  },
  'ADM-02': {
    taskId: 'ADM-02',
    name: 'Validate, activate or retire a benchmark dataset',
    purpose:
      'Move a dataset from draft figures into the live benchmark data the product serves, after checking it against the same rules activation enforces.',
    eligibleRoles: 'Super Admin only.',
    prerequisites: [
      'The dataset’s linked source is Approved or Active (see Sources tab).',
      'Market and regulatory-class datasets have at least one recorded observed value.',
    ],
    steps: [
      'Open the Datasets tab.',
      'Select Validate on the dataset row. Nothing is changed — this only reports whether activation would succeed and lists every failing rule.',
      'Correct any reported problem in the Sources tab or the underlying values, then validate again.',
      'Select Activate and confirm. The dataset starts being served and a one-year review date is set.',
      'Select Retire and confirm to take an active dataset out of service.',
    ],
    successEvidence:
      'The Datasets table reloads from the server and the Status column plus the available action (Activate or Retire) reflect the committed state. Every activation attempt — accepted or rejected — is recorded in the Update / audit log tab.',
    reversal:
      'Retire reverses Activate. There is no un-retire control; reactivating means selecting Activate again, which re-validates from scratch.',
    nextStep: 'Check the Update / audit log tab to confirm the change was recorded.',
    availability: 'operational',
  },
  'ADM-03': {
    taskId: 'ADM-03',
    name: 'Review benchmark reference data and the audit log',
    purpose:
      'Inspect the cohorts, observed values, planning target ranges and change history that the benchmark lifecycle acts on.',
    eligibleRoles: 'Super Admin only.',
    prerequisites: [],
    steps: [
      'Select the Cohorts, Observed values, Planning target ranges or Update / audit log tab.',
      'The table loads automatically. These four tabs make no changes of any kind.',
    ],
    successEvidence: 'Not applicable — nothing is changed by viewing these tabs.',
    reversal: 'Not applicable.',
    nextStep: 'Return to the Datasets tab to act on what the log shows.',
    availability: 'operational',
  },
  'ADM-04': {
    taskId: 'ADM-04',
    name: 'Create, edit, activate or deactivate a recommendation',
    purpose:
      'Maintain the recommendation library that decides which guidance a person is shown against their own results.',
    eligibleRoles: 'Super Admin only.',
    prerequisites: ['A stable recommendation code that is not already in use, when creating.'],
    steps: [
      'Use Search and the category filter to find an existing recommendation, or scroll to the form to create a new one.',
      'Select Edit on a recommendation to load it into the form.',
      'Set the trigger, the conditions and the wording. Conditions in the same group are combined with OR; different groups are combined with AND.',
      'Select Save changes or Create recommendation.',
      'Use Deactivate to stop a recommendation being served, and confirm. Use Activate to serve it again.',
    ],
    successEvidence:
      'A confirmation message appears beneath the form, and the library entry shows the committed values and its Active or Inactive state.',
    reversal:
      'Deactivate and Activate reverse each other. Edits overwrite the previous wording — there is no version history for recommendations.',
    nextStep: 'Check Gap review for evaluations that still match nothing.',
    availability: 'operational',
  },
  'ADM-05': {
    taskId: 'ADM-05',
    name: 'Bulk update recommendations from a CSV file',
    purpose:
      'Update many recommendations at once from the same column format as the master, conditions, calculation-method and placeholder files.',
    eligibleRoles: 'Super Admin only.',
    prerequisites: ['A CSV file in the exact column format for the type you select.'],
    steps: [
      'Choose the file type that matches your CSV.',
      'Select the file. The upload starts as soon as a file is chosen.',
      'Read the result message. Matching codes are updated in place, new codes are added, and codes absent from the file are left untouched.',
      'If validation fails, no existing data is changed — correct the listed rows and upload again.',
    ],
    successEvidence:
      'The result message states exactly how many recommendations were affected and how many conditions were inserted or replaced.',
    reversal:
      'There is no undo for a successful import. Re-upload a corrected file with the same codes to overwrite the values again.',
    nextStep: 'Spot-check an affected recommendation in the library.',
    availability: 'operational',
  },
  'ADM-06': {
    taskId: 'ADM-06',
    name: 'Review recommendation coverage gaps',
    purpose:
      'See real evaluations where nothing in the library matched, so you can decide whether a new recommendation is needed.',
    eligibleRoles: 'Super Admin only.',
    prerequisites: [],
    steps: [
      'Scroll to Gap review.',
      'Select Show context on a row to see the exact data that was evaluated.',
      'Decide whether to add or broaden a recommendation.',
    ],
    successEvidence: 'Not applicable — nothing is changed by reviewing gaps.',
    reversal: 'Not applicable.',
    nextStep: 'Create or edit a recommendation to cover the gap.',
    availability: 'operational',
  },
  'ADM-07': {
    taskId: 'ADM-07',
    name: 'Use the Resources dashboard',
    purpose: 'See what needs attention across Resources content and jump to the right queue.',
    eligibleRoles: 'Resource Admin, Author, Editor, Compliance Reviewer, Publisher, Super Admin.',
    prerequisites: [],
    steps: [
      'Read the Content overview counts.',
      'Use Needs attention to open the editorial review, compliance review, review-due or scheduled queues.',
      'Use Recent content to reopen something you were working on.',
    ],
    successEvidence: 'Not applicable — the dashboard makes no changes.',
    reversal: 'Not applicable.',
    nextStep: 'Open the queue with the highest count.',
    availability: 'operational',
  },
  'ADM-08': {
    taskId: 'ADM-08',
    name: 'Create or edit an article, guide or FHIP explainer',
    purpose: 'Write and maintain the long-form educational content the public Resources site serves.',
    eligibleRoles: 'Author, Editor, Resource Admin, Super Admin (create and edit); other Resources roles can view.',
    prerequisites: ['A primary category and an author record must exist before the content can be submitted for review.'],
    steps: [
      'Select New content and choose the content type, or open an existing item and select Edit.',
      'Enter the title. The URL slug is generated from it; select Check availability before publication if you change it.',
      'Write the summary and add content blocks. Use Add block for each section.',
      'Complete the sidebar: primary category, jurisdiction, author, compliance classification and review date.',
      'Select Save draft. Add a change summary first if you want this save recorded as a named revision.',
    ],
    successEvidence:
      'The save indicator shows Saved, and a new entry appears in Revision history when a change summary was supplied.',
    reversal:
      'Earlier revisions are listed in Revision history but cannot be restored from the interface in this release. Re-edit the content to correct it.',
    nextStep: 'Submit the content for editorial review from the Workflow panel.',
    availability: 'operational',
  },
  'ADM-09': {
    taskId: 'ADM-09',
    name: 'Move content through the publishing workflow',
    purpose:
      'Take content from draft to published through editorial and compliance review, or send it back and archive it.',
    eligibleRoles:
      'Author (submit), Editor (editorial approval), Compliance Reviewer (compliance approval), Publisher and Resource Admin (publish), Super Admin.',
    prerequisites: [
      'All unsaved changes are saved — workflow actions are blocked until they are.',
      'The content passes the checks listed against each field.',
    ],
    steps: [
      'Save your changes first. Workflow actions stay unavailable while anything is unsaved.',
      'Select the action that matches the stage: Submit for editorial review, Approve editorially, Send to compliance review, Approve compliance review, or Publish now.',
      'Publish now, and Send back to draft and Archive, ask you to confirm before anything changes.',
      'For Send back to draft and Archive, add a reason so the next person knows why.',
    ],
    successEvidence:
      'A confirmation message names the new state, the status badge changes, and a new row appears in the workflow history below.',
    reversal:
      'Send back to draft reverses an approval. Archive is reversed by moving the content forward again from its archived state. Publishing is reversed by archiving — the public page stops being served.',
    nextStep: 'Check the content appears correctly using Preview.',
    availability: 'operational',
  },
  'ADM-10': {
    taskId: 'ADM-10',
    name: 'Schedule content for future publication',
    purpose: 'Publish content automatically at a chosen future date and time.',
    eligibleRoles: 'Not applicable while this is unavailable.',
    prerequisites: [],
    steps: [],
    successEvidence: 'Not applicable.',
    reversal: 'Not applicable.',
    nextStep: 'Use Publish now at the time you want the content to go live.',
    availability: 'not_operational',
    unavailableReason:
      'Scheduled publication is not available in this release. There is no Schedule action in the workflow panel and nothing publishes content automatically, so a date entered anywhere will not cause publication. Publish now takes effect immediately.',
  },
  'ADM-11': {
    taskId: 'ADM-11',
    name: 'Add or edit a video',
    purpose: 'Maintain the video library, including its transcript and chapters.',
    eligibleRoles: 'Author, Editor, Resource Admin, Super Admin (create and edit); other Resources roles can view.',
    prerequisites: ['The YouTube URL or video ID.'],
    steps: [
      'Select Add video and paste the YouTube URL or the bare video ID.',
      'Complete the title, summary and the sidebar metadata.',
      'Paste the transcript. Transcripts are entered by hand — nothing is scraped or generated.',
      'Add chapters with a timestamp in mm:ss or h:mm:ss form.',
      'Select Save.',
    ],
    successEvidence: 'The save indicator shows Saved.',
    reversal: 'Re-edit the record. Video records are archived through the workflow panel, not deleted.',
    nextStep: 'Submit the video for editorial review from the Workflow panel.',
    availability: 'operational',
  },
  'ADM-12': {
    taskId: 'ADM-12',
    name: 'Create or edit a glossary definition',
    purpose: 'Maintain the plain-English glossary the rest of the product links into.',
    eligibleRoles: 'Author, Editor, Resource Admin, Super Admin (create and edit); other Resources roles can view.',
    prerequisites: [],
    steps: [
      'Select New glossary definition.',
      'Enter the term. If similar terms already exist you are told before you go further — check you are not duplicating one.',
      'Write the short definition as one clear sentence, then add any expanded content.',
      'Add aliases so people searching for another name for the same idea still find it.',
      'Select Save.',
    ],
    successEvidence: 'The save indicator shows Saved.',
    reversal: 'Re-edit the definition. Definitions are archived through the workflow panel, not deleted.',
    nextStep: 'Submit the definition for editorial review from the Workflow panel.',
    availability: 'operational',
  },
  'ADM-13': {
    taskId: 'ADM-13',
    name: 'Create or edit a money update',
    purpose: 'Publish a short, dated explanation of a real-world financial development.',
    eligibleRoles: 'Author, Editor, Resource Admin, Super Admin (create and edit); other Resources roles can view.',
    prerequisites: ['The date the development actually occurred.'],
    steps: [
      'Select Create money update, or create one from an existing template.',
      'Enter the title, the summary and the event date in YYYY-MM-DD form.',
      'Complete the structured sections that are pre-populated for you.',
      'Cite the official sources the update relies on.',
      'Select Save.',
    ],
    successEvidence: 'The save indicator shows Saved.',
    reversal: 'Re-edit the record. Money updates are archived through the workflow panel, not deleted.',
    nextStep: 'Submit the money update for editorial review from the Workflow panel.',
    availability: 'operational',
  },
  'ADM-14': {
    taskId: 'ADM-14',
    name: 'Create, edit or delete an FAQ',
    purpose: 'Maintain reusable questions and answers that can be attached to any Resources content.',
    eligibleRoles: 'Editor, Resource Admin, Super Admin.',
    prerequisites: [],
    steps: [
      'Select New FAQ, or Edit on an existing one.',
      'Write a question and a short answer that stands alone — the same FAQ can appear on several pages.',
      'Add any expanded answer, then set the jurisdiction, category and compliance classification.',
      'Use Linked content to attach the FAQ to specific pages, and Unlink to detach it.',
      'Select Save. Use Delete FAQ only for an FAQ that is not linked anywhere — mark it inactive instead if it is.',
    ],
    successEvidence: 'Saved appears next to the Save button, and linked content is listed under Linked content.',
    reversal:
      'Deleting an FAQ cannot be undone. Setting an FAQ inactive is fully reversible and hides it from public pages while keeping it editable.',
    nextStep: 'Check the FAQ appears where you linked it.',
    availability: 'operational',
  },
  'ADM-15': {
    taskId: 'ADM-15',
    name: 'Create, edit, activate or deactivate a call to action',
    purpose:
      'Maintain the controlled set of calls to action that bridge educational content to the rest of FHIP.',
    eligibleRoles: 'Resource Admin, Super Admin.',
    prerequisites: [],
    steps: [
      'Select New CTA, or Edit on an existing one.',
      'Give it an internal name, the public label readers see, and the destination.',
      'Select Create CTA or Save changes.',
      'Use Deactivate to remove a CTA from every public page that uses it, and confirm. Use Activate to restore it.',
    ],
    successEvidence:
      'A confirmation message appears above the table, and the Active column shows the committed state.',
    reversal: 'Deactivate and Activate reverse each other. There is no delete.',
    nextStep: 'Attach the CTA to content from the content editor sidebar.',
    availability: 'operational',
  },
  'ADM-16': {
    taskId: 'ADM-16',
    name: 'Curate related content',
    purpose:
      'Choose exactly which other resources appear alongside a given resource, overriding the automatic match.',
    eligibleRoles: 'Resource Admin, Super Admin.',
    prerequisites: ['The resource you want to curate already exists.'],
    steps: [
      'Search for and choose the resource you want to manage.',
      'Search for another resource and select it to add the relationship, then choose the relationship type.',
      'Use the up and down controls to set the order readers see.',
      'Use Remove and confirm to delete a relationship.',
    ],
    successEvidence:
      'A confirmation message appears, and the list shows the committed order returned by the server — not just the order you clicked.',
    reversal: 'Add the relationship again to restore it. Ordering can be changed at any time.',
    nextStep: 'Check the public page shows the resources in the order you set.',
    availability: 'operational',
  },
  'ADM-17': {
    taskId: 'ADM-17',
    name: 'Map a resource to an in-product context',
    purpose:
      'Decide which resource the "What does this mean?" link opens from a specific place in the product.',
    eligibleRoles: 'Resource Admin, Super Admin.',
    prerequisites: ['The resource you want to link to is published, or the link will not render.'],
    steps: [
      'Choose the context key you want to map.',
      'Search for a resource and select it to add the mapping.',
      'Use the up and down controls to order the mappings — the lowest-ordered active mapping is the one readers get.',
      'Use Deactivate to stop a mapping being used without deleting it, and Remove with confirmation to delete it.',
    ],
    successEvidence: 'A confirmation message appears and the list reloads from the server showing the committed state.',
    reversal: 'Activate reverses Deactivate. A removed mapping must be added again.',
    nextStep: 'Open the product page for that context and check the link resolves.',
    availability: 'operational',
  },
  'ADM-18': {
    taskId: 'ADM-18',
    name: 'Assign or remove a Resources role',
    purpose: 'Control who can author, review, approve and publish Resources content.',
    eligibleRoles: 'Resource Admin, Super Admin.',
    prerequisites: ['The person already has an FHIP account.'],
    steps: [
      'Search by name or email to find the person.',
      'Choose the role in the row and select Assign.',
      'To remove a role, select the remove control on the role and confirm.',
    ],
    successEvidence:
      'A confirmation message names the person and the role, and their role list updates after the table reloads.',
    reversal: 'Assign the role again to restore it. Removing a role never deletes past work or historical assignments.',
    nextStep: 'Ask the person to sign out and back in so their new access takes effect.',
    availability: 'operational',
  },
  'ADM-19': {
    taskId: 'ADM-19',
    name: 'View Resources analytics',
    purpose: 'See usage and engagement reporting for Resources content.',
    eligibleRoles: 'Not applicable while this is unavailable.',
    prerequisites: [],
    steps: [],
    successEvidence: 'Not applicable.',
    reversal: 'Not applicable.',
    nextStep: 'None yet.',
    availability: 'not_operational',
    unavailableReason:
      'No analytics are available yet. This area exists ahead of the reporting it will hold, and shows no figures of any kind. Nothing on it is a placeholder for a real value.',
  },
  'ADM-21': {
    taskId: 'ADM-21',
    name: 'Work a content queue',
    purpose:
      'See only the content at one stage of the publishing workflow, so nothing waits unnoticed.',
    eligibleRoles: 'Resource Admin, Author, Editor, Compliance Reviewer, Publisher, Super Admin.',
    prerequisites: [],
    steps: [
      'Open the queue from the Admin menu. Each queue is already limited to its own stage — there is no status filter to set.',
      'Narrow further with search, type, jurisdiction, compliance and category, then sort.',
      'Select View on a row to open the content, then Edit to act on it.',
      'Use Clear filters to return to the full queue.',
    ],
    successEvidence: 'Not applicable — queues make no changes.',
    reversal: 'Not applicable.',
    nextStep: 'Open the content and act on it from its Workflow panel.',
    availability: 'operational',
  },
};

export function getTaskHelp(taskId: string): AdminTaskHelp | null {
  return ADMIN_TASK_HELP[taskId] ?? null;
}

export const ADMIN_TASK_IDS = Object.keys(ADMIN_TASK_HELP);
