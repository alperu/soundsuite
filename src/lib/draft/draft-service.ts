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

export async function listDrafts(caseId: string) {
  return prisma.draft.findMany({
    where: { caseId },
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
    },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function getDraft(id: string) {
  return prisma.draft.findUnique({
    where: { id },
    include: {
      case: { select: { id: true, name: true, caseNumber: true } },
    },
  });
}

export async function createDraft(input: CreateDraftInput) {
  const slug = await uniqueSlug(input.caseId, input.title);
  return prisma.draft.create({
    data: {
      caseId: input.caseId,
      title: input.title,
      slug,
      documentType: input.documentType,
      content: '',
      status: 'draft',
      version: 1,
    },
  });
}

export async function updateDraft(id: string, input: UpdateDraftInput) {
  const existing = await prisma.draft.findUnique({ where: { id } });
  if (!existing) throw new Error('Draft not found');

  const shouldVersion = input.content !== undefined && input.content !== existing.content;

  const updated = await prisma.draft.update({
    where: { id },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.content !== undefined && { content: input.content }),
      ...(input.status !== undefined && { status: input.status }),
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
