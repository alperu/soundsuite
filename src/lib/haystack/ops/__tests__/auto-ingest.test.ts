/** @jest-environment node */

/**
 * ssAutoIngestPlan / ssAutoIngestApply with the model, the PDF reader and the
 * write helpers mocked. Synthetic folder, synthetic titles.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const callLLMJson = jest.fn();
jest.mock('@/lib/mcp/tools/ai-helper', () => ({ callLLMJson: (...args: unknown[]) => callLLMJson(...args) }));

jest.mock('@/services/filing-detector', () => ({
  FILING_TYPES: ['Motion', 'Notice', 'Letter', 'Order', 'Petition', 'Affidavit', 'Subpoena', 'Brief', 'Response', 'Reply', 'Judgment', 'Decree', "Clerk's Record", "Reporter's Record", 'Transcript', 'Settlement', 'Bill of Review', 'Return of Service', 'Demand Letter', 'Objection', 'Request', 'Supplement', 'Designation', 'Other'],
  quickExtractHeader: jest.fn(async (p: string) => `CAUSE NO. 00-0000-XX  IN THE DISTRICT COURT  ${path.basename(p)} caption text`),
  detectFiling: jest.fn(async (p: string) => {
    const n = path.basename(p).toLowerCase();
    if (n.includes('motion')) return { filingType: 'Motion', title: 'Motion to Compel', confidence: 0.9 };
    if (n.includes('response')) return { filingType: 'Response', title: 'Response to Motion to Compel', confidence: 0.9 };
    return { filingType: 'Other', title: n, confidence: 0.2 };
  }),
}));

const commitEntity = jest.fn();
jest.mock('@/lib/haystack/commit', () => ({ commitEntity: (...args: unknown[]) => commitEntity(...args) }));

const ensures = {
  ensureMotionForFiling: jest.fn().mockResolvedValue({}),
  ensureMotionAttachmentForFiling: jest.fn().mockResolvedValue({}),
  ensureClerksRecordForFiling: jest.fn().mockResolvedValue({}),
  ensureReportersRecordForFiling: jest.fn().mockResolvedValue({}),
};
jest.mock('@/lib/haystack/ensure-filing', () => ensures);

import { ssAutoIngestPlan, ssAutoIngestApply, resolveAnswerTarget, targetDirFor, linkSlotFor, type AutoIngestPlan } from '../auto-ingest';

const actor = { actor: 'agent' as const, via: 'test' };

async function mkFolder() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-etl-'));
  await fs.writeFile(path.join(root, '01 motion.pdf'), 'm');
  await fs.writeFile(path.join(root, '02 response.pdf'), 'r');
  await fs.writeFile(path.join(root, '03 notice.pdf'), 'n');
  return root;
}

/** Minimal in-memory client: cases, filings, documents. */
function memoryClient() {
  const cases: any[] = [];
  const filings: any[] = [];
  const documents: any[] = [];
  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;
  return {
    _state: { cases, filings, documents },
    case: {
      findUnique: jest.fn(async ({ where }: any) => cases.find((c) => c.path === where.path || c.id === where.id) ?? null),
    },
    filing: {
      findUnique: jest.fn(async ({ where }: any) => filings.find((f) => f.caseId === where.caseId_slug.caseId && f.slug === where.caseId_slug.slug) ?? null),
      create: jest.fn(async ({ data }: any) => { const row = { id: id('f'), ...data }; filings.push(row); return row; }),
    },
    document: {
      findMany: jest.fn(async ({ where }: any) => documents.filter((d) => where.filePath?.in?.includes(d.filePath) || where.hash?.in?.includes(d.hash))),
      findUnique: jest.fn(async ({ where }: any) => documents.find((d) => (where.hash && d.hash === where.hash) || (where.filePath && d.filePath === where.filePath)) ?? null),
      create: jest.fn(async ({ data }: any) => { const row = { id: id('d'), ...data }; documents.push(row); return row; }),
      update: jest.fn(async ({ where, data }: any) => { const row = documents.find((d) => d.id === where.id); Object.assign(row, data); return row; }),
      updateMany: jest.fn(async ({ where, data }: any) => { let n = 0; for (const d of documents) if (d.filePath === where.filePath) { Object.assign(d, data); n++; } return { count: n }; }),
    },
  } as any;
}

beforeEach(() => {
  callLLMJson.mockReset();
  commitEntity.mockReset();
  for (const fn of Object.values(ensures)) fn.mockClear();
});

