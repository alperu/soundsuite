export const DOCUMENT_TYPES = [
  'Appeal',
  'Response',
  'Motion',
  'Petition',
  'Reply',
  'Brief',
  'Memorandum',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DRAFT_STATUSES = ['draft', 'review', 'final'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface DraftSummary {
  id: string;
  caseId: string;
  title: string;
  slug: string;
  documentType: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DraftFull extends DraftSummary {
  content: string;
  case?: { id: string; name: string; caseNumber?: string };
}

export interface DraftVersionSummary {
  id: string;
  draftId: string;
  version: number;
  changeSummary?: string;
  createdAt: string;
}

export interface CreateDraftInput {
  caseId: string;
  title: string;
  documentType: string;
}

export interface UpdateDraftInput {
  title?: string;
  content?: string;
  status?: string;
  documentType?: string;
  changeSummary?: string;
}
