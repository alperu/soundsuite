/**
 * The `research_*` tool set (docs/tasks/06-mcp-two-profiles.md, item 6).
 * `tools/index.ts` appends `getResearchTools()` to the registry list.
 */

import type { BaseMCPTool } from './base-tool';
import { ResearchEvidenceTool, ResearchStartTool } from './research-evidence';
import { ResearchStatusTool, ResearchResultTool, ResearchCancelTool } from './research-jobs-tools';

export function getResearchTools(): BaseMCPTool[] {
  return [
    new ResearchEvidenceTool(),
    new ResearchStartTool(),
    new ResearchStatusTool(),
    new ResearchResultTool(),
    new ResearchCancelTool(),
  ];
}

export { ResearchEvidenceTool, ResearchStartTool } from './research-evidence';
export { ResearchStatusTool, ResearchResultTool, ResearchCancelTool } from './research-jobs-tools';
