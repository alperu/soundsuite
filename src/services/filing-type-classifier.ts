/**
 * FilingTypeClassifier — semantic filing type classification using LanceDB + embeddings.
 *
 * Maintains a `filing-types` LanceDB table seeded with filing type labels and
 * common variations. Classifies documents by embedding the cleaned filename
 * and finding the nearest type via vector similarity search.
 *
 * Results are cached in Redis for instant retrieval.
 */

import * as lancedb from '@lancedb/lancedb';
import * as path from 'path';
import * as crypto from 'crypto';
import { getRedis, isRedisAvailable } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const logger = createLogger('FilingTypeClassifier');

const TABLE_NAME = 'filing-types';
const REDIS_PREFIX = 'soundsuite:filing:';
const CACHE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

// ── Filing type seed data ───────────────────────────────────────────
// Each entry: [filingType, ...variations]
// The filingType is the canonical label; variations are common phrasings
// that should map to the same type.

const FILING_TYPE_SEEDS: Array<{ type: string; labels: string[] }> = [
  {
    type: 'Motion',
    labels: [
      'Motion', 'Motion to Compel', 'Motion for Summary Judgment',
      'Emergency Motion', 'Motion to Dismiss', 'Motion to Strike',
      'Motion for Reconsideration', 'Motion for Continuance',
      'Motion for New Trial', 'Motion in Limine',
    ],
  },
  {
    type: 'Notice',
    labels: [
      'Notice', 'Notice of Hearing', 'Notice of Appeal',
      'Supplemental Notice', 'Notice of Filing', 'Notice of Appearance',
    ],
  },
  {
    type: 'Affidavit',
    labels: [
      'Affidavit', 'Sworn Affidavit', 'Supplemental Affidavit',
      'Affidavit in Support', 'Affidavit of Service',
    ],
  },
  {
    type: 'Petition',
    labels: [
      'Petition', 'Petition for Bill of Review', "Petitioner's Response",
      "Petitioner's Motion", 'Original Petition', 'Amended Petition',
    ],
  },
  {
    type: 'Order',
    labels: [
      'Order', 'Court Order', 'Order Granting', 'Order Denying',
      'Temporary Restraining Order', 'Protective Order', 'Ruling',
    ],
  },
  {
    type: 'Response',
    labels: [
      'Response', 'Response to Motion', 'Opposition',
      "Respondent's Response", 'Response in Opposition',
    ],
  },
  {
    type: 'Reply',
    labels: [
      'Reply', 'Reply Brief', 'Reply to Response',
      "Petitioner's Reply", "Appellant's Reply",
    ],
  },
  {
    type: 'Brief',
    labels: [
      'Brief', "Appellant's Brief", "Appellee's Brief",
      'Trial Brief', 'Amicus Brief', 'Opening Brief',
      "Petitioner's Brief", "Respondent's Brief",
      'Amended Brief', "Petitioner's Amended Brief",
    ],
  },
  {
    type: 'Judgment',
    labels: [
      'Judgment', 'Final Judgment', 'Default Judgment',
      'Summary Judgment', 'Agreed Judgment',
    ],
  },
  {
    type: 'Decree',
    labels: [
      'Decree', 'Final Decree', 'Decree of Divorce',
      'Agreed Decree', 'Amended Decree',
    ],
  },
  {
    type: 'Subpoena',
    labels: [
      'Subpoena', 'Subpoena Duces Tecum', 'Deposition Subpoena',
    ],
  },
  {
    type: 'Letter',
    labels: [
      'Letter', 'Correspondence', 'Cover Letter', 'Demand Letter',
    ],
  },
  {
    type: "Clerk's Record",
    labels: ["Clerk's Record", 'Clerks Record', 'CR'],
  },
  {
    type: "Reporter's Record",
    labels: ["Reporter's Record", 'Reporters Record', 'RR', 'Transcript of Proceedings'],
  },
  {
    type: 'Transcript',
    labels: [
      'Transcript', 'Deposition Transcript', 'Hearing Transcript',
      'Trial Transcript',
    ],
  },
  {
    type: 'Settlement',
    labels: [
      'Settlement', 'Settlement Agreement', 'Mediated Settlement',
      'Settlement Offer',
    ],
  },
  {
    type: 'Bill of Review',
    labels: [
      'Bill of Review', 'Petition for Bill of Review',
    ],
  },
  {
    type: 'Return of Service',
    labels: [
      'Return of Service', 'Proof of Service', 'Certificate of Service',
    ],
  },
  {
    type: 'Demand Letter',
    labels: ['Demand Letter', 'Letter of Demand'],
  },
  {
    type: 'Objection',
    labels: [
      'Objection', 'Objection to Evidence', 'Objection to Motion',
    ],
  },
  {
    type: 'Request',
    labels: [
      'Request', 'Request for Production', 'Request for Admissions',
      'Request for Disclosure', 'Discovery Request',
    ],
  },
  {
    type: 'Supplement',
    labels: [
      'Supplement', 'Supplemental Filing', 'Supplemental Brief',
    ],
  },
  {
    type: 'Designation',
    labels: [
      'Designation', 'Designation of Record', "Appellant's Designation",
    ],
  },
];

