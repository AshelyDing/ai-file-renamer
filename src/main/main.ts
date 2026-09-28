// ==================== 模块引入（CommonJS 风格，编译产物可直接在 Electron 主进程加载） ====================
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { readFileText } = require('./fileReader');
const { getSuggestedFileName } = require('./aiService');
const { setupPortablePaths } = require('./portable-config');
const { loadConfig, getConfig, setConfig, saveConfig } = require('./configStore');
// 以下 import type 为纯类型导入：编译时完全擦除，不会出现在产物 JS 中。
// 类型没有运行时实体，无法用 require 引入，只能保留 import type。
import type * as Electron from 'electron';
import type { AIConfig } from './aiService';
import type { BatchRenameItemResult, BatchRenameTask, RenameResult } from './preload';
/**
 * main.ts —— 主进程入口。
 * 职责：便携路径初始化、加载持久化配置、创建窗口、
 *       注册 IPC 处理器（文件选择 / 内容读取 / AI 命名 / 单文件与批量重命名 / 配置读写）。
 */
// 必须在 app ready 之前调用：
// 便携 exe 运行时，将 userData（配置）、sessionData、日志全部重定向到 exe 同级目录，
// 保证不写入 C 盘 AppData。开发模式（npm start）下自动跳过，使用默认路径。
setupPortablePaths();
/** 主窗口引用（文件选择对话框作为其子窗口挂靠） */
let mainWindow: Electron.BrowserWindow | null = null;
/** 新文件名不允许出现的 Windows 非法字符 */
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*]/;
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    title: 'AI File Renamer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
win.webContents.openDevTools();
  mainWindow = win;
  win.on('closed', () => {
    mainWindow = null;
  });
  void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}
// ==================== 文件重命名工具函数 ====================
/** 把 fs.rename 抛出的底层错误翻译成友好提示（冲突 / 权限 / 文件不存在） */
function toFriendlyRenameError(err: unknown, oldPath: string, newName: string): Error {
  const code = (err as NodeJS.ErrnoException).code;
  const detail = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 'EEXIST':
      return new Error(`重命名失败：同目录下已存在「${newName}」，请更换名称或先处理同名文件。`);
    case 'EPERM':
    case 'EACCES':
      return new Error(
        `重命名失败：权限不足（${path.basename(oldPath)}），请检查文件是否被其他程序占用、目录是否可写。`,
      );
    case 'ENOENT':
      return new Error(`重命名失败：原文件不存在或已被移动（${path.basename(oldPath)}）。`);
    default:
      return new Error(`重命名失败（${path.basename(oldPath)}）：${detail}`);
  }
}
/**
 * 重命名工具函数：把 filePath 在同目录下改名为 newName。
 * 校验名称合法性，并捕获重命名冲突、权限不足等异常，统一抛出友好错误。
 * @param filePath 原文件完整路径
 * @param newName 新文件名（不含路径，重命名在原目录内进行）
 * @returns 原路径与新路径
 */
async function renameFile(filePath: string, newName: string): Promise<RenameResult> {
  const name = newName.trim();
  if (!name) {
    throw new Error('新文件名不能为空。');
  }
  if (name === path.basename(filePath)) {
    throw new Error('新文件名与原文件名相同，无需重命名。');
  }
  if (ILLEGAL_FILENAME_CHARS.test(name)) {
    throw new Error('新文件名包含非法字符（< > : " / \\ | ? *），请修改后重试。');
  }
  // 剔除控制字符（按码点判断，码点 < 32 视为控制字符）
  if (name.split('').some((ch) => ch.charCodeAt(0) < 32)) {
    throw new Error('新文件名包含控制字符，请修改后重试。');
  }
  const newPath = path.join(path.dirname(filePath), name);
  try {
    await fs.rename(filePath, newPath);
  } catch (err) {
    throw toFriendlyRenameError(err, filePath, name);
  }
  return { oldPath: filePath, newPath };
}
// ==================== 批量重命名 ====================
/**
 * 批量重命名基础逻辑：逐个调用 renameFile 执行，
 * 单个任务失败单独捕获并记录原因，不中断整批任务。
 * 返回结果数组（与输入顺序一致），渲染进程据此逐条标记成功 / 失败并汇总统计。
 */
