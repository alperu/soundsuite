#!/bin/bash

###############################################################################
# Sound Suite - Stop Script
# 
# This script gracefully stops all Sound Suite services:
# 1. Reads PIDs from .pids directory
# 2. Sends SIGTERM to each process for graceful shutdown
# 3. Waits for processes to stop (with timeout)
# 4. Sends SIGKILL if processes don't stop gracefully
# 5. Cleans up PID files and temporary files
# 6. Displays shutdown status
# 
# Requirements: All
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PID_DIR="$PROJECT_ROOT/.pids"
LOG_DIR="$PROJECT_ROOT/logs"

# Function to print colored messages
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

# Function to stop a service gracefully
stop_service() {
    local service_name=$1
    local pid_file=$2
    local timeout=${3:-10}  # Default 10 second timeout
    
    if [ ! -f "$pid_file" ]; then
        print_warning "$service_name: No PID file found"
        return 0
    fi
    
    local pid=$(cat "$pid_file")
    
    if [ -z "$pid" ]; then
        print_warning "$service_name: PID file is empty"
        rm -f "$pid_file"
        return 0
    fi
    
    if ! is_running "$pid"; then
        print_warning "$service_name: Process not running (PID: $pid)"
        rm -f "$pid_file"
        return 0
    fi
    
    print_info "$service_name: Stopping process (PID: $pid)..."
    
    # Send SIGTERM for graceful shutdown
    kill -TERM "$pid" 2>/dev/null || {
        print_error "$service_name: Failed to send SIGTERM"
        rm -f "$pid_file"
        return 1
    }
    
    # Wait for process to stop
    local count=0
    while is_running "$pid" && [ $count -lt $timeout ]; do
        sleep 1
        count=$((count + 1))
    done
    
    # Check if process stopped
    if is_running "$pid"; then
        print_warning "$service_name: Process did not stop gracefully, sending SIGKILL..."
        kill -KILL "$pid" 2>/dev/null || true
        sleep 1
        
        if is_running "$pid"; then
            print_error "$service_name: Failed to stop process"
            return 1
        fi
    fi
    
    print_success "$service_name: Stopped successfully"
    rm -f "$pid_file"
    return 0
}

print_info "Stopping Sound Suite services..."
echo ""

###############################################################################
# Step 1: Check if services are running
###############################################################################

print_info "Step 1: Checking for running services..."

if [ ! -d "$PID_DIR" ]; then
    print_warning "PID directory not found at $PID_DIR"
    print_info "No services appear to be running"
    exit 0
fi

# Count running services (includes dynamically-created worker PID files)
RUNNING_COUNT=0
SERVICES=("dashboard" "mcp-server" "job-queue" "file-watcher")

for service in "${SERVICES[@]}"; do
    pid_file="$PID_DIR/$service.pid"
    if [ -f "$pid_file" ]; then
        pid=$(cat "$pid_file")
        if is_running "$pid"; then
            RUNNING_COUNT=$((RUNNING_COUNT + 1))
        fi
    fi
done

# Also count worker-* PID files (created by ParsingWorkerManager)
for pid_file in "$PID_DIR"/worker-*.pid; do
    [ -f "$pid_file" ] || continue
    pid=$(cat "$pid_file")
    if is_running "$pid"; then
        RUNNING_COUNT=$((RUNNING_COUNT + 1))
    fi
done

if [ $RUNNING_COUNT -eq 0 ]; then
    print_warning "No running services found"
    print_info "Cleaning up PID directory..."
    rm -rf "$PID_DIR"
    print_success "Cleanup complete"
    exit 0
fi

print_success "Found $RUNNING_COUNT running service(s)"
echo ""

###############################################################################
# Step 2: Stop services in reverse order
###############################################################################

print_info "Step 2: Stopping services..."
echo ""

# Stop services in reverse order of startup
# Dashboard first (frontend), then backend services

STOP_SUCCESS=true

# Stop dashboard
if ! stop_service "Dashboard" "$PID_DIR/dashboard.pid" 15; then
    STOP_SUCCESS=false
fi

# Stop MCP server (if running as separate process)
if ! stop_service "MCP Server" "$PID_DIR/mcp-server.pid" 10; then
    STOP_SUCCESS=false
fi

# Stop job queue (if running as separate process)
if ! stop_service "Job Queue" "$PID_DIR/job-queue.pid" 10; then
    STOP_SUCCESS=false
fi

# Stop file watcher (if running as separate process)
if ! stop_service "File Watcher" "$PID_DIR/file-watcher.pid" 10; then
    STOP_SUCCESS=false
fi

# Stop worker pool workers (PID files created by ParsingWorkerManager)
for pid_file in "$PID_DIR"/worker-*.pid; do
    [ -f "$pid_file" ] || continue
    worker_name=$(basename "$pid_file" .pid)
    if ! stop_service "Worker ($worker_name)" "$pid_file" 5; then
        STOP_SUCCESS=false
    fi
done

echo ""

###############################################################################
# Step 3: Clean up temporary files
###############################################################################

print_info "Step 3: Cleaning up temporary files..."

# Remove PID directory
if [ -d "$PID_DIR" ]; then
    rm -rf "$PID_DIR"
    print_success "Removed PID directory"
fi

# Clean up any stale lock files
if [ -f "$PROJECT_ROOT/.next/cache/lock" ]; then
    rm -f "$PROJECT_ROOT/.next/cache/lock"
    print_success "Removed Next.js cache lock"
fi

# Note: We don't remove log files as they may be useful for debugging
print_info "Log files preserved at: $LOG_DIR"

echo ""

###############################################################################
# Step 4: Display shutdown status
###############################################################################

print_info "Step 4: Displaying shutdown status..."
echo ""

if [ "$STOP_SUCCESS" = true ]; then
    print_success "═══════════════════════════════════════════════════════════"
    print_success "  Sound Suite Stopped Successfully!"
    print_success "═══════════════════════════════════════════════════════════"
    echo ""
    print_info "All services have been stopped and cleaned up"
    echo ""
    print_info "To start services again:"
    echo "  ./scripts/start.sh"
    echo ""
    exit 0
else
    print_error "═══════════════════════════════════════════════════════════"
    print_error "  Some Services Failed to Stop"
    print_error "═══════════════════════════════════════════════════════════"
    echo ""
    print_warning "Some services may still be running"
    print_info "Check running processes:"
    echo "  ps aux | grep -E 'node|next'"
    echo ""
    print_info "Force kill if needed:"
    echo "  pkill -9 -f 'next-server'"
    echo ""
    exit 1
fi
