# One-shot pipeline: normalize -> enrich -> oa_route -> dispatch -> verify.
# Edge launch and every node call happen inside this single script, so the
# "launch Edge -> poll port -> run node" constraint is satisfied automatically.
#
# Usage:
#   .\run_batch.ps1 -Out D:\lib\my-topic -Items dois.txt
#   .\run_batch.ps1 -Out D:\lib\my-topic -Items items.json -Retry
#   .\run_batch.ps1 -Out D:\lib\my-topic -Items items.json -NoEdge -SkipVerify
#   .\run_batch.ps1 -Out D:\lib\my-topic -Items items.json -Dry
#   .\run_batch.ps1 -Out D:\lib\my-topic -Items items.json -Reuse -Retry
#   .\run_batch.ps1 -Out D:\lib\my-topic -Items items.json -Kb <ima knowledge base id>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Items,
  [int]$Port = 9223,
  [string]$Profile = "",
  [string]$Email = "",
  [switch]$NoEdge,
  [switch]$Retry,
  [switch]$SkipVerify,
  [switch]$Dry,
  [switch]$Reuse,
  [string]$Kb = $env:IMA_KB_ID,
  [switch]$SkipIma
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
if (-not $Profile) { $Profile = Join-Path (Get-Location).Path "_edgeprofile" }
if ($Email) { $env:UNPAYWALL_EMAIL = $Email }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# -Dry is a preview run: no Edge, no download, no verify.
$useEdge = (-not $NoEdge) -and (-not $Dry)

# Preflight: fail fast with a clear reason instead of dying halfway through.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "preflight failed: node not found in PATH"
  exit 2
}
if (-not $SkipVerify -and -not $Dry) {
  $pyok = $false
  try {
    $null = & python -c "import fitz" 2>&1
    $pyok = ($LASTEXITCODE -eq 0)
  } catch { $pyok = $false }
  if (-not $pyok) {
    Write-Host "preflight failed: python or PyMuPDF missing (fix: pip install pymupdf)"
    exit 2
  }
}

function Test-Port {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if ($useEdge -and -not (Test-Port)) {
  $edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
  if (-not (Test-Path $edge)) {
    Write-Host "preflight failed: Edge not found (tried both Program Files paths)"
    exit 2
  }
  Write-Host "[1/7] starting Edge on port $Port (profile: $Profile)"
  Start-Process $edge -ArgumentList "--remote-debugging-port=$Port", "--user-data-dir=$Profile", "--no-first-run", "--no-default-browser-check", "about:blank"
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-Port) { break }
    Start-Sleep -Milliseconds 500
  }
}
if ($useEdge -and -not (Test-Port)) { throw "Edge debug port $Port not ready" }
if (-not $useEdge) { Write-Host "[1/7] Edge skipped" }

$norm = Join-Path $Out "_items_norm.json"
$enr = Join-Path $Out "_items_enriched.json"

# -Reuse: keep the enriched pool from the previous run (no normalize / enrich).
# Handy after fixing download failures: re-run only oa_route + dispatch.
$reuse = $Reuse -and (Test-Path $enr)
if ($reuse) {
  Write-Host "[2/7] normalize skipped (-Reuse)"
  Write-Host "[3/7] enrich_meta skipped (-Reuse, reusing $enr)"
} else {
  Write-Host "[2/7] normalize"
  $nargs = @((Join-Path $here "normalize.mjs"), $Items, $norm)
  if ($useEdge) { $nargs += @("--port", "$Port") }
  & node @nargs
  if ($LASTEXITCODE -ne 0) { Write-Host "normalize failed"; exit 1 }

  Write-Host "[3/7] enrich_meta"
  & node (Join-Path $here "enrich_meta.mjs") $norm $enr
  if ($LASTEXITCODE -ne 0) { Write-Host "enrich_meta failed"; exit 1 }
}

Write-Host "[4/7] oa_route"
& node (Join-Path $here "oa_route.mjs") $Out $enr $Email
if ($LASTEXITCODE -ne 0) { Write-Host "oa_route failed"; exit 1 }

