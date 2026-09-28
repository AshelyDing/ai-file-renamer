const fs = require('fs/promises');
const path = require('path');
// import type 为纯类型导入：编译时擦除，不产生运行时 require
import type { AIConfig } from './aiService';
const { configureAI } = require('./aiService');
const { getConfigDir } = require('./portable-config');

/**
 * configStore.ts —— 配置持久化模块（主进程）。
 *
 * 职责：把 AI 接口配置（apiKey / baseUrl / model / timeoutMs）持久化为 JSON 文件。
 *  - 便携模式：exe 同级目录 AIFileRenamer/config.json
 *  - 开发模式：Electron 默认 userData 目录 config.json
 * 读取失败不阻断启动（回退默认配置），写入失败抛出友好错误供界面展示。
 */

/** 配置文件名 */
const CONFIG_FILE_NAME = 'config.json';

/** 默认配置（与 aiService 的默认值保持一致） */
const DEFAULT_CONFIG: AIConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  timeoutMs: 30_000,
};

/** 内存中的当前配置 */
let currentConfig: AIConfig = { ...DEFAULT_CONFIG };

/** 配置文件的完整路径（便携模式：AIFileRenamer/config.json；开发模式：默认 userData） */
function configFilePath(): string {
  return path.join(getConfigDir(), CONFIG_FILE_NAME);
}

/**
 * 校验并清洗配置数据：只保留合法字段，非法或缺失的字段回退默认值。
 * 磁盘上的 JSON 可能被手工改坏或字段缺失，逐字段兜底保证类型安全。
 */
function sanitizeConfig(raw: unknown): AIConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    baseUrl: str(obj.baseUrl, DEFAULT_CONFIG.baseUrl),
    apiKey: str(obj.apiKey, DEFAULT_CONFIG.apiKey),
    model: str(obj.model, DEFAULT_CONFIG.model),
    timeoutMs: num(obj.timeoutMs, DEFAULT_CONFIG.timeoutMs),
  };
}

/**
 * 从磁盘加载配置到内存（应用启动时调用一次）。
 * 文件不存在 → 使用默认配置；读取/解析异常 → 记录警告并使用默认配置，不让异常阻断启动。
 * 加载完成后同步到 aiService，使 AI 请求使用加载到的配置。
 */
async function loadConfig(): Promise<AIConfig> {
  const file = configFilePath();
  try {
    const content = await fs.readFile(file, 'utf-8');
    currentConfig = sanitizeConfig(JSON.parse(content));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[config] 读取配置文件失败，使用默认配置（${file}）：`, err);
    }
    currentConfig = { ...DEFAULT_CONFIG };
  }
  configureAI(currentConfig);
  return { ...currentConfig };
}

/** 读取内存中的当前配置（返回副本，供设置界面展示） */
function getConfig(): AIConfig {
  return { ...currentConfig };
}

/** 更新内存中的配置（部分字段），同步应用到 aiService；落盘需调用 saveConfig */
function setConfig(partial: Partial<AIConfig>): void {
  currentConfig = sanitizeConfig({ ...currentConfig, ...partial });
  configureAI(currentConfig);
}

/**
 * 把内存中的配置写入 JSON 文件（自动创建配置目录）。
 * 写入失败抛出友好错误（设置界面可展示给用户）。
 */
async function saveConfig(): Promise<void> {
  const file = configFilePath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true }); // 自动创建配置目录
    await fs.writeFile(file, JSON.stringify(currentConfig, null, 2), 'utf-8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`保存配置失败（${file}）：${detail}`);
  }
}

// CommonJS 导出：与原先的 export 一一对应（供 main.ts require 使用）
module.exports = {
  loadConfig,
  getConfig,
  setConfig,
  saveConfig,
};
