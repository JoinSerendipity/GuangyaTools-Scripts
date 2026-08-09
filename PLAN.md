# 光鸭网盘清理文件与解散子目录用户脚本计划

## Context

目标是在当前空项目中，用 Vue + `vue-monkey-plugin` 开发一个面向光鸭网盘的用户脚本，先实现 115 不大助手中的两个能力：

1. **清理文件**：在当前目录按规则找出可清理项并批量删除。
2. **解散子目录**：对选中的目录，将其子目录内的文件移动到选中目录，然后删除已经为空的子目录。

已读取 115 不大助手 GreasyFork 脚本的更新源（`update.greasyfork.org/scripts/474231/code.user.js`）。仓库当前为空，用户已确认允许新建 Vue + `vue-monkey-plugin` 项目。

已确认约束：

- 光鸭网盘入口地址：`http://guangyapan.com/`，会跳转到 `https://www.guangyapan.com/`。
- 清理文件需要实现 115 除 SHA1 外的能力：后缀、文件类型、文件名关键词、目录名关键词、大小上限、正则/匹配策略等。
- 删除动作必须走回收站/站点普通删除流程，不使用永久删除/清空回收站接口。

## Approach

推荐实现一个 Vue 3 + TypeScript userscript：注入光鸭网盘“全部文件”页面，新增工具按钮/面板；把页面适配、鉴权捕获、API 请求、规则匹配、批处理和 UI 状态分层。

> npm 上不存在名为 `vue-monkey-plugin` 的包；用户已确认采用 `vite-plugin-monkey`（当前 npm 最新版 8.1.0）配合 Vue 3 + TypeScript。

### 115 脚本中可借鉴的行为

- **清理文件**
  - 入口按钮文字为“清理文件”，打开抽屉式“文件清理工具”。
  - 支持按后缀、文件类型、文件名关键词、目录名关键词等规则查询当前目录文件；本项目明确不实现 SHA1 清理。
  - 删除前先预查询数量和大小，再弹窗确认。
  - 删除使用分批执行，115 中每批约 1150 个并间隔请求，避免接口压力过大。
- **解散子目录**
  - 入口可出现在选中文件夹的操作菜单中。
  - 先确认：递归遍历选中目录下的子目录，将所有层级中的文件移动到选中目录，再删除已经为空的顶层子目录（其空目录树随之移入回收站）。
  - 对每个选中目录：分页查询目录树；收集全部后代文件；移动文件到选中目录；确认目录树已空；删除顶层子目录；展示进度和结果统计。

### 光鸭网盘实现策略

- 已静态分析光鸭网盘生产 bundle，确认 API 基址为 `https://api.guangyapan.com`，关键端点和调用形态如下：
  - `POST /userres/v1/file/get_file_list`：普通目录分页列表。请求为 `{ parentId, pageSize, orderBy, sortType, page }`；“全部文件”默认 `pageSize: 50, orderBy: 3, sortType: 1`。响应使用 `data.list`、`data.total`。
  - `POST /userres/v1/file/get_file_page_data`：按媒体类型获取目录内容；已确认参数包含 `{ fileId, pageSize, orderBy, sortType, dirType, resType, fileTypes }`，本项目的通用遍历优先使用 `get_file_list`。
  - `POST /userres/v1/file/search_files`：全局名称搜索，请求 `{ name, pageSize, page }`；它没有从静态调用中体现当前目录范围，因此目录范围清理优先分页遍历后在前端匹配。
  - `POST /userres/v1/file/move_file`：`{ fileIds, parentId }`，响应 `data.taskId`。
  - `POST /userres/v1/file/delete_file`：`{ fileIds }`，普通文件列表与回收站“彻底删除”共用端点，操作语义依赖文件当前位置；本项目只允许对普通目录项调用，使其进入回收站。
  - `POST /userres/v1/get_task_status`：`{ taskId }`，每秒轮询；`status === 2` 成功、`status === 3` 失败（已通过真实移动/删除任务验证）。
  - `POST /userres/v1/file/recycle_file`：回收站还原，不用于本功能删除。
- 已确认光鸭的目录路由为 `/home/all/*`，每段编码为 `fileId-fileName`；当前目录 ID 可由 hash 路由最后一段解析，根目录 ID 为 `""`。
- 已确认文件模型关键字段：`fileId`、`fileName`、`fileSize`、`parentId`、`parentName`、`fileType`、`dirType`、`resType`（1 文件、2 目录）、`ext`、`fullParentIds`、`ctime`、`utime`、`subFolderCount`。
- 已确认请求必须带页面登录上下文生成的 `Authorization: Bearer ...`、`did`、`dt: 4`、`traceparent`，可能还带 `smid`。userscript 在 `document-start` 阶段通过 `unsafeWindow` 包装页面 `XMLHttpRequest.setRequestHeader`，只捕获发往 `api.guangyapan.com` 的最新鉴权请求头；API 层复用这些头并在过期后等待页面下一次正常请求刷新，避免读取站点私有 OAuth SDK。
- 仍需通过 Chrome DevTools MCP 在登录态验证：真实请求/响应样例、跨域调用可行性、普通目录删除进入回收站、批量数量限制和同名移动冲突返回。
- 将 API 封装为 `NetdiskApi`，业务逻辑只依赖 `listChildren`、`walkDescendants`、`moveItems`、`trashItems`、`waitTask`；所有分页、批量大小、重试和限速都集中在 API/批处理层。
- 页面适配器用 `MutationObserver` 跟随 React SPA 路由与重渲染：从 `/home/all/*` 解析当前目录；从列表行/卡片及勾选状态读取选中 ID，再用当前已加载列表或 API 补齐文件对象。无法稳定读取选中项时，解散功能提供“输入/选择当前目录下文件夹”的降级入口，不读取 React 私有 Fiber。
- UI 提供两个入口：
  - 路径栏附近“清理文件”按钮：打开右侧规则抽屉。
  - 选中文件夹后的“解散子目录”按钮：确认后显示逐目录进度。
