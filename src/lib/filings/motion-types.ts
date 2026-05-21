/**
 * Curated catalogue of motion types.
 *
 * This list backs the `MotionType: Choice` XETO spec (see Agent B's spec build)
 * and the combo dropdown used to tag motions in the UI. Entries are sourced
 * from:
 *   - `user-data`  — observed in this user's filings (Texas family law +
 *                    appellate practice)
 *   - `texas-rules` — Texas Rules of Civil Procedure / Appellate Procedure
 *   - `frcp`        — Federal Rules of Civil Procedure
 *   - `practice`    — common civil-litigation motions not yet observed in the
 *                     user's data but expected to come up
 *
 * Keep this file plain data — no logic. Sorted alphabetically by displayName
 * (en-US locale-compare).
 */

export type MotionTypeCategory =
  | 'disposition'
  | 'discovery'
  | 'scheduling'
  | 'procedural'
  | 'appellate'
  | 'family-law'
  | 'evidence'
  | 'protective'
  | 'other';

export interface MotionTypeEntry {
  /** camelCase identifier — used as XETO Choice marker name. */
  slug: string;
  /** Human-readable label shown in the combo dropdown. */
  displayName: string;
  category: MotionTypeCategory;
  /** One-line description for tooltips / docs. */
  shortDoc: string;
  source: 'user-data' | 'texas-rules' | 'frcp' | 'practice';
  /** Alternative search terms — combo UI filters displayName AND aliases. */
  aliases?: string[];
}

