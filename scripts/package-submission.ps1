[CmdletBinding()]
param(
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$submission = [System.IO.Path]::GetFullPath((Join-Path $workspace 'submission'))
$staging = [System.IO.Path]::GetFullPath((Join-Path $submission '_staging'))
$packageRoot = Join-Path $staging 'sau-presence-guard'
$archive = Join-Path $submission 'sau-presence-guard-submission.zip'

function Get-WorkspaceRelativePath([string]$Path) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if (-not $fullPath.StartsWith($workspace + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escaped the workspace: $fullPath"
  }
  return $fullPath.Substring($workspace.Length).TrimStart([char[]]'\/')
}

if (-not $submission.StartsWith($workspace + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Submission path escaped the workspace.'
}
if (-not $staging.StartsWith($submission + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Staging path escaped the submission directory.'
}

Push-Location $workspace
try {
  if (-not $SkipChecks) {
    npm run check
    if ($LASTEXITCODE -ne 0) { throw 'npm run check failed.' }
    npm audit --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'npm production audit failed.' }
  }

  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

  $excludedDirectories = @('.git', '.vercel', 'tmp', 'node_modules', 'dist', 'data', 'submission', '.dart_tool', 'build', '.idea', '.vscode')
  $excludedFiles = @('.env*', '*.sqlite', '*.sqlite-shm', '*.sqlite-wal', '*.jks', '*.p12', '*.mobileprovision', '*service-account*.json')

  $files = Get-ChildItem -LiteralPath $workspace -Recurse -File | Where-Object {
    $relative = Get-WorkspaceRelativePath $_.FullName
    $segments = $relative -split '[\\/]'
    $directoryBlocked = $segments | Where-Object { $excludedDirectories -contains $_ }
    $fileBlocked = $false
    foreach ($pattern in $excludedFiles) {
      if ($_.Name -like $pattern) { $fileBlocked = $true; break }
    }
    -not $directoryBlocked -and -not $fileBlocked
  }

  foreach ($file in $files) {
    $relative = Get-WorkspaceRelativePath $file.FullName
    $target = Join-Path $packageRoot $relative
    $targetDirectory = Split-Path -Parent $target
    New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target
  }

  Copy-Item -LiteralPath (Join-Path $submission 'README_FIRST.md') -Destination (Join-Path $packageRoot 'README_FIRST.md')
  Compress-Archive -LiteralPath $packageRoot -DestinationPath $archive -CompressionLevel Optimal

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $entries = @($zip.Entries | ForEach-Object { $_.FullName -replace '\\', '/' })
    $blocked = @($entries | Where-Object {
      $_ -match '(^|/)(node_modules|dist|data|\.git|submission)(/|$)' -or
      $_ -match '(^|/)\.env' -or
      $_ -match '\.(sqlite|sqlite-shm|sqlite-wal|jks|p12|mobileprovision)$'
    })
    if ($blocked.Count -gt 0) { throw "Blocked files entered the archive: $($blocked -join ', ')" }
    $required = @(
      'sau-presence-guard/README.md',
      'sau-presence-guard/docs/TZ_COMPLIANCE.md',
      'sau-presence-guard/docs/openapi.yaml',
      'sau-presence-guard/backend/src/app.ts',
      'sau-presence-guard/mobile/lib/sau_presence_guard.dart'
    )
    $missing = @($required | Where-Object { $entries -notcontains $_ })
    if ($missing.Count -gt 0) { throw "Required files are missing from the archive: $($missing -join ', ')" }
  } finally {
    $zip.Dispose()
  }

  $sizeMb = [math]::Round((Get-Item -LiteralPath $archive).Length / 1MB, 2)
  Write-Host "Created and verified: $archive ($sizeMb MB)"
} finally {
  Pop-Location
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
