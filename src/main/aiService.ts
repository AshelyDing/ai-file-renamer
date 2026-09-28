/**
 * aiService.ts —— AI 重命名服务（主进程）。
 *
 * 职责：把文件解析出的文本与用户选择的命名模板发送给大模型接口，
 * 返回推荐的新文件名（含扩展名）。
 *
 * 默认对接 DeepSeek（OpenAI 兼容格式：POST {baseUrl}/chat/completions），
 * 通过 configureAI() 可切换 API Key、接口地址与模型，兼容任意 OpenAI 格式网关。
 *
 * 依赖：axios（自带类型声明，无需额外类型包）。
 */

// axios 自带类型声明；require 返回 any，这里用类型断言恢复静态类型
// （断言在编译时擦除，运行时仍是普通 require）。保留类型后 axios.isAxiosError
// 仍可作为类型守卫，正确收窄 err 的类型（原 import type { AxiosError } 未实际使用，一并移除）
const axios = require('axios') as typeof import('axios').default;

// ==================== 类型定义 ====================

// 纯类型导出：编译时完全擦除，不产生运行时导出（preload.ts / configStore.ts 通过 import type 引用）
/** AI 接口配置（可在运行时通过 configureAI 修改） */
export interface AIConfig {
  /** 接口地址（OpenAI 兼容格式的 baseUrl），默认 DeepSeek：https://api.deepseek.com/v1 */
  baseUrl: string;
  /** API Key（未配置时调用会直接抛出友好错误） */
  apiKey: string;
  /** 模型名称，默认 deepseek-chat */
  model: string;
  /** 请求超时（毫秒），默认 30 秒 */
  timeoutMs: number;
}

/** OpenAI 兼容的聊天消息 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** OpenAI 兼容 /chat/completions 响应体（仅声明本模块用到的字段） */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  /** 部分网关会在 HTTP 200 的响应体里附带错误信息 */
  error?: { message?: string };
}

/** 网关返回的 HTTP 错误响应体（提取错误详情用） */
interface ErrorResponseBody {
  error?: { message?: string };
  message?: string;
}

// ==================== 常量与默认配置 ====================

const DEFAULT_CONFIG: AIConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  timeoutMs: 30_000,
};

/** 推荐文件名的最大长度（含扩展名） */
const MAX_FILENAME_LENGTH = 80;

/** Windows 文件名的非法字符（<> : " / \ | ? *） */
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*]/g;

/** 系统提示词：约束模型只输出文件名本身 */
const SYSTEM_PROMPT = [
  '你是一个专业的文件命名助手。请根据用户提供的文档内容摘要与命名模板，为文件起一个新名字。',
  '必须遵守以下规则：',
  '1. 只输出文件名本身（含扩展名），不要输出任何解释、说明、前后缀文字、标点包裹或代码块。',
  '2. 文件名应简洁、语义清晰，控制在 80 个字符以内。',
  '3. 不得包含 < > : " / \\ | ? * 等字符以及任何控制字符。',
  '4. 扩展名必须与文档内容类型相符（如 .pdf / .docx / .xlsx / .png / .jpg）。',
  '5. 若模板无法应用，输出一个基于内容的通用描述性文件名。',
].join('\n');

/** 当前生效配置（后续接入 userData 持久化后，可从磁盘加载覆盖这里） */
let currentConfig: AIConfig = { ...DEFAULT_CONFIG };

// ==================== 配置管理 ====================

/** 修改 AI 接口配置（传入部分字段即可，未传字段保持原值） */
function configureAI(partial: Partial<AIConfig>): void {
  currentConfig = { ...currentConfig, ...partial };
}

/** 读取当前配置（供设置界面展示与持久化） */
function getAIConfig(): AIConfig {
  return { ...currentConfig };
}

// ==================== 内部工具函数 ====================

/** 拼接 OpenAI 兼容的 chat/completions 完整地址（容忍 baseUrl 末尾多余斜杠） */
function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
}

/** 组装用户消息：命名模板 + 文档内容摘要 */
function buildUserMessage(extractedText: string, template: string): string {
  return [
    '命名模板：',
    template.trim() || '（未提供模板，请根据内容自由命名）',
    '',
    '文档内容摘要：',
    extractedText,
  ].join('\n');
}

