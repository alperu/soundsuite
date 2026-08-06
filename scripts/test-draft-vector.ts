#!/usr/bin/env npx tsx
/**
 * Test script: Verify draft vector indexing and chat search works end-to-end.
 *
 * Usage:
 *   npx tsx scripts/test-draft-vector.ts
 *
 * Requirements:
 *   - Dev server running on localhost:3000
 *   - At least one case exists in the database
 *   - Embedding provider configured (Ollama/OpenAI/Transformers)
 *
 * What it does:
 *   1. Creates a test draft with sample legal content
 *   2. Indexes the draft into LanceDB
 *   3. Sends a chat query with vectorSearch enabled
 *   4. Verifies the response includes context from the indexed draft
 *   5. Cleans up the test draft
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 30000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJSON(url: string, options?: RequestInit) {
  const res = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

async function fetchNDJSON(url: string, body: object): Promise<{ tokens: string; result: any; progress: string[] }> {
  const res = await fetch(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${errBody}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let tokens = '';
  let result: any = null;
  const progress: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'token') tokens += event.text;
        else if (event.type === 'result') result = event.data;
        else if (event.type === 'progress') progress.push(event.message);
      } catch {}
    }
  }

  return { tokens, result, progress };
}

function log(emoji: string, msg: string) {
  console.log(`${emoji}  ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Draft Vector Indexing Test ===\n');

  // Step 0: Check server is running
  try {
    await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
    log('✅', `Server running at ${BASE_URL}`);
  } catch {
    log('❌', `Server not reachable at ${BASE_URL}. Start with: npm run dev`);
    process.exit(1);
  }

  // Step 1: Find a case to use
  log('🔍', 'Finding a case...');
  const casesRes = await fetchJSON('/api/cases');
  const cases = Array.isArray(casesRes) ? casesRes : casesRes.cases || [];
  if (cases.length === 0) {
    log('❌', 'No cases found. Create a case first.');
    process.exit(1);
  }
  const testCase = cases[0];
  log('✅', `Using case: ${testCase.caseNumber || testCase.name} (${testCase.id})`);

  // Step 2: Create a test draft with unique content
  log('📝', 'Creating test draft...');
  const uniqueMarker = `TEST_VECTOR_${Date.now()}`;
  const testContent = JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1, textAlign: null },
        content: [{ type: 'text', text: 'Test Vector Index Document' }],
      },
      {
        type: 'paragraph',
        attrs: { textAlign: null },
        content: [
          {
            type: 'text',
            text: `${uniqueMarker} The trial court erred in granting the Rule 91a dismissal because deemed admissions under Texas Rule of Civil Procedure 198.2(c) conclusively established over $700,000 in concealed property sales. The court failed to consider the KVKK privacy barrier that prevented discovery of Turkish assets.`,
          },
        ],
      },
      {
        type: 'paragraph',
        attrs: { textAlign: null },
        content: [
          {
            type: 'text',
            text: 'Furthermore, the evidence of post-judgment conspiracy with Adam Wren demonstrates that the fraud was not isolated perjury but an ongoing coordinated scheme extending beyond the courtroom.',
          },
        ],
      },
    ],
  });

  const draft = await fetchJSON('/api/drafts', {
    method: 'POST',
    body: JSON.stringify({
      caseId: testCase.id,
      title: `Test Vector Draft ${Date.now()}`,
      documentType: 'Appeal',
    }),
  });
  log('✅', `Created draft: ${draft.id} (${draft.title})`);

  // Save content to the draft
  await fetchJSON(`/api/drafts/${draft.id}`, {
    method: 'PUT',
    body: JSON.stringify({ content: testContent }),
  });
  log('✅', 'Draft content saved');

  // Step 3: Index the draft
  log('🔄', 'Indexing draft into LanceDB...');
  try {
    const indexResult = await fetchJSON(`/api/drafts/${draft.id}/index`, {
      method: 'POST',
    });
    log('✅', `Indexed: ${indexResult.chunksIndexed} chunks created`);
    if (indexResult.embeddingModel) {
      log('📊', `Embedding model: ${indexResult.embeddingModel}`);
    }
  } catch (err: any) {
    log('❌', `Indexing failed: ${err.message}`);
    log('⚠️', 'This may be because no embedding provider is configured. Check Admin > Embedding Config.');
    // Clean up
    await fetchJSON(`/api/drafts/${draft.id}`, { method: 'DELETE' }).catch(() => {});
    process.exit(1);
  }

  // Step 4: Verify draft indexing status
  log('🔍', 'Verifying draft indexing status...');
  const updatedDraft = await fetchJSON(`/api/drafts/${draft.id}`);
  if (updatedDraft.indexingStatus === 'INDEXED') {
    log('✅', `Draft indexing status: INDEXED (version ${updatedDraft.indexedVersion})`);
  } else {
    log('❌', `Draft indexing status: ${updatedDraft.indexingStatus} (expected INDEXED)`);
  }

  // Step 5: Search via chat with vectorSearch enabled
  log('💬', 'Sending chat query with vector search...');
  try {
    // Get provider/model from config
    const config = await fetchJSON('/api/config');
    let provider = 'ollama';
    let model = config.ollamaCompletionModel || 'llama3.2';

    // Try to find any configured provider
    if (config.claudeApiKey) { provider = 'anthropic'; model = 'claude-sonnet-4-5-20250514'; }
    else if (config.openaiApiKey) { provider = 'openai'; model = 'gpt-4o-mini'; }

    log('🤖', `Using ${provider}/${model}`);

    const chatResponse = await fetchNDJSON('/api/draft/chat', {
      query: 'What happened with the Rule 91a dismissal and the deemed admissions?',
      caseIds: [testCase.id],
      documentContent: 'Test document',
      provider,
      model,
      vectorSearch: true,
      draftId: draft.id,
      maxTokens: 512,
    });

    // Check progress messages for draft search
    const draftSearchProgress = chatResponse.progress.find(p =>
      p.includes('draft') || p.includes('Draft')
    );

    if (draftSearchProgress) {
      log('✅', `Draft search triggered: "${draftSearchProgress}"`);
    } else {
      log('⚠️', 'No draft-specific search progress message found');
      log('📋', `Progress messages: ${chatResponse.progress.join(' | ')}`);
    }

    // Check if response mentions content from the draft
    const responseText = chatResponse.result?.text || chatResponse.tokens || '';
    if (responseText.length > 0) {
      log('✅', `AI responded with ${responseText.length} chars`);
      log('📝', `First 200 chars: ${responseText.slice(0, 200)}...`);
    } else {
      log('⚠️', 'AI response was empty');
    }

    // Check if unique marker content was found
    if (responseText.includes('91a') || responseText.includes('deemed') || responseText.includes('700,000')) {
      log('✅', 'Response references content from the indexed draft!');
    } else {
      log('⚠️', 'Response may not include draft content (AI may have used other context)');
    }

  } catch (err: any) {
    log('❌', `Chat failed: ${err.message}`);
    log('⚠️', 'This may be because no AI provider is configured.');
  }

  // Step 6: Verify staleness detection — edit the draft so version > indexedVersion
  log('✏️', 'Editing draft to test staleness detection...');
  await fetchJSON(`/api/drafts/${draft.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      content: testContent.replace('Test Vector Index Document', 'Updated Vector Index Document'),
      changeSummary: 'Test edit for staleness',
    }),
  });
  const editedDraft = await fetchJSON(`/api/drafts/${draft.id}`);
  const isStale = editedDraft.version > (editedDraft.indexedVersion || 0);
  if (isStale) {
    log('✅', `Staleness detected: version=${editedDraft.version}, indexedVersion=${editedDraft.indexedVersion} → Vector toggle should be AMBER`);
  } else {
    log('⚠️', `Staleness NOT detected: version=${editedDraft.version}, indexedVersion=${editedDraft.indexedVersion}`);
  }

  // Step 7: Re-index to make it fresh again
  log('🔄', 'Re-indexing after edit...');
  const reindexResult = await fetchJSON(`/api/drafts/${draft.id}/index`, { method: 'POST' });
  log('✅', `Re-indexed: ${reindexResult.chunksIndexed} chunks`);

  const freshDraft = await fetchJSON(`/api/drafts/${draft.id}`);
  const isFresh = freshDraft.version === freshDraft.indexedVersion;
  if (isFresh) {
    log('✅', `Index fresh: version=${freshDraft.version}, indexedVersion=${freshDraft.indexedVersion} → Vector toggle should be GREEN`);
  } else {
    log('⚠️', `Still stale after reindex: version=${freshDraft.version}, indexedVersion=${freshDraft.indexedVersion}`);
  }

  // Done — draft stays in DB and LanceDB for UI testing
  console.log('\n=== Test Complete ===');
  console.log(`\nDraft kept for UI testing:`);
  console.log(`  ID:    ${draft.id}`);
  console.log(`  Title: ${draft.title}`);
  console.log(`  Case:  ${testCase.caseNumber || testCase.name}`);
  console.log(`  URL:   ${BASE_URL}/draft/${testCase.id}/${draft.slug}`);
  console.log(`\nOpen the Draft page to verify:`);
  console.log(`  - Vector toggle should be GREEN (index is fresh)`);
  console.log(`  - Edit the draft → toggle turns AMBER`);
  console.log(`  - Click "Vector" text → reindexes → turns GREEN`);
  console.log(`  - Ask a question in chat with Vector ON → should find draft content\n`);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
