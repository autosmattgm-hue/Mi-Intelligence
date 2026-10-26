# MI — start the trading server on Windows
$ErrorActionPreference = 'Continue'
$projectRoot = $PSScriptRoot
Set-Location $projectRoot

Write-Host '🚀 Starting MI — Master Intelligence Trading Suite...'

# Start the server in a hidden window, log to server.log
$p = Start-Process -FilePath 'node.exe' -ArgumentList 'server/index.js' -WorkingDirectory $projectRoot -RedirectStandardOutput (Join-Path $projectRoot 'server.log') -RedirectStandardError (Join-Path $projectRoot 'server.err.log') -PassThru -WindowStyle Hidden
$p.Id | Set-Content '.server.pid' -Encoding UTF8

Write-Host "Started (PID $($p.Id))."
Write-Host "Open http://localhost:3009 in your browser."
Write-Host ""
Write-Host "To stop:  .\stop.ps1"
Start-Sleep -Seconds 2
Get-Content (Join-Path $projectRoot 'server.log') -Tail 8
