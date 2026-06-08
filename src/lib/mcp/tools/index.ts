import { BaseMCPTool } from './base-tool';
import { QueryCaseKnowledgeTool } from './query-case-knowledge';
import { QueryCaseGraphTool } from './query-case-graph';
import { ScanForPatternTool } from './scan-for-pattern';
import { RetrieveExhibitTool } from './retrieve-exhibit';
import { DetectContradictionsTool } from './detect-contradictions';
import { TrackClaimEvolutionTool } from './track-claim-evolution';
import { ExtractArgumentStructureTool } from './extract-argument-structure';
import { CompareArgumentStructuresTool } from './compare-argument-structures';
import { ReconstructTimelineTool } from './reconstruct-timeline';
import { ExtractObligationsTool } from './extract-obligations';
import { ExtractEntitiesTool } from './extract-entities';
import { AnalyzeCitationsTool } from './analyze-citations';
import { DetectPrivilegeTool } from './detect-privilege';
import { AnalyzeToneTool } from './analyze-tone';
import { SearchWorkflowsTool } from './search-workflows';

export function getAllTools(): BaseMCPTool[] {
  return [
    new QueryCaseKnowledgeTool(),
    new QueryCaseGraphTool(),
    new ScanForPatternTool(),
    new RetrieveExhibitTool(),
    new DetectContradictionsTool(),
    new TrackClaimEvolutionTool(),
    new ExtractArgumentStructureTool(),
    new CompareArgumentStructuresTool(),
    new ReconstructTimelineTool(),
    new ExtractObligationsTool(),
    new ExtractEntitiesTool(),
    new AnalyzeCitationsTool(),
    new DetectPrivilegeTool(),
    new AnalyzeToneTool(),
    new SearchWorkflowsTool(),
  ];
}

export { BaseMCPTool } from './base-tool';
export { QueryCaseKnowledgeTool } from './query-case-knowledge';
export { QueryCaseGraphTool } from './query-case-graph';
export { ScanForPatternTool } from './scan-for-pattern';
export { RetrieveExhibitTool } from './retrieve-exhibit';
export { DetectContradictionsTool } from './detect-contradictions';
export { TrackClaimEvolutionTool } from './track-claim-evolution';
export { ExtractArgumentStructureTool } from './extract-argument-structure';
export { CompareArgumentStructuresTool } from './compare-argument-structures';
export { ReconstructTimelineTool } from './reconstruct-timeline';
export { ExtractObligationsTool } from './extract-obligations';
export { ExtractEntitiesTool } from './extract-entities';
export { AnalyzeCitationsTool } from './analyze-citations';
export { DetectPrivilegeTool } from './detect-privilege';
export { AnalyzeToneTool } from './analyze-tone';
export { SearchWorkflowsTool } from './search-workflows';
