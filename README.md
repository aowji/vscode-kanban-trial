# Markdown Kanban

把工作区里的 Markdown 文档显示成类似 GitLab Issue Board 的看板。
**一个 Markdown 文档 = 一张卡片**，卡片状态保存在项目根目录的一个 `*.kb.yaml` 里 ——
文档本身只被读取、从不被改写，看板文件是纯文本、可 git 管理的。

## 功能

- **`*.kb.yaml` 的自定义编辑器**：双击（默认打开方式）直接进看板，等同于 Markdown 预览插件的体验；同一份文件随时可切回文本编辑 YAML
- 递归扫描看板文件所在目录下的 `*.md` / `*.markdown`，自动忽略 `node_modules`、`.git`、`dist` 等
- 卡片显示：标题、标签 chips、最后修改时间、正文首段摘要
- 列由看板文件里的 `lists:` 决定；**默认只有 `No status` 一列**，其它 list 可在 `*.kb.yaml` 里写，也可以直接在看板界面增删：
  - 最右端 `+ Add list` 追加新列
  - 拖拽列头左右移动即可重排顺序（顺序错了不用删了重加）
  - 列头 `⋮` 菜单：`Move left` / `Move right` / `Add list before` / `Add list after` / `Collapse list` / `Remove list`，插入时弹出输入框
- **列可以折叠**：点列头左侧的 `❮` 收成窄条（只留竖排标题和计数），点窄条或 `❯` 展开；折叠的列照样能接收拖过来的卡片。折叠只是视图偏好（和搜索、标签过滤一样按窗口记住），不写进 `*.kb.yaml`
- 没有列 tag 的文档进入最左侧的 “No status” 列；删除 list 不会丢失卡片原有 tag，卡片会自动回到 “No status”
- **拖拽卡片换列**，或点卡片右上角的 `⋮` 菜单换列（键盘可用）
- 换列只改 `*.kb.yaml`，Markdown 文档一个字节都不动
- 顶部可按关键字搜索，也可以点 tag chip 做多标签过滤
- 文档新建 / 修改 / 删除、看板文件被外部改动时自动刷新
- 窗口重载后看板自动恢复

## 使用

1. `npm install && npm run compile`
2. 用 VS Code 打开本目录，按 `F5` 启动扩展开发宿主
3. 在新窗口里打开你的项目文件夹
4. 命令面板执行 **Markdown Kanban: Create Board File** —— 生成 `kanban.kb.yaml` 并直接以看板打开
5. 之后**双击任意 `*.kb.yaml` 就是看板**；想改 YAML 就点看板右上角 `✎`，或右键 → *Reopen Editor With…* → 普通文本编辑器
6. 在 VS Code 里新建 `.md` 文档，它会自动出现在看板的 “No status” 列，拖到对应列即可

## 打开方式

| 场景 | 行为 |
| --- | --- |
| 双击 / 资源管理器打开 `*.kb.yaml` | 默认打开看板（`contributes.customEditors` + `priority: default`） |
| 看板右上角 `✎` | 同一文件切换为文本编辑器编辑 YAML |
| 文本编辑器右上角看板图标 | 回到看板（来自 `editor/title` 菜单） |
| 右键 → *Reopen Editor With…* | 手动选择 “Kanban Board” 或 “Text Editor” |
| 命令面板 → *Open Board* | 打开当前 `*.kb.yaml`，或工作区里唯一的看板文件 |

看板改列/拖卡片时只写这个 YAML 文件；Markdown 文档永远只读。文件被外部改动时看板会自动刷新。

## 模型：board / list / card

| 概念 | 在我们这里是什么 |
| --- | --- |
| **board** | 一个 `*.kb.yaml` 文件 + 它打开的那块看板面板（可以有多个，比如 `work.kb.yaml` / `life.kb.yaml`） |
| **list** | 看板里的一列，由 `lists:` 里的一个 tag 定义；**list 属于 board，写在看板文件里** |
| **card** | 一篇 Markdown 文档，1:1 对应，id 就是文档路径 |

## 看板文件

```yaml
# Markdown Kanban board.
version: 1
lists:
  - backlog
  - todo
  - "in-progress:In Progress"
  - done
cards:
  docs/fix-login.md:
    tags:
      - todo
      - bug
  docs/spec.md:
    tags:
      - done
```

- `lists:` 定义这个看板自己的列与列序；支持 `tag:显示名` 改名。不写（缺 `lists` 键）时退回设置里的 `markdownKanban.defaultLists`；显式写 `lists: []` 则是"只有 No status"
- key 是相对看板文件所在目录的 POSIX 路径；拖动卡片只会重写对应的这一条（注释、其它条目、`lists` 原样保留）
- 列 tag 取 `lists` 里的那几个；一张卡片只会落在一列
- 其余 tag 会作为 chip 显示在卡片上，不参与分列
- 拖到 “No status” 列 = 删掉该条记录（无状态）
- 记录对应的文档不存在时会被忽略，并在看板顶部提示有多少条这种记录
- 手写的 `tags: "a, b"`、纯列表、空值都能读
- YAML 写坏时看板顶部报错，并且**拒绝写回**，避免把文件覆盖成"看起来正常"的内容