- 危险操作统一采用“预扫描 → 展示命中项/总大小/冲突 → 二次确认 → 执行 → 轮询任务 → 汇总结果”；删除只调用普通目录项的 `delete_file`。

## Files to modify

仓库为空，预计新增：

- `package.json`：项目脚本与依赖。
- `vite.config.ts`：配置 `vue-monkey-plugin`、userscript metadata、目标匹配域名。
- `src/main.ts`：userscript 入口、挂载 Vue 根组件。
- `src/App.vue`：入口按钮与面板容器。
- `src/components/CleanerPanel.vue`：清理文件 UI。
- `src/components/FlattenSubfoldersButton.vue`：解散子目录入口与进度弹窗。
- `src/services/authCapture.ts`：捕获并更新页面 API 鉴权请求头。
- `src/services/guangyaApi.ts`：光鸭 API、分页、任务轮询和错误标准化。
- `src/services/cleaner.ts`：规则解析、前端匹配、预览和分批移入回收站（不含 SHA1）。
- `src/services/flattenSubfolders.ts`：递归扫描、冲突预检、移动和空目录删除。
- `src/services/pageAdapter.ts`：解析 hash 路由、读取选中项、注入按钮并适配 SPA 重渲染。
- `src/utils/batch.ts`：限速、分批、取消信号和统计。
- `src/types.ts`：文件、目录、规则、API 与任务类型。
- `src/**/*.test.ts`：规则解析/匹配、分页、批处理和解散流程测试。

## Reuse

从 115 脚本复用思路而非直接复制代码：

- 分批删除/移动 + 请求间隔，参考 115 的 `getFilesList`、`rb/delete`、`files/move` 批处理思路。
- 清理前“预查询 → 展示数量/大小 → 确认 → 批量删除”的流程。
- 解散子目录的处理顺序：列子目录 → 移动子目录文件到父目录 → 删除空子目录 → 展示统计。
- 关键词规则借鉴：普通包含匹配、目录名前缀、大小上限、区分大小写、完整匹配、正则匹配；排除 SHA1。

## Steps

- [x] 确认光鸭网盘域名：`https://www.guangyapan.com/`。
- [x] 静态确认目录路由、列表 API、文件模型、移动/删除/任务轮询端点。
- [x] 配置 Chrome DevTools MCP/Windows Chrome CDP，在登录态确认请求头、请求/响应样例、跨域鉴权复用、任务轮询及普通删除进入回收站；实现固定 50 项安全批次和本地同名预检。
- [x] 初始化 Vue 3 + TypeScript + `vite-plugin-monkey` userscript 项目，设置 `@match`、`@run-at document-start`、`unsafeWindow` 和 API 域名权限。
- [x] 实现 `authCapture.ts`，等待并复用页面最新鉴权上下文，禁止日志输出 token。
- [x] 实现 `guangyaApi.ts`：分页列表、移动、普通删除、任务轮询、业务错误和登录过期处理。
- [x] 实现 `pageAdapter.ts`：跟踪 `/home/all/*`、注入入口、读取选中目录并适配 React 重渲染。
- [x] 实现清理规则：后缀、文件类型、文件名关键词、目录名关键词、最大大小、包含/完整、区分大小写、正则；不实现 SHA1。
- [x] 实现清理预扫描和结果表格；只对用户最终勾选的普通目录项分批调用 `delete_file`，逐批等待任务成功。
- [x] 实现解散子目录：递归分页扫描全部后代；预检重名；分批将所有文件移动到选中目录；重新扫描确认无文件后，把顶层子目录移入回收站。
- [x] 加入进度、取消、部分失败重试、完成统计和页面刷新提示。
- [x] 加入进度、取消/失败提示、操作完成后的刷新/重新拉取提示。
- [x] 为核心筛选和批处理函数补单元测试或最小脚本测试。
- [x] 打包并在 Windows Chrome 登录态以 userscript 等价的 `document-start` 注入完成手动验证；产物可直接交给 Tampermonkey/Violentmonkey 安装。

## Verification

- `npm run dev`：本地开发构建不报错。
- `npm run build`：生成 userscript 文件。
- 单元测试：规则解析与组合、大小边界、目录/文件类型、正则错误、分页终止、批次切分、取消、部分失败、递归遍历与“未清空不删目录”。
- 手动测试清理文件：
  - 在隔离测试目录创建多种后缀/类型/名称/大小的文件与目录，验证预览命中准确。
  - 确认执行后项目出现在回收站，可还原；不调用清空回收站。
  - 测试无匹配、多页数据、失效登录、任务失败和中途取消。
- 手动测试解散子目录：
  - A/B/C 多层目录内放置文件；执行后所有文件位于 A，B 及其空目录树进入回收站。
  - 测试空子目录、同名文件、批量上限、移动部分失败、重新扫描仍有文件时禁止删目录。
- 使用 Chrome DevTools 检查 Console/Network：无 token 日志、无未捕获异常、请求参数与页面原生请求一致、每个 `taskId` 均轮询到终态。

## Open questions

- 已创建 `.mcp.json` 并连接 Windows Chrome CDP；下一次 Pi 会话会直接使用 `--browser-url=http://127.0.0.1:9222`。
- 已实现同名文件冲突策略：预扫描时识别目标目录已有同名项目以及待移动文件之间的重名；跳过冲突文件并在结果中列出，继续处理其他无冲突文件。由于冲突文件仍留在子目录中，对应目录树不得删除。
