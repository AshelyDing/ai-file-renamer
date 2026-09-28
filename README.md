# AI File Renamer

AI 自动重命名文件的桌面 GUI 工具，基于 **Electron + TypeScript**。
读取文件内容后调用大模型（默认 DeepSeek，兼容 OpenAI 格式接口）生成语义化文件名，
支持**单文件**与**批量**两种模式，打包产物为 Windows 单文件便携 exe（绿色免安装）。

## 功能清单

- **单文件重命名**：原生对话框选文件 → 提取内容预览 → AI 生成建议名（可手动修改）→ 一键重命名
- **批量重命名**：多选文件 → 逐个提取内容 → 并发限流（最多 3 并发，防接口限流）批量生成 AI 名称 → 表格内逐行编辑 → 批量执行，逐条标记成功 / 失败并汇总统计
- **命名模板**：智能命名 / 主题-日期 / 作者-主题 / 项目-主题-版本 / 简短描述
- **AI 设置面板**：API Key、接口地址、模型下拉，保存后持久化（JSON）并立即生效
- **绿色便携**：打包为单文件 portable exe，配置 / 缓存 / 日志全部存放在 exe 同级目录，不写 C 盘 AppData
- **友好错误**：网络超时、接口报错、内容为空、同名冲突、权限不足等均有中文提示

## 支持的文件类型

| 类型 | 内容提取方式 | 提取范围 |
| --- | --- | --- |
| pdf | pdf-parse | 前 3 页文本 |
| docx | mammoth | 全文（docx 不含分页信息，统一截断 3000 字符，约等于前 3 页） |
| xlsx | xlsx（SheetJS） | 第一个工作表前 10 行 |
| png / jpg / jpeg | tesseract.js 本地 OCR | 图片内全部文字 |

所有提取文本统一截断为最多 3000 字符。

## 开发环境部署步骤

环境要求：**Node.js 20+**（Electron 32 内置 Node 20）、npm。

```bash
# 1. 安装依赖
npm install

# 2. 开发启动（tsc 编译 + electron 运行）
npm start
```

源码目录结构：

```
ai-file-renamer/
├── src/
│   ├── main/                  # 主进程
│   │   ├── main.ts            # 入口：窗口、IPC 处理器、单文件与批量重命名
│   │   ├── preload.ts         # contextBridge 安全桥（window.api）
│   │   ├── fileReader.ts      # pdf / docx / xlsx / 图片 内容提取
│   │   ├── aiService.ts       # 调用大模型生成文件名（默认 DeepSeek）
│   │   ├── configStore.ts     # AI 接口配置 JSON 持久化
│   │   └── portable-config.ts # 便携模式路径重定向（配置/缓存/日志 → exe 同级）
│   └── renderer/              # 渲染进程（GUI）
│       ├── index.html
│       └── renderer.ts
├── scripts/copy-assets.cjs    # 构建时复制静态资源到 dist
├── package.json               # 依赖 + electron-builder 打包配置
└── tsconfig.json
```

## 打包便携 exe

```bash
npm run dist
```

- 产物：`dist/AI File Renamer-v0.1.0-portable.exe`（**单文件，无需安装，双击即用**）
- 打包目标：Windows x64 portable；已开启 asar；`tesseract.js` 已配置 `asarUnpack` 避免 WASM 加载失败
- 国内网络下载 Electron 二进制慢时，打包前设置镜像：
  `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

## 软件使用教程

### 第 0 步：配置 AI 接口（首次使用必做）

1. 启动后展开顶部「**AI 设置**」面板
2. 填写 API Key（DeepSeek 可在 https://platform.deepseek.com 申请）、
   接口地址（默认 `https://api.deepseek.com/v1`，可换成任意 OpenAI 兼容接口）、
   模型（默认 `deepseek-chat`）
3. 点击「保存配置」，出现绿色提示即生效；配置会持久化，下次启动自动加载

### 单文件重命名

1. 工作模式选「单文件模式」
2. 点击「选择文件」→ 系统对话框选文件 → 内容预览区自动显示提取的文本
3. 选择命名模板（或保持「智能命名」）
4. 点击「生成 AI 文件名」→ 建议名出现在输入框，可手动修改
5. 点击「确认重命名」，状态栏提示成功后完成

### 批量重命名

1. 工作模式切到「批量模式」（切换模式会清空当前数据）
2. 点击「选择多个文件」→ 多选 → 逐个读取内容，表格实时刷新
3. 选择命名模板 → 点击「批量生成 AI 名称」（并发 ≤3，进度实时显示）
4. 在表格「手动编辑」列微调名称（读取 / 生成失败的行会标红显示原因，不参与重命名）
5. 点击「批量执行重命名」→ 每条记录独立标记成功 / 失败，底部显示统计（成功数 / 失败数）

## 注意事项

1. **API 密钥**：密钥仅保存在本地配置文件（便携模式：exe 同级 `AIFileRenamer/config.json`；
   开发模式：系统 userData 目录），只发送给你所配置的 AI 接口，不会上传到其他地方。
   请勿分享含密钥的配置目录。未配置 API Key 时点击生成会得到明确提示。
2. **OCR 语言包下载**：png / jpg 走 tesseract.js **本地 OCR**（中英语言包 chi_sim+eng）。
   首次识别需联网自动下载语言包（约几十 MB）到缓存目录（便携模式：`AIFileRenamer/cache/`；
   开发模式：项目目录下 `tesseract-js-cache/`，已在 .gitignore 中忽略）。
   下载期间状态栏停留在「正在读取文件内容」属正常；下载完成后完全离线识别。
3. **同名文件风险**：重命名**不会自动覆盖**已有文件。目标目录已存在同名文件时会失败并提示
   「同目录下已存在…」，请先改名或删除冲突文件。批量模式下单条失败不影响其余文件，
   处理完冲突后可再次点击「批量执行重命名」（成功行不会重复执行，会提示新旧名相同）。
4. 便携 exe 启动时会把运行时解压到系统临时目录（%TEMP%），退出后自动清理——这是单文件
   便携程序的固有机制，不属于配置 / 缓存写入；若 exe 位于只读介质（如光盘），程序会自动
   回退到系统默认路径以保证可启动。
5. `xlsx` 使用 npm 上的 0.18.5（SheetJS 新版改为官网 CDN 分发）。
6. 便携模式数据目录名为 `AIFileRenamer`（位于 exe 同级），删除该目录即恢复出厂设置。

## 便携模式目录布局

```
AI File Renamer.exe        <- 单文件便携 exe
AIFileRenamer/             <- 首次运行自动生成
├── cache/                 <- tesseract 语言包等业务缓存
├── logs/                  <- 日志
└── config.json            <- AI 接口配置（含 API Key）
```