// ── LanceDB row interface ───────────────────────────────────────────

interface FilingTypeRow {
  id: string;
  vector: number[];
  filing_type: string;
  label: string;
}

// ── Classifier class ────────────────────────────────────────────────

export interface ClassificationResult {
  filingType: string;
  title: string;
  confidence: number;
  source: 'cache' | 'regex' | 'semantic';
}

/**
 * Singleton classifier. Lazily initializes the LanceDB table and
 * embedding model on first use.
 */
let classifierInstance: FilingTypeClassifier | null = null;

export function getClassifier(): FilingTypeClassifier {
  if (!classifierInstance) {
    classifierInstance = new FilingTypeClassifier();
  }
  return classifierInstance;
}

export class FilingTypeClassifier {
  private db: any = null;
  private table: any = null;
  private embedder: any = null;
  private initialized = false;
  private initializing: Promise<void> | null = null;

  /**
   * Lazily initialize the LanceDB connection, table, and embedding model.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = this._doInit();
    await this.initializing;
    this.initialized = true;
    this.initializing = null;
  }

  private async _doInit(): Promise<void> {
    try {
      // Connect to LanceDB
      const dbPath = process.env.LANCEDB_PATH || 'data/lancedb';
      this.db = await lancedb.connect(dbPath);

      // Initialize embedding model
      const { TransformersEmbeddingProvider } = await import(
        '@/lib/ingestion/transformers-embedding-provider'
      );
      const { getConfig } = await import('@/lib/db/config');
      const config = await getConfig();
      this.embedder = new TransformersEmbeddingProvider(config.embeddingModel);

      // Check if table exists and is seeded
      const tableNames = await this.db.tableNames();
      if (tableNames.includes(TABLE_NAME)) {
        this.table = await this.db.openTable(TABLE_NAME);
        // Verify it has data
        const count = await this.table.countRows();
        if (count === 0) {
          await this._seedTable();
        }
      } else {
        await this._seedTable();
      }

      logger.info('Initialized', {
        table: TABLE_NAME,
        model: config.embeddingModel,
      });
    } catch (error) {
      logger.error('Initialization failed', error);
      throw error;
    }
  }

  /**
   * Seed the filing-types table with embeddings for all type labels.
   */
  private async _seedTable(): Promise<void> {
    logger.info('Seeding filing-types table...');

    // Collect all labels
    const entries: Array<{ type: string; label: string }> = [];
    for (const { type, labels } of FILING_TYPE_SEEDS) {
      for (const label of labels) {
        entries.push({ type, label });
      }
    }

    // Embed all labels in one batch
    const texts = entries.map(e => e.label);
    const vectors = await this.embedder.embed(texts);

    // Build rows
    const rows: FilingTypeRow[] = entries.map((entry, i) => ({
      id: crypto.randomUUID(),
      vector: vectors[i],
      filing_type: entry.type,
      label: entry.label,
    }));

    // Create table (overwrites if exists)
    this.table = await this.db.createTable(TABLE_NAME, rows, {
      mode: 'overwrite',
    });

    logger.info(`Seeded ${rows.length} filing type labels`);
  }

  // ── Redis caching ─────────────────────────────────────────────────

