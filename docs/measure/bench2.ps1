$ErrorActionPreference = 'Continue'
$exe  = 'C:\deepseek harness\models\llama-cpp\llama-server.exe'
$out  = 'C:\deepseek harness\_ctx_audit\bench2.log'
Set-Content -Path $out -Value "model | ctx | K/V | tg tok/s | VRAM peak MiB" -Encoding UTF8

function Run-One([string]$model, [string]$label, [int]$ctx, [string]$kvk, [string]$kvv) {
  $a = @('-m',$model,'-c',"$ctx",'-ngl','99','-fa','on','-np','1',
         '-ctk',$kvk,'-ctv',$kvv,'--port','8097')
  $p = Start-Process -FilePath $exe -ArgumentList $a -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput 'C:\deepseek harness\_ctx_audit\s2.out' `
        -RedirectStandardError  'C:\deepseek harness\_ctx_audit\s2.err'
  $ok = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) { break }
    try { Invoke-RestMethod 'http://127.0.0.1:8097/health' -TimeoutSec 3 | Out-Null; $ok = $true; break } catch {}
  }
  $vram = (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''
  $tag = "$label | $ctx | $kvk/$kvv"
  if ($ok) {
    $body = @{ prompt='The ocean is vast.'; n_predict=64; stream=$false; cache_prompt=$false } | ConvertTo-Json -Compress
    try {
      $r = Invoke-RestMethod 'http://127.0.0.1:8097/completion' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 600
      $tg = [math]::Round([double]$r.timings.predicted_per_second, 2)
      $pk = (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''
      "$tag | $tg | $pk" | Add-Content $out
    } catch { "$tag | GEN-ERR $($_.Exception.Message) | $vram" | Add-Content $out }
  } else {
    "$tag | LOAD-FAILED | $vram" | Add-Content $out
  }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 5
  Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4
}

$q1  = 'F:\models-archive\Bonsai-27B-Q1_0.gguf'
$ter = 'F:\models-archive\Ternary-Bonsai-2-27B-PTQ1_0.gguf'

Run-One $q1  'Q1_0'    163840 'q4_0' 'q4_0'
Run-One $q1  'Q1_0'    196608 'q4_0' 'q4_0'
Run-One $q1  'Q1_0'     98304 'q8_0' 'q8_0'
Run-One $ter 'Ternary'  65536 'q4_0' 'q4_0'
Run-One $ter 'Ternary'  98304 'q4_0' 'q4_0'
"=== DONE ===" | Add-Content $out
