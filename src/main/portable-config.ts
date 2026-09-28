const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * portable-config.ts —— 便携模式（portable）路径管理。
 *
 * 路径判断逻辑：
 * 1. electron-builder 打包的 portable 单文件 exe 启动时，会把程序解压到系统临时目录运行，
 *    并注入环境变量 PORTABLE_EXECUTABLE_DIR（值为 exe 所在目录）；
 * 2. 开发模式（npm start / electron .）没有该变量，此时不修改任何 Electron 默认路径；
 * 3. 便携模式下若 exe 同级目录不可写（如只读介质），回退默认路径，保证程序仍可启动。
 *
 * 便携模式目录布局（全部位于 exe 同级目录，不写 C 盘 AppData）：
 *   AIFileRenamer/          <- userData（Electron 配置与 Chromium 缓存随 userData 一并迁入）
 *   ├── cache/              <- 业务缓存（tesseract 语言包等，经 getCacheDir() 取用）
 *   ├── logs/               <- 日志（Electron logs 路径）
 *   └── config.json         <- 应用配置（configStore 读写）
 */

/** portable exe 运行时由 electron-builder 注入的环境变量（exe 所在目录） */
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR;

/** 便携数据根目录名称（exe 同级目录下的 AIFileRenamer 文件夹） */
const PORTABLE_ROOT_NAME = 'AIFileRenamer';

/** 便携数据根目录（仅便携模式且初始化成功时非 null） */
let portableRoot: string | null = null;

/** 是否运行在便携 exe 中（判断依据：PORTABLE_EXECUTABLE_DIR 环境变量是否存在） */
function isPortable(): boolean {
  return PORTABLE_DIR !== undefined;
}

/** 便携数据根目录；非便携模式为 null */
function getPortableRoot(): string | null {
  return portableRoot;
}

/**
 * 缓存目录：
 * - 便携模式：AIFileRenamer/cache（tesseract 语言包等业务缓存）
 * - 开发模式：null，由调用方使用各自默认位置（如 tesseract 默认缓存目录）
 */
function getCacheDir(): string | null {
  return portableRoot ? path.join(portableRoot, 'cache') : null;
}

/**
 * 配置目录（config.json 所在目录）：
 * - 便携模式：AIFileRenamer（即重定向后的 userData）
 * - 开发模式：Electron 默认 userData（开发环境不改动任何路径）
 */
function getConfigDir(): string {
  return portableRoot ?? app.getPath('userData');
}

/**
 * 必须在 app ready 之前调用（main.ts 顶部）。
 * 便携模式：把 userData / sessionData / logs 重定向到 exe 同级目录下的 AIFileRenamer 文件夹，
 *           Chromium 磁盘缓存与 GPU 缓存默认位于 userData 之下，随 userData 一并迁移；
 * 开发模式：直接返回，不修改任何路径。
 */
function setupPortablePaths(): void {
  if (!PORTABLE_DIR) {
    return; // 开发模式（npm start），保持 Electron 默认路径不变
  }

  const root = path.join(PORTABLE_DIR, PORTABLE_ROOT_NAME);

  try {
    // 提前创建目录并试写，检测 exe 所在位置是否可写
    fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });

    app.setPath('userData', root);
    app.setPath('sessionData', root);
    app.setPath('logs', path.join(root, 'logs'));

    portableRoot = root;
  } catch (err) {
    // exe 位于只读介质等场景：回退到系统默认路径，保证程序仍可启动
    portableRoot = null;
    console.warn('[portable] exe 同级目录不可写，回退到系统默认路径：', err);
  }
}

// CommonJS 导出：与原先的 export 一一对应（供 main.ts / fileReader.ts / configStore.ts require 使用）
module.exports = {
  isPortable,
  getPortableRoot,
  getCacheDir,
  getConfigDir,
  setupPortablePaths,
};

// 空导出：仅把本文件标记为 TypeScript 模块，隔离全局作用域
// （避免与 fileReader.ts 等文件的顶层变量重名），编译后不产生任何运行时代码
export {};
