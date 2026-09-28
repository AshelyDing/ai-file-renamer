/**
 * 渲染进程逻辑：
 *  - 单文件模式：选择文件 → 读取内容 → AI 生成文件名 → 确认重命名
 *  - 批量模式：多选文件 → 逐个提取文本 → 并发限流（≤3）批量生成 AI 名称 → 批量执行重命名
 * 另含 AI 设置面板：加载 / 保存接口配置（经 configStore 持久化到 JSON 文件）。
 * 通过 preload 暴露的 window.api（IPC 封装）与主进程交互，本文件不直接接触 Node 能力。
 * 本文件编译为 renderer.js，由 index.html 通过 <script src="./renderer.js"> 加载。
 */
import type { RendererApi } from '../main/preload';
// 全局类型声明：window.api 复用 preload.ts 导出的 RendererApi（单一类型来源，避免两处定义漂移）
declare global {
  interface Window {
    api?: RendererApi;
  }
}
/** 批量模式下的单条文件记录（就地类型声明） */
interface BatchFileRecord {
  /** 文件路径（重命名成功后更新为新路径） */
  filePath: string;
  /** 提取出的内容摘要 */
  text: string;
  /** AI 建议的新文件名（用户在编辑框中修改后以编辑框为准） */
  suggestedName: string;
  /** 处理状态 */
  status: 'pending' | 'processing' | 'success' | 'failed';
  /** 失败原因（友好提示） */
  error?: string;
}

