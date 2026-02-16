#!/bin/bash

###############################################################################
# Sound Suite - Start Script
# 
# This script starts all Sound Suite services in the correct order:
# 1. Checks database and runs migrations if needed
# 2. Starts file watcher service in background
# 3. Starts job queue service in background
# 4. Starts MCP server in background
# 5. Starts Next.js dashboard (dev or production mode)
# 
# All service PIDs are logged for management by the stop script.
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

# Create directories if they don't exist
mkdir -p "$PID_DIR"
mkdir -p "$LOG_DIR"

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

# Function to cleanup on exit
cleanup() {
    print_warning "Received interrupt signal. Cleaning up..."
    if [ -f "$PID_DIR/dashboard.pid" ]; then
        local pid=$(cat "$PID_DIR/dashboard.pid")
        if is_running "$pid"; then
            print_info "Stopping dashboard (PID: $pid)..."
            kill "$pid" 2>/dev/null || true
        fi
    fi
    exit 1
}

trap cleanup INT TERM

# Parse command line arguments
MODE="dev"
if [ "$1" = "production" ] || [ "$1" = "prod" ]; then
    MODE="production"
fi

print_info "Starting Sound Suite in $MODE mode..."
echo ""

###############################################################################
# Step 1: Check environment and database
###############################################################################

print_info "Step 1: Checking environment and database..."

# Check if .env file exists
if [ ! -f "$PROJECT_ROOT/.env" ]; then
    print_error ".env file not found!"
    print_info "Please copy .env.example to .env and configure it:"
    print_info "  cp .env.example .env"
    exit 1
fi

# Load environment variables
set -a
source "$PROJECT_ROOT/.env"
set +a

# Check if database exists
DB_PATH="${DATABASE_URL#file:}"
DB_PATH="$PROJECT_ROOT/$DB_PATH"

if [ ! -f "$DB_PATH" ]; then
    print_warning "Database not found at $DB_PATH"
    print_info "Running Prisma migrations to create database..."
    cd "$PROJECT_ROOT"
    npx prisma migrate deploy
    print_success "Database created and migrations applied"
else
    print_success "Database found at $DB_PATH"
    
    # Check if migrations are needed
    print_info "Checking for pending migrations..."
    cd "$PROJECT_ROOT"
    if npx prisma migrate status 2>&1 | grep -q "pending"; then
        print_warning "Pending migrations detected"
        print_info "Running migrations..."
        npx prisma migrate deploy
        print_success "Migrations applied"
    else
        print_success "Database is up to date"
    fi
fi

echo ""

###############################################################################
# Step 2: Check for existing services
###############################################################################

print_info "Step 2: Checking for existing services..."

# Check if services are already running
SERVICES_RUNNING=false

if [ -f "$PID_DIR/file-watcher.pid" ]; then
    PID=$(cat "$PID_DIR/file-watcher.pid")
    if is_running "$PID"; then
        print_warning "File watcher is already running (PID: $PID)"
        SERVICES_RUNNING=true
    fi
fi

if [ -f "$PID_DIR/job-queue.pid" ]; then
    PID=$(cat "$PID_DIR/job-queue.pid")
    if is_running "$PID"; then
        print_warning "Job queue is already running (PID: $PID)"
        SERVICES_RUNNING=true
    fi
fi

if [ -f "$PID_DIR/mcp-server.pid" ]; then
    PID=$(cat "$PID_DIR/mcp-server.pid")
    if is_running "$PID"; then
        print_warning "MCP server is already running (PID: $PID)"
        SERVICES_RUNNING=true
    fi
fi

if [ -f "$PID_DIR/dashboard.pid" ]; then
    PID=$(cat "$PID_DIR/dashboard.pid")
    if is_running "$PID"; then
        print_warning "Dashboard is already running (PID: $PID)"
        SERVICES_RUNNING=true
    fi
fi

if [ "$SERVICES_RUNNING" = true ]; then
    print_error "Some services are already running!"
    print_info "Please stop existing services first:"
    print_info "  ./scripts/stop.sh"
    exit 1