export const MOTION_TYPES: readonly MotionTypeEntry[] = [
  {
    slug: 'antiSuitInjunction',
    displayName: 'Motion for Anti-Suit Injunction',
    category: 'protective',
    shortDoc: 'Asks the court to enjoin a party from prosecuting a parallel suit elsewhere.',
    source: 'practice',
  },
  {
    slug: 'forBillOfReview',
    displayName: 'Motion for Bill of Review',
    category: 'family-law',
    shortDoc: 'Equitable Texas action to vacate a prior judgment after appellate timetables have run.',
    source: 'user-data',
    aliases: ['Bill of Review', 'BOR'],
  },
  {
    slug: 'clarification',
    displayName: 'Motion for Clarification',
    category: 'procedural',
    shortDoc: 'Asks the court to clarify an ambiguous ruling or order before entry.',
    source: 'user-data',
  },
  {
    slug: 'continue',
    displayName: 'Motion for Continuance',
    category: 'scheduling',
    shortDoc: 'Asks the court to postpone a hearing, trial, or deadline.',
    source: 'user-data',
    aliases: ['Continuance', 'Postpone'],
  },
  {
    slug: 'defaultJudgment',
    displayName: 'Motion for Default Judgment',
    category: 'disposition',
    shortDoc: 'Asks the court to enter judgment against a party who failed to answer or appear.',
    source: 'practice',
  },
  {
    slug: 'enBancReconsideration',
    displayName: 'Motion for En Banc Reconsideration',
    category: 'appellate',
    shortDoc: 'Asks the full appellate court (not just a panel) to rehear the case.',
    source: 'texas-rules',
    aliases: ['En Banc'],
  },
  {
    slug: 'enforce',
    displayName: 'Motion for Enforcement',
    category: 'family-law',
    shortDoc: 'Asks the court to enforce a prior order (typically a family-law decree).',
    source: 'practice',
    aliases: ['Enforcement', 'Contempt'],
  },
  {
    slug: 'expediteScheduling',
    displayName: 'Motion for Expedited Scheduling Order',
    category: 'scheduling',
    shortDoc: 'Asks the court to issue an expedited scheduling order for emergency relief.',
    source: 'user-data',
    aliases: ['Expedite'],
  },
  {
    slug: 'extensionOfTime',
    displayName: 'Motion for Extension of Time',
    category: 'scheduling',
    shortDoc: 'Asks the court to extend a deadline (commonly briefing deadlines).',
    source: 'user-data',
    aliases: ['Extension'],
  },
  {
    slug: 'inCameraReview',
    displayName: 'Motion for In Camera Review',
    category: 'discovery',
    shortDoc: 'Asks the judge to privately inspect documents before ruling on privilege.',
    source: 'practice',
  },
  {
    slug: 'leaveToFile',
    displayName: 'Motion for Leave to File',
    category: 'procedural',
    shortDoc: 'Asks the court for permission to file a pleading out of time or beyond page limits.',
    source: 'user-data',
    aliases: ['Leave'],
  },
  {
    slug: 'mediation',
    displayName: 'Motion for Mediation',
    category: 'procedural',
    shortDoc: 'Asks the court to order the parties to mediation.',
    source: 'user-data',
  },
  {
    slug: 'newTrial',
    displayName: 'Motion for New Trial',
    category: 'procedural',
    shortDoc: 'Asks the trial court to set aside the judgment and grant a new trial.',
    source: 'user-data',
    aliases: ['MNT'],
  },
  {
    slug: 'partialSummaryJudgment',
    displayName: 'Motion for Partial Summary Judgment',
    category: 'disposition',
    shortDoc: 'Asks the court to resolve some — but not all — claims as a matter of law.',
    source: 'practice',
    aliases: ['PSJ', 'MPSJ'],
  },
  {
    slug: 'permanentInjunction',
    displayName: 'Motion for Permanent Injunction',
    category: 'protective',
    shortDoc: 'Asks the court for a final order permanently barring specified conduct.',
    source: 'practice',
  },
  {
    slug: 'protectiveOrder',
    displayName: 'Motion for Protective Order',
    category: 'discovery',
    shortDoc: 'Asks the court to limit or shield discovery to prevent harm or harassment.',
    source: 'practice',
  },
  {
    slug: 'reconsider',
    displayName: 'Motion for Reconsideration',
    category: 'procedural',
    shortDoc: 'Asks the court to reconsider a prior ruling, often based on new evidence.',
    source: 'user-data',
    aliases: ['Reconsider', 'MFR'],
  },
  {
    slug: 'rehearing',
    displayName: 'Motion for Rehearing',
    category: 'appellate',
    shortDoc: 'Asks an appellate panel to rehear the case after a decision.',
    source: 'texas-rules',
  },
  {
    slug: 'remoteAppearance',
    displayName: 'Motion for Remote Appearance',
    category: 'procedural',
    shortDoc: 'Asks the court for permission to appear by video or telephone.',
    source: 'user-data',
    aliases: ['Remote Hearing', 'Zoom Appearance'],
  },
  {
    slug: 'sanctions',
    displayName: 'Motion for Sanctions',
    category: 'discovery',
    shortDoc: 'Asks the court to penalize a party for discovery abuse or frivolous conduct.',
    source: 'user-data',
    aliases: ['Sanctions', 'Rule 11'],
  },
  {
    slug: 'stayPendingAppeal',
    displayName: 'Motion for Stay Pending Appeal',
    category: 'appellate',
    shortDoc: 'Asks the court to suspend enforcement of the judgment while the appeal is pending.',
    source: 'user-data',
    aliases: ['Stay', 'Emergency Stay'],
  },
  {
    slug: 'substitutedService',
    displayName: 'Motion for Substituted Service',
    category: 'procedural',
    shortDoc: 'Asks the court for permission to serve a party by alternative means.',
    source: 'user-data',
  },
  {
    slug: 'summaryJudgment',
    displayName: 'Motion for Summary Judgment',
    category: 'disposition',
    shortDoc: 'Asks the court to rule for the movant as a matter of law without trial.',
    source: 'practice',
    aliases: ['MSJ', 'Summary Judgment'],
  },
  {
    slug: 'temporaryOrders',
    displayName: 'Motion for Temporary Orders',
    category: 'family-law',
    shortDoc: 'Asks the court for interim orders (support, custody, possession) pending final hearing.',
    source: 'user-data',
    aliases: ['Temp Orders', 'TO'],
  },
  {
    slug: 'temporaryRestrainingOrder',
    displayName: 'Motion for Temporary Restraining Order',
    category: 'protective',
    shortDoc: 'Asks the court for an immediate, short-term order barring specified conduct.',
    source: 'user-data',
    aliases: ['TRO'],
  },
  {
    slug: 'inLimine',
    displayName: 'Motion in Limine',
    category: 'evidence',
    shortDoc: 'Asks the court to bar mention of specified evidence before trial begins.',
    source: 'practice',
    aliases: ['MIL', 'Limine'],
  },
  {
    slug: 'abate',
    displayName: 'Motion to Abate',
    category: 'appellate',
    shortDoc: 'Asks the court to pause or suspend proceedings, often pending another action.',
    source: 'user-data',
    aliases: ['Abatement'],
  },
  {
    slug: 'abateAndConsolidate',
    displayName: 'Motion to Abate and Consolidate',
    category: 'appellate',
    shortDoc: 'Combined request to pause proceedings and merge related appeals into one.',
    source: 'user-data',
  },
  {
    slug: 'abateAndRemand',
    displayName: 'Motion to Abate and Remand',
    category: 'appellate',
    shortDoc: 'Asks the appellate court to suspend the appeal and send the case back to the trial court.',
    source: 'user-data',
  },
  {
    slug: 'appointReceiver',
    displayName: 'Motion to Appoint Receiver',
    category: 'family-law',
    shortDoc: 'Asks the court to appoint a neutral third party to take custody of assets or a business.',
    source: 'user-data',
    aliases: ['Receiver', 'Post-Judgment Receiver'],
  },
  {
    slug: 'compelDiscovery',
    displayName: 'Motion to Compel Discovery',
    category: 'discovery',
    shortDoc: 'Asks the court to force a party to respond to discovery requests.',
    source: 'user-data',
    aliases: ['MTC', 'Compel'],
  },
  {
    slug: 'consolidate',
    displayName: 'Motion to Consolidate',
    category: 'appellate',
    shortDoc: 'Asks the court to merge two or more related cases or appeals.',
    source: 'user-data',
    aliases: ['Consolidation'],
  },
  {
    slug: 'dismiss',
    displayName: 'Motion to Dismiss',
    category: 'disposition',
    shortDoc: 'Asks the court to throw the case out, typically for failure to state a claim.',
    source: 'user-data',
    aliases: ['MTD', '12(b)(6)'],
  },
  {
    slug: 'dismissForLackOfJurisdiction',
    displayName: 'Motion to Dismiss for Lack of Jurisdiction',
    category: 'disposition',
    shortDoc: 'Asks the court to dismiss because it lacks subject-matter or personal jurisdiction.',
    source: 'frcp',
    aliases: ['12(b)(1)', '12(b)(2)'],
  },
  {
    slug: 'disqualify',
    displayName: 'Motion to Disqualify',
    category: 'procedural',
    shortDoc: 'Asks the court to remove a judge or attorney from the case.',
    source: 'user-data',
    aliases: ['DQ', 'Disqualification'],
  },
  {
    slug: 'exclude',
    displayName: 'Motion to Exclude',
    category: 'evidence',
    shortDoc: 'Asks the court to exclude specific evidence or expert testimony.',
    source: 'practice',
    aliases: ['Daubert'],
  },
  {
    slug: 'expungeLisPendens',
    displayName: 'Motion to Expunge Lis Pendens',
    category: 'procedural',
    shortDoc: 'Asks the court to remove a recorded notice of pending litigation against real property.',
    source: 'user-data',
    aliases: ['Lis Pendens'],
  },
  {
    slug: 'modifyConservatorship',
    displayName: 'Motion to Modify Conservatorship',
    category: 'family-law',
    shortDoc: 'Asks the court to change custody or conservatorship of a child.',
    source: 'practice',
    aliases: ['Custody Modification'],
  },
  {
    slug: 'quashSubpoena',
    displayName: 'Motion to Quash Subpoena',
    category: 'discovery',
    shortDoc: 'Asks the court to invalidate a subpoena.',
    source: 'practice',
    aliases: ['Quash'],
  },
  {
    slug: 'recuse',
    displayName: 'Motion to Recuse',
    category: 'procedural',
    shortDoc: 'Asks a judge to step aside due to bias or conflict of interest.',
    source: 'texas-rules',
    aliases: ['Recusal'],
  },
  {
    slug: 'resetHearing',
    displayName: 'Motion to Reset Hearing',
    category: 'scheduling',
    shortDoc: 'Asks the court to reschedule a previously set hearing.',
    source: 'practice',
    aliases: ['Reset'],
  },
  {
    slug: 'setAsideDecree',
    displayName: 'Motion to Set Aside Decree',
    category: 'family-law',
    shortDoc: 'Asks the court to vacate a final divorce decree, often paired with a bill of review.',
    source: 'user-data',
    aliases: ['Set Aside', 'Vacate Decree'],
  },
  {
    slug: 'setAsideDefault',
    displayName: 'Motion to Set Aside Default',
    category: 'procedural',
    shortDoc: 'Asks the court to vacate a default judgment so the case can be defended.',
    source: 'practice',
  },
  {
    slug: 'strike',
    displayName: 'Motion to Strike',
    category: 'procedural',
    shortDoc: 'Asks the court to remove a pleading, affidavit, or evidence from the record.',
    source: 'user-data',
  },
  {
    slug: 'substituteCounsel',
    displayName: 'Motion to Substitute Counsel',
    category: 'procedural',
    shortDoc: 'Notifies the court that one attorney is replacing another for a party.',
    source: 'user-data',
    aliases: ['Substitution of Counsel'],
  },
  {
    slug: 'supplementTheRecord',
    displayName: 'Motion to Supplement the Record',
    category: 'appellate',
    shortDoc: 'Asks the appellate court to add items to the appellate record.',
    source: 'texas-rules',
    aliases: ['Supplement Record'],
  },
  {
    slug: 'suspendEnforcement',
    displayName: 'Motion to Suspend Enforcement',
    category: 'appellate',
    shortDoc: 'Asks the court to suspend enforcement of a money judgment pending review.',
    source: 'user-data',
    aliases: ['Supersedeas'],
  },
  {
    slug: 'withdrawCounsel',
    displayName: 'Motion to Withdraw',
    category: 'procedural',
    shortDoc: 'Attorney asks the court for permission to stop representing a party.',
    source: 'user-data',
    aliases: ['Withdrawal of Counsel', 'Withdraw'],
  },
  {
    slug: 'other',
    displayName: 'Other Motion',
    category: 'other',
    shortDoc: 'Catch-all for motion types not in this catalog (UI shows a free-text fallback).',
    source: 'practice',
  },
  {
    slug: 'modifyParentChildRelationship',
    displayName: 'Petition / Motion to Modify Parent-Child Relationship',
    category: 'family-law',
    shortDoc: 'Asks the court to modify a prior SAPCR order (Texas).',
    source: 'user-data',
    aliases: ['SAPCR', 'Modify SAPCR'],
  },
  {
    slug: 'rule91aDismiss',
    displayName: 'Rule 91a Motion to Dismiss',
    category: 'disposition',
    shortDoc: 'Texas-specific motion to dismiss baseless causes of action under TRCP 91a.',
    source: 'user-data',
    aliases: ['91a', 'Rule 91a'],
  },
];
