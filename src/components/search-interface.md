# Search Interface Component

## Overview

The Search Interface component provides a user-friendly interface for testing semantic and pattern searches across legal documents. It's designed for the Sound Suite search playground page.

## Features

### Mode Toggle
- **Semantic Search**: Natural language queries using AI embeddings (calls `query_case_knowledge` MCP tool)
- **Pattern Search**: Regex pattern matching for exact searches (calls `scan_for_pattern` MCP tool)

### Search Form
- Query input field with contextual placeholder text
- Optional case filter dropdown to restrict results to a specific case
- Submit button with loading state

### Results Display
- Shows document name, page number, and matched text
- For semantic search: displays similarity score
- For pattern search: highlights the matched pattern
- Click to expand/collapse full context
- Responsive design with hover states

### Error Handling
- Displays user-friendly error messages
- Validates query input
- Handles MCP server errors gracefully

## Usage

```tsx
import SearchInterface from '@/components/search-interface';

// In your page component
const cases = await getCases(); // Fetch cases from database

<SearchInterface cases={cases} />
```

## API Integration

The component calls two API routes:
- `/api/search/semantic` - For semantic searches
- `/api/search/pattern` - For pattern searches

Both routes proxy requests to the MCP server and handle authentication.

## Requirements Validated

- **14.1**: Provides search interface with two modes (Semantic and Pattern)
- **14.2**: Calls query_case_knowledge MCP tool in Semantic mode
- **14.3**: Calls scan_for_pattern MCP tool in Pattern mode
- **14.4**: Displays results with document name, page number, and matched text
- **14.5**: Allows filtering results by case_id
- **14.6**: Implements result highlighting on click (expands full context)