document.addEventListener('DOMContentLoaded', async () => {
  // ---------------- DOM 引用 ----------------
  // 模式切换
  const modeRadios = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
  const singleModeArea = document.getElementById('singleModeArea') as HTMLDivElement;
  const batchModeArea = document.getElementById('batchModeArea') as HTMLDivElement;
  // 单文件模式
  const btnSelectFile = document.getElementById('btnSelectFile')!;
  const btnGenerate = document.getElementById('btnGenerate')!;
  const btnRename = document.getElementById('btnRename') as HTMLButtonElement;
  const selectedFileEl = document.getElementById('selectedFile')!;
  const templateSelect = document.getElementById('templateSelect') as HTMLSelectElement;
  const contentPreview = document.getElementById('contentPreview') as HTMLTextAreaElement;
  const suggestedNameInput = document.getElementById('suggestedName') as HTMLInputElement;
  const statusEl = document.getElementById('status')!;
  const versionsEl = document.getElementById('versions');
  // 批量模式
  const btnSelectMulti = document.getElementById('btnSelectMulti')!;
  const btnBatchGenerate = document.getElementById('btnBatchGenerate')!;
  const btnBatchRename = document.getElementById('btnBatchRename')!;
  const batchStatusEl = document.getElementById('batchStatus')!;
  const batchTableBody = document.getElementById('batchTableBody') as HTMLTableSectionElement;
  const batchSummaryEl = document.getElementById('batchSummary')!;
  // AI 设置面板相关元素
  const btnSaveConfig = document.getElementById('btnSaveConfig')!;
  const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement;
  const baseUrlInput = document.getElementById('baseUrlInput') as HTMLInputElement;
  const modelSelect = document.getElementById('modelSelect') as HTMLSelectElement;
  const configStatusEl = document.getElementById('configStatus')!;

  // ---------------- 状态 ----------------
  /** 当前选中的文件路径（单文件模式，重命名成功后更新为新路径） */
  let selectedFilePath: string | null = null;
  /** 最近一次读取到的文件内容（单文件模式） */
  let extractedText = '';
  /** 是否处于批量模式 */
  let isBatchMode = false;
  /** 批量模式下的文件记录列表 */
  let batchRecords: BatchFileRecord[] = [];

  // ---------------- 工具函数 ----------------
  /** 获取 window.api；preload 未正确加载时给出明确错误 */
  function getApi(): RendererApi {
    if (!window.api) {
      throw new Error('preload 未正确加载，window.api 不可用。');
    }
    return window.api;
  }
  /** 去掉 ipcRenderer.invoke 抛错时的包装前缀，只保留真实错误信息 */
  function cleanErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  /** 在单文件模式状态栏显示信息（isError 时标红） */
  function setStatus(text: string, isError = false): void {
    statusEl.textContent = text;
    statusEl.style.color = isError ? '#c0392b' : '#2c3e50';
  }
  /** 在批量模式状态栏显示信息（isError 时标红） */
  function batchStatus(text: string, isError = false): void {
    batchStatusEl.textContent = text;
    batchStatusEl.style.color = isError ? '#c0392b' : '#2c3e50';
  }
  /** 在设置面板状态区显示信息 */
  function setConfigStatus(text: string, color = '#7f8c8d'): void {
    configStatusEl.textContent = text;
    configStatusEl.style.color = color;
  }
  /** 把配置中的模型名设置到下拉框；模型不在预设列表时动态补充选项 */
  function setModelSelect(model: string): void {
    const exists = Array.from(modelSelect.options).some((option) => option.value === model);
    if (!exists) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      modelSelect.appendChild(option);
    }
    modelSelect.value = model;
  }
  /** 从完整路径提取文件名（兼容 Windows 与 POSIX 分隔符） */
  function fileNameOf(filePath: string): string {
    return filePath.split(/[\\/]/).pop() ?? filePath;
  }
  /** 批量记录状态对应的展示文本 */
  function batchStatusText(record: BatchFileRecord): string {
    switch (record.status) {
      case 'pending':
        return '待处理';
      case 'processing':
        return '处理中…';
      case 'success':
        return '成功';
      case 'failed':
        return `失败：${record.error ?? '未知原因'}`;
    }
  }
  /** 批量记录状态对应的颜色 */
  function batchStatusColor(record: BatchFileRecord): string {
    switch (record.status) {
      case 'pending':
        return '#7f8c8d';
      case 'processing':
        return '#2980b9';
      case 'success':
        return '#27ae60';
      case 'failed':
        return '#c0392b';
    }
  }
  /** 重建批量文件表格（以 batchRecords 为准，编辑框修改会实时回写记录） */
  function renderBatchTable(): void {
    batchTableBody.textContent = '';
    for (const record of batchRecords) {
      const tr = document.createElement('tr');
      // 原文件名
      const tdName = document.createElement('td');
      tdName.textContent = fileNameOf(record.filePath);
      // 提取内容预览（截断展示，完整内容在记录中）
      const tdPreview = document.createElement('td');
      tdPreview.classList.add('preview-cell');
      tdPreview.textContent =
        record.text.length > 120 ? `${record.text.slice(0, 120)}…` : record.text || '（无内容）';
      // AI 建议新名称
      const tdSuggest = document.createElement('td');
      tdSuggest.textContent = record.suggestedName || '—';
      // 手动编辑输入框（预填建议名，修改后直接回写记录）
      const tdEdit = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = record.suggestedName;
      input.placeholder = '可手动修改';
      input.addEventListener('input', () => {
        record.suggestedName = input.value.trim();
      });
      tdEdit.appendChild(input);
      // 状态标记（待处理 / 处理中 / 成功 / 失败+原因）
      const tdStatus = document.createElement('td');
      tdStatus.textContent = batchStatusText(record);
      tdStatus.style.color = batchStatusColor(record);
      tr.append(tdName, tdPreview, tdSuggest, tdEdit, tdStatus);
      batchTableBody.appendChild(tr);
    }
  }
  /**
   * 并发限流工具：最多 maxConcurrency 个任务同时执行（防止大模型接口限流）。
   * worker 内部自行捕获异常时，本函数不会中断；worker 抛出的异常会向上传播。
   */
  async function runWithConcurrencyLimit<T>(
    items: T[],
    maxConcurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(maxConcurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index]);
      }
    });
    await Promise.all(runners);
  }
  /** 清空两种模式下的全部数据（模式切换时调用） */
  function clearAllData(): void {
    // 单文件模式
    selectedFilePath = null;
    extractedText = '';
    selectedFileEl.textContent = '未选择文件';
    contentPreview.value = '';
    suggestedNameInput.value = '';
    btnRename.disabled = true;
    setStatus('');
    // 批量模式
    batchRecords = [];
    batchStatus('');
    batchSummaryEl.textContent = '';
    renderBatchTable();
  }
  /** 按当前模式显示 / 隐藏对应区块 */
  function applyModeVisibility(): void {
    singleModeArea.hidden = isBatchMode;
    batchModeArea.hidden = !isBatchMode;
  }

  // ---------------- 模式切换 ----------------
  for (const radio of Array.from(modeRadios)) {
    radio.addEventListener('change', () => {
      isBatchMode = radio.value === 'batch';
      clearAllData(); // 切换模式时清空原有数据
      applyModeVisibility();
    });
  }

  // ---------------- 单文件模式事件 ----------------
  /** 1. 选择文件：弹系统对话框 → 读取内容 → 填充预览区 */
  btnSelectFile.addEventListener('click', async () => {
    try {
      const api = getApi();
      setStatus('正在打开文件选择窗口…');
      const filePath = await api.selectFile();
      if (!filePath) {
        setStatus('已取消选择');
        return;
      }
      // 换文件时重置上一轮的生成结果
      selectedFilePath = filePath;
      selectedFileEl.textContent = filePath;
      extractedText = '';
      contentPreview.value = '';
      suggestedNameInput.value = '';
      btnRename.disabled = true;
      setStatus('正在读取文件内容…');
      extractedText = await api.readFileText(filePath);
      contentPreview.value = extractedText;
      setStatus('内容读取完成，可点击「生成 AI 文件名」');
    } catch (err) {
      setStatus(cleanErrorMessage(err), true);
    }
  });
  /** 2. 生成 AI 文件名：把内容预览 + 命名模板发给主进程的 AI 服务 */
  btnGenerate.addEventListener('click', async () => {
    if (!selectedFilePath || !extractedText) {
      setStatus('请先选择文件并读取内容', true);
      return;
    }
    try {
      setStatus('正在请求 AI 生成文件名，请稍候…');
      const name = await getApi().getSuggestedFileName(extractedText, templateSelect.value);
      suggestedNameInput.value = name;
      btnRename.disabled = false;
      setStatus('已生成建议文件名，可手动修改后确认');
    } catch (err) {
      setStatus(cleanErrorMessage(err), true);
    }
  });
  /** 3. 确认重命名：把新文件名交给主进程执行，成功后更新界面 */
  btnRename.addEventListener('click', async () => {
    if (!selectedFilePath) {
      setStatus('请先选择文件', true);
      return;
    }
    const newName = suggestedNameInput.value.trim();
    if (!newName) {
      setStatus('新文件名不能为空，请先生成或手动填写', true);
      return;
    }
    try {
      setStatus('正在重命名…');
      const result = await getApi().renameFile(selectedFilePath, newName);
      selectedFilePath = result.newPath;
      selectedFileEl.textContent = result.newPath;
      btnRename.disabled = true;
      setStatus('重命名成功！');
    } catch (err) {
      setStatus(cleanErrorMessage(err), true);
    }
  });

  // ---------------- 批量模式事件 ----------------
  /** 1. 多选文件：逐个调用 readFileText 提取文本，单个失败单独标记，不中断其余文件 */
  btnSelectMulti.addEventListener('click', async () => {
    try {
      batchStatus('正在打开文件选择窗口…');
      const paths = await getApi().selectMultiFile();
      if (paths.length === 0) {
        batchStatus('已取消选择');
        return;
      }
      // 重新选择时清空旧列表与统计
      batchRecords = [];
      batchSummaryEl.textContent = '';
      renderBatchTable();
      batchStatus(`已选择 ${paths.length} 个文件，正在逐个读取内容…`);
      let okCount = 0;
      for (const filePath of paths) {
        const record: BatchFileRecord = { filePath, text: '', suggestedName: '', status: 'pending' };
        try {
          record.text = await getApi().readFileText(filePath);
          okCount += 1;
        } catch (err) {
          // 单个文件读取失败单独标记，继续处理其余文件
          record.status = 'failed';
          record.error = cleanErrorMessage(err);
        }
        batchRecords.push(record);
        renderBatchTable();
      }
      batchStatus(`内容读取完成：成功 ${okCount} 个，失败 ${paths.length - okCount} 个`);
    } catch (err) {
      batchStatus(cleanErrorMessage(err), true);
    }
  });
  /** 2. 批量生成 AI 名称：最多 3 个并发，防止大模型接口限流；单个失败单独标记 */
  btnBatchGenerate.addEventListener('click', async () => {
    const targets = batchRecords.filter((record) => record.status !== 'failed' && record.text);
    if (targets.length === 0) {
      batchStatus('没有可生成的文件，请先选择文件', true);
      return;
    }
    const template = templateSelect.value;
    let done = 0;
    batchStatus(`正在批量生成 AI 名称（并发 ≤3），0/${targets.length}`);
    await runWithConcurrencyLimit(targets, 3, async (record) => {
      try {
        record.suggestedName = await getApi().getSuggestedFileName(record.text, template);
      } catch (err) {
        // 单个生成失败单独标记（如未配置 API Key、网络超时），继续处理其余文件
        record.status = 'failed';
        record.error = cleanErrorMessage(err);
      }
      done += 1;
      batchStatus(`正在批量生成 AI 名称，${done}/${targets.length}`);
      renderBatchTable();
    });
    const ok = targets.filter((record) => record.status !== 'failed').length;
    batchStatus(`AI 名称生成完成：成功 ${ok} 个，失败 ${targets.length - ok} 个`);
  });
  /** 3. 批量执行重命名：主进程逐条执行、单个失败不中断；渲染层按结果逐条标记并汇总统计 */
  btnBatchRename.addEventListener('click', async () => {
    // 收集可执行任务：读取/生成失败或名称为空的记录跳过
    const tasks: Array<{ record: BatchFileRecord; newName: string }> = [];
    for (const record of batchRecords) {
      const newName = record.suggestedName.trim();
      if (record.status === 'failed' || !newName) {
        continue;
      }
      tasks.push({ record, newName });
    }
    if (tasks.length === 0) {
      batchStatus('没有可执行的重命名任务，请先选择文件并生成 AI 名称', true);
      return;
    }
    for (const task of tasks) {
      task.record.status = 'processing';
    }
    renderBatchTable();
    batchStatus('正在批量执行重命名…');
    try {
      const results = await getApi().batchRename(
        tasks.map((task) => ({ filePath: task.record.filePath, newName: task.newName })),
      );
      // 主进程按输入顺序返回逐条结果，据此回填每条记录
      let successCount = 0;
      results.forEach((result, index) => {
        const record = tasks[index].record;
        if (result.success) {
          record.status = 'success';
          record.filePath = result.newPath ?? record.filePath; // 更新为最新路径
          successCount += 1;
        } else {
          record.status = 'failed';
          record.error = result.error ?? '未知原因';
        }
      });
      renderBatchTable();
      const failCount = tasks.length - successCount;
      batchSummaryEl.textContent = `统计：成功 ${successCount} · 失败 ${failCount} · 共 ${tasks.length}`;
      batchSummaryEl.style.color = failCount > 0 ? '#c0392b' : '#27ae60';
      batchStatus(`批量重命名完成：成功 ${successCount} 个，失败 ${failCount} 个`);
    } catch (err) {
      // 整批 IPC 调用本身失败（正常情况下不会发生，防御处理）
      batchStatus(cleanErrorMessage(err), true);
    }
  });

  // ---------------- AI 设置面板逻辑 ----------------
  /** 启动时加载已保存的 AI 配置并填充设置面板 */
  async function initConfigPanel(): Promise<void> {
    try {
      const config = await getApi().getAppConfig();
      apiKeyInput.value = config.apiKey;
      baseUrlInput.value = config.baseUrl;
      setModelSelect(config.model);
    } catch (err) {
      setConfigStatus(`加载配置失败：${cleanErrorMessage(err)}`, '#c0392b');
    }
  }
  /** 保存 AI 配置：写入 JSON 文件并立即对 aiService 生效 */
  btnSaveConfig.addEventListener('click', async () => {
    const config = {
      apiKey: apiKeyInput.value.trim(),
      baseUrl: baseUrlInput.value.trim(),
      model: modelSelect.value,
    };
    if (!config.baseUrl) {
      setConfigStatus('接口地址不能为空', '#c0392b');
      return;
    }
    try {
      await getApi().saveAppConfig(config);
      setConfigStatus(
        config.apiKey ? '配置已保存并生效' : '已保存，但 API Key 为空，生成文件名前需要填写',
        config.apiKey ? '#27ae60' : '#e67e22',
      );
    } catch (err) {
      setConfigStatus(cleanErrorMessage(err), '#c0392b');
    }
  });

  // ---------------- 启动 ----------------
  // 展示运行环境版本信息
  if (versionsEl && window.api) {
    const v = window.api.versions;
    versionsEl.textContent = `Electron ${v.electron} · Chromium ${v.chrome} · Node ${v.node}`;
  }
  // 加载已保存的 AI 配置到设置面板
  await initConfigPanel();
  // 初始模式为单文件（HTML 中 radio 默认选中），同步区块显隐
  applyModeVisibility();
})
