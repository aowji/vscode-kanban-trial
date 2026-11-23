# Changelog

## 0.2.0

- 看板文件新增 `include:`：用 glob 搜索**未被 `cards:` 记录**的文档，命中的才作为 “No status” 卡片出现；`cards:` 里记录过的卡片始终显示，不受 glob 影响
- 看板顶部新增 Glob 过滤器输入框（没有设置时为空），回车或失焦保存回 `.kb.yaml`，Escape 取消；逗号分隔，括号里的逗号不会被拆开
- 新建看板的模板写入 `include: []`
- 文档扫描改用 globby 遍历、picomatch 做相对路径匹配；删除自研 glob 实现，并移除 `markdownKanban.includeGlobs` / `markdownKanban.excludeGlobs` 设置

## 0.1.0

- 首次发布
- 递归扫描看板文件所在目录的 Markdown，按 `*.kb.yaml` 里的 tag 分列显示为看板
- board / list / card 三层模型：一个 `*.kb.yaml` 是一个 board，`lists:` 定义它自己的列，每篇文档是一张 card
- 卡片状态只写进 `*.kb.yaml`，Markdown 文档永远不被修改
- 通过 `*.kb.yaml` 打开看板：同时注册为自定义编辑器（默认打开方式）和编辑器标题栏按钮
- 提供 `Create Board File` 命令生成看板文件
- 看板右上角 `✎` 可随时切回文本编辑器编辑 YAML
- 拖拽 / 菜单换列，仅重写看板文件里对应的一条记录
- list 支持拖列头重排、列头菜单在任意位置插入/移动/删除，顺序错了不需要删了重加；末尾用 `+ Add list` 追加
- 代码整理：删除 front matter 偏移扫描、多根扫描、未使用的 webview 状态与冗余刷新命令（配置项 `columns` 更名为 `defaultLists`）
- 不再解析 Markdown front matter：卡片标题取文档第一个 `#` 标题、否则用文件名，front matter 只被跳过（未闭合时在卡片上提示）
- 删除 `markdownKanban.showUnassigned` 设置：“No status” 列始终显示，避免关掉后无归属的卡片在看板上凭空消失
- 代码精简：合并 `editor.ts` 里三处重复的写回+刷新+报错逻辑，统一 `store.ts` 的看板解析与错误构造，删除无引用的 `findList` / `resolveLists`、卡片上未使用的 `data-list` 属性与死样式
- 命名对齐：`ParsedList` → `BoardList`、`BoardData` → `BoardFile`、`CardView.id/path` → `absPath/relPath`、`BoardState.context` → `meta`
- `package.json` 删除冗余的 `activationEvents`（VS Code 1.74+ 会按贡献点自动生成）
- 修复集成测试偶发失败：夹具写文件改为先写临时文件再 rename，避免测试读到半写状态
- 列可以折叠成窄条（列头 `❮`）：暂时不关注的列不占横向空间，折叠状态下仍可拖卡片进去；折叠状态是视图偏好，不写进看板文件
- 修复拖列时提示位置与实际落位不一致：拖到自己列上会被扔到最右端、列间空隙和 “No status” 列上是提示残留但不生效；现在按指针位置计算落位，提示线与最终位置始终一致
- 界面重做：列比页面略深、卡片浮起（深浅主题分别调过），卡片 hover 抬升并只在该时显示 `⋮`；标签条改为换行不再出现横向滚动条；列拖拽提示改成间隙里的一根强调色竖条；折叠箭头与 `+ Add list` 也一并收敛
- 列头菜单新增 `Rename list`：**改名就是改 tag** —— `lists:` 里那条与所有卡片上的同名 tag 一起改（大小写不敏感），卡片跟着留在该列
- 列名一律原样显示：去掉 `tag:显示名` 写法与自动美化（`in-progress` 不再显示成 “In Progress”）
- 卡片展示标题、标签 chips、修改时间与正文首段摘要
- 搜索与多标签过滤、文档与看板文件变更自动刷新
- 窗口重载后看板自动恢复；输出面板 → Markdown Kanban 提供诊断日志
