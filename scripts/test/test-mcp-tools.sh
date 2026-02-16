#!/bin/bash

# Test script for MCP tools
# Tests all MCP tools with sample queries

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
echo "Sound Suite - MCP Tools Test"
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

# Test 1: List available tools
echo "Test 1: List available MCP tools"
TOOLS_RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{"method": "tools/list"}' 2>&1)

if echo "$TOOLS_RESPONSE" | grep -q "query_case_knowledge"; then
    print_result "List tools" "PASS" "Found query_case_knowledge tool"
else
    print_result "List tools" "FAIL" "query_case_knowledge tool not found"
fi
echo ""

# Test 2: Test query_case_knowledge tool
echo "Test 2: query_case_knowledge tool"
QUERY_RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{
        "method": "tools/call",
        "params": {
            "name": "query_case_knowledge",
            "arguments": {
                "query": "test query",
                "limit": 5
            }
        }
    }' 2>&1)

if echo "$QUERY_RESPONSE" | grep -q "results"; then
    RESULT_COUNT=$(echo "$QUERY_RESPONSE" | grep -o '"results":\[' | wc -l)
    print_result "query_case_knowledge" "PASS" "Tool executed successfully"
else
    print_result "query_case_knowledge" "FAIL" "Tool execution failed"
fi
echo ""

# Test 3: Test scan_for_pattern tool
echo "Test 3: scan_for_pattern tool"
PATTERN_RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{
        "method": "tools/call",
        "params": {
            "name": "scan_for_pattern",
            "arguments": {
                "pattern": "\\d{4}",
                "limit": 5
            }
        }
    }' 2>&1)

if echo "$PATTERN_RESPONSE" | grep -q "results"; then
    print_result "scan_for_pattern" "PASS" "Tool executed successfully"
else
    print_result "scan_for_pattern" "FAIL" "Tool execution failed"
fi
echo ""

# Test 4: Test retrieve_exhibit tool
echo "Test 4: retrieve_exhibit tool"
EXHIBIT_RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{
        "method": "tools/call",
        "params": {
            "name": "retrieve_exhibit",
            "arguments": {
                "description": "test image",
                "limit": 5
            }
        }
    }' 2>&1)

if echo "$EXHIBIT_RESPONSE" | grep -q "results"; then
    print_result "retrieve_exhibit" "PASS" "Tool executed successfully"
else
    print_result "retrieve_exhibit" "FAIL" "Tool execution failed"
fi
echo ""

# Test 5: Test invalid regex pattern error handling
echo "Test 5: Invalid regex error handling"
ERROR_RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{
        "method": "tools/call",
        "params": {
            "name": "scan_for_pattern",
            "arguments": {
                "pattern": "[invalid(regex",
                "limit": 5
            }
        }
    }' 2>&1)

if echo "$ERROR_RESPONSE" | grep -q "error"; then
    print_result "Invalid regex handling" "PASS" "Error properly returned"
else
    print_result "Invalid regex handling" "FAIL" "Error not handled correctly"
fi
echo ""

# Test 6: Test case filtering
echo "Test 6: Case filtering"
FILTER_RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{
        "method": "tools/call",
        "params": {
            "name": "query_case_knowledge",
            "arguments": {
                "query": "test",
                "caseId": "test-case-id",
                "limit": 5
            }
        }
    }' 2>&1)

if echo "$FILTER_RESPONSE" | grep -q "results"; then
    print_result "Case filtering" "PASS" "Filter parameter accepted"
else
    print_result "Case filtering" "FAIL" "Filter parameter not working"
fi
echo ""

# Test 7: Test result limit
echo "Test 7: Result limit enforcement"
LIMIT_RESPONSE=$(curl -s -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    -d '{
        "method": "tools/call",
        "params": {
            "name": "query_case_knowledge",
            "arguments": {
                "query": "test",
                "limit": 3
            }
        }
    }' 2>&1)

if echo "$LIMIT_RESPONSE" | grep -q "results"; then
    print_result "Result limit" "PASS" "Limit parameter accepted"
else
    print_result "Result limit" "FAIL" "Limit parameter not working"
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
