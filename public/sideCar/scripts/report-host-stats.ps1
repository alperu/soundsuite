# report-host-stats.ps1 — Sound Suite host-stats companion (Windows)
#
# Docker Desktop on Windows runs Linux containers in a hidden WSL2 VM with
# NO GPU passthrough to those containers — the sidecar cannot see the
# host's NVIDIA card from inside its container. This script runs natively
# on the Windows host, polls nvidia-smi.exe + system perf counters, and
# POSTs the result to the sidecar's /api/host-stats every 10 seconds.
#
# Install as a Scheduled Task that runs at logon (see install-sidecar.md
# Windows section), or run manually for testing:
#
#   powershell -ExecutionPolicy Bypass -File .\report-host-stats.ps1
#
# Compatible with Windows PowerShell 5.1 (built into Windows 10/11). No
# pwsh 7 features required.
#
# Environment overrides (optional):
#   SS_SIDECAR_URL   default http://localhost:8098
#   SS_REPORT_INTERVAL_SECONDS   default 10

$ErrorActionPreference = 'Continue'   # keep looping on individual probe errors
$ScriptVersion         = 'report-host-stats.ps1@1.0'

$SidecarUrl = if ($env:SS_SIDECAR_URL) { $env:SS_SIDECAR_URL } else { 'http://localhost:8098' }
$Interval   = if ($env:SS_REPORT_INTERVAL_SECONDS) { [int]$env:SS_REPORT_INTERVAL_SECONDS } else { 10 }
if ($Interval -lt 5)  { $Interval = 5 }
if ($Interval -gt 60) { $Interval = 60 }

# Resolve nvidia-smi once at startup. Prefer System32 (set by NVIDIA driver
# installer) but fall back to PATH lookup.
function Resolve-NvidiaSmi {
    $candidates = @(
        "$env:SystemRoot\System32\nvidia-smi.exe",
        "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    $cmd = Get-Command 'nvidia-smi.exe' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}
$NvidiaSmi = Resolve-NvidiaSmi
$HasNvidia = $null -ne $NvidiaSmi

Write-Host "[host-stats] sidecar=$SidecarUrl interval=${Interval}s nvidia-smi=$NvidiaSmi"

# Query GPU memory + name per device. Returns array of hashtables matching
# the GpuInfo type expected by /api/host-stats.
function Get-GpuStats {
    if (-not $HasNvidia) { return @() }

    $query = 'index,name,memory.total,memory.used,memory.free,temperature.gpu'
    $raw = & $NvidiaSmi --query-gpu=$query --format=csv,noheader,nounits 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return @() }

    # Per-process attribution (nice-to-have). Columns: gpu_uuid, pid,
    # process_name, used_memory. Map UUID -> index by re-running a tiny query.
    $uuidToIndex = @{}
    $uuidMap = & $NvidiaSmi --query-gpu=index,uuid --format=csv,noheader 2>$null
    if ($LASTEXITCODE -eq 0 -and $uuidMap) {
        foreach ($line in @($uuidMap)) {
            if (-not $line) { continue }
            $parts = $line -split ',\s*'
            if ($parts.Count -ge 2) { $uuidToIndex[$parts[1].Trim()] = [int]$parts[0].Trim() }
        }
    }

    $procsByIndex = @{}
    $procRaw = & $NvidiaSmi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>$null
    if ($LASTEXITCODE -eq 0 -and $procRaw) {
        foreach ($line in @($procRaw)) {
            if (-not $line) { continue }
            $parts = $line -split ',\s*'
            if ($parts.Count -lt 4) { continue }
            $uuid = $parts[0].Trim()
            $idx  = if ($uuidToIndex.ContainsKey($uuid)) { $uuidToIndex[$uuid] } else { 0 }
            if (-not $procsByIndex.ContainsKey($idx)) { $procsByIndex[$idx] = @() }
            $procsByIndex[$idx] += @{
                pid        = [int]$parts[1].Trim()
                name       = $parts[2].Trim()
                usedMemory = [int]$parts[3].Trim()
            }
        }
    }

    $gpus = @()
    foreach ($line in @($raw)) {
        if (-not $line) { continue }
        $parts = $line -split ',\s*'
        if ($parts.Count -lt 6) { continue }
        $idx = [int]$parts[0].Trim()
        $entry = @{
            index       = $idx
            name        = $parts[1].Trim()
            memoryTotal = [int]$parts[2].Trim()
            memoryUsed  = [int]$parts[3].Trim()
            memoryFree  = [int]$parts[4].Trim()
            temperature = [int]$parts[5].Trim()
        }
        if ($procsByIndex.ContainsKey($idx)) { $entry.processes = $procsByIndex[$idx] }
        $gpus += $entry
    }
    return ,$gpus
}

# CPU utilization — short sample via Get-Counter. PowerShell 5.1 friendly.
function Get-CpuStats {
    $percent = 0
    try {
        $sample = Get-Counter -Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop
        if ($sample.CounterSamples.Count -gt 0) {
            $percent = [math]::Round($sample.CounterSamples[0].CookedValue, 1)
        }
    } catch {}

    $cores = [Environment]::ProcessorCount
    $model = ''
    try {
        $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1
        if ($cpu) { $model = $cpu.Name }
    } catch {}

    return @{ percent = $percent; cores = $cores; model = $model }
}

# Physical RAM totals via Win32_OperatingSystem (KB → bytes).
function Get-MemoryStats {
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $totalBytes = [int64]$os.TotalVisibleMemorySize * 1024
        $freeBytes  = [int64]$os.FreePhysicalMemory     * 1024
        $usedBytes  = [math]::Max(0, $totalBytes - $freeBytes)
        return @{ totalBytes = $totalBytes; usedBytes = $usedBytes; freeBytes = $freeBytes }
    } catch {
        return @{ totalBytes = 0; usedBytes = 0; freeBytes = 0 }
    }
}

function Send-HostStats {
    param([hashtable]$Payload)
    $json = $Payload | ConvertTo-Json -Depth 6 -Compress
    try {
        Invoke-RestMethod -Uri "$SidecarUrl/api/host-stats" `
            -Method POST `
            -ContentType 'application/json' `
            -Body $json `
            -TimeoutSec 5 `
            -ErrorAction Stop | Out-Null
        return $true
    } catch {
        Write-Host "[host-stats] POST failed: $($_.Exception.Message)"
        return $false
    }
}

# Main loop. Catches any per-iteration exception so a transient probe error
# never kills the scheduled task.
while ($true) {
    try {
        $payload = @{
            at        = [int64]((Get-Date -UFormat %s) -as [double] * 1000)
            source    = $ScriptVersion
            agent     = "PowerShell $($PSVersionTable.PSVersion)"
            os        = 'win32'
            cpu       = Get-CpuStats
            memory    = Get-MemoryStats
            gpus      = Get-GpuStats
            hasNvidia = $HasNvidia
        }
        Send-HostStats -Payload $payload | Out-Null
    } catch {
        Write-Host "[host-stats] iteration error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $Interval
}
