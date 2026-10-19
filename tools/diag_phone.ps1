# 一键诊断:手机连不上时,分清是哪一层的问题
#
# 用法(在本机 PowerShell 里跑):
#   powershell -ExecutionPolicy Bypass -File tools\diag_phone.ps1
#
# 它会依次报告:
#   1. 服务是否在监听(8091)
#   2. 代理是否在监听(8092)
#   3. 防火墙规则覆盖情况
#   4. 本机在局域网上的地址(手机该连哪个)
#   5. 从本机自连这两个端口是否正常
#
# 然后你在手机浏览器上分别打开下面列出的两个地址,就能定位是哪一层。

$ErrorActionPreference = 'Continue'

function Section($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }

Section '1. 端口监听状态(用 netstat,不用 tasklist)'
$ns = netstat -ano 2>$null
foreach ($port in 8091, 8092) {
  $hit = $ns | Select-String ":$port\s" | Select-String 'LISTENING'
  if ($hit) {
    $pid = ($hit[0].Line -split '\s+')[-1]
    Write-Host "  [OK]   $port 正在监听 (PID $pid)" -ForegroundColor Green
  } else {
    Write-Host "  [!!]   $port 没有人监听" -ForegroundColor Red
  }
}

Section '2. 本机 HTTP 自连'
foreach ($port in 8091, 8092) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 4
    Write-Host "  [OK]   $port 本地 HTTP $($r.StatusCode)" -ForegroundColor Green
  } catch {
    try {
      $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:$port/_bridge/status" -UseBasicParsing -TimeoutSec 4
      Write-Host "  [OK]   $port 本地 HTTP $($r2.StatusCode) (代理)" -ForegroundColor Green
    } catch {
      Write-Host "  [--]   $port 本地不可达" -ForegroundColor DarkGray
    }
  }
}

Section '3. 局域网地址(手机该连这些)'
$addrs = @()
try {
  Add-Type -AssemblyName System.Net.NetworkInformation -ErrorAction SilentlyContinue
  $addrs = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
    ForEach-Object {
      $_.GetIPProperties().UnicastAddresses |
        Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } |
        ForEach-Object { [PSCustomObject]@{ Name = $_.Address.ToString(); Iface = $args } }
    }
} catch { }

if (-not $addrs -or $addrs.Count -eq 0) {
  # 退回 node,这是最可靠的枚举方式
  $json = node -e "const os=require('os');const out=[];for(const [n,a] of Object.entries(os.networkInterfaces()))for(const x of a||[])if((x.family===4||x.family==='IPv4')&&!x.internal)out.push(n+' '+x.address);process.stdout.write(out.join('\n'))" 2>$null
  $json -split "`n" | Where-Object { $_ } | ForEach-Object {
    $parts = $_ -split ' '
    Write-Host "  $($parts[-1])  ($($parts[0..($parts.Count-2)] -join ' '))" -ForegroundColor White
  }
}

Section '4. 防火墙规则覆盖情况'
$rules = netsh advfirewall firewall show rule name=all verbose 2>$null
foreach ($prog in 'llama-server', 'node.exe') {
  $blocks = ($rules -join "`n") -split '(?=Rule Name:)'
  $mine = $blocks | Where-Object { $_ -match [regex]::Escape($prog) -and $_ -match 'Action:\s+Allow' }
  if ($mine) {
    $profiles = ($mine | ForEach-Object {
      if ($_ -match 'Profiles:\s*(.+)') { $Matches[1].Trim() }
    }) | Sort-Object -Unique
    $protos = ($mine | ForEach-Object {
      if ($_ -match 'Protocol:\s*(.+)') { $Matches[1].Trim() }
    }) | Sort-Object -Unique
    Write-Host "  [OK]   $prog 有放行规则: 配置文件=$($profiles -join '/') 协议=$($protos -join '/')" -ForegroundColor Green
  } else {
    Write-Host "  [!!]   $prog 没有放行规则" -ForegroundColor Red
  }
}

$fw = netsh advfirewall show allprofiles state 2>$null
$on = ($fw | Select-String 'State\s+ON').Count
Write-Host "  防火墙状态:$on 个配置文件开启(共 3 个)"
if ($on -eq 3) {
  Write-Host "  提示:若手机连不上而上面规则都正常,可临时全关防火墙对比:" -ForegroundColor Yellow
  Write-Host "        netsh advfirewall set allprofiles state off   (测完记得开回来)" -ForegroundColor Yellow
}

Section '5. 下一步:在手机上分别打开这两个地址'
$ip = (node -e "const os=require('os');const r=[];for(const [n,a] of Object.entries(os.networkInterfaces()))for(const x of a||[])if((x.family===4||x.family==='IPv4')&&!x.internal)r.push(x.address);process.stdout.write(r.join(','))" 2>$null) -split ','
foreach ($a in $ip) {
  Write-Host "  http://${a}:8091/   <- 直连模型(不需要代理)" -ForegroundColor White
  Write-Host "  http://${a}:8092/   <- 经代理(才有档位与压缩)" -ForegroundColor White
}
Write-Host ""
Write-Host "判读方法:" -ForegroundColor Cyan
Write-Host "  两个都打不开      -> 手机与电脑之间不通(热点客户端隔离 / 连的不是同一热点)"
Write-Host "  8091 通 8092 不通 -> 代理没启动,或代理端口的入站被拦"
Write-Host "  两个都通          -> 之前多半只是服务没启动"