async function batchRename(tasks: BatchRenameTask[]): Promise<BatchRenameItemResult[]> {
  const results: BatchRenameItemResult[] = [];
  for (const task of tasks) {
    try {
      const { newPath } = await renameFile(task.filePath, task.newName);
      results.push({ filePath: task.filePath, success: true, newPath });
    } catch (err) {
      // 单个失败只记录原因，继续处理剩余任务
      results.push({
        filePath: task.filePath,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
// ==================== IPC 处理器 ====================
/** 构造文件选择对话框参数（单文件 / 多文件由 properties 决定） */
function buildOpenDialogOptions(
  properties: Electron.OpenDialogOptions['properties'],
): Electron.OpenDialogOptions {
  return {
    title: '选择要重命名的文件',
    properties,
    filters: [
      {
        name: '支持的文件（pdf / docx / xlsx / png / jpg）',
        extensions: ['pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg'],
      },
      { name: '所有文件', extensions: ['*'] },
    ],
  };
}
/** 弹出文件选择对话框（挂靠主窗口） */
async function showOpenDialog(
  properties: Electron.OpenDialogOptions['properties'],
): Promise<Electron.OpenDialogReturnValue> {
  const options = buildOpenDialogOptions(properties);
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
}
/** 注册所有 ipcMain.handle 处理器（通道名与 preload.ts 中 window.api 的方法一一对应） */
function registerIpcHandlers(): void {
  // 文件选择（单文件模式）：取消时返回 null
  ipcMain.handle('file:selectFile', async (): Promise<string | null> => {
    const result = await showOpenDialog(['openFile']);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
  // 文件选择（批量模式，支持多选）：取消时返回空数组
  ipcMain.handle('file:selectMultiFile', async (): Promise<string[]> => {
    const result = await showOpenDialog(['openFile', 'multiSelections']);
    return result.canceled ? [] : result.filePaths;
  });
  // 文件内容读取：委托 fileReader.readFileText（异常已在该模块包装成友好错误）
  ipcMain.handle('file:readFileText', (_event: Electron.IpcMainInvokeEvent, filePath: string) => readFileText(filePath));
  // AI 生成文件名：委托 aiService.getSuggestedFileName（异常已在该模块包装成友好错误）
  ipcMain.handle('ai:getSuggestedFileName', (_event: Electron.IpcMainInvokeEvent, extractedText: string, template: string) =>
    getSuggestedFileName(extractedText, template),
  );
  // 单文件重命名：本地工具函数，冲突 / 权限异常已包装成友好错误
  ipcMain.handle('file:renameFile', (_event: Electron.IpcMainInvokeEvent, filePath: string, newName: string) =>
    renameFile(filePath, newName),
  );
  // 批量重命名：单个失败不中断整批，返回逐条结果（渲染进程据此标记成功 / 失败）
  ipcMain.handle('file:batchRename', (_event: Electron.IpcMainInvokeEvent, tasks: BatchRenameTask[]) => batchRename(tasks));
  // 应用配置：读取内存中的配置（configStore 内部已同步到 aiService）
  ipcMain.handle('app:getConfig', () => getConfig());
  // 应用配置：保存（先合并进内存并同步 aiService，再写入 JSON 文件；写盘失败抛友好错误）
  ipcMain.handle('app:saveConfig', async (_event: Electron.IpcMainInvokeEvent, config: Partial<AIConfig>) => {
    setConfig(config);
    await saveConfig();
  });
}
// ==================== 应用生命周期 ====================
void app.whenReady().then(async () => {
  // 启动时加载已保存的 AI 配置（文件缺失/损坏时回退默认值，不会阻断启动）
  await loadConfig();
  registerIpcHandlers();
  createWindow();
  // macOS 行为：点击 Dock 图标且无窗口时重建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
