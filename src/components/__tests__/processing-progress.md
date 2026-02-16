# Processing Progress Component

## Overview

The `ProcessingProgress` component displays real-time processing progress for document ingestion in the Sound Suite dashboard. It uses Server-Sent Events (SSE) to receive live updates from the backend.

## Features

### 1. Progress Percentage
- Calculated as: `(processed / total) × 100`
- Where `processed = indexed + error` (both are considered "processed")
- Displayed as a visual progress bar and percentage text

### 2. Processing Rate
- Calculated as documents per minute
- Uses a 1-minute rolling window to track processing history
- Formula: `(docs_processed_in_window) / (time_window_in_minutes)`
- Displayed with lightning bolt icon

### 3. Estimated Time Remaining (ETA)
- Calculated as: `(queued / rate) × 60` seconds
- Only shown when rate > 0 and queued > 0
- Formatted as "Xm Ys" or "Xs"
- Displayed with clock icon

### 4. Completion Message
- Shows when `queued === 0 && processing === 0`
- Displays green checkmark with success message
- Shows final count: "X of Y documents indexed"

### 5. Status Breakdown
- Shows counts for:
  - Processing (yellow)
  - Queued (gray)
  - Failed/Error (red)

## Real-Time Updates

The component uses Server-Sent Events (SSE) for real-time updates:

1. Connects to `/api/progress` endpoint (or `/api/progress?caseId=X` for case-specific)
2. Receives updates every 2 seconds
3. Automatically reconnects on connection loss
4. Cleans up connection when component unmounts

## Usage

```tsx
import ProcessingProgress from '@/components/processing-progress';

// Global progress (all cases)
<ProcessingProgress />

// Case-specific progress
<ProcessingProgress caseId="case-uuid" />
```

## Integration

The component is integrated into the `CaseViewWrapper` component and appears at the top of the document grid view, just below the header.

## Requirements Validated

- **Requirement 13.1**: Progress percentage calculation
- **Requirement 13.3**: Completion message display
- **Requirement 13.4**: Processing rate display
- **Requirement 13.5**: ETA calculation and display

## Technical Details

### SSE Connection
- Uses native `EventSource` API
- Automatic reconnection on error
- Proper cleanup on unmount

### State Management
- Uses React `useState` for progress stats
- Updates triggered by SSE messages
- No polling required (push-based updates)

### Styling
- Tailwind CSS for responsive design
- Color-coded status indicators
- Smooth progress bar transitions
- Icons from Heroicons (inline SVG)

## Testing

Unit tests verify:
- Progress percentage calculation (0%, 50%, 100%)
- Processing rate calculation (docs/min)
- ETA calculation (seconds remaining)
- Completion detection
- Error document handling

See: `src/app/api/progress/__tests__/progress.test.ts`
