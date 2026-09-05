# MI — start the trading server on Windows
$ErrorActionPreference = 'Continue'
Set-Location 'f:\Mi Trading'

Write-Host '🚀 Starting MI — Master Intelligence Trading Suite...'

# Start the server in a hidden window, log to server.log
$p = Start-Process -FilePath 'node.exe' -ArgumentList 'server/index.js' -WorkingDirectory 'f:\Mi Trading' -RedirectStandardOutput 'f:\Mi Trading\server.log' -RedirectStandardError 'f:\Mi Trading\server.err.log' -PassThru -WindowStyle Hidden
$p.Id | Set-Content '.server.pid' -Encoding UTF8

Write-Host "Started (PID $($p.Id))."
Write-Host "Open http://localhost:3009 in your browser."
Write-Host ""
Write-Host "To stop:  .\stop.ps1"
Start-Sleep -Seconds 2
Get-Content 'f:\Mi Trading\server.log' -Tail 8