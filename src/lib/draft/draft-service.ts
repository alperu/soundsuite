import { prisma } from '@/lib/db/prisma';
import type { CreateDraftInput, UpdateDraftInput } from './draft-types';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

async function uniqueSlug(caseId: string, base: string): Promise<string> {
  let slug = slugify(base);
  let suffix = 0;
  while (true) {
    const candidate = suffix === 0 ? slug : `${slug}-${suffix}`;
    const existing = await prisma.draft.findUnique({
      where: { caseId_slug: { caseId, slug: candidate } },
    });
    if (!existing) return candidate;
    suffix++;
  }
}

const LINKED_CASES_INCLUDE = {
  draftCases: {
    select: {
      caseId: true,
      case: { select: { id: true, name: true, caseNumber: true } },
    },
  },
} as const;

function mapLinkedCases(draft: any) {
  if (!draft?.draftCases) return draft;
  return {
    ...draft,
    linkedCases: draft.draftCases.map((dc: any) => ({
      id: dc.case.id,
      name: dc.case.name,
      caseNumber: dc.case.caseNumber,
    })),
    draftCases: undefined,
  };
}

export async function listDrafts(caseId: string) {
  // Find drafts where this case is either the primary case or a linked case
  const drafts = await prisma.draft.findMany({
    where: {
      OR: [
        { caseId },
        { draftCases: { some: { caseId } } },
      ],
    },
    select: {
      id: true,
      caseId: true,
      title: true,
      slug: true,
      documentType: true,
      status: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      ...LINKED_CASES_INCLUDE,
    },
    orderBy: { updatedAt: 'desc' },
  });
  return drafts.map(mapLinkedCases);
}

export async function getDraft(id: string) {
  const draft = await prisma.draft.findUnique({
    where: { id },
    include: {
      case: { select: { id: true, name: true, caseNumber: true } },
      ...LINKED_CASES_INCLUDE,
    },
  });
  return mapLinkedCases(draft);
}

export async function createDraft(input: CreateDraftInput) {
  const slug = await uniqueSlug(input.caseId, input.title);
  const draft = await prisma.draft.create({
    data: {
      caseId: input.caseId,
      title: input.title,
      slug,
      documentType: input.documentType,
      content: '',
      status: 'draft',
      version: 1,
      // Create linked cases (always include primary case + any additional)
      draftCases: {
        create: [
          { caseId: input.caseId },
          ...(input.additionalCaseIds || [])
            .filter(id => id !== input.caseId)
            .map(caseId => ({ caseId })),
        ],
      },
    },
    include: {
      case: { select: { id: true, name: true, caseNumber: true } },
      ...LINKED_CASES_INCLUDE,
    },
  });
  return mapLinkedCases(draft);
}

export async function updateDraft(id: string, input: UpdateDraftInput) {
  const existing = await prisma.draft.findUnique({ where: { id } });
  if (!existing) throw new Error('Draft not found');

  const contentChanged = input.content !== undefined && input.content !== existing.content;

  // Only create a version if content changed AND enough time since last version
  // This prevents a new version on every 1.5s autosave — only meaningful checkpoints
  let shouldVersion = false;
  if (contentChanged) {
    const lastVersion = await prisma.draftVersion.findFirst({
      where: { draftId: id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const MIN_VERSION_INTERVAL = 2 * 60 * 1000; // 2 minutes between versions
    shouldVersion = !lastVersion
      || (Date.now() - lastVersion.createdAt.getTime() > MIN_VERSION_INTERVAL)
      || !!input.changeSummary; // explicit changeSummary always creates a version
  }

  const updated = await prisma.draft.update({
    where: { id },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.content !== undefined && { content: input.content }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.documentType !== undefined && { documentType: input.documentType }),
      ...(shouldVersion && { version: { increment: 1 } }),
    },
  });

  if (shouldVersion) {
    await prisma.draftVersion.create({
      data: {
        draftId: id,
        version: updated.version,
        content: input.content!,
        changeSummary: input.changeSummary || null,
      },
    });
  }

  return updated;
}

export async function deleteDraft(id: string) {
  // Clean up vectors from LanceDB before deleting
  try {
    const { VectorStore } = await import('@/lib/vector/vector-store');
    const vs = new VectorStore({
      dbPath: process.env.LANCEDB_PATH || './data/lancedb',
      tableName: process.env.LANCEDB_TABLE || 'chunks',
    });
    await vs.initialize();
    await vs.deleteByDocument(id);
  } catch {
    // Don't block deletion if vector cleanup fails
  }
  return prisma.draft.delete({ where: { id } });
}

export async function listVersions(draftId: string) {
  return prisma.draftVersion.findMany({
    where: { draftId },
    select: {
      id: true,
      draftId: true,
      version: true,
      changeSummary: true,
      createdAt: true,
    },
    orderBy: { version: 'desc' },
  });
}

export async function getVersion(versionId: string) {
  return prisma.draftVersion.findUnique({ where: { id: versionId } });
}

export async function restoreVersion(draftId: string, versionId: string) {
  const version = await prisma.draftVersion.findUnique({ where: { id: versionId } });
  if (!version || version.draftId !== draftId) {
    throw new Error('Version not found');
  }
  return updateDraft(draftId, {
    content: version.content,
    changeSummary: `Restored from version ${version.version}`,
  });
}

// --- Linked cases management ---

export async function addLinkedCase(draftId: string, caseId: string) {
  return prisma.draftCase.create({
    data: { draftId, caseId },
  });
}

export async function removeLinkedCase(draftId: string, caseId: string) {
  return prisma.draftCase.delete({
    where: { draftId_caseId: { draftId, caseId } },
  });
}

export async function getLinkedCaseIds(draftId: string): Promise<string[]> {
  const links = await prisma.draftCase.findMany({
    where: { draftId },
    select: { caseId: true },
  });
  return links.map(l => l.caseId);
}
