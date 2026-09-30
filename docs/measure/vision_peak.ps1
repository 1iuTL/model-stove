# NOTE: ASCII only.
# Post-request sampling can miss a transient peak while the vision encoder runs.
# This one polls nvidia-smi concurrently with the image request.
$ErrorActionPreference = 'Continue'
$exe   = 'C:\deepseek harness\models\llama-prism\llama-server.exe'
$model = 'F:\models-archive\Ternary-Bonsai-2-27B-Abliterated-PTQ1_0.gguf'
$mmproj= 'D:\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'
$img   = 'C:\deepseek harness\models\test_report.png'
$out   = 'C:\deepseek harness\_ctx_audit\vision_peak.log'
Set-Content -Path $out -Value 'ctx | phase | tok/s | vram_after | vram_peak_polled | verdict' -Encoding UTF8
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($img))

function Poll-Peak([int]$seconds) {
  $max = 0
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    $v = [int]((nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join '')
    if ($v -gt $max) { $max = $v }
    Start-Sleep -Milliseconds 300
  }
  return $max
}

function Run-One([int]$ctx) {
  $a = @('-m',$model,'-c',"$ctx",'-ngl','99','-fa','on','-np','1',
         '-ctk','q4_0','-ctv','q4_0','--reasoning-budget','200',
         '--temp','0.7','--top-p','0.95','--top-k','20',
         '--mmproj',$mmproj,'--no-mmproj-offload','--image-max-tokens','1024',
         '--port','8097')
  $p = Start-Process -FilePath $exe -ArgumentList $a -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput 'C:\deepseek harness\_ctx_audit\vp.out' `
        -RedirectStandardError  'C:\deepseek harness\_ctx_audit\vp.err'
  $ok = $false
  for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) { break }
    try { Invoke-RestMethod 'http://127.0.0.1:8097/health' -TimeoutSec 3 | Out-Null; $ok=$true; break } catch {}
  }
  if (-not $ok) { "$ctx | LOAD-FAILED" | Add-Content $out; Start-Sleep -Seconds 5; return }

  # Warm up so CUDA graph build-up does not pollute the measurement
  try { Invoke-RestMethod 'http://127.0.0.1:8097/v1/chat/completions' -Method Post -ContentType 'application/json' -TimeoutSec 600 `
        -Body (@{ messages=@(@{role='user';content='hi'}); max_tokens=8; stream=$false } | ConvertTo-Json -Compress -Depth 6) | Out-Null } catch {}

  # Poll in a background job while the image request runs in the foreground.
  $job = Start-Job -ScriptBlock {
    $max = 0
    for ($i = 0; $i -lt 400; $i++) {
      $v = [int]((nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join '')
      if ($v -gt $max) { $max = $v }
      Start-Sleep -Milliseconds 250
    }
    return $max
  }

  $content = @(
    @{ type='text'; text='Describe this image and read all text in it.' },
    @{ type='image_url'; image_url=@{ url = "data:image/png;base64,$b64" } }
  )
  $body = @{ messages=@(@{ role='user'; content=$content }); max_tokens=400; stream=$false; temperature=0.7 } | ConvertTo-Json -Compress -Depth 8
  try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r  = Invoke-RestMethod 'http://127.0.0.1:8097/v1/chat/completions' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 900
    $sw.Stop()
    $ct = [int]$r.usage.completion_tokens
    $tps = [math]::Round($ct / $sw.Elapsed.TotalSeconds, 2)
    $after = (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''
    $polled = Receive-Job -Job $job -Wait
    Remove-Job -Job $job -Force
    $v = 'OK'; if ($tps -lt 15) { $v = 'SLOW' }
    "$ctx | image | $tps | $after | $polled | $v" | Add-Content $out
  } catch {
    "$ctx | image | ERR | - | - | $($_.Exception.Message)" | Add-Content $out
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 5
  Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
}

Run-One 65536
Run-One 98304
'=== DONE ===' | Add-Content $out
