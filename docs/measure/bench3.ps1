$ErrorActionPreference = 'Continue'
$out = 'C:\deepseek harness\_ctx_audit\bench3.log'
Set-Content -Path $out -Value "model | bin | ctx | tg tok/s | VRAM peak MiB" -Encoding UTF8

function Run-One([string]$exe,[string]$model,[string]$label,[int]$ctx) {
  $a = @('-m',$model,'-c',"$ctx",'-ngl','99','-fa','on','-np','1',
         '-ctk','q4_0','-ctv','q4_0','--port','8097')
  $p = Start-Process -FilePath $exe -ArgumentList $a -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput 'C:\deepseek harness\_ctx_audit\s3.out' `
        -RedirectStandardError  'C:\deepseek harness\_ctx_audit\s3.err'
  $ok = $false
  for ($i = 0; $i -lt 150; $i++) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) { break }
    try { Invoke-RestMethod 'http://127.0.0.1:8097/health' -TimeoutSec 3 | Out-Null; $ok = $true; break } catch {}
  }
  $vram = (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''
  $tag = "$label | $ctx"
  if ($ok) {
    $body = @{ prompt='The ocean is vast.'; n_predict=64; stream=$false; cache_prompt=$false } | ConvertTo-Json -Compress
    try {
      $r = Invoke-RestMethod 'http://127.0.0.1:8097/completion' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 900
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

$prism = 'C:\deepseek harness\models\llama-prism\llama-server.exe'
$stock = 'C:\deepseek harness\models\llama-cpp\llama-server.exe'
$ter   = 'F:\models-archive\Ternary-Bonsai-2-27B-PTQ1_0.gguf'
$q1    = 'F:\models-archive\Bonsai-27B-Q1_0.gguf'

Run-One $prism $ter 'Ternary+prism'  65536
Run-One $prism $ter 'Ternary+prism'  98304
Run-One $prism $ter 'Ternary+prism' 131072
Run-One $stock $q1  'Q1_0+stock'    229376
"=== DONE ===" | Add-Content $out
