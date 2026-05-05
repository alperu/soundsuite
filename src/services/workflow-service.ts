/**
 * Workflow management service.
 *
 * Handles CRUD for workflows and templates, creating workflows from templates,
 * and appending citations to workflow content.
 */

// Use the shared singleton (Prisma 7+ requires the driver adapter to be passed
// at construction time; constructing a bare client here would throw).
import { prisma } from '@/lib/db/prisma';
import { getCitationFormatter, CitationInput, FormattedCitation } from '@/lib/citations/citation-formatter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowCreateInput {
  caseId: string;
  templateId?: string;
  title: string;
  slug?: string;
}

export interface CitationEntry {
  text: string;
  citation: string;
  citationShort: string;
  page: number;
  document: string;
  filingType?: string;
}

export interface TemplateFilters {
  category?: string;
  tag?: string;
  search?: string;
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function serializeTags(tags: string[]): string {
  return JSON.stringify(tags.map(t => t.toLowerCase().trim()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Template operations
// ---------------------------------------------------------------------------

export async function listTemplates(filters?: TemplateFilters) {
  const all = await prisma.workflowTemplate.findMany({
    orderBy: { name: 'asc' },
    ...(filters?.category ? { where: { category: filters.category } } : {}),
  });

  // Parse tags and apply in-memory filters
  let results = all.map(t => ({
    ...t,
    tags: parseTags(t.tags),
  }));

  if (filters?.tag) {
    const tag = filters.tag.toLowerCase();
    results = results.filter(t => t.tags.some(tt => tt === tag));
  }

  if (filters?.search) {
    const q = filters.search.toLowerCase();
    results = results.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.description?.toLowerCase().includes(q) ||
      t.tags.some(tag => tag.includes(q))
    );
  }

  return results;
}

export async function getTemplate(id: string) {
  const t = await prisma.workflowTemplate.findUnique({ where: { id } });
  if (!t) return null;
  return { ...t, tags: parseTags(t.tags) };
}

export async function createTemplate(data: {
  name: string;
  jurisdiction?: string;
  category?: string;
  tags?: string[];
  description?: string;
  content: string;
}) {
  const { tags, ...rest } = data;
  return prisma.workflowTemplate.create({
    data: {
      ...rest,
      tags: tags ? serializeTags(tags) : '[]',
    },
  });
}

export async function updateTemplate(id: string, data: {
  name?: string;
  jurisdiction?: string;
  category?: string;
  tags?: string[];
  description?: string;
  content?: string;
}) {
  const { tags, ...rest } = data;
  const updateData: Record<string, any> = { ...rest };
  if (tags !== undefined) {
    updateData.tags = serializeTags(tags);
  }
  const t = await prisma.workflowTemplate.update({
    where: { id },
    data: updateData,
  });
  return { ...t, tags: parseTags(t.tags) };
}

export async function deleteTemplate(id: string) {
  return prisma.workflowTemplate.delete({ where: { id } });
}

export async function getAllTags(): Promise<string[]> {
  const all = await prisma.workflowTemplate.findMany({ select: { tags: true } });
  const tagSet = new Set<string>();
  for (const t of all) {
    for (const tag of parseTags(t.tags)) {
      tagSet.add(tag);
    }
  }
  return Array.from(tagSet).sort();
}

export async function getAllCategories(): Promise<string[]> {
  const all = await prisma.workflowTemplate.findMany({
    select: { category: true },
    distinct: ['category'],
  });
  return all.map(t => t.category).filter((c): c is string => c !== null).sort();
}

// ---------------------------------------------------------------------------
// Workflow operations
// ---------------------------------------------------------------------------

export async function listWorkflows(caseId: string) {
  return prisma.workflow.findMany({
    where: { caseId },
    include: { template: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getWorkflow(id: string) {
  return prisma.workflow.findUnique({
    where: { id },
    include: { template: { select: { name: true } } },
  });
}

export async function createWorkflow(input: WorkflowCreateInput) {
  const slug = input.slug || slugify(input.title);
  let content = '';

  // If creating from template, copy the template content
  if (input.templateId) {
    const template = await prisma.workflowTemplate.findUnique({
      where: { id: input.templateId },
    });
    if (template) {
      content = template.content;
    }
  }

  return prisma.workflow.create({
    data: {
      caseId: input.caseId,
      templateId: input.templateId,
      title: input.title,
      slug,
      content,
      status: 'draft',
    },
  });
}

export async function updateWorkflow(id: string, data: {
  title?: string;
  content?: string;
  status?: string;
}) {
  return prisma.workflow.update({
    where: { id },
    data,
  });
}

export async function deleteWorkflow(id: string) {
  return prisma.workflow.delete({ where: { id } });
}

/**
 * Append formatted citations to a workflow's content.
 * Citations are added as a markdown block at the end (or at a designated marker).
 */
export async function addCitations(workflowId: string, citations: CitationEntry[]) {
  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

  const citationBlock = citations
    .map(c => `- **${c.citationShort}**: ${c.text.substring(0, 200)}${c.text.length > 200 ? '...' : ''} _(${c.document})_`)
    .join('\n');

  let updatedContent: string;

  if (workflow.content.includes('### Citations')) {
    // Citations heading exists — append at end
    updatedContent = `${workflow.content.trimEnd()}\n\n${citationBlock}`;
  } else {
    // No citations section — create one and append
    updatedContent = `${workflow.content.trimEnd()}\n\n---\n\n### Citations\n\n${citationBlock}`;
  }

  return prisma.workflow.update({
    where: { id: workflowId },
    data: { content: updatedContent },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Seed default templates
// ---------------------------------------------------------------------------

const TEXAS_STATE_APPEAL_TEMPLATE = `# Texas State Appeal Brief

## Statement of the Case

_Briefly describe the nature of the case, the course of proceedings, and the trial court's disposition._

*Add CR citations here, e.g., \\[1 CR 5\\]*

## Issues Presented

1. _Issue 1_
2. _Issue 2_

## Statement of Facts

_Present the relevant facts with proper record citations._

*Add RR citations here, e.g., \\[2 RR 45:10-15\\]*

## Summary of the Argument

_Provide a concise summary of each argument._

## Argument

### Issue 1

_Develop the legal argument with citations to the record and legal authorities._

### Issue 2

_Develop the legal argument with citations to the record and legal authorities._

## Prayer

_State the specific relief requested._

### Citations
`;

// ---------------------------------------------------------------------------
// Analysis tool template definitions
// ---------------------------------------------------------------------------

interface AnalysisToolTemplate {
  name: string;
  toolName: string;
  tags: string[];
  description: string;
  content: string;
}

const ANALYSIS_TOOL_TEMPLATES: AnalysisToolTemplate[] = [
  {
    name: 'Query Case Knowledge',
    toolName: 'query_case_knowledge',
    tags: ['analysis-tools', 'search', 'query-case-knowledge'],
    description: 'Workflow template for semantic case knowledge queries using the query_case_knowledge tool.',
    content: `# Query Case Knowledge

## Parameters

| Parameter | Value |
|-----------|-------|
| **Query** | _Enter your natural language question_ |
| **Case** | _Select target case_ |
| **Limit** | 10 |

## Findings

| # | Document | Page | Score | Key Text |
|---|----------|------|-------|----------|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

## Analysis

_Summarize the key findings from the semantic search results._

_Identify patterns, themes, or important details across the retrieved passages._

### Citations
`,
  },
  {
    name: 'Scan for Pattern',
    toolName: 'scan_for_pattern',
    tags: ['analysis-tools', 'search', 'scan-for-pattern'],
    description: 'Workflow template for regex pattern scanning across documents using the scan_for_pattern tool.',
    content: `# Scan for Pattern

## Parameters

| Parameter | Value |
|-----------|-------|
| **Pattern** | _Enter regex pattern (e.g., \\d{4}-\\d{2}-\\d{2})_ |
| **Case** | _Select target case_ |

## Findings

| # | Document | Page | Match | Context |
|---|----------|------|-------|---------|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

## Analysis

_Summarize the pattern matches found across documents._

_Note any significant occurrences or patterns in the results._

### Citations
`,
  },
  {
    name: 'Retrieve Exhibit',
    toolName: 'retrieve_exhibit',
    tags: ['analysis-tools', 'search', 'retrieve-exhibit'],
    description: 'Workflow template for searching exhibit images by description using the retrieve_exhibit tool.',
    content: `# Retrieve Exhibit

## Parameters

| Parameter | Value |
|-----------|-------|
| **Description** | _Describe the exhibit to search for_ |
| **Case** | _Select target case_ |

## Findings

| # | Exhibit Label | Document | Description | Relevance |
|---|---------------|----------|-------------|-----------|
| 1 | | | | |
| 2 | | | | |

## Analysis

_Describe the retrieved exhibits and their relevance to the case._

### Citations
`,
  },
  {
    name: 'Detect Contradictions',
    toolName: 'detect_contradictions',
    tags: ['analysis-tools', 'contradiction', 'detect-contradictions'],
    description: 'Workflow template for detecting contradictory statements across case documents.',
    content: `# Detect Contradictions

## Parameters

| Parameter | Value |
|-----------|-------|
| **Case** | _Select target case_ |
| **Document IDs** | _Optional: specific document IDs_ |
| **Topic** | _Optional: focus area_ |

## Contradictions Found

### Contradiction 1

| Aspect | Details |
|--------|---------|
| **Statement A** | _First contradictory statement_ |
| **Source A** | _Document, page_ |
| **Statement B** | _Second contradictory statement_ |
| **Source B** | _Document, page_ |
| **Severity** | High / Medium / Low |
| **Explanation** | _Why these statements contradict_ |

### Contradiction 2

_(Repeat pattern above)_

## Analysis

_Summarize the key contradictions and their potential impact on the case._

### Citations
`,
  },
  {
    name: 'Track Claim Evolution',
    toolName: 'track_claim_evolution',
    tags: ['analysis-tools', 'contradiction', 'track-claim-evolution'],
    description: 'Workflow template for tracking how claims evolve across filings over time.',
    content: `# Track Claim Evolution

## Parameters

| Parameter | Value |
|-----------|-------|
| **Case** | _Select target case_ |
| **Claim** | _Describe the claim to track_ |

## Claim Timeline

| Date | Filing | Claim Version | Changes | Source |
|------|--------|---------------|---------|--------|
| | | | | |
| | | | | |
| | | | | |

## Evolution Analysis

_Describe how the claim has changed over time._

_Identify significant shifts in language, scope, or assertions._

### Citations
`,
  },
  {
    name: 'Extract Argument Structure',
    toolName: 'extract_argument_structure',
    tags: ['analysis-tools', 'argument', 'extract-argument-structure'],
    description: 'Workflow template for mapping the logical structure of legal arguments in a document.',
    content: `# Extract Argument Structure

## Parameters

| Parameter | Value |
|-----------|-------|
| **Document** | _Select target document_ |
| **Case** | _Select target case_ |

## Argument Map

### Main Argument 1

| Component | Content |
|-----------|---------|
| **Claim** | _Main assertion_ |
| **Premises** | _Supporting premises_ |
| **Evidence** | _Referenced evidence_ |
| **Legal Authority** | _Cases/statutes cited_ |
| **Strength** | Strong / Moderate / Weak |

### Main Argument 2

_(Repeat pattern above)_

## Analysis

_Evaluate the overall argument structure, identify strengths and weaknesses._

### Citations
`,
  },
  {
    name: 'Compare Argument Structures',
    toolName: 'compare_argument_structures',
    tags: ['analysis-tools', 'argument', 'compare-argument-structures'],
    description: 'Workflow template for comparing argument structures between two documents.',
    content: `# Compare Argument Structures

## Parameters

| Parameter | Value |
|-----------|-------|
| **Document A** | _Select first document_ |
| **Document B** | _Select second document_ |
| **Case** | _Select target case_ |

## Comparison Matrix

| Aspect | Document A | Document B | Assessment |
|--------|-----------|-----------|------------|
| **Main Claim** | | | |
| **Key Evidence** | | | |
| **Legal Authority** | | | |
| **Logical Gaps** | | | |

## Analysis

_Compare and contrast the argument structures of both documents._

_Identify where arguments align, conflict, or have different strengths._

### Citations
`,
  },
  {
    name: 'Reconstruct Timeline',
    toolName: 'reconstruct_timeline',
    tags: ['analysis-tools', 'timeline', 'reconstruct-timeline'],
    description: 'Workflow template for reconstructing a chronological timeline of events from case documents.',
    content: `# Reconstruct Timeline

## Parameters

| Parameter | Value |
|-----------|-------|
| **Case** | _Select target case_ |
| **Date Range** | _Optional: start and end dates_ |

## Timeline

| Date | Event | Source Document | Page | Significance |
|------|-------|----------------|------|-------------|
| | | | | |
| | | | | |
| | | | | |
| | | | | |

## Key Periods

_Identify significant time periods, gaps, or clusters of events._

## Analysis

_Summarize the timeline and its implications for the case._

### Citations
`,
  },
  {
    name: 'Extract Obligations',
    toolName: 'extract_obligations',
    tags: ['analysis-tools', 'timeline', 'extract-obligations'],
    description: 'Workflow template for extracting deadlines, duties, and obligations from case documents.',
    content: `# Extract Obligations

## Parameters

| Parameter | Value |
|-----------|-------|
| **Case** | _Select target case_ |
| **Document** | _Optional: specific document_ |

## Obligations

| # | Obligation | Party | Deadline | Source | Status |
|---|-----------|-------|----------|--------|--------|
| 1 | | | | | Pending / Met / Missed |
| 2 | | | | | |
| 3 | | | | | |

## Analysis

_Summarize key obligations, upcoming deadlines, and any missed obligations._

### Citations
`,
  },
  {
    name: 'Extract Entities',
    toolName: 'extract_entities',
    tags: ['analysis-tools', 'entity', 'extract-entities'],
    description: 'Workflow template for identifying people, organizations, and their relationships in case documents.',
    content: `# Extract Entities

## Parameters

| Parameter | Value |
|-----------|-------|
| **Case** | _Select target case_ |
| **Entity Types** | _People, Organizations, Locations, etc._ |

## Entities

### People

| Name | Role | Affiliations | Key References |
|------|------|-------------|----------------|
| | | | |
| | | | |

### Organizations

| Name | Type | Key People | Key References |
|------|------|-----------|----------------|
| | | | |
| | | | |

## Relationships

_Map key relationships between entities identified above._

## Analysis

_Summarize the entity landscape and notable relationships._

### Citations
`,
  },
  {
    name: 'Analyze Citations',
    toolName: 'analyze_citations',
    tags: ['analysis-tools', 'entity', 'analyze-citations'],
    description: 'Workflow template for analyzing legal citations and authorities referenced across case documents.',
    content: `# Analyze Citations

## Parameters

| Parameter | Value |
|-----------|-------|
| **Case** | _Select target case_ |
| **Document** | _Optional: specific document_ |

## Citation Analysis

| Citation | Type | Frequency | Context | Significance |
|----------|------|-----------|---------|-------------|
| | Case / Statute / Rule | | | |
| | | | | |
| | | | | |

## Most Cited Authorities

_List the most frequently cited authorities and their relevance._

## Analysis

_Evaluate the citation patterns and the strength of legal authority support._

### Citations
`,
  },
  {
    name: 'Detect Privilege',
    toolName: 'detect_privilege',
    tags: ['analysis-tools', 'review', 'detect-privilege'],
    description: 'Workflow template for identifying potentially privileged content in case documents.',
    content: `# Detect Privilege

## Parameters

| Parameter | Value |
|-----------|-------|
| **Case** | _Select target case_ |
| **Document** | _Optional: specific document_ |

## Privileged Content

| # | Type | Document | Page | Content Summary | Confidence |
|---|------|----------|------|-----------------|-----------|
| 1 | Attorney-Client / Work Product / Other | | | | High / Medium / Low |
| 2 | | | | | |
| 3 | | | | | |

## Analysis

_Summarize privilege findings and recommend next steps for privilege review._

### Citations
`,
  },
  {
    name: 'Analyze Tone',
    toolName: 'analyze_tone',
    tags: ['analysis-tools', 'review', 'analyze-tone'],
    description: 'Workflow template for analyzing the tone and language patterns in case documents.',
    content: `# Analyze Tone

## Parameters

| Parameter | Value |
|-----------|-------|
| **Document** | _Select target document_ |
| **Case** | _Select target case_ |

## Tone Analysis

| Section | Tone | Key Phrases | Assessment |
|---------|------|-------------|------------|
| | Neutral / Aggressive / Defensive / Persuasive | | |
| | | | |
| | | | |

## Language Patterns

_Describe notable language patterns, persuasive techniques, or rhetorical strategies used._

## Analysis

_Summarize the overall tone and its potential impact on the case._

### Citations
`,
  },
];

export async function seedDefaultTemplates() {
  // Upsert Texas State Appeal template
  await prisma.workflowTemplate.upsert({
    where: { name: 'Texas State Appeal' },
    update: {
      category: 'Writing',
      tags: serializeTags(['appeal', 'texas', 'brief']),
      description: 'Template for a Texas state appellate brief with standard sections and citation placeholders.',
      content: TEXAS_STATE_APPEAL_TEMPLATE,
    },
    create: {
      name: 'Texas State Appeal',
      jurisdiction: 'Texas',
      category: 'Writing',
      tags: serializeTags(['appeal', 'texas', 'brief']),
      description: 'Template for a Texas state appellate brief with standard sections and citation placeholders.',
      content: TEXAS_STATE_APPEAL_TEMPLATE,
    },
  });

  // Upsert 13 analysis tool templates
  for (const tmpl of ANALYSIS_TOOL_TEMPLATES) {
    await prisma.workflowTemplate.upsert({
      where: { name: tmpl.name },
      update: {
        category: 'Analysis Tools',
        tags: serializeTags(tmpl.tags),
        description: tmpl.description,
        content: tmpl.content,
      },
      create: {
        name: tmpl.name,
        category: 'Analysis Tools',
        tags: serializeTags(tmpl.tags),
        description: tmpl.description,
        content: tmpl.content,
      },
    });
  }
}
