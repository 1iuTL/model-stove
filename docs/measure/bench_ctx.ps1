$ErrorActionPreference = 'Continue'
$exe   = 'C:\deepseek harness\models\llama-cpp\llama-server.exe'
$model = 'F:\models-archive\Bonsai-27B-Q1_0.gguf'
$out   = 'C:\deepseek harness\_ctx_audit\bench.log'
Set-Content -Path $out -Value "Bonsai 27B Q1_0 / q4_0 KV / fa on / np 1" -Encoding UTF8

function Run-One([int]$ctx, [string]$kvk, [string]$kvv) {
  $args = @('-m',$model,'-c',"$ctx",'-ngl','99','-fa','on','-np','1',
            '-ctk',$kvk,'-ctv',$kvv,'--port','8097')
  $p = Start-Process -FilePath $exe -ArgumentList $args -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput 'C:\deepseek harness\_ctx_audit\srv.out' `
        -RedirectStandardError  'C:\deepseek harness\_ctx_audit\srv.err'
  $ok = $false
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) { break }
    try { Invoke-RestMethod 'http://127.0.0.1:8097/health' -TimeoutSec 3 | Out-Null; $ok = $true; break } catch {}
  }
  $vram = (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''
  $tag  = "ctx=$ctx k=$kvk/v=$kvv"
  if ($ok) {
    $body = @{ prompt = 'The ocean is vast and deep.'; n_predict = 64; stream = $false; cache_prompt = $false } | ConvertTo-Json -Compress
    try {
      $r = Invoke-RestMethod 'http://127.0.0.1:8097/completion' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 600
      $tg = [math]::Round([double]$r.timings.predicted_per_second, 2)
      $pp = [math]::Round([double]$r.timings.prompt_per_second, 2)
      $peak = (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''
      "$tag  OK  tg=${tg} tok/s  pp=${pp} tok/s  vram_after=${vram}MiB  peak=${peak}MiB" | Add-Content $out
    } catch { "$tag  GEN-ERROR  $($_.Exception.Message)  vram=${vram}MiB" | Add-Content $out }
  } else {
    "$tag  LOAD-FAILED  vram=${vram}MiB" | Add-Content $out
  }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 6
  Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

foreach ($c in 32768, 65536, 98304, 131072) { Run-One $c 'q4_0' 'q4_0' }
foreach ($c in 65536, 131072)               { Run-One $c 'q8_0' 'q8_0' }
"=== DONE ===" | Add-Content $out
