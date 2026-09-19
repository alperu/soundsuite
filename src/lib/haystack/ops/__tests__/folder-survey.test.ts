/** @jest-environment node */

/**
 * ssFolderSurvey over a temp folder and an in-memory client. Synthetic files
 * only — the "PDFs" are a few bytes with a .pdf name; the survey hashes bytes,
 * it does not parse.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { ssFolderSurvey } from '../folder-survey';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function mkCase() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-survey-'));
  await fs.mkdir(path.join(root, 'sub'));
  await fs.mkdir(path.join(root, 'nested-case'));
  await fs.writeFile(path.join(root, 'motion.pdf'), 'motion-bytes');
  await fs.writeFile(path.join(root, 'sub', 'moved.pdf'), 'moved-bytes');
  await fs.writeFile(path.join(root, 'brand-new.pdf'), 'new-bytes');
  await fs.writeFile(path.join(root, 'ignored.pdf'), 'ignored-bytes');
  await fs.writeFile(path.join(root, 'nested-case', 'inner.pdf'), 'inner-bytes');
  await fs.writeFile(path.join(root, 'notes.txt'), 'not a pdf');
  return root;
}

function client(root: string) {
  const docs = [
    { id: 'd-known', filePath: path.join(root, 'motion.pdf'), fileName: 'motion.pdf', hash: sha('motion-bytes'), status: 'INDEXED', filingId: 'f1', caseId: 'c1' },
    { id: 'd-moved', filePath: path.join(root, 'old-place', 'moved.pdf'), fileName: 'moved.pdf', hash: sha('moved-bytes'), status: 'DISCOVERED', filingId: null, caseId: 'c1' },
    { id: 'd-gone', filePath: path.join(root, 'gone.pdf'), fileName: 'gone.pdf', hash: sha('gone'), status: 'ERROR', filingId: null, caseId: 'c1' },
  ];
  return {
    case: {
      findUnique: jest.fn().mockResolvedValue({ id: 'c1', name: 'Case One', path: root }),
      findMany: jest.fn().mockResolvedValue([
        { id: 'c1', name: 'Case One', path: root },
        { id: 'c2', name: 'Inner', path: path.join(root, 'nested-case') },
        { id: 'c3', name: 'Sibling', path: root + '-sibling' },
      ]),
    },
    document: {
      findMany: jest.fn(async (args: any) => {
        if (args?.where?.caseId) return docs;
        if (args?.where?.hash?.in) return docs.filter((d) => args.where.hash.in.includes(d.hash));
        return [];
      }),
    },
    ignoredFile: {
      findMany: jest.fn().mockResolvedValue([{ filePath: path.join(root, 'ignored.pdf'), hash: sha('ignored-bytes') }]),
    },
  } as any;
}

describe('ssFolderSurvey', () => {
  let root: string;
  beforeAll(async () => { root = await mkCase(); });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('classifies every file and every row, and flags the nested case', async () => {
    const res = await ssFolderSurvey({ prisma: client(root), actor: { actor: 'agent', via: 'test' } }, { caseId: '@c1' });
    const by = (d: string) => res.rows.filter((r) => r.disposition === d).map((r) => r.name).sort();

    expect(res.meta).toMatchObject({ reachable: true, filesOnDisk: 5, documentRows: 3, known: 1, moved: 1, new: 2, ignored: 1, orphaned: 1, nestedFiles: 1 });
    expect(by('known')).toEqual(['motion.pdf']);
    expect(by('moved')).toEqual(['moved.pdf']);
    expect(by('new')).toEqual(['brand-new.pdf', 'inner.pdf']);
    expect(by('ignored')).toEqual(['ignored.pdf']);
    expect(by('orphaned')).toEqual(['gone.pdf']);

    const moved = res.rows.find((r) => r.disposition === 'moved')!;
    expect(moved.doc).toBe('d-moved');
    expect(moved.storedPath).toContain('old-place');

    const inner = res.rows.find((r) => r.name === 'inner.pdf')!;
    expect(inner.note).toMatch(/nested case folder/);
    expect((res.meta.nestedCases as Array<{ id: string }>).map((n) => n.id)).toEqual(['c2']);
    expect(res.meta.knownByStatus).toEqual({ INDEXED: 1 });
  });

  it('filters by disposition and keeps whole-set counts in meta', async () => {
    const res = await ssFolderSurvey({ prisma: client(root), actor: { actor: 'agent', via: 'test' } }, { caseId: 'c1', disposition: 'new', limit: 1 });
    expect(res.rows).toHaveLength(1);
    expect(res.meta.matching).toBe(2);
    expect(res.meta.new).toBe(2);
  });

  it('reports an unreachable path as a finding, not an exception', async () => {
    const c = client(root);
    c.case.findUnique.mockResolvedValueOnce({ id: 'c1', name: 'Case One', path: path.join(root, 'does-not-exist') });
    const res = await ssFolderSurvey({ prisma: c, actor: { actor: 'agent', via: 'test' } }, { caseId: 'c1' });
    expect(res.meta.reachable).toBe(false);
    expect(res.rows).toEqual([]);
  });

  it('404s an unknown case', async () => {
    const c = client(root);
    c.case.findUnique.mockResolvedValueOnce(null);
    await expect(ssFolderSurvey({ prisma: c, actor: { actor: 'agent', via: 'test' } }, { caseId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
