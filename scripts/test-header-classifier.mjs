#!/usr/bin/env node
/**
 * Sanity tests for classifyFilingFromHeader + classifyFilingHybrid.
 *
 * Run:
 *   node scripts/test-header-classifier.mjs
 *
 * No Jest harness — direct dynamic-import of the TS source via tsx loader
 * if available, otherwise via the project's ts-node/tsx dev install.
 * We use a tiny inline TS->JS transform-free trick: import from the
 * compiled .next build if present; otherwise fall back to invoking through
 * `tsx`. The simpler path used here: spawn `npx tsx` to run a small inner
 * script that exercises the helpers and prints pass/fail counts.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// Worktrees don't have their own node_modules — locate tsx in the parent
// (main) repo when this script runs from a worktree.
function findTsx(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const tsxBin = findTsx(repoRoot);

const innerScript = String.raw`
import {
  classifyFilingFromHeader,
  classifyFilingHybrid,
} from '${repoRoot.replace(/\\/g, '\\\\')}/src/services/filing-detector';

interface Case {
  name: string;
  header: string;
  expectedKind?: string;       // expected from classifyFilingFromHeader
  expectedConfidence?: string; // 'high' | 'medium'
  filename?: string;           // optional, exercises hybrid wrapper
  expectedFilingType?: string; // expected hybrid PascalCase result
  expectedSource?: string;     // 'header' | 'filename' | 'hybrid'
}

const cases: Case[] = [
  // 1. The reported bug — Response opposing a Petition.
  {
    name: 'bug: response opposing petition (the failing case)',
    header:
      "NO. D-1-FM-21-000111\nIN THE DISTRICT COURT OF TRAVIS COUNTY, TEXAS\n" +
      "RESPONDENT'S RESPONSE IN OPPOSITION TO PETITION TO " +
      "ENFORCE PRIOR ORDER DATED JULY 7, 2025 AND APPLICATION FOR " +
      "TEMPORARY RESTRAINING ORDER AND EMERGENCY RELIEF",
    expectedKind: 'response',
    expectedConfidence: 'high',
    filename:
      'petition-alper-doe-petition-to-enforce-prior-order-dated-july-7-2025compress.pdf',
    expectedFilingType: 'Response',
    expectedSource: 'header',
  },

  // 2. Plain Motion to Compel
  {
    name: 'motion to compel',
    header: 'MOTION TO COMPEL DISCOVERY RESPONSES',
    expectedKind: 'motion',
    expectedConfidence: 'high',
    filename: 'random-name.pdf',
    expectedFilingType: 'Motion',
    expectedSource: 'header',
  },

  // 3. Notice of Appeal — title pattern, no in-support-of preamble.
  {
    name: 'notice of appeal',
    header: 'CAUSE NO. 2024-CV-123\nNOTICE OF APPEAL',
    expectedKind: 'notice',
    expectedConfidence: 'high',
  },

  // 4. "Affidavit in support of Notice" — the notice should NOT match.
  {
    name: 'affidavit in support of notice (notice must NOT match)',
    header: 'AFFIDAVIT IN SUPPORT OF NOTICE OF NONSUIT',
    expectedKind: 'affidavit',
    expectedConfidence: 'medium',
  },

  // 5. Order Granting Motion — must be 'order', not 'motion'.
  {
    name: 'order granting motion',
    header: 'ORDER GRANTING MOTION FOR SUMMARY JUDGMENT',
    expectedKind: 'order',
    expectedConfidence: 'high',
  },

  // 6. Proposed Order — must hit proposedOrder, not order.
  {
    name: 'proposed order',
    header: 'PROPOSED ORDER ON MOTION TO COMPEL',
    expectedKind: 'proposedOrder',
    expectedConfidence: 'high',
  },

  // 7. Appellant's Brief
  {
    name: "appellant's brief",
    header: "APPELLANT'S BRIEF ON THE MERITS",
    expectedKind: 'brief',
    expectedConfidence: 'high',
  },

  // 8. Reporter's Record
  {
    name: "reporter's record",
    header: "REPORTER'S RECORD VOLUME 1 OF 3\nCAUSE NO. 12345",
    expectedKind: 'reportersRecord',
    expectedConfidence: 'high',
  },

  // 9. Subpoena
  {
    name: 'subpoena duces tecum',
    header: 'SUBPOENA DUCES TECUM',
    expectedKind: 'subpoena',
    expectedConfidence: 'high',
  },

  // 10. Request for Admissions
  {
    name: 'request for admissions',
    header: "PETITIONER'S REQUEST FOR ADMISSIONS TO RESPONDENT",
    expectedKind: 'rfa',
    expectedConfidence: 'high',
  },

  // 11. Bare petition — medium confidence; filename "petition-foo" → filename wins.
  {
    name: 'plain petition (filename also says petition)',
    header: 'PETITION FOR ENFORCEMENT',
    expectedKind: 'petition',
    expectedConfidence: 'medium',
    filename: 'petition-for-enforcement.pdf',
    expectedFilingType: 'Petition',
    expectedSource: 'filename',
  },

  // 12. Empty header — hybrid must fall through to filename.
  {
    name: 'no header text (PDF parse failed)',
    header: '',
    filename: 'D-1-FM-25-000222 - MOTION FOR RECONSIDERATION.pdf',
    expectedFilingType: 'Motion',
    expectedSource: 'filename',
  },
];

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const c of cases) {
  // Part A: header classifier
  if (c.expectedKind) {
    const r = classifyFilingFromHeader(c.header);
    if (!r) {
      fail++;
      failures.push(c.name + ' — header classifier returned null');
      continue;
    }
    if (r.kind !== c.expectedKind) {
      fail++;
      failures.push(
        c.name + ' — expected kind=' + c.expectedKind +
        ', got kind=' + r.kind + ' (matched ' + JSON.stringify(r.matched) + ')'
      );
      continue;
    }
    if (c.expectedConfidence && r.confidence !== c.expectedConfidence) {
      fail++;
      failures.push(
        c.name + ' — expected confidence=' + c.expectedConfidence +
        ', got ' + r.confidence
      );
      continue;
    }
    pass++;
  }

  // Part B: hybrid wrapper
  if (c.filename && c.expectedFilingType) {
    const h = classifyFilingHybrid({
      fileName: c.filename,
      headerText: c.header,
    });
    if (h.filingType !== c.expectedFilingType) {
      fail++;
      failures.push(
        c.name + ' — hybrid expected filingType=' + c.expectedFilingType +
        ', got ' + h.filingType + ' (source=' + h.source + ')'
      );
      continue;
    }
    if (c.expectedSource && h.source !== c.expectedSource) {
      fail++;
      failures.push(
        c.name + ' — hybrid expected source=' + c.expectedSource +
        ', got ' + h.source
      );
      continue;
    }
    pass++;
  }
}

console.log('PASS=' + pass);
console.log('FAIL=' + fail);
if (failures.length > 0) {
  console.log('--- failures ---');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
`;

const cmd = tsxBin ?? 'npx';
const argv = tsxBin
  ? ['--eval', innerScript]
  : ['--yes', 'tsx', '--eval', innerScript];
const result = spawnSync(cmd, argv, { stdio: 'inherit', cwd: repoRoot });
process.exit(result.status ?? 1);