$dcode = 0
if ($Dry) {
  Write-Host "[5/7] dispatch preview (-Dry)"
  & node (Join-Path $here "dispatch.mjs") "$Port" $Out --dry
  $dcode = $LASTEXITCODE
} elseif (-not $NoEdge) {
  Write-Host "[5/7] dispatch"
  $dargs = @((Join-Path $here "dispatch.mjs"), "$Port", $Out)
  if ($Retry) { $dargs += "--retry-failed" }
  & node @dargs
  $dcode = $LASTEXITCODE
} else {
  Write-Host "[5/7] dispatch skipped (-NoEdge)"
}

$vcode = 0
if ($SkipVerify -or $Dry) {
  Write-Host "[6/7] verify skipped"
} else {
  Write-Host "[6/7] verify"
  & python (Join-Path $here "verify_pdf.py") $Out --meta (Join-Path $Out "meta.json")
  $vcode = $LASTEXITCODE
}

# [7/7] Optional IMA mirror. Off by default: needs -Kb <id> (or IMA_KB_ID) plus
# an installed ima-skill. Upload failures never change the download exit code.
if ($Dry) {
  Write-Host "[7/7] ima skipped (-Dry)"
} elseif ($SkipIma) {
  Write-Host "[7/7] ima skipped (-SkipIma)"
} elseif ($SkipVerify) {
  Write-Host "[7/7] ima skipped (-SkipVerify: nothing is verified yet)"
} elseif (-not $Kb) {
  $imaSkill = Join-Path $env:USERPROFILE ".trae-cn\skills\ima-skill\ima_api.cjs"
  if (-not (Test-Path $imaSkill)) { $imaSkill = Join-Path $env:USERPROFILE ".workbuddy\skills\ima-skill\ima_api.cjs" }
  if (Test-Path $imaSkill) {
    Write-Host "[7/7] ima skipped (ima-skill detected; pass -Kb <id> to mirror verified PDFs)"
  } else {
    Write-Host "[7/7] ima skipped (no -Kb)"
  }
} else {
  Write-Host "[7/7] ima upload -> kb $Kb"
  & node (Join-Path $here "upload_ima.mjs") $Out --kb "$Kb"
  if ($LASTEXITCODE -ne 0) { Write-Host "WARN ima upload reported failures (PDFs are still on disk)" }
}

$failFile = Join-Path $Out "_failed.json"
if (Test-Path $failFile) {
  $raw = [System.IO.File]::ReadAllText($failFile, [System.Text.Encoding]::UTF8)
  # PS5.1: @() around "ConvertFrom-Json" collapses a JSON array into ONE element,
  # so convert first and only wrap when the result is not an array.
  $list = $raw | ConvertFrom-Json
  if ($list -isnot [array]) { $list = @($list) }
  if ($list.Count -gt 0) { Write-Host "failures recorded: $($list.Count) (see $failFile)" }
}

# With -NoEdge there is no browser channel to take over, so every pending-browser
# entry is a final failure and must affect the exit code. -Dry is a preview and
# always exits 0 (nothing was downloaded, so "pending" is expected).
$missing = 0
$repFile = Join-Path $Out "_oa_report.json"
if ($NoEdge -and -not $Dry -and (Test-Path $repFile)) {
  $rawRep = [System.IO.File]::ReadAllText($repFile, [System.Text.Encoding]::UTF8)
  $rep = $rawRep | ConvertFrom-Json
  if ($rep -isnot [array]) { $rep = @($rep) }
  $missing = @($rep | Where-Object { $_.status -eq 'pending-browser' }).Count
}
if ($missing -gt 0) { Write-Host "unresolved: $missing pending-browser (no browser channel with -NoEdge, see $repFile)" }

if ($Dry) { Write-Host "dry run done: $Out"; exit 0 }
if ($dcode -ne 0 -or $vcode -ne 0 -or $missing -gt 0) { exit 1 }
Write-Host "done: $Out"
exit 0
