/**
 * SSE event publishing via Redis pub/sub.
 *
 * Provides typed event publishing for real-time updates to SSE consumers.
 * Events are published to Redis channels and picked up by SSE watch endpoints.
 * Falls back gracefully when Redis is unavailable.
 */

import { getRedis, isRedisAvailable } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SSEEvents');

// Redis pub/sub channel names
export const SSE_CHANNELS = {
  DOC_STATUS: 'soundsuite:doc_status',
  FILING_EVENTS: 'soundsuite:filing_events',
  DOCUMENT_EVENTS: 'soundsuite:document_events',
} as const;

// Event type constants
export type FilingEventType = 'filing_created' | 'filing_updated' | 'filing_deleted';
export type DocumentEventType = 'document_added' | 'document_status_changed';

export interface FilingEventPayload {
  type: FilingEventType;
  caseId: string;
  filingId: string;
  filingType?: string;
  title?: string;
  slug?: string;
  timestamp: number;
}

export interface DocumentEventPayload {
  type: DocumentEventType;
  caseId: string;
  documentId: string;
  fileName?: string;
  filePath?: string;
  status?: string;
  filingId?: string | null;
  timestamp: number;
}

/**
 * Publish a filing event (created/updated/deleted) to Redis pub/sub.
 */
export async function publishFilingEvent(payload: Omit<FilingEventPayload, 'timestamp'>): Promise<void> {
  try {
    if (!(await isRedisAvailable())) return;
    const redis = getRedis();
    const event: FilingEventPayload = { ...payload, timestamp: Date.now() };
    await redis.publish(SSE_CHANNELS.FILING_EVENTS, JSON.stringify(event));
    logger.debug('Published filing event', { type: payload.type, caseId: payload.caseId, filingId: payload.filingId });
  } catch (err) {
    logger.error('Failed to publish filing event', err);
  }
}

/**
 * Publish a document event (added/status_changed) to Redis pub/sub.
 */
export async function publishDocumentEvent(payload: Omit<DocumentEventPayload, 'timestamp'>): Promise<void> {
  try {
    if (!(await isRedisAvailable())) return;
    const redis = getRedis();
    const event: DocumentEventPayload = { ...payload, timestamp: Date.now() };
    await redis.publish(SSE_CHANNELS.DOCUMENT_EVENTS, JSON.stringify(event));
    logger.debug('Published document event', { type: payload.type, caseId: payload.caseId, documentId: payload.documentId });
  } catch (err) {
    logger.error('Failed to publish document event', err);
  }
}