  /**
   * Generate a cache key for a file path.
   */
  private cacheKey(filePath: string): string {
    const hash = crypto.createHash('sha256').update(filePath).digest('hex').substring(0, 16);
    return `${REDIS_PREFIX}${hash}`;
  }

  /**
   * Get cached detection result from Redis.
   */
  async getCachedDetection(filePath: string): Promise<ClassificationResult | null> {
    try {
      const available = await isRedisAvailable();
      if (!available) return null;

      const redis = getRedis();
      const raw = await redis.get(this.cacheKey(filePath));
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      return {
        filingType: parsed.filingType,
        title: parsed.title,
        confidence: parsed.confidence,
        source: 'cache',
      };
    } catch {
      return null;
    }
  }

  /**
   * Cache a detection result in Redis.
   */
  async cacheDetection(filePath: string, result: { filingType: string; title: string; confidence: number }): Promise<void> {
    try {
      const available = await isRedisAvailable();
      if (!available) return;

      const redis = getRedis();
      const data = JSON.stringify({
        filingType: result.filingType,
        title: result.title,
        confidence: result.confidence,
        classifiedAt: new Date().toISOString(),
      });
      await redis.set(this.cacheKey(filePath), data, 'EX', CACHE_TTL);
    } catch (error) {
      logger.warn('Failed to cache detection', { error });
    }
  }

  // ── Semantic classification ───────────────────────────────────────

  /**
   * Classify a document by embedding its text and finding the nearest
   * filing type in the LanceDB table.
   *
   * @param text - Cleaned filename, folder name, or header text to classify
   * @returns Top match with confidence score
   */
  async classifyText(text: string): Promise<{ filingType: string; confidence: number }> {
    await this.initialize();

    if (!this.table || !this.embedder) {
      return { filingType: 'Other', confidence: 0.2 };
    }

    try {
      // Embed the input text
      const [vector] = await this.embedder.embed([text]);

      // Search for top 3 nearest neighbors
      const results = await this.table.search(vector).limit(3).toArray();

      if (!results || results.length === 0) {
        return { filingType: 'Other', confidence: 0.2 };
      }

      // LanceDB returns _distance (L2 distance). Convert to similarity score.
      // Lower distance = more similar. We use 1 / (1 + distance) as confidence.
      const top = results[0];
      const distance = top._distance ?? top.distance ?? 1;
      const confidence = 1 / (1 + distance);

      // If confidence is too low, fall back to Other
      if (confidence < 0.3) {
        return { filingType: 'Other', confidence };
      }

      return {
        filingType: top.filing_type,
        confidence: Math.min(confidence, 0.99),
      };
    } catch (error) {
      logger.error('Classification failed', error);
      return { filingType: 'Other', confidence: 0.2 };
    }
  }

  /**
   * Full classification pipeline for a file path.
   * Builds a search string from the filename and parent folder,
   * then runs semantic classification.
   */
  async classifyFiling(filePath: string): Promise<ClassificationResult> {
    // Import helpers from filing-detector
    const { extractFilingTitle } = await import('./filing-detector');

    const fileName = path.basename(filePath);
    const folderName = path.basename(path.dirname(filePath));

    // Build search text: cleaned filename + folder name
    const baseName = path.basename(fileName, path.extname(fileName))
      .replace(/[-_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Strip case number prefix for cleaner embedding
    const cleaned = baseName
      .replace(/^Cause\s+No\.?\s*/i, '')
      .replace(/^[A-Z]-\d+-[A-Z]+-\d+-\d+\s*[-–—]\s*/i, '')
      .replace(/^[A-Z]{1,4}[-_.]\d{2,6}[-_.]\d{3,8}\s*[-–—]\s*/i, '')
      .trim();

    const searchText = cleaned || folderName || baseName;

    // Run semantic classification
    const { filingType, confidence } = await this.classifyText(searchText);

    // Extract title using existing logic
    const title = extractFilingTitle(fileName, undefined, folderName);

    return { filingType, title, confidence, source: 'semantic' };
  }

  /**
   * Re-seed the table (e.g. after adding new filing types).
   */
  async reseed(): Promise<void> {
    this.initialized = false;
    this.table = null;
    await this.initialize();
    await this._seedTable();
  }
}
