# NOTE: ASCII only -- Windows PowerShell 5.1 reads .ps1 as ANSI, non-ASCII breaks parsing.
# Chinese prompts live in prompts.json; model replies are written to files for diffing.
$ErrorActionPreference = 'Continue'
$exe     = 'C:\deepseek harness\models\llama-cpp\llama-server.exe'
$model   = 'F:\models-archive\Bonsai-27B-Q1_0.gguf'
$out     = 'C:\deepseek harness\_ctx_audit\kv3.log'
$dir     = 'C:\deepseek harness\_ctx_audit\kvout'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$prompts = Get-Content 'C:\deepseek harness\_ctx_audit\prompts.json' -Encoding UTF8 -Raw | ConvertFrom-Json
Set-Content -Path $out -Value 'kv | run | content_len | reasoning_len | max_run | verdict' -Encoding UTF8

function Max-Run([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return 0 }
  $m = [regex]::Matches($s, '(.)\1*'); $max = 0
  foreach ($x in $m) { if ($x.Length -gt $max) { $max = $x.Length } }
  return $max
}

function Run-KV([string]$kv) {
  # --reasoning-budget 200 is the setting verified in Bonsai deployment notes:
  # it caps thinking so the rest of the token budget reaches the actual answer.
  # (--reasoning-effort none was tried first and does NOT work on build 11095 --
  #  thinking got longer, not shorter, and content stayed empty.)
  $a = @('-m',$model,'-c','65536','-ngl','99','-fa','on','-np','1',
         '-ctk',$kv,'-ctv',$kv,'--reasoning-budget','200',
         '--temp','0.7','--top-p','0.95','--top-k','20','--port','8097')
  $p = Start-Process -FilePath $exe -ArgumentList $a -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput 'C:\deepseek harness\_ctx_audit\k2.out' `
        -RedirectStandardError  'C:\deepseek harness\_ctx_audit\k2.err'
  $ok = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) { break }
    try { Invoke-RestMethod 'http://127.0.0.1:8097/health' -TimeoutSec 3 | Out-Null; $ok=$true; break } catch {}
  }
  if (-not $ok) { "$kv | LOAD-FAILED" | Add-Content $out; return }

  for ($n = 0; $n -lt $prompts.Count; $n++) {
    $body = @{ messages=@(@{role='user'; content=[string]$prompts[$n]}); max_tokens=700; stream=$false; temperature=0.7 } | ConvertTo-Json -Compress -Depth 6
    try {
      $r  = Invoke-RestMethod 'http://127.0.0.1:8097/v1/chat/completions' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 900
      $c  = [string]$r.choices[0].message.content
      $rz = [string]$r.choices[0].message.reasoning_content
      $run = [math]::Max((Max-Run $c), (Max-Run $rz))
      $v = 'OK'
      if ($c.Length -eq 0)      { $v = 'EMPTY-CONTENT' }
      elseif ($run -ge 100)     { $v = 'COLLAPSE' }
      elseif ($run -ge 40)      { $v = 'SUSPECT' }
      "$kv | $n | $($c.Length) | $($rz.Length) | $run | $v" | Add-Content $out
      Set-Content -Path (Join-Path $dir "$kv-$n.txt") -Value $c -Encoding UTF8
    } catch {
      "$kv | $n | ERR | - | - | $($_.Exception.Message)" | Add-Content $out
    }
  }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 5
  Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
}

Run-KV 'q4_0'
Run-KV 'q8_0'
Run-KV 'f16'
'=== DONE ===' | Add-Content $out
