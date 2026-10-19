# 允许手机从局域网访问 Model Stove 的 8091 / 8092 端口。
#
# 为什么需要这一步(这是"手机卡在加载界面"的真正原因):
#   Windows 防火墙默认 BlockInbound,而入站允许规则**按配置文件生效**。
#   这台机器在手机热点时段被判为 Public,而实测:
#     llama-server.exe 有 6 条 Public 入站规则  -> 8091 能通
#     node.exe         0 条规则                 -> 8092(代理)被静默丢包
#     electron.exe     0 条规则                 -> 外壳自己的网络访问会被弹窗
#   表现就是:手机浏览器一直转圈,而电脑这边看不出任何异常。
#
# 添加规则必须管理员权限(实测普通权限返回
# "The requested operation requires elevation"),所以只能走 UAC。
#
# 用法:双击同目录的 allow-lan.cmd,或在管理员 PowerShell 里执行本文件。

$ErrorActionPreference = 'Stop'
$report = @()

function Add-InboundRule {
  param([string]$Name, [string]$Program)
  if (-not (Test-Path $Program)) {
    $script:report += "跳过(文件不存在): $Program"
    return
  }
  # 先删同名旧规则,避免重复堆积
  netsh advfirewall firewall delete rule name="$Name" 2>&1 | Out-Null
  # profile 三个都给:热点时段会被判成 Public,而校园网/家用网可能是别的,
  # 只给 Public 会在换网络后失效。
  $out = netsh advfirewall firewall add rule name="$Name" dir=in action=allow `
           program="$Program" enable=yes profile=public,private,domain protocol=any 2>&1
  if ($LASTEXITCODE -eq 0) {
    $script:report += "已添加: $Name"
    $script:report += "          -> $Program"
  } else {
    $script:report += "失败($LASTEXITCODE): $Name :: $out"
  }
}

Add-InboundRule -Name 'Model Stove proxy (node)'   -Program 'C:\Program Files\nodejs\node.exe'
Add-InboundRule -Name 'Model Stove app (electron)' -Program 'C:\deepseek harness\model-stove\node_modules\electron\dist\electron.exe'

# 顺手清掉排查过程中可能留下的临时规则。
#
# 为什么需要:`netsh advfirewall firewall add rule` **不做去重**,而
# `delete rule name=X` 一次只删一条 —— 所以"加两次、删一次"会剩一条重复规则。
# 实测就这么堆出过重复项。
foreach ($stale in @('MS Diag (node)', '__syntax_probe__')) {
  netsh advfirewall firewall delete rule name="$stale" 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $report += "已清理临时规则: $stale" }
}

Write-Host ''
Write-Host '=== 结果 ===' -ForegroundColor Cyan
$report | ForEach-Object { Write-Host "  $_" }

Write-Host ''
Write-Host '=== 复核 ===' -ForegroundColor Cyan

# 复核走**注册表**,而不是解析 netsh 的输出。
#
# 这里原来用 `netsh advfirewall firewall show rule` 再匹配 "Rule Name",
# 而中文 Windows 上那个字段叫"规则名称:" —— 于是规则明明加成功了,复核却报
# "不存在",反过来还让人以为加规则失败了。netsh 在这台机器上还自相矛盾:
# `show rule name=all` 里数不到 node.exe,按名字却能查到。详见 firewall-rules.ps1。
. (Join-Path $PSScriptRoot 'firewall-rules.ps1')

foreach ($item in @(
  @{ Label = 'Model Stove proxy (node)';   Program = 'C:\Program Files\nodejs\node.exe' },
  @{ Label = 'Model Stove app (electron)'; Program = 'C:\deepseek harness\model-stove\node_modules\electron\dist\electron.exe' }
)) {
  $hits = Get-StoveInboundAllow -Needle $item.Program
  if ($hits.Count -gt 0) {
    Write-Host ("  [OK] {0}" -f $item.Label) -ForegroundColor Green
    $hits | Select-Object -First 3 | ForEach-Object {
      Write-Host ("         {0}  Dir={1} Action={2} Active={3} Profile={4}" -f $_.Name, $_.Dir, $_.Action, $_.Active, $_.Profile)
    }
  } else {
    Write-Host ("  [!!] {0}  —— 没查到入站允许规则" -f $item.Label) -ForegroundColor Red
  }
}

Write-Host ''
Write-Host '完成后可以关闭本窗口。回到 Model Stove,启动服务与代理,再用手机访问。' -ForegroundColor Green
Write-Host '注意:Model Stove 界面里的「放行防火墙」按钮做的是同一件事。' -ForegroundColor DarkGray
Write-Host ''
Read-Host '按回车键退出'