## 配置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `markdownKanban.defaultLists` | `[]` | 新建看板文件时写入的默认列表；看板文件没有 `lists` 键时的回退值。默认为空（仅保留 `No status`）。支持 `tag:显示名` |
| `markdownKanban.excludeDirectories` | `node_modules`, `.git`, `dist` … | 不扫描的目录名 |
| `markdownKanban.sortBy` | `updated` | 列内排序：`updated` 或 `title` |
| `markdownKanban.openMode` | `beside` | 点卡片时在侧边打开（看板保留）还是当前标签页。`beside` 固定复用看板右边那一个编辑组 |
| `markdownKanban.maxFiles` | `3000` | 最多扫描多少个文件 |

## 快捷操作

| 操作 | 效果 |
| --- | --- |
| 点卡片 | 打开对应文档（同一张卡片反复点只会有同一个标签页，不会越开越多） |
| 拖拽卡片 | 换列（写看板文件） |
| 卡片聚焦后按 `Enter` / `Space` | 打开文档 |
| 卡片聚焦后按 `m` | 打开操作菜单 |
| 点 tag chip | 过滤该标签（可多选） |
| 点看板右上角 `✎` | 切换成文本编辑器编辑这个 YAML |
| 最右端 `+ Add list` | 在末尾追加一列（表单内输入 `tag` 或 `tag:显示名`） |
| 拖拽列头 | 左右拖动即可重排列顺序（`No status` 不可拖），拖到最右槽 = 移到末尾 |
| 列头 `⋮` 菜单 | `Move left` / `Move right` / `Add list before` / `Add list after` / `Remove list`，键盘可达 |
| 列头 `×` | 删除该 list（卡片 tag 保留，回到 `No status`） |

## 开发

```bash
npm run compile   # 打包 dist/extension.js
npm run watch     # 监听编译
npm run typecheck # tsc 类型检查
npm test          # 48 个测试：文档扫描与摘要 / 看板文件读写 / list 插入·重排·删除 / 分列 / 自定义编辑器集成
```

### 启动调试宿主（F5）

按 `F5`（Run Extension）。如果宿主窗口刚打开就自己关掉、扩展也没加载，先看
**输出面板 → Markdown Kanban**（扩展自己的诊断日志）和 **输出 → Log (Extension Host)**。

已知情况：某些 VS Code 版本 / 配置文件下，F5 启动的宿主会在约 1 秒内以退出码 134（SIGABRT）
崩溃，此时扩展宿主的日志目录还没创建出来 —— 说明崩溃发生在加载本扩展之前，
与本扩展代码无关（本扩展是懒激活的纯 JS，模块加载实测 8ms）。排查顺序：

1. 用 **任务 → `Launch dev host (no debugger)`**：绕开 `--inspect-extensions`，能正常用就继续开发；
2. 用 **Run Extension (no other extensions)** 配置：排除其它已安装扩展的干扰；
3. 关掉 VS Code 后重命名该文件夹的窗口状态
   `%APPDATA%\Code\User\workspaceStorage\<hash>`（只丢窗口布局，可恢复）；
4. 彻底绕开调试器：`code --extensionDevelopmentPath="D:\vscode-kanban-trial" --new-window` 起一个普通实例，
   配合 `npm run watch` + 在该窗口按 `Ctrl+R` 重载即可迭代。

- [src/core/](src/core) 是不依赖 `vscode` 的纯逻辑（Markdown 扫描与摘要、看板文件读写、list 解析），单测覆盖
- [src/editor.ts](src/editor.ts) 是看板的自定义编辑器（`CustomTextEditorProvider`）与看板文件写回
- [media/](media) 是 webview 的前端（原生 JS + CSS，无构建步骤）
- [test/preview/preview.html](test/preview/preview.html) 是纯浏览器预览页，用假数据渲染看板，方便调 UI

## 已知取舍

- **只有 `*.kb.yaml` 会被写入**，Markdown 文档永远是只读的；卡片标题取文档里第一个 `#` 标题，没有标题时用文件名
- 看板是**文本自定义编辑器**（不是纯 Webview），所以编辑器里始终是同一个 `TextDocument`：外部/文本编辑器改动会实时反映到看板，`Ctrl+Z` 撤销也走正常文本撤销栈
- 移动卡片后如果该文件原本是干净的会自动保存；如果原本有未保存改动则只改缓冲区，不覆盖你的编辑
- 看板文件语法错误时只提示、不写回，避免猜测破坏内容
