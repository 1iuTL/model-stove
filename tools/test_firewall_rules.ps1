# tools/firewall-rules.ps1 的正规测试。
#
# 为什么要测这个模块:它是"防火墙到底放没放行"的唯一判据,而之前的判据
# (解析 netsh 的本地化文本)是错的 —— 中文 Windows 下永远不命中,把"存在"
# 误判成"不存在",我因此连着给出了错误结论。判据错了,后面所有推理都错,
# 所以它必须自己有测试。
#
# 用法(执行策略被禁,必须带 Bypass):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\test_firewall_rules.ps1

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'firewall-rules.ps1')

$failed = 0
function Check {
  param([string]$Name, [bool]$Ok, [string]$Extra = '')
  $mark = if ($Ok) { '[ok]' } else { '[XX]' }
  Write-Host ("  {0} {1}{2}" -f $mark, $Name, $(if ($Extra) { "  $Extra" } else { '' }))
  if (-not $Ok) { $script:failed++ }
}

Write-Host '=== 注册表读取 ==='
$all = Get-StoveFirewallRuleValue
Check '能读到防火墙规则' ($all.Count -gt 100) "共 $($all.Count) 条"

Check '每条都有 Raw' (($all | Where-Object { -not $_.Raw }).Count -eq 0)
Check '解析出了 Name/Dir/Action/Active 字段' (
  (($all | Where-Object { $_.Dir -and $_.Action }).Count) -gt 0
)

# 缺 Profile 段必须被补成"全适用",否则读的人会以为规则没生效
$noProfile = $all | Where-Object { $_.Raw -notmatch 'Profile=' } | Select-Object -First 1
if ($noProfile) {
  Check '缺 Profile 段时补为全适用' ($noProfile.Profile -eq 'Domain,Private,Public') $noProfile.Profile
} else {
  Check '缺 Profile 段时补为全适用' $true '(本机所有规则都显式写了 Profile)'
}

Write-Host ''
Write-Host '=== 过滤只保留入站 + 允许 + 已启用 ==='
$inAllow = Get-StoveInboundAllow
Check '过滤后非空' ($inAllow.Count -gt 0) "共 $($inAllow.Count) 条"
Check '结果里没有非入站的' (($inAllow | Where-Object { $_.Dir -ne 'In' }).Count -eq 0)
Check '结果里没有非 Allow 的' (($inAllow | Where-Object { $_.Action -ne 'Allow' }).Count -eq 0)
Check '结果里没有未启用的' (($inAllow | Where-Object { $_.Active -ne 'TRUE' }).Count -eq 0)

# 关键回归:必须能按**程序路径**找到规则。这正是当初失败的用法。
Write-Host ''
Write-Host '=== 按程序路径判定(核心用途) ==='
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$hits = Get-StoveInboundAllow -Needle $nodeExe
Check 'node.exe 有入站允许规则' ($hits.Count -gt 0) "$($hits.Count) 条"
$hits | Select-Object -First 3 | ForEach-Object { Write-Host "         $($_.Name)  Profile=$($_.Profile)" }

Check 'Test-StoveProgramAllowed 对 node.exe 返回真' (Test-StoveProgramAllowed -Program $nodeExe)
Check 'Test-StoveProgramAllowed 对不存在的程序返回假' (
  -not (Test-StoveProgramAllowed -Program 'C:\definitely\not\a\real\program.exe')
)

# netsh 的坑:它的显示名匹配在这台机器上不可靠。这里确认注册表路径不依赖它。
Write-Host ''
Write-Host '=== 与 netsh 的对照(只做记录,不做断言) ==='
$netshOut = netsh advfirewall firewall show rule name="Model Stove proxy (node)" 2>&1
$netshHas = ($netshOut | Select-String 'Rule Name|规则名称').Count -gt 0
Write-Host ("  netsh name=... 命中: {0}" -f $netshHas)
$netshAll = netsh advfirewall firewall show rule name=all dir=in 2>&1
$netshAllHas = ($netshAll | Select-String 'node\.exe').Count
Write-Host ("  netsh name=all 里含 node.exe 的行: {0}" -f $netshAllHas)
$regHas = (Get-StoveInboundAllow -Needle 'node.exe').Count
Write-Host ("  注册表里 node.exe 的入站允许规则: {0} 条" -f $regHas)
Write-Host '  -> 两者不一致时,以注册表为准(netsh 在这台机器上自相矛盾)'

Write-Host ''
if ($failed -eq 0) {
  Write-Host '全部通过'
  exit 0
} else {
  Write-Host "有 $failed 项失败"
  exit 1
}
