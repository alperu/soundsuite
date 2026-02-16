#!/bin/bash

###############################################################################
# Sound Suite - Health Check Script
# 
# This script checks the health of all Sound Suite services:
# 1. Checks if FileWatcher is running
# 2. Checks if JobQueue is running
# 3. Checks if MCP Server is running
# 4. Checks if Dashboard is running
# 5. Checks database connectivity
# 6. Checks LanceDB accessibility
# 7. Displays service status with color-coded output
# 8. Returns exit code 0 if healthy, 1 if any service down
# 
# Requirements: 19.5
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Symbols
CHECK_MARK="✓"
CROSS_MARK="✗"
WARNING_MARK="⚠"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PID_DIR="$PROJECT_ROOT/.pids"

# Health status tracking
ALL_HEALTHY=true
CRITICAL_FAILURE=false

# Function to print colored messages
print_header() {
    echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
}

print_service_status() {
    local service_name=$1
    local status=$2
    local message=$3
    
    case $status in
        "running")
            echo -e "${GREEN}${CHECK_MARK} ${service_name}${NC}: Running"
            [ -n "$message" ] && echo -e "  ${message}"
            ;;
        "stopped")
            echo -e "${YELLOW}${WARNING_MARK} ${service_name}${NC}: Stopped"
            [ -n "$message" ] && echo -e "  ${message}"
            ALL_HEALTHY=false
            ;;
        "error")
            echo -e "${RED}${CROSS_MARK} ${service_name}${NC}: Error"
            [ -n "$message" ] && echo -e "  ${message}"
            ALL_HEALTHY=false
            CRITICAL_FAILURE=true
            ;;
        "unknown")
            echo -e "${YELLOW}${WARNING_MARK} ${service_name}${NC}: Unknown"
            [ -n "$message" ] && echo -e "  ${message}"
            ALL_HEALTHY=false
            ;;
    esac
}

print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if a process is running
is_running() {
    local pid=$1
    if [ -z "$pid" ]; then
        return 1
    fi
    kill -0 "$pid" 2>/dev/null
    return $?
}

# Function to check PID-based service
check_pid_service() {
    local service_name=$1
    local pid_file=$2
    
    if [ ! -f "$pid_file" ]; then
        print_service_status "$service_name" "stopped" "PID file not found"
        return 1
    fi
    
    local pid=$(cat "$pid_file")
    
    if [ -z "$pid" ]; then
        print_service_status "$service_name" "error" "PID file is empty"
        return 1
    fi
    
    if is_running "$pid"; then
        print_service_status "$service_name" "running" "PID: $pid"
        return 0
    else
        print_service_status "$service_name" "stopped" "Process not running (stale PID: $pid)"
        return 1
    fi
}

###############################################################################
# Main Health Check
###############################################################################

print_header "Sound Suite Health Check"
echo ""
print_info "Checking system health at $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

###############################################################################
# Check 1: Dashboard (Next.js)
###############################################################################

echo -e "${BLUE}━━━ Dashboard Service ━━━${NC}"

if [ -f "$PID_DIR/dashboard.pid" ]; then
    check_pid_service "Dashboard" "$PID_DIR/dashboard.pid"
else
    # Dashboard might be running but PID not tracked
    # Try to check via HTTP
    if curl -s -f http://localhost:3000 > /dev/null 2>&1; then
        print_service_status "Dashboard" "running" "Responding on http://localhost:3000"
    else
        print_service_status "Dashboard" "stopped" "Not responding on http://localhost:3000"
    fi
fi

echo ""

###############################################################################
# Check 2: MCP Server
###############################################################################

echo -e "${BLUE}━━━ MCP Server ━━━${NC}"

# Load environment to get MCP port
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    source "$PROJECT_ROOT/.env" 2>/dev/null || true
    set +a
fi

MCP_PORT=${MCP_PORT:-3001}

if [ -f "$PID_DIR/mcp-server.pid" ]; then
    check_pid_service "MCP Server" "$PID_DIR/mcp-server.pid"
