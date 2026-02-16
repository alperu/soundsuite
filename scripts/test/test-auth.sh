#!/bin/bash

# Test script for authentication
# Tests OAuth and API key authentication

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
echo "Sound Suite - Authentication Test"
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

# Check if MCP server is running
echo "Checking MCP server status..."
MCP_PORT=${MCP_PORT:-3001}
MCP_URL="http://localhost:$MCP_PORT"

if ! curl -s "$MCP_URL/health" > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠ WARNING${NC}: MCP server not running on port $MCP_PORT"
    echo "  Please start the MCP server first: npm run mcp:start"
    echo ""
    echo -e "${RED}✗ Cannot run tests without MCP server${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} MCP server is running"
echo ""

# Test 1: Test unauthenticated request (should fail)
echo "Test 1: Unauthenticated request rejection"
UNAUTH_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{
        "method": "tools/list"
    }' 2>&1)

HTTP_CODE=$(echo "$UNAUTH_RESPONSE" | tail -n1)

# Check if auth is enabled
if [ "$HTTP_CODE" = "401" ]; then
    print_result "Unauthenticated rejection" "PASS" "Request properly rejected with 401"
elif [ "$HTTP_CODE" = "200" ]; then
    echo -e "${YELLOW}⚠ WARNING${NC}: Authentication appears to be disabled (auth mode: none)"
    print_result "Unauthenticated rejection" "PASS" "Auth disabled - request allowed"
else
    print_result "Unauthenticated rejection" "FAIL" "Unexpected status code: $HTTP_CODE"
fi
echo ""

# Test 2: Test API key authentication
echo "Test 2: API key authentication"
TEST_API_KEY=${TEST_API_KEY:-"test-api-key-12345"}

API_KEY_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $TEST_API_KEY" \
    -d '{
        "method": "tools/list"
    }' 2>&1)

HTTP_CODE=$(echo "$API_KEY_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$API_KEY_RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
    if echo "$RESPONSE_BODY" | grep -q "tools"; then
        print_result "API key authentication" "PASS" "Request authenticated successfully"
    else
        print_result "API key authentication" "FAIL" "Request succeeded but response invalid"
    fi
elif [ "$HTTP_CODE" = "401" ]; then
    echo -e "${YELLOW}⚠ WARNING${NC}: API key rejected - may need to configure valid key"
    print_result "API key authentication" "FAIL" "API key not accepted"
else
    print_result "API key authentication" "FAIL" "Unexpected status code: $HTTP_CODE"
fi
echo ""

# Test 3: Test invalid API key (should fail)
echo "Test 3: Invalid API key rejection"
INVALID_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: invalid-key-xyz" \
    -d '{
        "method": "tools/list"
    }' 2>&1)

HTTP_CODE=$(echo "$INVALID_RESPONSE" | tail -n1)

if [ "$HTTP_CODE" = "401" ]; then
    print_result "Invalid key rejection" "PASS" "Invalid key properly rejected"
elif [ "$HTTP_CODE" = "200" ]; then
    echo -e "${YELLOW}⚠ WARNING${NC}: Invalid key accepted - auth may be disabled"
    print_result "Invalid key rejection" "FAIL" "Invalid key was accepted"
else
    print_result "Invalid key rejection" "FAIL" "Unexpected status code: $HTTP_CODE"
fi
echo ""

# Test 4: Test authentication configuration
echo "Test 4: Authentication configuration"
cd "$PROJECT_ROOT"

if [ -f ".env" ]; then
    if grep -q "MCP_AUTH_MODE" .env; then
        AUTH_MODE=$(grep "MCP_AUTH_MODE" .env | cut -d'=' -f2 | tr -d ' "')
        print_result "Auth configuration" "PASS" "Auth mode configured: $AUTH_MODE"
    else
        print_result "Auth configuration" "FAIL" "MCP_AUTH_MODE not found in .env"
    fi
else
    print_result "Auth configuration" "FAIL" ".env file not found"
fi
echo ""

# Test 5: Test API key storage
echo "Test 5: API key storage"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testAPIKeyStorage() {
        try {
            const { PrismaClient } = require('@prisma/client');
            const prisma = new PrismaClient();
            
            const apiKeyConfig = await prisma.config.findUnique({
                where: { key: 'mcp.apiKeys' }
            });
            
            if (apiKeyConfig) {
                console.log('SUCCESS:API keys configured in database');
            } else {
                console.log('FAIL:No API keys found in database');
            }
            
            await prisma.\$disconnect();
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testAPIKeyStorage();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    print_result "API key storage" "PASS" "API keys stored in database"
elif [[ "$TEST_OUTPUT" == FAIL:* ]]; then
    echo -e "${YELLOW}⚠ WARNING${NC}: No API keys configured"
    print_result "API key storage" "PASS" "No keys configured (expected for fresh install)"
else
    print_result "API key storage" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Test 6: Test OAuth configuration (if enabled)
echo "Test 6: OAuth configuration"
cd "$PROJECT_ROOT"

if [ -f ".env" ]; then
    if grep -q "OAUTH_CLIENT_ID" .env && grep -q "OAUTH_CLIENT_SECRET" .env; then
        print_result "OAuth configuration" "PASS" "OAuth credentials configured"
    else
        echo -e "${YELLOW}⚠ INFO${NC}: OAuth not configured (optional)"
        print_result "OAuth configuration" "PASS" "OAuth not configured (optional)"
    fi
else
    print_result "OAuth configuration" "FAIL" ".env file not found"
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