describe('helpers', () => {
  it('maps filing types to tidy folders', () => {
    expect(targetDirFor('Motion')).toBe('Motions');
    expect(targetDirFor('Judgment')).toBe('Orders');
    expect(targetDirFor("Reporter's Record")).toBe('Records');
    expect(targetDirFor('Designation')).toBe('Other');
  });

  it('picks the ref slot by filing type', () => {
    expect(linkSlotFor('Response')).toBe('respondingTo');
    expect(linkSlotFor('Reply')).toBe('replyingTo');
    expect(linkSlotFor('Order')).toBe('resolves');
    expect(linkSlotFor('Notice')).toBe('motionRef');
  });

  it('resolves an answered title to the one clearly-best motion, or nothing', () => {
    const motions = [
      { path: '/a', title: 'Motion to Compel Discovery' },
      { path: '/b', title: 'Motion for Continuance' },
    ];
    expect(resolveAnswerTarget('Motion to Compel Discovery', motions)).toBe('/a');
    expect(resolveAnswerTarget('Motion for Continuance of Trial', motions)).toBe('/b');
    expect(resolveAnswerTarget('Motion', motions)).toBeNull();
    expect(resolveAnswerTarget('Something unrelated', motions)).toBeNull();
  });
});

describe('ssAutoIngestPlan', () => {
  let root: string;
  beforeAll(async () => { root = await mkFolder(); });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('reads the folder, asks the model once for identity and once per batch, and writes nothing', async () => {
    callLLMJson
      .mockResolvedValueOnce({
        caseNumber: '00-0000-XX', court: 'District Court', parties: ['Plaintiff', 'Defendant'], caseName: 'Sample v. Sample',
        confidence: 'high', evidence: 'CAUSE NO. 00-0000-XX', perFile: [{ file: '01 motion.pdf', caseNumber: '00-0000-XX' }],
      })
      .mockResolvedValueOnce({
        items: [
          { index: 0, filingType: 'Motion', title: 'Motion to Compel Discovery', filedOn: '2026-01-02', signedOn: '2026-01-01', filedBy: 'Petitioner', author: 'A. Counsel', stampEvidence: 'Filed: 1/2/2026 9:15 AM  Envelope No. 1', confidence: 'high', evidence: 'MOTION TO COMPEL', answersTitle: null },
          { index: 1, filingType: 'Response', title: 'Response to Motion to Compel Discovery', filedOn: '2026-01-12', filedBy: 'respondent', confidence: 'high', evidence: 'RESPONSE', answersTitle: 'Motion to Compel Discovery' },
          { index: 2, filingType: 'notice', title: 'Notice of Hearing', filedOn: 'not a date', filedBy: 'the clerk', confidence: 'medium', evidence: 'NOTICE', answersTitle: null },
        ],
      });

    const client = memoryClient();
    const res = await ssAutoIngestPlan({ prisma: client, actor }, { path: root });
    const plan = res.rows[0].plan as AutoIngestPlan;

    expect(callLLMJson).toHaveBeenCalledTimes(2);
    expect(callLLMJson.mock.calls[0][2]).toMatchObject({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' });
    expect(res.meta).toMatchObject({ planned: 3, filesOnDisk: 3, linksResolved: 1, linksUnresolved: 0, disagreesWithDetector: 1, caseNumber: '00-0000-XX' });
    expect(plan.case).toMatchObject({ existingCaseId: null, name: 'Sample v. Sample', caseNumber: '00-0000-XX', confidence: 'high', disagreement: [] });

    const [motion, response, notice] = plan.files;
    expect(motion).toMatchObject({
      filingType: 'Motion', kind: 'motion', targetDir: 'Motions', accepted: true,
      // WHO / WHEN: side normalised to the vocabulary, stamp date kept apart from signature date.
      filedOn: '2026-01-02', signedOn: '2026-01-01', filedBy: 'petitioner', author: 'A. Counsel',
      stampEvidence: 'Filed: 1/2/2026 9:15 AM Envelope No. 1',
    });
    expect(response).toMatchObject({ filingType: 'Response', kind: 'response', answersPath: motion.path, targetDir: 'Responses', filedBy: 'respondent', author: null });
    // Lower-case type from the model is canonicalised; an unparseable date is
    // null; a side outside the vocabulary is 'unknown', never a guess.
    expect(notice).toMatchObject({ filingType: 'Notice', kind: 'notice', filedOn: null, filedBy: 'unknown', disagreesWithDetector: true });
    expect(notice.detector.filingType).toBe('Other');
    expect(res.meta).toMatchObject({ withFileStamp: 2, pagesRead: 2, byFiledBy: { petitioner: 1, respondent: 1, unknown: 1 } });
    // Two pages, not five: the extractor was asked for exactly that.
    const { quickExtractHeader } = jest.requireMock('@/services/filing-detector');
    expect(quickExtractHeader).toHaveBeenCalledWith(expect.stringContaining('01 motion.pdf'), 2);

    expect(client.filing.create).not.toHaveBeenCalled();
    expect(client.document.create).not.toHaveBeenCalled();
    expect(commitEntity).not.toHaveBeenCalled();
  });

  it('reports disagreement between sampled cause numbers instead of choosing', async () => {
    callLLMJson
      .mockResolvedValueOnce({ caseNumber: '00-0000-XX', confidence: 'high', perFile: [{ file: 'a', caseNumber: '00-0000-XX' }, { file: 'b', caseNumber: '00-0001-XX' }] })
      .mockResolvedValueOnce({ items: [] });
    const res = await ssAutoIngestPlan({ prisma: memoryClient(), actor }, { path: root });
    const plan = res.rows[0].plan as AutoIngestPlan;
    expect(plan.case.confidence).toBe('low');
    expect(plan.case.disagreement).toHaveLength(2);
    expect(plan.warnings.join(' ')).toMatch(/more than one case/);
    // No items back → every file falls back to the detector.
    expect(plan.files[0].evidence).toMatch(/regex detector/);
  });

  it('rejects a path that is not a directory', async () => {
    await expect(ssAutoIngestPlan({ prisma: memoryClient(), actor }, { path: path.join(root, '01 motion.pdf') })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});

describe('ssAutoIngestApply', () => {
  let root: string;
  let plan: AutoIngestPlan;

  beforeEach(async () => {
    root = await mkFolder();
    const motionPath = path.join(root, '01 motion.pdf');
    const responsePath = path.join(root, '02 response.pdf');
    const file = (p: string, filingType: string, title: string, extra: Partial<AutoIngestPlan['files'][number]> = {}) => ({
      path: p, name: path.basename(p), relDir: '', size: 1, hash: null, existing: null,
      detector: { filingType, title, confidence: 0.9 }, filingType, kind: filingType.toLowerCase(), title, filedOn: null,
      signedOn: null, filedBy: 'unknown' as const, author: null, stampEvidence: null,
      confidence: 'high' as const, evidence: '', disagreesWithDetector: false, answersTitle: null, answersPath: null,
      targetDir: targetDirFor(filingType), accepted: true, ...extra,
    });
    plan = {
      version: 1, createdAt: new Date().toISOString(), model: 'deepseek/deepseek-v4.1-flash', path: root,
      case: { existingCaseId: null, name: 'Sample v. Sample', caseNumber: '00-0000-XX', court: 'District Court', parties: [], county: null, state: null, confidence: 'high', evidence: '', disagreement: [] },
      files: [
        file(motionPath, 'Motion', 'Motion to Compel Discovery', { filedOn: '2026-01-02', signedOn: '2026-01-01', filedBy: 'petitioner', author: 'A. Counsel', stampEvidence: 'Filed: 1/2/2026' }),
        file(responsePath, 'Response', 'Response to Motion to Compel Discovery', { answersTitle: 'Motion to Compel Discovery', answersPath: motionPath }),
        file(path.join(root, '03 notice.pdf'), 'Notice', 'Notice of Hearing', { accepted: false }),
      ],
      unplanned: [], warnings: [],
    };
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('dry run reports every step and touches nothing', async () => {
    const client = memoryClient();
    const res = await ssAutoIngestApply({ prisma: client, actor }, { plan, organize: true });
    expect(res.meta).toMatchObject({ dryRun: true, caseAction: 'would-create', accepted: 2, skippedByReviewer: 1, filingsCreated: 0, linksWritten: 0 });
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ filingAction: 'would-create', movedTo: path.join(root, 'Motions', '01 motion.pdf'), documentAction: 'would-create QUEUED' });
    expect(res.rows[1].linkAction).toMatch(/would-write respondingTo/);
    expect(commitEntity).not.toHaveBeenCalled();
    expect(client.filing.create).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, '01 motion.pdf'))).resolves.toBeUndefined();
  });

  it('applies: creates the case, moves files, creates filings + entities + documents, writes the link with provenance', async () => {
    commitEntity.mockImplementation(async ({ id, kind, patch }: any) => {
      if (kind === 'case') return { ok: true, row: { id: 'case-1', ...patch } };
      return { ok: true, row: { id, ...patch } };
    });
    const client = memoryClient();
    const res = await ssAutoIngestApply({ prisma: client, actor }, { plan, organize: true, dryRun: false });

    expect(res.meta).toMatchObject({ dryRun: false, caseAction: 'created', case: 'case-1', filingsCreated: 2, documentsCreated: 2, moved: 2, linksWritten: 1 });

    // Files moved into their kind folders; the Document rows carry the new path.
    await expect(fs.access(path.join(root, 'Motions', '01 motion.pdf'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, 'Responses', '02 response.pdf'))).resolves.toBeUndefined();
    expect(client._state.documents.map((d: any) => d.filePath).sort()).toEqual([
      path.join(root, 'Motions', '01 motion.pdf'),
      path.join(root, 'Responses', '02 response.pdf'),
    ]);
    expect(client._state.documents.every((d: any) => d.status === 'QUEUED')).toBe(true);
    expect(client._state.filings.map((f: any) => f.slug)).toEqual(['motion-motion-to-compel-discovery', 'response-response-to-motion-to-compel-discovery']);

    // Entities through ensure-filing, never a raw create.
    expect(ensures.ensureMotionForFiling).toHaveBeenCalledTimes(1);
    expect(ensures.ensureMotionAttachmentForFiling).toHaveBeenCalledWith(expect.any(String), 'response');

    // WHO / WHEN landed as tags on the motion: real spec slots for the dates,
    // the rest namespaced under ssEtl so nothing collides with the vocabulary.
    const motionTags = commitEntity.mock.calls.find(([arg]: any) => arg.kind === 'motion')!;
    expect(motionTags[0].patch).toMatchObject({
      filedOn: '2026-01-02', signedOn: '2026-01-01',
      ssEtl: { filedBy: 'petitioner', author: 'A. Counsel', stampEvidence: 'Filed: 1/2/2026' },
      ssProvenance: { op: 'ssAutoIngestApply' },
    });
    expect(client._state.filings[0].filingDate).toEqual(new Date('2026-01-02'));

    // The one link: respondingTo on the response, pointing at the motion's filing id.
    const linkCall = commitEntity.mock.calls.find(([arg]: any) => arg.kind === 'response' && arg.patch.respondingTo);
    expect(linkCall).toBeDefined();
    const [{ patch }] = linkCall!;
    expect(patch.respondingTo).toBe(client._state.filings[0].id);
    expect(patch.ssProvenance).toMatchObject({ actor: 'agent', op: 'ssAutoIngestApply', model: 'deepseek/deepseek-v4.1-flash' });

    // The case create carried provenance and the identity fields.
    const [{ patch: casePatch }] = commitEntity.mock.calls.find(([arg]: any) => arg.kind === 'case')!;
    expect(casePatch).toMatchObject({ name: 'Sample v. Sample', caseNumber: '00-0000-XX', jurisdiction: 'District Court', path: root });
  });

  it('is idempotent: a second apply finds everything and creates nothing', async () => {
    commitEntity.mockImplementation(async ({ id, kind, patch }: any) => ({ ok: true, row: { id: kind === 'case' ? 'case-1' : id, ...patch } }));
    const client = memoryClient();
    client._state.cases.push({ id: 'case-1', path: root });
    await ssAutoIngestApply({ prisma: client, actor }, { plan, dryRun: false });
    const createsAfterFirst = client.filing.create.mock.calls.length + client.document.create.mock.calls.length;
    // Re-plan paths are unchanged because organize=false.
    const again = await ssAutoIngestApply({ prisma: client, actor }, { plan, dryRun: false });
    expect(again.meta).toMatchObject({ caseAction: 'found', filingsCreated: 0, filingsFound: 2, documentsCreated: 0 });
    expect(client.filing.create.mock.calls.length + client.document.create.mock.calls.length).toBe(createsAfterFirst);
  });

  it('refuses a plan whose file is outside the folder or whose type is unknown', async () => {
    const outside = { ...plan, files: [{ ...plan.files[0], path: '/etc/passwd.pdf' }] };
    await expect(ssAutoIngestApply({ prisma: memoryClient(), actor }, { plan: outside })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const badType = { ...plan, files: [{ ...plan.files[0], filingType: 'Memo' }] };
    await expect(ssAutoIngestApply({ prisma: memoryClient(), actor }, { plan: badType })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});
