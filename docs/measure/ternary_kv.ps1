# NOTE: ASCII only -- PowerShell 5.1 reads .ps1 as ANSI; non-ASCII breaks parsing.
# Chinese prompts live in prompts.json.
#
# Ternary (PTQ1_0) KV-cache quality + feasibility test.
# MUST use the prism build: stock llama.cpp rejects ggml type 143.
$ErrorActionPreference = 'Continue'
$exe  = 'C:\deepseek harness\models\llama-prism\llama-server.exe'
$out  = 'C:\deepseek harness\_ctx_audit\ternary.log'
$dir  = 'C:\deepseek harness\_ctx_audit\tout'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$prompts = Get-Content 'C:\deepseek harness\_ctx_audit\prompts.json' -Encoding UTF8 -Raw | ConvertFrom-Json
Set-Content -Path $out -Value 'model | ctx | kv | run | content_len | reasoning_len | max_run | tok/s | vram_peak | verdict' -Encoding UTF8

function Max-Run([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return 0 }
  $m = [regex]::Matches($s, '(.)\1*'); $max = 0
  foreach ($x in $m) { if ($x.Length -gt $max) { $max = $x.Length } }
  return $max
}

function Run-One([string]$file, [string]$label, [int]$ctx, [string]$kv) {
  $a = @('-m',$file,'-c',"$ctx",'-ngl','99','-fa','on','-np','1',
         '-ctk',$kv,'-ctv',$kv,'--reasoning-budget','200',
         '--temp','0.7','--top-p','0.95','--top-k','20','--port','8097')
  $p = Start-Process -FilePath $exe -ArgumentList $a -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput 'C:\deepseek harness\_ctx_audit\t.out' `
        -RedirectStandardError  'C:\deepseek harness\_ctx_audit\t.err'
  $ok = $false
  for ($i = 0; $i -lt 150; $i++) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) { break }
    try { Invoke-RestMethod 'http://127.0.0.1:8097/health' -TimeoutSec 3 | Out-Null; $ok=$true; break } catch {}
  }
  if (-not $ok) {
    $e = (Get-Content 'C:\deepseek harness\_ctx_audit\t.err' -Tail 3 -ErrorAction SilentlyContinue) -join ' / '
    "$label | $ctx | $kv | LOAD-FAILED | - | - | - | - | - | $e" | Add-Content $out
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 5; return
  }

  for ($n = 0; $n -lt $prompts.Count; $n++) {
    $body = @{ messages=@(@{role='user'; content=[string]$prompts[$n]}); max_tokens=700; stream=$false; temperature=0.7 } | ConvertTo-Json -Compress -Depth 6
    try {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $r  = Invoke-RestMethod 'http://127.0.0.1:8097/v1/chat/completions' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 900
      $sw.Stop()
      $c  = [string]$r.choices[0].message.content
      $rz = [string]$r.choices[0].message.reasoning_content
      $run = [math]::Max((Max-Run $c), (Max-Run $rz))
      $ct  = [int]$r.usage.completion_tokens
      $tps = if($sw.Elapsed.TotalSeconds -gt 0){ [math]::Round($ct / $sw.Elapsed.TotalSeconds, 2) } else { 0 }
      $pk  = (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''
      $v = 'OK'
      if ($c.Length -eq 0)  { $v = 'EMPTY-CONTENT' }
      elseif ($run -ge 100) { $v = 'COLLAPSE' }
      elseif ($run -ge 40)  { $v = 'SUSPECT' }
      if ([int]$pk -gt 7850) { $v = $v + '+OVER-VRAM' }
      "$label | $ctx | $kv | $n | $($c.Length) | $($rz.Length) | $run | $tps | $pk | $v" | Add-Content $out
      Set-Content -Path (Join-Path $dir "$label-$ctx-$kv-$n.txt") -Value $c -Encoding UTF8
    } catch {
      "$label | $ctx | $kv | $n | ERR | - | - | - | - | $($_.Exception.Message)" | Add-Content $out
    }
  }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 5
  Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
}

$abl = 'F:\models-archive\Ternary-Bonsai-2-27B-Abliterated-PTQ1_0.gguf'
$her = 'D:\Ternary-Bonsai-2-27B-Heretic-PTQ1_0.gguf'

# Main model first. 64K is the shipped preset; 96K is the measured ceiling;
# q8_0@64K answers "can I just raise KV precision at my working context?"
Run-One $abl 'Abliterated' 65536 'q4_0'
Run-One $abl 'Abliterated' 65536 'q8_0'
Run-One $abl 'Abliterated' 98304 'q4_0'
# Spot-check the other uncensored variant at the shipped preset.
Run-One $her 'Heretic'     65536 'q4_0'
'=== DONE ===' | Add-Content $out
