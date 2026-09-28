// CommonJS 引入（preload 在沙箱中以 CommonJS 形式加载）
const { contextBridge, ipcRenderer } = require('electron');
// import type 为纯类型导入：编译时擦除，不产生运行时 require
import type { AIConfig } from './aiService';
/**
 * preload —— 渲染进程与主进程之间的安全桥。
 *
 * 所有业务能力通过 ipcRenderer.invoke 调用主进程注册的 ipcMain.handle 处理器，
 * 渲染进程只拿到一个纯函数式的 window.api，不接触任何 Node 能力。
 * 通道名与 main.ts 中 registerIpcHandlers() 一一对应。
 */
// 以下 interface 全部为纯类型导出：编译时完全擦除，不产生任何运行时导出。
// 类型无法用 module.exports 导出；renderer.ts / main.ts 通过 import type 复用这些类型。
/** 文件重命名结果 */
export interface RenameResult {
  /** 原文件路径 */
  oldPath: string;
  /** 重命名后的文件路径 */
  newPath: string;
}
/** 批量重命名中的单个任务 */
export interface BatchRenameTask {
  /** 原文件路径 */
  filePath: string;
  /** 新文件名（不含路径，在原目录内改名） */
  newName: string;
}
/** 批量重命名中单个任务的执行结果（失败时不抛出，只记录 error） */
export interface BatchRenameItemResult {
  /** 原文件路径 */
  filePath: string;
  /** 执行是否成功 */
  success: boolean;
  /** 成功时的新路径 */
  newPath?: string;
  /** 失败时的错误原因（友好提示） */
  error?: string;
}
/** 渲染进程可用的 API（window.api 的类型，单一来源，renderer.ts 通过 import type 复用） */
export interface RendererApi {
  /** 弹出系统原生文件选择对话框（单文件），取消时返回 null */
  selectFile(): Promise<string | null>;
  /** 弹出系统原生文件选择对话框（批量模式，支持多选），取消时返回空数组 */
  selectMultiFile(): Promise<string[]>;
  /** 读取文件内容（pdf/docx/xlsx/png/jpg），返回最多 3000 字符的纯文本 */
  readFileText(filePath: string): Promise<string>;
  /** 请求 AI 根据内容摘要与命名模板生成建议文件名 */
  getSuggestedFileName(extractedText: string, template: string): Promise<string>;
  /** 用新名称重命名单个文件（新名不含路径，在原目录内改名） */
  renameFile(filePath: string, newName: string): Promise<RenameResult>;
  /** 批量重命名：单个失败不中断整批，返回逐条结果（与输入顺序一致） */
  batchRename(tasks: BatchRenameTask[]): Promise<BatchRenameItemResult[]>;
  /** 读取应用配置（AI 接口设置，configStore 中的 JSON 配置） */
  getAppConfig(): Promise<AIConfig>;
  /** 保存应用配置（AI 接口设置），保存后立即生效并持久化到 JSON 文件 */
  saveAppConfig(config: Partial<AIConfig>): Promise<void>;
  /** 运行环境版本信息（启动页展示用） */
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}
const api: RendererApi = {
  selectFile: () => ipcRenderer.invoke('file:selectFile') as Promise<string | null>,
  selectMultiFile: () => ipcRenderer.invoke('file:selectMultiFile') as Promise<string[]>,
  readFileText: (filePath) => ipcRenderer.invoke('file:readFileText', filePath) as Promise<string>,
  getSuggestedFileName: (extractedText, template) =>
    ipcRenderer.invoke('ai:getSuggestedFileName', extractedText, template) as Promise<string>,
  renameFile: (filePath, newName) =>
    ipcRenderer.invoke('file:renameFile', filePath, newName) as Promise<RenameResult>,
  batchRename: (tasks) =>
    ipcRenderer.invoke('file:batchRename', tasks) as Promise<BatchRenameItemResult[]>,
  getAppConfig: () => ipcRenderer.invoke('app:getConfig') as Promise<AIConfig>,
  saveAppConfig: (config) => ipcRenderer.invoke('app:saveConfig', config) as Promise<void>,
  versions: {
    electron: process.versions.electron!,
    chrome: process.versions.chrome!,
    node: process.versions.node,
  },
};
contextBridge.exposeInMainWorld('api', api);
