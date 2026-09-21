## Comet 
Comet 是一个面向Coding的可恢复长程任务工作流与 Skill 平台。

它提供两套彼此独立的需求工作流：面向强模型、只依赖 Comet 原生 runtime 的 Native，以及保留 OpenSpec + Superpowers 完整阶段治理的 Classic；同时覆盖 Skill 创建、评估与发布。

让你可以用一个工具链处理需求到归档、中断后恢复，将任意Skill组合得像Comet一样，基于科学的Rubric、Pass@k、Pass^k评分演进你的Skill
https://github.com/rpamis/comet/blob/master/README-zh.md

快捷部署和卸载指令

以下命令在 **Windows PowerShell 终端**执行。需要 Node.js 22.16+（22.x）或 24+、npm 和 Git；先安装 CLI，再初始化所需的 Skill。依据：[官方安装说明](https://github.com/rpamis/comet/blob/master/README-zh.md)。

### 1. 安装 CLI

```powershell
# 检查运行环境
node --version
npm.cmd --version
git --version

# 全局安装 Comet CLI
npm.cmd install -g @rpamis/comet

# 确认命令可用
comet --version
```

### 2. 初始化项目

进入实际项目目录，运行交互式初始化，按提示选择平台、语言和工作流：

```powershell
Set-Location -LiteralPath 'E:\AICoding'
comet init

# 初始化后检查安装状态
comet doctor
```

如需直接为当前项目的 Codex 平台安装中文 Native 工作流，可用下面的命令替代交互式 `comet init`：

```powershell
comet init --scope project --platform codex --language zh --workflow native --yes
```

其他安装方式按需选择，不需要全部执行。参数说明见 [官方 init 文档](https://docs.comet.rpamis.com/zh/cli/init)。

```powershell
# 当前项目：选择 Classic 工作流
comet init --scope project --platform codex --language zh --workflow classic

# 当前项目：同时安装 Native 和 Classic
comet init --scope project --platform codex --language zh --workflow both

# 全局 Skill：让多个项目使用同一套中文 Native 能力
comet init --scope global --platform codex --language zh --workflow native
```

`npm -g` 安装的是终端 CLI；`comet init --scope global` 安装的是全局 Skill 和配套资产，两者用途不同。初始化完成后，在 AI 编码工具的对话框中调用：

```text
/comet 优化设计文档
```

### 3. 卸载

先移除对应范围的 Comet Skill、规则和 hooks，再按需卸载 CLI。以下几种范围独立选择；官方卸载会保留项目代码和设计文档，详见 [官方 uninstall 文档](https://docs.comet.rpamis.com/zh/cli/uninstall)。

```powershell
# 仅卸载当前项目的 Comet 资产
Set-Location -LiteralPath 'E:\AICoding'
comet uninstall --scope project --current-project
```

```powershell
# 仅卸载全局 Comet 资产
# --current-project 用于绕过“所有已登记项目”的范围选择
comet uninstall --scope global --current-project
```

```powershell
# 如需清理所有已登记项目，单独执行此命令
comet uninstall --all-projects
```

```powershell
# 不再需要终端 CLI 时，最后执行
npm.cmd uninstall -g @rpamis/comet
```

仅执行 npm 卸载不会代替项目或全局资产清理。需要非交互卸载时，可在已明确范围的 `comet uninstall` 命令后添加 `--force`，它会跳过确认。

### 4. 提示“找不到 comet 命令”时

先在终端检查全局安装记录及命令搜索结果：

```powershell
npm.cmd list -g @rpamis/comet --depth=0
npm.cmd prefix -g
Get-Command comet -All -ErrorAction SilentlyContinue
```

如果包已安装，但命令不可见，可检查 npm 全局目录中的启动文件，并临时补充当前终端的 PATH：

```powershell
$cometNpmPrefix = (npm.cmd prefix -g).Trim()
$cometLauncher = Join-Path $cometNpmPrefix 'comet.cmd'

if (Test-Path -LiteralPath $cometLauncher) {
    $env:Path = "$cometNpmPrefix;$env:Path"
    & $cometLauncher --version
} else {
    Write-Host '未找到 comet.cmd，请先完成 npm 全局安装并检查安装错误。'
}
```

这只修复当前终端环境。长期使用时，将 `npm.cmd prefix -g` 返回的目录加入用户 PATH，然后重新打开终端及使用该环境的编辑器。仅有 `SKILL.md` 文件不代表 CLI 已安装。