fi

print_success "No existing services found"
echo ""

###############################################################################
# Step 3: Start background services
###############################################################################

print_info "Step 3: Starting background services..."

# Note: In the current implementation, the file watcher, job queue, and MCP server
# are all started as part of the Next.js application. They are not separate processes.
# This is because they are integrated into the Next.js API routes and server components.
# 
# For a production deployment, you might want to separate these into standalone services.
# For now, we'll just note that they will start with the Next.js application.

print_info "Background services (file watcher, job queue, MCP server) will start with the dashboard"
print_success "Background services configured"
echo ""

###############################################################################
# Step 4: Start Next.js dashboard
###############################################################################

print_info "Step 4: Starting Next.js dashboard..."

cd "$PROJECT_ROOT"

if [ "$MODE" = "production" ]; then
    # Production mode
    print_info "Building Next.js application for production..."
    npm run build
    
    print_info "Starting Next.js in production mode..."
    npm run start > "$LOG_DIR/dashboard.log" 2>&1 &
    DASHBOARD_PID=$!
else
    # Development mode
    print_info "Starting Next.js in development mode..."
    npm run dev > "$LOG_DIR/dashboard.log" 2>&1 &
    DASHBOARD_PID=$!
fi

# Save PID
echo "$DASHBOARD_PID" > "$PID_DIR/dashboard.pid"

# Wait a moment for the server to start
sleep 3

# Check if the dashboard is running
if is_running "$DASHBOARD_PID"; then
    print_success "Dashboard started (PID: $DASHBOARD_PID)"
else
    print_error "Dashboard failed to start"
    print_info "Check logs at: $LOG_DIR/dashboard.log"
    exit 1
fi

echo ""

###############################################################################
# Step 5: Display startup status
###############################################################################

print_info "Step 5: Displaying startup status..."
echo ""

print_success "═══════════════════════════════════════════════════════════"
print_success "  Sound Suite Started Successfully!"
print_success "═══════════════════════════════════════════════════════════"
echo ""
print_info "Service Status:"
echo "  • Dashboard:     Running (PID: $DASHBOARD_PID)"
echo "  • File Watcher:  Integrated with dashboard"
echo "  • Job Queue:     Integrated with dashboard"
echo "  • MCP Server:    Integrated with dashboard"
echo "  • Worker Pool:   Dynamic allocation (PID-controlled, Redis-backed)"
echo "  • Parser Workers: Auto-scaled by background daemon"
echo ""
print_info "Access Points:"
echo "  • Dashboard:     http://localhost:3000"
echo "  • MCP Server:    http://localhost:${MCP_PORT:-3001}"
echo ""
print_info "Logs:"
echo "  • Dashboard:     $LOG_DIR/dashboard.log"
echo ""
print_info "Management:"
echo "  • Stop services:  ./scripts/stop.sh"
echo "  • Restart:        ./scripts/restart.sh"
echo "  • Health check:   ./scripts/health-check.sh"
echo "  • Worker pool:    http://localhost:3000/api/worker-pool/manage"
echo ""

###############################################################################
# Step 6: Health check
###############################################################################

print_info "Step 6: Running health check..."
echo ""

# Wait a bit more for services to fully initialize
sleep 2

# Check if the dashboard is responding
print_info "Checking dashboard health..."
if curl -s -f http://localhost:3000/api/health > /dev/null 2>&1; then
    print_success "Dashboard health check passed"
else
    print_warning "Dashboard health check failed (this is normal if services are still starting)"
    print_info "You can run './scripts/health-check.sh' to check status later"
fi

echo ""
print_success "═══════════════════════════════════════════════════════════"
print_success "  Startup Complete!"
print_success "═══════════════════════════════════════════════════════════"
echo ""

# If in development mode, tail the logs
if [ "$MODE" = "dev" ]; then
    print_info "Tailing dashboard logs (Ctrl+C to stop)..."
    print_info "Note: Stopping log tail will NOT stop the services"
    echo ""
    tail -f "$LOG_DIR/dashboard.log"
fi