else
    # MCP Server is integrated with dashboard, check via HTTP
    if curl -s -f http://localhost:${MCP_PORT}/health > /dev/null 2>&1; then
        print_service_status "MCP Server" "running" "Responding on http://localhost:${MCP_PORT}"
    else
        print_service_status "MCP Server" "unknown" "Not responding on http://localhost:${MCP_PORT} (may be integrated with dashboard)"
    fi
fi

echo ""

###############################################################################
# Check 3: File Watcher
###############################################################################

echo -e "${BLUE}━━━ File Watcher Service ━━━${NC}"

if [ -f "$PID_DIR/file-watcher.pid" ]; then
    check_pid_service "File Watcher" "$PID_DIR/file-watcher.pid"
else
    # File Watcher is integrated with dashboard, check via API
    if curl -s http://localhost:3000/api/health 2>/dev/null | grep -q '"fileWatcher"'; then
        WATCHER_STATUS=$(curl -s http://localhost:3000/api/health 2>/dev/null | grep -o '"fileWatcher":{[^}]*}' | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
        
        if [ "$WATCHER_STATUS" = "running" ]; then
            print_service_status "File Watcher" "running" "Integrated with dashboard"
        elif [ "$WATCHER_STATUS" = "stopped" ]; then
            print_service_status "File Watcher" "stopped" "Service not started"
        elif [ "$WATCHER_STATUS" = "error" ]; then
            print_service_status "File Watcher" "error" "Service encountered an error"
        else
            print_service_status "File Watcher" "unknown" "Status: $WATCHER_STATUS"
        fi
    else
        print_service_status "File Watcher" "unknown" "Cannot determine status (dashboard may be down)"
    fi
fi

echo ""

###############################################################################
# Check 4: Job Queue
###############################################################################

echo -e "${BLUE}━━━ Job Queue Service ━━━${NC}"

if [ -f "$PID_DIR/job-queue.pid" ]; then
    check_pid_service "Job Queue" "$PID_DIR/job-queue.pid"
else
    # Job Queue is integrated with dashboard, check via API
    if curl -s http://localhost:3000/api/health 2>/dev/null | grep -q '"jobQueue"'; then
        QUEUE_STATUS=$(curl -s http://localhost:3000/api/health 2>/dev/null | grep -o '"jobQueue":{[^}]*}' | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
        
        if [ "$QUEUE_STATUS" = "running" ]; then
            # Extract queue details
            QUEUE_LENGTH=$(curl -s http://localhost:3000/api/health 2>/dev/null | grep -o '"queueLength":[0-9]*' | cut -d':' -f2)
            ACTIVE_JOBS=$(curl -s http://localhost:3000/api/health 2>/dev/null | grep -o '"activeJobsCount":[0-9]*' | cut -d':' -f2)
            
            print_service_status "Job Queue" "running" "Queue: $QUEUE_LENGTH pending, $ACTIVE_JOBS active"
        elif [ "$QUEUE_STATUS" = "stopped" ]; then
            print_service_status "Job Queue" "stopped" "Service not started"
        elif [ "$QUEUE_STATUS" = "error" ]; then
            print_service_status "Job Queue" "error" "Service encountered an error"
        else
            print_service_status "Job Queue" "unknown" "Status: $QUEUE_STATUS"
        fi
    else
        print_service_status "Job Queue" "unknown" "Cannot determine status (dashboard may be down)"
    fi
fi

echo ""

###############################################################################
# Check 5: Database Connectivity
###############################################################################

echo -e "${BLUE}━━━ Database (SQLite) ━━━${NC}"

# Check if database file exists
if [ -f "$PROJECT_ROOT/.env" ]; then
    DB_URL=$(grep "DATABASE_URL" "$PROJECT_ROOT/.env" | cut -d'=' -f2 | tr -d ' "' | sed 's/file://')
    DB_PATH="$PROJECT_ROOT/$DB_URL"
    
    if [ -f "$DB_PATH" ]; then
        # Check if database is accessible
        if sqlite3 "$DB_PATH" "SELECT 1;" > /dev/null 2>&1; then
            # Get table counts
            CASE_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM Case;" 2>/dev/null || echo "0")
            DOC_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM Document;" 2>/dev/null || echo "0")
            
            print_service_status "Database" "running" "Path: $DB_PATH | Cases: $CASE_COUNT, Documents: $DOC_COUNT"
        else
            print_service_status "Database" "error" "Database file exists but is not accessible"
        fi
    else
        print_service_status "Database" "error" "Database file not found at $DB_PATH"
    fi
else
    # Try via API
    if curl -s http://localhost:3000/api/health 2>/dev/null | grep -q '"database"'; then
        DB_STATUS=$(curl -s http://localhost:3000/api/health 2>/dev/null | grep -o '"database":{[^}]*}' | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
        
        if [ "$DB_STATUS" = "running" ]; then
            print_service_status "Database" "running" "Connected and operational"
        elif [ "$DB_STATUS" = "error" ]; then
            print_service_status "Database" "error" "Connection failed"
        else
            print_service_status "Database" "unknown" "Status: $DB_STATUS"
        fi
    else
        print_service_status "Database" "unknown" "Cannot determine status"
    fi
fi

echo ""

###############################################################################
# Check 6: LanceDB Accessibility
###############################################################################

echo -e "${BLUE}━━━ Vector Database (LanceDB) ━━━${NC}"

# Check if LanceDB directory exists
if [ -f "$PROJECT_ROOT/.env" ]; then
    LANCE_PATH=$(grep "LANCEDB_PATH" "$PROJECT_ROOT/.env" | cut -d'=' -f2 | tr -d ' "')
    
    if [ -z "$LANCE_PATH" ]; then
        LANCE_PATH="./data/lancedb"
    fi
    
    LANCE_FULL_PATH="$PROJECT_ROOT/$LANCE_PATH"
    
    if [ -d "$LANCE_FULL_PATH" ]; then
        # Check if directory is readable and writable
        if [ -r "$LANCE_FULL_PATH" ] && [ -w "$LANCE_FULL_PATH" ]; then
            # Count tables (subdirectories)
            TABLE_COUNT=$(find "$LANCE_FULL_PATH" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
            DIR_SIZE=$(du -sh "$LANCE_FULL_PATH" 2>/dev/null | cut -f1)
            
            print_service_status "LanceDB" "running" "Path: $LANCE_FULL_PATH | Tables: $TABLE_COUNT, Size: $DIR_SIZE"
        else
            print_service_status "LanceDB" "error" "Directory exists but is not accessible (check permissions)"
        fi
    else
        print_service_status "LanceDB" "stopped" "Directory not found at $LANCE_FULL_PATH (will be created on first use)"
    fi
else
    print_service_status "LanceDB" "unknown" "Cannot determine path (.env not found)"
fi

echo ""

###############################################################################
# Overall Health Summary
###############################################################################

print_header "Health Summary"
echo ""

if [ "$ALL_HEALTHY" = true ]; then
    print_success "All services are healthy!"
    echo ""
    echo -e "${GREEN}System Status: HEALTHY${NC}"
    echo ""
    exit 0
elif [ "$CRITICAL_FAILURE" = true ]; then
    print_error "Critical service failures detected!"
    echo ""
    echo -e "${RED}System Status: UNHEALTHY${NC}"
    echo ""
    print_info "Recommended actions:"
    echo "  1. Check service logs: tail -f $PROJECT_ROOT/logs/dashboard.log"
    echo "  2. Restart services: ./scripts/restart.sh"
    echo "  3. Check database integrity: ./scripts/db/db-migrate.sh"
    echo ""
    exit 1
else
    print_warning "Some services are not running optimally"
    echo ""
    echo -e "${YELLOW}System Status: DEGRADED${NC}"
    echo ""
    print_info "Recommended actions:"
    echo "  1. Start services if not running: ./scripts/start.sh"
    echo "  2. Check service logs: tail -f $PROJECT_ROOT/logs/dashboard.log"
    echo "  3. Restart services if needed: ./scripts/restart.sh"
    echo ""
    exit 1
fi
