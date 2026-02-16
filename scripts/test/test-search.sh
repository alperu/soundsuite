#!/bin/bash

# Test script for search functionality
# Tests semantic and pattern search

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test results
TESTS_PASSED=0
TESTS_FAILED=0

echo "=========================================="
echo "Sound Suite - Search Functionality Test"
echo "=========================================="
echo ""

# Function to print test result
print_result() {
    local test_name="$1"
    local result="$2"
    local message="$3"
    
    if [ "$result" = "PASS" ]; then
        echo -e "${GREEN}✓ PASS${NC}: $test_name"
        [ -n "$message" ] && echo "  → $message"
        ((TESTS_PASSED++))
    else
        echo -e "${RED}✗ FAIL${NC}: $test_name"
        [ -n "$message" ] && echo "  → $message"
        ((TESTS_FAILED++))
    fi
}

# Test 1: Check LanceDB connection
echo "Test 1: LanceDB connectivity"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testLanceDB() {
        try {
            const { VectorStore } = require('./src/lib/vector/vector-store');
            const store = new VectorStore({
                dbPath: './data/lancedb',
                tableName: 'chunks'
            });
            
            await store.initialize();
            console.log('SUCCESS:LanceDB connected');
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testLanceDB();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    print_result "LanceDB connection" "PASS" "Connected successfully"
else
    print_result "LanceDB connection" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Test 2: Test semantic search
echo "Test 2: Semantic search"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testSemanticSearch() {
        try {
            const { VectorStore } = require('./src/lib/vector/vector-store');
            const { TransformersEmbeddingProvider } = require('./src/lib/ingestion/embedding-provider');
            
            const store = new VectorStore({
                dbPath: './data/lancedb',
                tableName: 'chunks'
            });
            await store.initialize();
            
            const provider = new TransformersEmbeddingProvider({ model: 'Xenova/all-MiniLM-L6-v2' });
            const embeddings = await provider.embed(['test query']);
            
            const results = await store.search({
                vector: embeddings[0],
                limit: 5
            });
            
            console.log('SUCCESS:' + results.length + ' results found');
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testSemanticSearch();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    RESULT_COUNT=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
    print_result "Semantic search" "PASS" "Found $RESULT_COUNT results"
else
    print_result "Semantic search" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Test 3: Test pattern search (regex)
echo "Test 3: Pattern search (regex)"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testPatternSearch() {
        try {
            const { VectorStore } = require('./src/lib/vector/vector-store');
            
            const store = new VectorStore({
                dbPath: './data/lancedb',
                tableName: 'chunks'
            });
            await store.initialize();
            
            const results = await store.search({
                hybridQuery: '\\\\d{4}',
                limit: 5
            });
            
            console.log('SUCCESS:' + results.length + ' results found');
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testPatternSearch();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    RESULT_COUNT=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
    print_result "Pattern search" "PASS" "Found $RESULT_COUNT results"
else
    print_result "Pattern search" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Test 4: Test hybrid search (vector + pattern)
echo "Test 4: Hybrid search"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testHybridSearch() {
        try {
            const { VectorStore } = require('./src/lib/vector/vector-store');
            const { TransformersEmbeddingProvider } = require('./src/lib/ingestion/embedding-provider');
            
            const store = new VectorStore({
                dbPath: './data/lancedb',
                tableName: 'chunks'
            });
            await store.initialize();
            
            const provider = new TransformersEmbeddingProvider({ model: 'Xenova/all-MiniLM-L6-v2' });
            const embeddings = await provider.embed(['test query']);
            
            const results = await store.search({
                vector: embeddings[0],
                hybridQuery: 'test',
                limit: 5
            });
            
            console.log('SUCCESS:' + results.length + ' results found');
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testHybridSearch();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    RESULT_COUNT=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
    print_result "Hybrid search" "PASS" "Found $RESULT_COUNT results"
else
    print_result "Hybrid search" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Test 5: Test case filtering in search
echo "Test 5: Case filtering"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testCaseFilter() {
        try {
            const { VectorStore } = require('./src/lib/vector/vector-store');
            const { TransformersEmbeddingProvider } = require('./src/lib/ingestion/embedding-provider');
            
            const store = new VectorStore({
                dbPath: './data/lancedb',
                tableName: 'chunks'
            });
            await store.initialize();
            
            const provider = new TransformersEmbeddingProvider({ model: 'Xenova/all-MiniLM-L6-v2' });
            const embeddings = await provider.embed(['test query']);
            
            const results = await store.search({
                vector: embeddings[0],
                filter: { case_id: 'test-case-id' },
                limit: 5
            });
            
            console.log('SUCCESS:' + results.length + ' results found');
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testCaseFilter();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    RESULT_COUNT=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
    print_result "Case filtering" "PASS" "Filter applied successfully"
else
    print_result "Case filtering" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Test 6: Test result ordering by similarity
echo "Test 6: Result ordering"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testOrdering() {
        try {
            const { VectorStore } = require('./src/lib/vector/vector-store');
            const { TransformersEmbeddingProvider } = require('./src/lib/ingestion/embedding-provider');
            
            const store = new VectorStore({
                dbPath: './data/lancedb',
                tableName: 'chunks'
            });
            await store.initialize();
            
            const provider = new TransformersEmbeddingProvider({ model: 'Xenova/all-MiniLM-L6-v2' });
            const embeddings = await provider.embed(['test query']);
            
            const results = await store.search({
                vector: embeddings[0],
                limit: 10
            });
            
            // Check if results are ordered by score (descending)
            let ordered = true;
            for (let i = 1; i < results.length; i++) {
                if (results[i].score > results[i-1].score) {
                    ordered = false;
                    break;
                }
            }
            
            if (ordered) {
                console.log('SUCCESS:Results properly ordered');
            } else {
                console.log('FAIL:Results not ordered by score');
            }
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testOrdering();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    print_result "Result ordering" "PASS" "Results ordered by similarity score"
else
    print_result "Result ordering" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Summary
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo -e "Tests Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests Failed: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
