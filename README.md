# Toolkits

面向开发、测试和运维人员的工具集合，包含浏览器工具、工程源码、需求设计与使用知识库。

工程仓库：[Xavier-110/Toolkits](https://github.com/Xavier-110/Toolkits)，主分支为 `main`。

## 工程介绍

| 工具 | 入口 | 用途 |
| --- | --- | --- |
| 在线运维工具箱 | [启动说明](Tools/ops-toolkit/README.md#在线启动) | 账号密码登录、白名单及三角色权限、共享配置与版本编辑／提交署名 |
| Pointer API 可视化工具 | [Tools/point_tools.html](Tools/point_tools.html) | 配置服务地址、上传图片、查看检测结果、时延和可视化图层；需要可访问的 Pointer API 服务 |

运维工具箱需要启动 Node.js 服务，通过浏览器访问。解析依赖和样式均已内嵌，转换和证书解析在浏览器本地执行。

配置与历史版本保存在服务端，默认使用 SQLite，可通过导入、导出备份迁移。数据不会随 Git 提交自动同步；完整备份包含原始配置值，分享时可使用脱敏导出。旧版 v1/v2 备份仍可导入在线版的待映射区。

当前功能、数据边界及部署方式见[运维工具箱说明](Tools/ops-toolkit/README.md)。工具页面尚未提供 Git 自动同步功能。

## 目录结构

```text
Toolkits/
├─ README.md                         # 工程介绍与 Git 使用说明
├─ Tools/
│  ├─ ops_toolkit_online.html        # 在线页面，由业务服务提供
│  ├─ point_tools.html               # Pointer API 可视化工具
│  └─ ops-toolkit/                   # 运维工具箱源码工程
│     ├─ src/                        # 页面、样式、转换、证书与存储逻辑
│     ├─ server/                     # 账号、权限、共享配置 API 与 SQLite
│     ├─ tests/                      # 单元、浏览器与性能验证
│     ├─ build.mjs                   # 单文件构建脚本
│     └─ package.json               # 依赖与开发命令
├─ docs/openspec/                    # OpenSpec 配置、规格与变更记录
└─ 知识库/                           # 工具与工作流使用指南
```

## 快速使用与开发

Pointer 工具可直接打开对应 HTML 文件；运维工具箱需按下述步骤启动服务。详细操作、数据边界和第三方许可证见[运维工具箱说明](Tools/ops-toolkit/README.md)。

开发运维工具箱需要 Node.js 24 或满足依赖要求的更新版本。以下命令使用 Windows PowerShell；`E:\Toolkits` 请替换为实际工程路径。

```powershell
Set-Location E:\Toolkits\Tools\ops-toolkit
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd run init-admin
npm.cmd start
```

首次安装时初始化管理员；已有账号无需重复初始化。启动后访问 `http://127.0.0.1:4173/`，按 `Ctrl+C` 停止服务。配置保存在服务端，数据目录与部署参数见启动说明。

修改 `src/` 后重新执行 `npm.cmd run build`，构建结果写入 `Tools/ops_toolkit_online.html`，提交时一并纳入对应产物。需要在线浏览器验证时执行 `npm.cmd run test:browser`，默认使用本机安装的 Chrome；性能验证执行 `node tests/performance.mjs`。

## Git 安装

以下以 Windows 为例，安装一次后即可在 PowerShell 和 IDE 中使用。

1. 从 [Git 官方 Windows 安装页](https://git-scm.com/install/windows)下载安装程序，选择适合电脑架构的版本。也可以在已具备 WinGet 的 PowerShell 中运行：

   ```powershell
   winget install --id Git.Git -e --source winget
   ```

2. 使用安装程序时，确保 Git 加入 `PATH`，允许命令行和第三方软件调用；保留 Git Credential Manager，方便后续 HTTPS 认证。
3. 安装完成后重新打开 PowerShell 和 IDE，验证：

   ```powershell
   git --version
   Get-Command git
   ```

如果提示找不到 `git`，先重启终端；仍失败时检查安装目录下的 `cmd` 路径是否已加入 `PATH`。其他系统参见 [Git 官方安装入口](https://git-scm.com/install)。

## Git 身份与 GitHub 认证

### 1. 配置提交者身份

将下面的姓名和邮箱替换为自己的信息。邮箱可使用 GitHub 已验证邮箱，或账号设置中提供的隐私邮箱。

```powershell
git config --global user.name "你的姓名"
git config --global user.email "your-email@example.com"
git config --global init.defaultBranch main
git config --global --get user.name
git config --global --get user.email
```

`--global` 对当前系统用户的仓库生效；如果本工程需要单独的身份，在工程目录内执行相同命令并去掉 `--global`。提交身份用于记录作者，不等于 GitHub 登录或仓库写入权限。

### 2. HTTPS 认证（推荐）

本工程的远程地址使用 HTTPS。首次访问需要认证的仓库或推送时，按 Git Credential Manager 提示完成浏览器登录。若终端要求输入用户名和密码，用户名填写 GitHub 用户名，密码位置填写具有目标仓库所需权限的个人访问令牌（PAT），不能使用 GitHub 账号密码。参见 [GitHub 命令行认证说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github#authenticating-with-the-command-line)。

令牌不要写进仓库 URL、README 或其他被提交的文件。读取公开仓库成功不代表拥有推送权限；没有本仓库写权限时，先 Fork 到自己的账号，再向自己的仓库推送并发起 Pull Request。

### 3. SSH 认证（可选）

如果希望使用 SSH，在 PowerShell 中生成密钥。已有合适密钥时可直接使用；生成过程中如提示目标文件已存在，不要覆盖原密钥。

```powershell
ssh-keygen -t ed25519 -C "your-email@example.com"
```

按提示选择保存位置并设置密钥口令。若使用默认位置，可读取公钥：

```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

将公钥添加至 GitHub 的 **Settings → SSH and GPG keys → New SSH key**，私钥留在本机。然后测试连接：

```powershell
ssh -T git@github.com
```

首次连接时先对照官方指纹确认主机身份；出现包含 `successfully authenticated` 的欢迎信息表示认证成功，GitHub 不提供 Shell 登录。详细步骤见 [GitHub SSH 连接测试](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/testing-your-ssh-connection)。

已克隆工程可在仓库目录切换为 SSH 地址：

```powershell
git remote set-url origin git@github.com:Xavier-110/Toolkits.git
git remote -v
```

## 本地工程对接远程仓库

按实际情况选择下面一种方式。示例使用本工程地址；使用 Fork 时替换为自己仓库的地址。

### 方式一：首次获取工程

在准备存放工程的父目录执行。目标 `Toolkits` 目录应不存在或为空。

```powershell
Set-Location E:\
git clone https://github.com/Xavier-110/Toolkits.git
Set-Location .\Toolkits
git remote -v
git branch -vv
```

`clone` 会创建本地仓库、配置名为 `origin` 的远程地址，并为检出的分支设置跟踪关系，无需再执行 `git init` 或 `git remote add`。

### 方式二：已有本地 Git 工程

在工程根目录检查当前状态：

```powershell
Set-Location E:\Toolkits
git status
git remote -v
git branch -vv
```

本工程当前已配置 `origin` 为 `https://github.com/Xavier-110/Toolkits.git`，本地分支为 `main`。地址正确时直接保留。

仅当 `git remote -v` 没有列出 `origin` 时，添加关联：

```powershell
git remote add origin https://github.com/Xavier-110/Toolkits.git
```

如果已有 `origin`，但确认需要改为本工程地址，执行：

```powershell
git remote set-url origin https://github.com/Xavier-110/Toolkits.git
```

关联后读取远程信息并检查历史：

```powershell
git fetch origin
git branch -a
git log --oneline --graph --decorate --all -15
```

当本地 `main` 与 `origin/main` 属于同一工程历史，且远程已有 `main` 时，可以设置跟踪关系：

```powershell
git branch --set-upstream-to=origin/main main
```

如果本地文件夹没有 `.git`，而目标远程仓库已有工程历史，优先按方式一克隆到新目录，再复制需要保留的文件。只有准备把全新工程发布到空远程仓库时，才使用 `git init -b main`，按下节方式选择文件并提交，添加远程地址后执行 `git push -u origin main`。

## 日常更新与提交

以下以修改 README 并通过功能分支协作为例，在工程根目录执行。

1. 开始前确认工作区干净，再更新主分支。若已有未提交修改，先提交，或使用 `git stash push -u` 临时保存，之后在需要这些修改的分支用 `git stash pop` 恢复；仅执行 `git add` 不会让工作区变干净。

   ```powershell
   git status
   git switch main
   git pull --ff-only
   git switch -c docs/update-readme
   ```

2. 修改文件后检查差异，按文件选择本次提交内容。`git diff --cached` 会显示所有已暂存内容，提交前确认其中没有无关文件。

   ```powershell
   git diff -- README.md
   git add README.md
   git diff --cached
   git commit -m "docs: 补充工程介绍和 Git 使用说明"
   ```

3. 首次推送分支并建立跟踪关系，然后在 GitHub 上发起合入 `main` 的 Pull Request。

   ```powershell
   git push -u origin docs/update-readme
   ```

4. 后续在同一分支提交后执行 `git push`。通过 `git status` 和 `git branch -vv` 检查本地状态与跟踪关系。

提交源码时同时纳入必要的构建产物和依赖锁文件；不提交 `node_modules/`、缓存、测试输出或含真实凭据的配置备份。忽略规则可参考 [运维工具箱 .gitignore](Tools/ops-toolkit/.gitignore)。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| `git` 无法识别 | 确认已安装，重新打开终端和 IDE，并检查 `PATH` |
| `remote origin already exists` | 先执行 `git remote -v`；需要改地址时用 `git remote set-url origin ...` |
| `Authentication failed` 或 HTTP 403 | 检查登录账号、PAT 权限及仓库写权限；GitHub HTTPS 不接受账号密码 |
| `Permission denied (publickey)` | 检查 SSH 公钥是否添加到正确账号，再运行 `ssh -T git@github.com` |
| 当前分支没有上游 | 首次推送用 `git push -u origin 分支名`；远程分支已存在时也可设置跟踪关系 |
| `non-fast-forward` 或无法快进拉取 | 先 `git fetch origin` 并检查双方历史，在工作区干净时按团队约定合并或变基，解决冲突后再推送 |
| `refusing to merge unrelated histories` | 确认远程地址是否正确；对已有远程工程，优先重新克隆后迁移本地文件 |
