# NOTE: ASCII only -- PowerShell 5.1 reads .ps1 as ANSI.
# Find the largest context at which ternary + q8_0 KV still runs at full speed.
$ErrorActionPreference = 'Continue'
$exe  = 'C:\deepseek harness\models\llama-prism\llama-server.exe'
$out  = 'C:\deepseek harness\_ctx_audit\ternary_q8.log'
$file = 'F:\models-archive\Ternary-Bonsai-2-27B-Abliterated-PTQ1_0.gguf'
$prompts = Get-Content 'C:\deepseek harness\_ctx_audit\prompts.json' -Encoding UTF8 -Raw | ConvertFrom-Json
Set-Content -Path $out -Value 'ctx | kv | run | content_len | max_run | tok/s | vram_peak | verdict' -Encoding UTF8

function Max-Run([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return 0 }
  $m = [regex]::Matches($s, '(.)\1*'); $max = 0
  foreach ($x in $m) { if ($x.Length -gt $max) { $max = $x.Length } }
  return $max
}

function Run-One([int]$ctx, [string]$kv) {
  $a = @('-m',$file,'-c',"$ctx",'-ngl','99','-fa','on','-np','1',
         '-ctk',$kv,'-ctv',$kv,'--reasoning-budget','200',
         '--temp','0.7','--top-p','0.95','--top-k','20','--port','8097')
  $p = Start-Process -FilePath $exe -ArgumentList $a -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput 'C:\deepseek harness\_ctx_audit\tq.out' `
        -RedirectStandardError  'C:\deepseek harness\_ctx_audit\tq.err'
  $ok = $false
  for ($i = 0; $i -lt 150; $i++) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) { break }
    try { Invoke-RestMethod 'http://127.0.0.1:8097/health' -TimeoutSec 3 | Out-Null; $ok=$true; break } catch {}
  }
  if (-not $ok) { "$ctx | $kv | LOAD-FAILED" | Add-Content $out; Start-Sleep -Seconds 5; return }

  # Warm up once so the first sample is not polluted by CUDA graph build-up.
  try { Invoke-RestMethod 'http://127.0.0.1:8097/v1/chat/completions' -Method Post -ContentType 'application/json' -TimeoutSec 600 `
        -Body (@{ messages=@(@{role='user';content='hi'}); max_tokens=8; stream=$false } | ConvertTo-Json -Compress -Depth 6) | Out-Null } catch {}

  for ($n = 0; $n -lt $prompts.Count; $n++) {
    $body = @{ messages=@(@{role='user'; content=[string]$prompts[$n]}); max_tokens=700; stream=$false; temperature=0.7 } | ConvertTo-Json -Compress -Depth 6
    try {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $r  = Invoke-RestMethod 'http://127.0.0.1:8097/v1/chat/completions' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 900
      $sw.Stop()
      $c  = [string]$r.choices[0].message.content
      $ct = [int]$r.usage.completion_tokens
      $tps = if($sw.Elapsed.TotalSeconds -gt 0){ [math]::Round($ct / $sw.Elapsed.TotalSeconds, 2) } else { 0 }
      $pk  = (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''
      $run = [math]::Max((Max-Run $c), (Max-Run ([string]$r.choices[0].message.reasoning_content)))
      $v = 'OK'
      if ($c.Length -eq 0) { $v = 'EMPTY-CONTENT' } elseif ($run -ge 100) { $v = 'COLLAPSE' }
      if ($tps -lt 15) { $v = $v + '+SPILLED' }
      "$ctx | $kv | $n | $($c.Length) | $run | $tps | $pk | $v" | Add-Content $out
    } catch { "$ctx | $kv | $n | ERR | - | - | - | $($_.Exception.Message)" | Add-Content $out }
  }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 5
  Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
}

Run-One 32768 'q8_0'
Run-One 49152 'q8_0'
'=== DONE ===' | Add-Content $out
