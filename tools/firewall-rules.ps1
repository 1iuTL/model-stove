# 读取 Windows 防火墙的入站规则 —— 只走注册表,不解析 netsh 的文本。
#
# 为什么不用 netsh(这台机器上实测踩到的坑):
#   1. netsh 的输出是**本地化**的。中文 Windows 上字段标签是
#      "规则名称:"/"已启用:"/"操作:",所以任何匹配 "Rule Name" 的代码永远不命中,
#      会把"存在"误判成"不存在"。这个错我犯了三次。
#   2. 这台机器上 netsh 的查询本身**自相矛盾**:同一条规则
#      `show rule name="X"` 一会儿查到一会儿查不到,而
#      `show rule name=all` 里又数不到它;按名字查到了、按 all 数不到。
#      所以它连"个数"都不能信。
#   3. PowerShell 的 `Get-NetFirewallRule` 在**非提权**环境下返回 0 条规则
#      (提权后才正常),所以它也不能拿来给用户界面做自检。
#
# 注册表就稳定得多:语言无关、非提权可读、内容就是规则的权威定义。
# 规则值形如:
#   v2.33|Action=Allow|Active=TRUE|Dir=In|App=C:\...\node.exe|Name=My rule|
# 注意 **没有 Profile= 段就表示 Domain/Private/Public 全适用**(Windows 的默认语义),
# 而 netsh 回显同样的规则时会写 "Profiles: Domain,Private,Public" —— 两者一致。
#
# 用法(在 PowerShell 里点源引入):
#   . .\tools\firewall-rules.ps1
#   Get-StoveInboundAllow -Needle 'node.exe'

$script:FwRulesKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules'

function Get-StoveFirewallRuleValue {
  <#
    取回所有防火墙规则条目,解析成对象。
    返回项:{ Raw, Name, Dir, Action, Active, App, Profile }
  #>
  param([string]$Needle = '')

  $props = Get-ItemProperty -Path $script:FwRulesKey -ErrorAction SilentlyContinue
  if (-not $props) { return @() }

  $out = @()
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Name -match '^PS') { continue }
    $raw = [string]$p.Value
    if ($Needle -and ($raw -notmatch [regex]::Escape($Needle))) { continue }

    $f = @{}
    foreach ($seg in ($raw -split '\|')) {
      if ($seg -match '^([A-Za-z]+)=(.*)$') { $f[$Matches[1]] = $Matches[2] }
    }
    $out += [pscustomobject]@{
      Raw     = $raw
      Name    = $f['Name']
      Dir     = $f['Dir']
      Action  = $f['Action']
      Active  = $f['Active']
      App     = $f['App']
      # 空字符串在 Windows 里的语义是"三个配置文件全适用",这里显式写出来,
      # 免得读的人以为"字段缺了 = 没生效"。
      Profile = if ($f['Profile']) { $f['Profile'] } else { 'Domain,Private,Public' }
    }
  }
  return $out
}

function Get-StoveInboundAllow {
  <#
    只保留"方向=入站 且 动作=允许 且 已启用"的规则。
    这就是"这个程序能不能从局域网连进来"的判据。

    ⚠️ -Needle 请传**程序路径**(如 'C:\Program Files\nodejs\node.exe'),
    不要传规则名。理由:注册表里的字段是 App=<路径> 和 Name=<显示名>,
    两者会互相误命中 —— 而判据本来就该是"这个程序有没有被放行",
    不是"有没有一条叫这个名字的规则"。

    实测踩过:用规则名当 Needle 做"清理复核",把**不该删的规则**也报成
    "已移除",并据此误删了两条正确的放行规则。用路径就没这个问题。
  #>
  param([string]$Needle = '')

  Get-StoveFirewallRuleValue -Needle $Needle | Where-Object {
    $_.Dir -eq 'In' -and $_.Action -eq 'Allow' -and $_.Active -eq 'TRUE'
  }
}

function Test-StoveProgramAllowed {
  <#
    某个程序当前是否被入站放行。返回 $true/$false。
    界面上的"防火墙警告"就该用这个结论来决定要不要出现。
  #>
  param([Parameter(Mandatory)][string]$Program)

  $hits = Get-StoveInboundAllow -Needle $Program
  return ($hits.Count -gt 0)
}