/**
 * 清洗模型输出，得到合法文件名：
 * 取第一行非空内容、去代码块/引号包裹、剔除非法字符与控制字符、压缩空白、
 * 去掉结尾空格与点、超长截断（保留扩展名）。
 */
function sanitizeFileName(raw: string): string {
  // 模型偶尔会输出多行或带解释，防御性地只取第一行非空内容
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  let name = firstLine ?? '';

  // 去掉 markdown 代码块包裹（``` 或 ```text）
  name = name.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

  // 去掉成对出现的引号 / 反引号包裹
  name = name.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();

  // 剔除 Windows 非法字符
  name = name.replace(ILLEGAL_FILENAME_CHARS, '');

  // 剔除控制字符（按码点过滤，码点 < 32 的视为控制字符）
  name = name
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join('');

  // 压缩连续空白，去掉首尾空格与结尾的点（Windows 不允许）
  name = name.replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');

  // 超长截断：尽量保留扩展名（最后一个点后不超过 8 个字符视为扩展名）
  if (name.length > MAX_FILENAME_LENGTH) {
    const dotIndex = name.lastIndexOf('.');
    const ext = dotIndex > 0 && name.length - dotIndex <= 8 ? name.slice(dotIndex) : '';
    name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }

  return name.trim();
}

/** 把 axios 抛出的各种异常翻译成友好错误信息 */
function wrapAICallError(err: unknown, timeoutMs: number): Error {
  if (axios.isAxiosError(err)) {
    // 请求超时
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return new Error(`请求 AI 接口超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络后重试。`);
    }
    // 有 HTTP 响应：接口返回了错误（4xx/5xx），优先取网关给出的错误详情
    if (err.response) {
      const body = err.response.data as ErrorResponseBody | undefined;
      const detail = body?.error?.message ?? body?.message ?? err.message;
      return new Error(`AI 接口请求失败（HTTP ${err.response.status}）：${detail}`);
    }
    // 无响应：网络不通、DNS 失败或接口地址错误
    return new Error(`无法连接到 AI 接口（${err.code ?? '网络错误'}），请检查网络与接口地址配置。`);
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(`调用 AI 接口失败：${detail}`);
}

/** 发起一次 chat/completions 请求，网络层异常在此统一包装 */
async function requestCompletion(config: AIConfig, userMessage: string): Promise<ChatCompletionResponse> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];
  try {
    const { data } = await axios.post<ChatCompletionResponse>(
      chatCompletionsUrl(config.baseUrl),
      {
        model: config.model,
        messages,
        temperature: 0.3,
        max_tokens: 128,
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: config.timeoutMs,
      },
    );
    return data;
  } catch (err) {
    throw wrapAICallError(err, config.timeoutMs);
  }
}

// ==================== 对外主函数 ====================

/**
 * 请求大模型为文件推荐一个新名字。
 * @param extractedText 文件解析出的内容摘要（fileReader.readFileText 的返回值）
 * @param template 用户选择的命名模板（如 "项目报告-{日期}-{作者}"）
 * @returns 清洗后的推荐文件名（含扩展名，最多 80 字符）
 * @throws 未配置 API Key、内容为空、网络/超时、接口报错、返回内容无效时抛出友好错误
 */
async function getSuggestedFileName(extractedText: string, template: string): Promise<string> {
  const config = currentConfig;

  if (!config.apiKey.trim()) {
    throw new Error('尚未配置 AI 接口的 API Key，请先在设置中填写。');
  }
  if (!config.baseUrl.trim()) {
    throw new Error('尚未配置 AI 接口地址。');
  }
  const content = extractedText.trim();
  if (!content) {
    throw new Error('文件内容为空，无法生成建议文件名。');
  }

  const data = await requestCompletion(config, buildUserMessage(content, template));

  // 网关在 HTTP 200 响应体里返回错误的情况
  if (data.error?.message) {
    throw new Error(`AI 接口返回错误：${data.error.message}`);
  }

  const raw = data.choices?.[0]?.message?.content ?? '';
  const name = sanitizeFileName(raw);
  if (!name) {
    throw new Error('AI 返回内容为空或不是有效文件名，请重试。');
  }
  return name;
}

// CommonJS 导出：与原先的 export 一一对应（供 main.ts / configStore.ts require 使用）
module.exports = {
  configureAI,
  getAIConfig,
  getSuggestedFileName,
};
