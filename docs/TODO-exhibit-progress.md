# TODO: Exhibit Extraction Progress Not Showing in UI

## Issue

After adding heartbeat/sub-progress to the ingestion pipeline, the **embedding generation** stage correctly shows progress updates in the UI, but the **exhibit extraction** stage does not appear to show sub-progress.

## What Was Implemented

- `ExhibitExtractor.extractExhibits()` now accepts an `onProgress(processed, total)` callback
- The callback is invoked after each candidate image is processed (OCR'd and saved)
- `IngestionPipeline` passes an `onProgress` that calls `publishProgress` with detail like `Processing exhibit 3/12...` and progress in the 50-59% range
- A heartbeat (`setInterval` every 60s) keeps the Redis key alive during long stages

## Possible Causes to Investigate

1. **No candidate images** — if all images are filtered out (by size, dedup, or boundary filters), the processing loop never runs and `onProgress` is never called. The stage would jump from "Extracting exhibits..." straight to completion.
2. **Stage completes too fast** — if there are only a few small exhibits, OCR finishes in seconds and the progress update is never visible in the polling interval.
3. **Redis publish timing** — the `publishProgress` call inside the callback uses `.catch(() => {})` (fire-and-forget). If Redis is slow or the stage completes before the write lands, the UI poll may miss it.

## How to Verify

1. Find or create a test PDF with many (10+) large exhibit images that pass all filters
2. Queue it for processing and watch the home page card
3. Check Redis during processing: `redis-cli hgetall "legallens:doc_progress:<docId>"`
4. Add temporary `console.log` inside the `onProgress` callback to confirm it's being called

## Files

- `src/lib/ingestion/ingestion-pipeline.ts` — heartbeat + sub-progress wiring
- `src/lib/ingestion/exhibit-extractor.ts` — `onProgress` callback in processing loop
