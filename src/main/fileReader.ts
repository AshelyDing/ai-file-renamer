/**
 * fileReader.ts —— 文件内容提取模块（主进程）。
 *
 * 职责：按扩展名读取各类文件并提取纯文本，供后续 AI 自动重命名使用。
 *   - png / jpg / jpeg ：tesseract.js 本地 OCR 识别图片文字
 *   - pdf              ：pdf-parse 提取前 3 页文本
 *   - docx             ：mammoth 提取文档文本（docx 不含分页信息，按 3000 字符截断 ≈ 前 3 页）
 *   - xlsx             ：xlsx 库读取第一个工作表前 10 行
 * 所有提取结果统一去除首尾空白并截断为最多 3000 字符；
 * 任何读取/解析异常都会被包装成带文件名与类型说明的友好错误抛出。
 */

const path = require('path');
const { access, readFile } = require('fs/promises');
const pdfParse = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const XLSX = require('xlsx');
// mammoth：require 形式下不参与模块类型解析，按 any 使用（无需 @types/mammoth）
const mammoth = require('mammoth');
const { getCacheDir } = require('./portable-config');

/** 提取文本统一截断长度（避免后续喂给 AI 的内容过大） */
const MAX_TEXT_LENGTH = 3000;
/** PDF 最多解析到的页码（0 基：2 表示第 1~3 页） */
const PDF_MAX_PAGE_INDEX = 2;
/** xlsx 读取的行数上限 */
const XLSX_MAX_ROWS = 10;
/** OCR 语言包：简体中文 + 英文；首次使用自动下载到缓存目录，之后完全离线本地识别 */
const OCR_LANGS = 'chi_sim+eng';

/** 去除首尾空白并截断到 maxLength 字符 */
function truncateText(text: string, maxLength = MAX_TEXT_LENGTH): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** 把底层异常包装成带文件名与类型上下文的友好错误 */
function toFriendlyError(kind: string, filePath: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(`读取${kind}文件失败（${path.basename(filePath)}）：${detail}`);
}

/** 校验文件是否可访问，给出比底层 ENOENT 更友好的提示 */
async function assertFileAccessible(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(`文件不存在或无法访问：「${filePath}」`);
  }
}

/**
 * png / jpg / jpeg：tesseract.js 本地 OCR 提取图片中的文字。
 * 语言包首次使用会下载到缓存目录（便携模式下为 exe 同级 cache/），此后离线识别。
 */
async function extractImageText(filePath: string): Promise<string> {
  const cacheDir = getCacheDir();
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  try {
    worker = await createWorker(OCR_LANGS, 1, {
      // 便携模式下把语言包缓存到 exe 同级目录；开发模式不传，使用 tesseract 默认缓存位置
      ...(cacheDir ? { cachePath: cacheDir } : {}),
      logger: (m: { status: string; progress: number }) => console.log(`[OCR] ${m.status} ${Math.round(m.progress * 100)}%`),
    });
    const { data } = await worker.recognize(filePath);
    if (!data.text.trim()) {
      throw new Error('图片中未识别出任何文字（可能是纯图形、文字过小或过于模糊）');
    }
    return truncateText(data.text);
  } catch (err) {
    throw toFriendlyError('图片（OCR）', filePath, err);
  } finally {
    // 无论成败都释放 worker；清理失败不影响主流程
    try {
      await worker?.terminate();
    } catch {
      /* 忽略清理异常 */
    }
  }
}

/** pdf：读取前 3 页文本（扫描版 PDF 无文字层时会给出明确提示） */
async function extractPdfText(filePath: string): Promise<string> {
  try {
    const buffer = await readFile(filePath);
    // max 为 0 基页码：2 表示最多解析到第 3 页（即前 3 页）
    const result = await pdfParse(buffer, { max: PDF_MAX_PAGE_INDEX });
    if (!result.text.trim()) {
      throw new Error('PDF 未提取到文本（可能是扫描版 PDF，无文字层）');
    }
    return truncateText(result.text);
  } catch (err) {
    throw toFriendlyError('PDF', filePath, err);
  }
}

/**
 * docx：提取文档文本。
 * 说明：docx 文件格式本身不存储分页信息，无法精确截取"前 3 页"；
 * 这里提取全文并统一按 3000 字符截断，量级上约等于前 3 页的文字量。
 */
async function extractDocxText(filePath: string): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    if (!result.value.trim()) {
      throw new Error('文档中未提取到文本');
    }
    return truncateText(result.value);
  } catch (err) {
    throw toFriendlyError('Word（docx）', filePath, err);
  }
}

/** xlsx：读取第一个工作表的前 10 行，每行单元格用 " | " 拼接，行间换行 */
async function extractXlsxText(filePath: string): Promise<string> {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) {
      throw new Error('工作簿中没有可读取的工作表');
    }
    // header:1   → 按行输出二维数组（不把首行当表头）
    // raw:false  → 取单元格格式化后的显示文本，而非原始值
    // defval:''  → 空单元格补空字符串
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: '',
    });
    const text = rows
      .slice(0, XLSX_MAX_ROWS)
      .map((row) =>
        row
          .map((cell) => String(cell ?? '').trim())
          .filter((cell) => cell.length > 0)
          .join(' | '),
      )
      .filter((line) => line.length > 0)
      .join('\n');
    if (!text) {
      throw new Error('工作表前 10 行没有内容');
    }
    return truncateText(text);
  } catch (err) {
    throw toFriendlyError('Excel（xlsx）', filePath, err);
  }
}

/**
 * 统一的文件读取入口：按扩展名分发到对应解析器。
 * @param filePath 待读取的文件路径
 * @returns 提取出的纯文本（最多 3000 字符）
 * @throws 文件不存在、类型不支持或解析失败时抛出友好错误
 */
async function readFileText(filePath: string): Promise<string> {
  await assertFileAccessible(filePath);

  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
    case '.jpg':
    case '.jpeg':
      return await extractImageText(filePath);
    case '.pdf':
      return await extractPdfText(filePath);
    case '.docx':
      return await extractDocxText(filePath);
    case '.xlsx':
      return await extractXlsxText(filePath);
    default:
      throw new Error(
        `不支持的文件类型「${path.extname(filePath) || '无扩展名'}」，仅支持 png / jpg / pdf / docx / xlsx`,
      );
  }
}

// CommonJS 导出：与原先的 export 一一对应（供 main.ts require 使用）
module.exports = {
  extractImageText,
  extractPdfText,
  extractDocxText,
  extractXlsxText,
  readFileText,
};

// 空导出：仅把本文件标记为 TypeScript 模块，隔离全局作用域
// （避免与 portable-config.ts 等文件的顶层变量重名），编译后不产生任何运行时代码
export {};
