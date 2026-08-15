import type {
  CapacityQuote,
  DatasetSource,
  RequestedAgent,
  TaskCategory,
  WalletSummary,
} from '@agent-pool/shared';
import { DATASET_UNIT_MAX, INLINE_UNIT_MAX, formatCredits } from '@agent-pool/shared';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Code2,
  Copy,
  Cpu,
  FileJson2,
  Flame,
  Gauge,
  Globe2,
  KeyRound,
  Layers3,
  LockKeyhole,
  Plus,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Trash2,
  Upload,
  WalletCards,
  Webhook,
  X,
  Zap,
} from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CopyCommand } from '../components/CopyCommand';
import { InlineError, LoadingState } from '../components/LoadingState';
import { NumberDraftInput } from '../components/NumberDraftInput';
import { PageHeader } from '../components/PageHeader';
import { api, ApiError } from '../lib/api';
import { capacityReason, duration, fullDateTime } from '../lib/format';
import {
  acceptanceChecks,
  attachPublishDataset,
  buildTaskCapsule,
  callbackExample,
  compileAgentInstruction,
  expectedOutputCoverage,
  generateReceiptSecret,
  inlineUnitLimitMessage,
  isHttpsDatasetUrl,
  isHttpsWebhook,
  parseConstraints,
  parseExampleOutput,
  parseJsonObject,
  receiptExample,
  resolvePublishUnitCount,
  unitReferenceIssues,
  webhookHostname,
  type AcceptanceMode,
  type AnswerNormalization,
  type CreatePoolWebInput,
  type DeliveryFormat,
  type DeliveryMode,
  type LaunchMode,
  type TaskExampleDraft,
} from '../lib/taskContract';
import type { CapacityCatalogItem } from '../lib/types';
import type { TaskUnitDraft } from '../lib/unitTypes';
import { lockedBudget, parseUnits, printableValue, type UnitParseMode } from '../lib/units';

const CATEGORIES: Array<{
  value: TaskCategory;
  label: string;
}> = [
  { value: 'text', label: '文本' },
  { value: 'data', label: '数据' },
  { value: 'coding', label: '代码' },
  { value: 'research', label: '研究' },
  { value: 'math', label: '数学' },
  { value: 'vision', label: '视觉' },
  { value: 'other', label: '其他' },
];

const STEPS = [
  { id: 1, label: '任务说明' },
  { id: 2, label: '数据在哪' },
  { id: 3, label: '预算与试跑' },
  { id: 4, label: '检查并发布' },
] as const;

const DEFAULT_ACCEPTANCE_OPTIONS: Array<{
  value: Extract<AcceptanceMode, 'non_empty' | 'hidden_exact' | 'manual'>;
  label: string;
  detail: string;
}> = [
  { value: 'non_empty', label: '结果非空', detail: '只确认有内容，不判断正确性' },
  { value: 'hidden_exact', label: '与预设答案一致', detail: '每条任务都要提供预设答案' },
  { value: 'manual', label: '人工确认', detail: '由你查看结果后决定是否完成' },
];

const ADVANCED_ACCEPTANCE_OPTIONS: Array<{
  value: Extract<AcceptanceMode, 'schema' | 'schema_and_hidden_exact'>;
  label: string;
  detail: string;
}> = [
  { value: 'schema', label: 'JSON Schema', detail: '检查形状、类型和必填字段' },
  {
    value: 'schema_and_hidden_exact',
    label: 'Schema + 预设答案',
    detail: '格式和答案都符合才算完成',
  },
];

const ACCEPTANCE_OPTIONS = [...DEFAULT_ACCEPTANCE_OPTIONS, ...ADVANCED_ACCEPTANCE_OPTIONS];

const EMPTY_EXAMPLE: TaskExampleDraft = { input: '', output: '', note: '' };

function defaultDeadline(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function legacyValidation(mode: AcceptanceMode): 'auto' | 'manual' {
  return mode === 'manual' || mode === 'webhook' ? 'manual' : 'auto';
}

function plainCheckText(value: string): string {
  return value
    .replaceAll('隐藏标准结果精确匹配', '与预设答案一致')
    .replaceAll('发布者人工决定', '人工确认')
    .replaceAll('Webhook 回执签名', '回调地址签名回执')
    .replaceAll('Units', '任务')
    .replaceAll('Unit', '任务')
    .replaceAll('交付', '结果')
    .replaceAll('验收', '确认');
}

function points(value: number): string {
  return `${formatCredits(value)} 积分`;
}

function deadlineIso(value: string): string {
  const time = new Date(value).getTime();
  return Number.isFinite(time)
    ? new Date(time).toISOString()
    : new Date(Date.now() + 86_400_000).toISOString();
}

export function PublishPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<TaskCategory>('text');
  const [goal, setGoal] = useState('');
  const [inputDescription, setInputDescription] = useState('');
  const [outputDescription, setOutputDescription] = useState('');
  const [constraintsRaw, setConstraintsRaw] = useState('');
  const [examples, setExamples] = useState<TaskExampleDraft[]>([{ ...EMPTY_EXAMPLE }]);
  const [expandedExample, setExpandedExample] = useState<number | null>(0);

  const [datasetMode, setDatasetMode] = useState<DatasetSource['mode']>('https');
  const [datasetUrl, setDatasetUrl] = useState('');
  const [datasetCheckedUrl, setDatasetCheckedUrl] = useState('');
  const [datasetHost, setDatasetHost] = useState<string | null>(null);
  const [remoteUnitCount, setRemoteUnitCount] = useState(0);
  const [checkingDataset, setCheckingDataset] = useState(false);
  const [rawUnits, setRawUnits] = useState('');
  const [parseMode, setParseMode] = useState<UnitParseMode>('lines');
  const [units, setUnits] = useState<TaskUnitDraft[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [deliveryTarget, setDeliveryTarget] = useState<DeliveryMode>('platform');
  const [deliveryFormat, setDeliveryFormat] = useState<DeliveryFormat>('text');
  const [schemaText, setSchemaText] = useState('');
  const [acceptanceMode, setAcceptanceMode] = useState<AcceptanceMode>('non_empty');
  const [answerNormalization, setAnswerNormalization] = useState<AnswerNormalization>({
    trimStrings: false,
    collapseWhitespace: false,
    caseInsensitive: false,
    numericTolerance: 0,
  });
  const [webhookUrl, setWebhookUrl] = useState('');
  const [receiptSecret, setReceiptSecret] = useState(generateReceiptSecret);
  const [secretCopied, setSecretCopied] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const [requestedAgent, setRequestedAgent] = useState<RequestedAgent>('codex');
  const [requestedModel, setRequestedModel] = useState('');
  const [requiredConcurrency, setRequiredConcurrency] = useState(20);
  const [maxUnitSeconds, setMaxUnitSeconds] = useState(120);
  const [deadlineAt, setDeadlineAt] = useState(defaultDeadline);
  const [rewardPerUnit, setRewardPerUnit] = useState(10);
  const [launchMode, setLaunchMode] = useState<LaunchMode>('pilot');
  const [pilotUnits, setPilotUnits] = useState(3);

  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [catalog, setCatalog] = useState<CapacityCatalogItem[]>([]);
  const [quote, setQuote] = useState<CapacityQuote | null>(null);
  const [quoteFingerprint, setQuoteFingerprint] = useState('');
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.wallet(), api.capacityCatalog()])
      .then(([walletResult, catalogResult]) => {
        setWallet(walletResult);
        setCatalog(catalogResult);
        const codex = catalogResult.find((entry) => entry.adapter === 'codex');
        if (codex?.models[0]) setRequestedModel(codex.models[0]);
      })
      .catch((requestError) => {
        setError(requestError instanceof ApiError ? requestError.message : '无法读取容量目录');
      })
      .finally(() => setLoading(false));
  }, []);

  const constraints = useMemo(() => parseConstraints(constraintsRaw), [constraintsRaw]);
  const schemaState = useMemo(() => parseJsonObject(schemaText), [schemaText]);
  const dataset: DatasetSource =
    datasetMode === 'https'
      ? { mode: 'https', url: datasetUrl.trim() }
      : { mode: 'inline' };
  const httpsReady =
    datasetMode === 'https' &&
    datasetCheckedUrl === datasetUrl.trim() &&
    remoteUnitCount >= 2 &&
    remoteUnitCount <= DATASET_UNIT_MAX;
  const unitCount = resolvePublishUnitCount(dataset, units, remoteUnitCount);
  const coverage = useMemo(() => {
    if (datasetMode === 'https') {
      return {
        covered: httpsReady ? remoteUnitCount : 0,
        total: remoteUnitCount,
        percent: httpsReady ? 100 : 0,
      };
    }
    return expectedOutputCoverage(units);
  }, [datasetMode, httpsReady, remoteUnitCount, units]);
  const references = useMemo(
    () => (datasetMode === 'https' ? [] : unitReferenceIssues(units)),
    [datasetMode, units],
  );
  const currentModels = useMemo(
    () => catalog.find((entry) => entry.adapter === requestedAgent)?.models || [],
    [catalog, requestedAgent],
  );
  const checks = useMemo(
    () => acceptanceChecks(acceptanceMode, coverage, Boolean(schemaState.value)),
    [acceptanceMode, coverage, schemaState.value],
  );
  const compiledPreview = useMemo(
    () =>
      compileAgentInstruction({
        goal,
        inputDescription,
        outputDescription,
        constraints,
        examples,
        format: deliveryFormat,
        acceptanceMode,
        schema: schemaState.value,
        criteria: checks.map((check) => `${check.label}：${check.detail}`),
      }),
    [
      goal,
      inputDescription,
      outputDescription,
      constraints,
      examples,
      deliveryFormat,
      acceptanceMode,
      schemaState.value,
      checks,
    ],
  );

  const budget = lockedBudget(unitCount, rewardPerUnit);
  const heldUnits = launchMode === 'pilot' ? Math.max(0, unitCount - pilotUnits) : 0;
  const capacityInput = useMemo(
    () => ({
      adapter: requestedAgent,
      model: requestedModel.trim(),
      deliveryMode: deliveryTarget,
      unitCount,
      requiredConcurrency,
      maxUnitSeconds,
      deadlineAt: deadlineIso(deadlineAt),
    }),
    [
      requestedAgent,
      requestedModel,
      deliveryTarget,
      unitCount,
      requiredConcurrency,
      maxUnitSeconds,
      deadlineAt,
    ],
  );
  const currentFingerprint = JSON.stringify(capacityInput);
  const quoteIsCurrent = quote !== null && quoteFingerprint === currentFingerprint;
  const exactMode =
    acceptanceMode === 'hidden_exact' || acceptanceMode === 'schema_and_hidden_exact';
  const advancedAcceptance =
    acceptanceMode === 'schema' || acceptanceMode === 'schema_and_hidden_exact';

  const parsedExamples = () =>
    examples
      .filter((example) => example.input.trim() || example.output.trim())
      .map((example) => ({
        input: example.input,
        output: parseExampleOutput(example.output, deliveryFormat),
        ...(example.note.trim() ? { note: example.note.trim() } : {}),
      }));

  const buildPayload = (options?: {
    probe?: boolean;
    acceptanceMode?: AcceptanceMode;
    deliveryTarget?: DeliveryMode;
    requiredConcurrency?: number;
  }): CreatePoolWebInput => {
    const mode = options?.acceptanceMode ?? acceptanceMode;
    const target = options?.deliveryTarget ?? deliveryTarget;
    const criteria = acceptanceChecks(mode, coverage, Boolean(schemaState.value)).map(
      (check) => `${check.label}：${check.detail}`,
    );
    const capsule = buildTaskCapsule({
      goal: goal.trim(),
      inputDescription: inputDescription.trim(),
      outputDescription: outputDescription.trim(),
      constraints,
      examples: options?.probe
        ? examples
            .filter((example) => example.input.trim() && example.output.trim())
            .map((example) => ({
              input: example.input,
              output: example.output,
              ...(example.note.trim() ? { note: example.note.trim() } : {}),
            }))
        : parsedExamples(),
      format: options?.probe ? 'text' : deliveryFormat,
      schema: options?.probe ? undefined : schemaState.value,
      acceptanceMode: mode,
      criteria,
      normalization: exactMode && !options?.probe ? answerNormalization : undefined,
    });
    return attachPublishDataset(
      {
        title: title.trim(),
        category,
        publicSummary: goal.trim().slice(0, 300),
        requestedAgent,
        requestedModel: requestedModel.trim() || currentModels[0] || 'unspecified',
        requiredConcurrency: options?.requiredConcurrency ?? requiredConcurrency,
        maxUnitSeconds,
        deadlineAt: capacityInput.deadlineAt,
        rewardPerUnit,
        validationMode: legacyValidation(mode),
        taskCapsule: capsule,
        deliveryTarget:
          target === 'webhook'
            ? { mode: 'webhook', url: webhookUrl.trim(), receiptSecret }
            : { mode: 'platform' },
        launchMode,
        pilotUnits: launchMode === 'pilot' ? pilotUnits : Math.min(3, Math.max(1, unitCount)),
      },
      dataset,
      units,
    );
  };

  const applyRemoteCount = (totalUnits: number, url: string, host: string | null) => {
    if (totalUnits > DATASET_UNIT_MAX) {
      throw new Error('远程文件条数超出平台上限');
    }
    setRemoteUnitCount(totalUnits);
    setDatasetCheckedUrl(url);
    setDatasetHost(host);
    setRequiredConcurrency((current) => Math.min(Math.max(1, current), totalUnits));
    setPilotUnits((current) => Math.min(Math.max(1, current || 3), Math.min(3, totalUnits)));
    setParseError(null);
    setQuote(null);
  };

  const updateExample = (index: number, key: keyof TaskExampleDraft, value: string) => {
    setExamples((current) =>
      current.map((example, exampleIndex) =>
        exampleIndex === index ? { ...example, [key]: value } : example,
      ),
    );
  };

  const addExample = () => {
    setExpandedExample(examples.length);
    setExamples((current) => [...current, { ...EMPTY_EXAMPLE }]);
  };

  const removeExample = (index: number) => {
    setExamples((current) => current.filter((_, exampleIndex) => exampleIndex !== index));
    setExpandedExample((current) => {
      if (current === null) return null;
      if (current === index) return Math.max(0, index - 1);
      return current > index ? current - 1 : current;
    });
  };

  const selectAgent = (agent: RequestedAgent) => {
    setRequestedAgent(agent);
    const models = catalog.find((item) => item.adapter === agent)?.models || [];
    setRequestedModel(models[0] || '');
    setQuote(null);
  };

  const selectDatasetMode = (mode: DatasetSource['mode']) => {
    setDatasetMode(mode);
    setParseError(null);
    setError(null);
    setQuote(null);
  };

  const parseCurrentUnits = (): TaskUnitDraft[] | null => {
    try {
      const parsed = parseUnits(rawUnits, parseMode);
      if (parsed.length < 2) throw new Error('至少需要 2 条独立任务数据');
      if (parsed.length > INLINE_UNIT_MAX) throw new Error(inlineUnitLimitMessage());
      setUnits(parsed);
      setRequiredConcurrency((current) => Math.min(Math.max(1, current), parsed.length));
      setPilotUnits((current) => Math.min(Math.max(1, current || 3), Math.min(3, parsed.length)));
      setParseError(null);
      setQuote(null);
      return parsed;
    } catch (parseFailure) {
      setUnits([]);
      setParseError(parseFailure instanceof Error ? parseFailure.message : '无法解析输入');
      return null;
    }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      setParseError('文件不能超过 15 MB');
      return;
    }
    const text = await file.text();
    const mode: UnitParseMode = file.name.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'lines';
    setParseMode(mode);
    setRawUnits(text);
    try {
      const parsed = parseUnits(text, mode);
      if (parsed.length < 2) throw new Error('至少需要 2 条独立任务数据');
      if (parsed.length > INLINE_UNIT_MAX) throw new Error(inlineUnitLimitMessage());
      setUnits(parsed);
      setRequiredConcurrency((current) => Math.min(Math.max(1, current), parsed.length));
      setPilotUnits(Math.min(3, parsed.length));
      setParseError(null);
      setQuote(null);
    } catch (parseFailure) {
      setUnits([]);
      setParseError(parseFailure instanceof Error ? parseFailure.message : '无法解析文件');
    }
    event.target.value = '';
  };

  const setTarget = (target: DeliveryMode) => {
    setDeliveryTarget(target);
    setAcceptanceMode(target === 'webhook' ? 'webhook' : 'non_empty');
  };

  const selectAcceptance = (mode: AcceptanceMode) => {
    if (mode !== 'webhook') setDeliveryTarget('platform');
    setAcceptanceMode(mode);
  };

  const setFormat = (format: DeliveryFormat) => {
    setDeliveryFormat(format);
    if (
      format === 'text' &&
      (acceptanceMode === 'schema' || acceptanceMode === 'schema_and_hidden_exact')
    ) {
      setAcceptanceMode('non_empty');
    }
  };

  const copySecretOnce = async () => {
    if (secretCopied) return;
    try {
      await navigator.clipboard.writeText(receiptSecret);
      setSecretCopied(true);
      setCopyNotice('已复制。关掉后看不到。');
    } catch {
      setCopyNotice('浏览器拒绝复制，请重试或重新生成。');
    }
  };

  const regenerateSecret = () => {
    setReceiptSecret(generateReceiptSecret());
    setSecretCopied(false);
    setCopyNotice('已生成新的 32-byte secret，旧 secret 已失效。');
  };

  const voidError = (message: string): false => {
    setError(message);
    return false;
  };

  const checkHttpsDataset = async (): Promise<number | null> => {
    if (!isHttpsDatasetUrl(datasetUrl)) {
      setParseError('请填写有效的 HTTPS JSONL 地址');
      return null;
    }
    setCheckingDataset(true);
    setError(null);
    setParseError(null);
    try {
      const result = await api.validatePool(
        buildPayload({
          probe: true,
          acceptanceMode: 'non_empty',
          deliveryTarget: 'platform',
          requiredConcurrency: 1,
        }),
      );
      applyRemoteCount(
        result.totalUnits,
        datasetUrl.trim(),
        result.dataset.mode === 'https' ? result.dataset.host : null,
      );
      return result.totalUnits;
    } catch (requestError) {
      setRemoteUnitCount(0);
      setDatasetCheckedUrl('');
      setDatasetHost(null);
      const message =
        requestError instanceof ApiError ? requestError.message : '无法检查这个地址';
      setParseError(message);
      return null;
    } finally {
      setCheckingDataset(false);
    }
  };

  const confirmRemoteAcceptance = async (knownCount: number): Promise<boolean> => {
    setCheckingDataset(true);
    setError(null);
    try {
      const result = await api.validatePool(
        buildPayload({
          requiredConcurrency: Math.min(Math.max(1, requiredConcurrency), Math.max(1, knownCount)),
        }),
      );
      applyRemoteCount(
        result.totalUnits,
        datasetUrl.trim(),
        result.dataset.mode === 'https' ? result.dataset.host : null,
      );
      return true;
    } catch (requestError) {
      return voidError(
        requestError instanceof ApiError ? requestError.message : '远程文件还不能按当前完成规则发布',
      );
    } finally {
      setCheckingDataset(false);
    }
  };

  const validateStep = (options?: { httpsReady?: boolean }): boolean => {
    setError(null);
    if (step === 1) {
      if (title.trim().length < 3) return voidError('任务名称至少 3 个字');
      if (goal.trim().length < 8) return voidError('目标至少需要 8 个字符');
      if (inputDescription.trim().length < 8) return voidError('请说明每条任务会提供什么');
      if (outputDescription.trim().length < 8) return voidError('请说明你希望收到什么结果');
      if (!examples[0]?.input.trim() || !examples[0]?.output.trim())
        return voidError('至少提供 1 组完整的示例输入与输出');
    }
    if (step === 2) {
      let parsed = units;
      if (datasetMode === 'https') {
        if (!isHttpsDatasetUrl(datasetUrl)) return voidError('请填写有效的 HTTPS JSONL 地址');
        if (!(options?.httpsReady ?? httpsReady)) return voidError('请先检查地址，确认文件条数');
      } else {
        const nextUnits = parseCurrentUnits();
        if (!nextUnits) return false;
        parsed = nextUnits;
      }
      if (deliveryFormat === 'json') {
        for (const [index, example] of examples.entries()) {
          if (!example.output.trim()) continue;
          try {
            parseExampleOutput(example.output, 'json');
          } catch {
            return voidError(`示例 ${index + 1} 的输出不是有效 JSON`);
          }
        }
      }
      const parsedCoverage =
        datasetMode === 'https' ? coverage : expectedOutputCoverage(parsed);
      if (acceptanceMode === 'schema' || acceptanceMode === 'schema_and_hidden_exact') {
        if (deliveryFormat !== 'json') return voidError('Schema 检查要求结果格式为 JSON');
        if (!schemaText.trim()) return voidError('这种完成规则需要填写 JSON Schema');
        if (schemaState.error || !schemaState.value)
          return voidError(`JSON Schema 尚未就绪：${schemaState.error || '请填写对象'}`);
      }
      if (exactMode && datasetMode === 'inline') {
        if (parsedCoverage.covered !== parsedCoverage.total)
          return voidError(
            `与预设答案比对需要覆盖全部任务，目前 ${parsedCoverage.covered}/${parsedCoverage.total}`,
          );
      }
      if (deliveryTarget === 'webhook') {
        if (!isHttpsWebhook(webhookUrl)) return voidError('接收地址必须是有效的 HTTPS');
        if (datasetMode === 'inline') {
          const issues = unitReferenceIssues(parsed);
          if (issues.length) return voidError(issues.join('；').replaceAll('Unit', '任务'));
        }
        if (!secretCopied) return voidError('请先复制一次确认密钥');
      }
    }
    if (step === 3) {
      if (!requestedModel.trim()) return voidError('请填写模型名称');
      if (!unitCount) return voidError('请先确认任务数据');
      if (requiredConcurrency < 1 || requiredConcurrency > unitCount)
        return voidError('同时执行上限必须在 1 到任务条数之间');
      if (maxUnitSeconds < 10 || maxUnitSeconds > 3600)
        return voidError('每条任务时限必须在 10–3600 秒之间');
      if (rewardPerUnit < 1 || rewardPerUnit > 1_000_000)
        return voidError('每条任务奖励必须在 1–1,000,000 积分之间');
      if (launchMode === 'pilot' && (pilotUnits < 1 || pilotUnits > Math.min(3, unitCount)))
        return voidError('试跑条数必须在 1–3 之间，且不能超过任务总数');
      const deadlineTime = new Date(deadlineAt).getTime();
      if (!Number.isFinite(deadlineTime) || deadlineTime <= Date.now() + 10_000)
        return voidError('请选择至少晚于当前时间 10 秒的截止时间');
      if (budget > (wallet?.purchasedAvailable || 0))
        return voidError('积分不够，请先去积分页增加');
    }
    return true;
  };

  const next = async () => {
    let knownHttpsReady = httpsReady;
    let knownCount = unitCount;
    if (step === 2 && datasetMode === 'https' && !knownHttpsReady) {
      const checked = await checkHttpsDataset();
      if (checked === null) return;
      knownHttpsReady = true;
      knownCount = checked;
    }
    if (!validateStep({ httpsReady: knownHttpsReady })) return;
    if (
      step === 2 &&
      datasetMode === 'https' &&
      (exactMode || deliveryTarget === 'webhook')
    ) {
      const confirmed = await confirmRemoteAcceptance(knownCount);
      if (!confirmed) return;
    }
    if (step === 3) {
      await getCapacityQuote();
      return;
    }
    setStep((current) => Math.min(4, current + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const getCapacityQuote = async () => {
    setLoadingQuote(true);
    setError(null);
    try {
      const nextQuote = await api.capacityQuote(capacityInput);
      setQuote(nextQuote);
      setQuoteFingerprint(currentFingerprint);
      setStep(4);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '容量评估失败');
    } finally {
      setLoadingQuote(false);
    }
  };

  const publish = async () => {
    if (!quoteIsCurrent) {
      setError('发布参数已经变化，请重新获取容量评估');
      setStep(3);
      return;
    }
    const payload = buildPayload();

    setPublishing(true);
    setError(null);
    try {
      const created = await api.createPool(payload);
      navigate(`/app/pools/${created.id}`, { replace: true });
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  if (loading) return <LoadingState label="正在加载" />;

  return (
    <div className="page publish-page capsule-publish-page">
      <PageHeader
        eyebrow="发布新任务"
        title="把要做的事说清楚。"
        description="说明目标、数据在哪、怎样算做完，再定预算和截止时间。"
      />

      <nav className="wizard-steps" aria-label="发布步骤">
        {STEPS.map((item) => (
          <button
            type="button"
            key={item.id}
            disabled={item.id > step}
            className={
              item.id === step
                ? 'wizard-step wizard-step-active'
                : item.id < step
                  ? 'wizard-step wizard-step-done'
                  : 'wizard-step'
            }
            onClick={() => item.id < step && setStep(item.id)}
          >
            <span>
              {item.id < step ? <Check aria-hidden="true" /> : String(item.id).padStart(2, '0')}
            </span>
            {item.label}
          </button>
        ))}
      </nav>

      {error ? <InlineError message={error} /> : null}

      <section className="wizard-panel capsule-wizard-panel publish-workbench">
        {step === 1 ? (
          <div className="capsule-stage">
            <section className="task-capsule">
              <header className="capsule-head">
                <div>
                  <span>
                    <small>任务说明</small>
                    <strong>{title.trim() || '未命名任务'}</strong>
                  </span>
                </div>
              </header>

              <div className="capsule-body">
                <div className="capsule-identity-section">
                  <label className="field capsule-title-field">
                    <span>任务名称</span>
                    <input
                      value={title}
                      maxLength={120}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="例如：代数题逐题校验 / Batch 01"
                    />
                  </label>
                  <fieldset className="field">
                    <legend>任务类型</legend>
                    <div className="choice-row capsule-category-row">
                      {CATEGORIES.map((item) => (
                        <label
                          key={item.value}
                          className={
                            category === item.value ? 'choice-chip choice-chip-active' : 'choice-chip'
                          }
                        >
                          <input
                            type="radio"
                            name="category"
                            value={item.value}
                            checked={category === item.value}
                            onChange={() => setCategory(item.value)}
                          />
                          {item.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>

                <label className="field capsule-goal-field">
                  <span>
                    任务目标 <small>用一句话说清什么算完成</small>
                  </span>
                  <textarea
                    value={goal}
                    maxLength={2_000}
                    onChange={(event) => setGoal(event.target.value)}
                    rows={4}
                    placeholder="为每条输入生成可独立检查的结果。明确什么算完成，不要只写背景。"
                  />
                </label>

                <div className="capsule-contract-pair">
                  <label className="field">
                    <span>每条任务会提供什么</span>
                    <textarea
                      value={inputDescription}
                      maxLength={2_000}
                      onChange={(event) => setInputDescription(event.target.value)}
                      rows={4}
                      placeholder="说明每条数据里有哪些字段、上下文和边界。"
                    />
                  </label>
                  <label className="field">
                    <span>希望收到什么结果</span>
                    <textarea
                      value={outputDescription}
                      maxLength={2_000}
                      onChange={(event) => setOutputDescription(event.target.value)}
                      rows={4}
                      placeholder="Agent 只应返回什么？结构、语气、长度或必要字段是什么？"
                    />
                  </label>
                </div>

                <label className="field capsule-constraints-field">
                  <span>
                    必须遵守的要求 <small>换行或逗号分隔</small>
                  </span>
                  <textarea
                    value={constraintsRaw}
                    maxLength={4_000}
                    onChange={(event) => setConstraintsRaw(event.target.value)}
                    rows={3}
                    placeholder={'不要使用外部网络\n只返回最终答案\n不得修改输入中的 ID'}
                  />
                </label>
                <div className="constraint-chip-list" aria-label="已解析约束">
                  {constraints.length ? (
                    constraints.map((constraint, index) => (
                      <span key={constraint}>
                        <i>{String(index + 1).padStart(2, '0')}</i> {constraint}
                      </span>
                    ))
                  ) : (
                    <small>暂无额外要求；Agent 将按任务目标和结果说明执行。</small>
                  )}
                </div>

                <div className="capsule-examples">
                  <div className="capsule-subhead">
                    <div>
                      <span className="section-index">示例 · {examples.length} / 3</span>
                      <h3>给 Agent 看一组正确答案</h3>
                    </div>
                    {examples.length < 3 ? (
                      <button
                        className="button button-outline button-small"
                        type="button"
                        onClick={addExample}
                      >
                        <Plus aria-hidden="true" /> 添加示例
                      </button>
                    ) : null}
                  </div>
                  {examples.map((example, index) => (
                    <article
                      className={
                        expandedExample === index
                          ? 'example-card example-card-expanded'
                          : 'example-card'
                      }
                      key={index}
                    >
                      <header>
                        <button
                          className="example-card-toggle"
                          type="button"
                          aria-expanded={expandedExample === index}
                          onClick={() =>
                            setExpandedExample((current) => (current === index ? null : index))
                          }
                        >
                          <span className="example-serial">
                            <i>{String(index + 1).padStart(2, '0')}</i>
                            <strong>
                              {example.input.trim() && example.output.trim() ? '已填完' : '待填写'}
                            </strong>
                          </span>
                          <span className="example-toggle-meta">
                            {example.input.trim() && example.output.trim() ? '完整' : '未完成'}
                            <ChevronDown aria-hidden="true" />
                          </span>
                        </button>
                        {examples.length > 1 ? (
                          <button
                            className="example-remove"
                            type="button"
                            aria-label={`删除示例 ${index + 1}`}
                            onClick={() => removeExample(index)}
                          >
                            <Trash2 aria-hidden="true" />
                          </button>
                        ) : null}
                      </header>
                      <div className="example-card-fields" hidden={expandedExample !== index}>
                        <div className="form-grid-2">
                          <label className="field">
                            <span>示例输入</span>
                            <textarea
                              value={example.input}
                              maxLength={4_000}
                              onChange={(event) =>
                                updateExample(index, 'input', event.target.value)
                              }
                              rows={4}
                              placeholder="一条真实但不敏感的任务数据"
                            />
                          </label>
                          <label className="field">
                            <span>理想输出</span>
                            <textarea
                              className="code-input"
                              value={example.output}
                              maxLength={4_000}
                              onChange={(event) =>
                                updateExample(index, 'output', event.target.value)
                              }
                              rows={4}
                              placeholder="Agent 应该返回的最终结果"
                            />
                          </label>
                        </div>
                        <label className="field">
                          <span>
                            补充说明 <small>可选，解释为什么这样输出</small>
                          </span>
                          <input
                            value={example.note}
                            maxLength={500}
                            onChange={(event) => updateExample(index, 'note', event.target.value)}
                            placeholder="例如：保留原始 ID，且不要添加 Markdown"
                          />
                        </label>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
              <footer className="capsule-foot">
                <span>
                  <LockKeyhole aria-hidden="true" /> 这些内容只给执行任务的 Agent 看
                </span>
              </footer>
            </section>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="delivery-stage">
            <section className="units-step capsule-section-card">
              <div className="form-section-heading">
                <span>02</span>
                <div>
                  <h2>数据在哪</h2>
                  <p>文件放在你自己的地址，或先粘贴一小批试试。</p>
                </div>
              </div>

              <div className="delivery-target-grid">
                <button
                  type="button"
                  className={datasetMode === 'https' ? 'delivery-target active' : 'delivery-target'}
                  onClick={() => selectDatasetMode('https')}
                >
                  <Globe2 aria-hidden="true" />
                  <span>
                    <strong>文件地址</strong>
                    <small>放一份 JSONL，发布后不要改</small>
                  </span>
                  {datasetMode === 'https' ? <CheckCircle2 aria-hidden="true" /> : null}
                </button>
                <button
                  type="button"
                  className={datasetMode === 'inline' ? 'delivery-target active' : 'delivery-target'}
                  onClick={() => selectDatasetMode('inline')}
                >
                  <FileJson2 aria-hidden="true" />
                  <span>
                    <strong>粘贴 / 导入</strong>
                    <small>适合先试几条</small>
                  </span>
                  {datasetMode === 'inline' ? <CheckCircle2 aria-hidden="true" /> : null}
                </button>
              </div>

              {datasetMode === 'https' ? (
                <>
                  <label className="field">
                    <span>JSONL 地址</span>
                    <span className="input-shell">
                      <Globe2 aria-hidden="true" />
                      <input
                        type="url"
                        value={datasetUrl}
                        onChange={(event) => {
                          const nextUrl = event.target.value;
                          setDatasetUrl(nextUrl);
                          if (datasetCheckedUrl && nextUrl.trim() !== datasetCheckedUrl) {
                            setRemoteUnitCount(0);
                            setDatasetCheckedUrl('');
                            setDatasetHost(null);
                          }
                          setQuote(null);
                        }}
                        placeholder="https://files.example.com/batch.jsonl"
                      />
                    </span>
                  </label>
                  <div className="unit-envelope-note">
                    <ShieldCheck aria-hidden="true" />
                    <p>
                      <strong>发布后请保持这份文件不变。</strong>
                      做任务时会按行来取，改了文件会对不上。
                    </p>
                  </div>
                  <div className="unit-parse-bar">
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={checkingDataset}
                      onClick={() => void checkHttpsDataset()}
                    >
                      <Globe2 aria-hidden="true" /> {checkingDataset ? '正在检查…' : '检查地址'}
                    </button>
                    <span>
                      {httpsReady
                        ? `已确认 ${remoteUnitCount.toLocaleString('zh-CN')} 条${
                            datasetHost ? ` · ${datasetHost}` : ''
                          }`
                        : '填写地址后先检查，确认条数再继续'}
                    </span>
                  </div>
                  {parseError ? (
                    <div className="form-error" role="alert">
                      {parseError}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="unit-toolbar">
                    <div className="segment-control" role="group" aria-label="输入格式">
                      <button
                        type="button"
                        className={parseMode === 'lines' ? 'active' : ''}
                        onClick={() => setParseMode('lines')}
                      >
                        每行一条
                      </button>
                      <button
                        type="button"
                        className={parseMode === 'jsonl' ? 'active' : ''}
                        onClick={() => setParseMode('jsonl')}
                      >
                        JSONL
                      </button>
                    </div>
                    <label className="button button-outline button-small file-button">
                      <Upload aria-hidden="true" /> 导入 .txt / .jsonl
                      <input
                        type="file"
                        accept=".txt,.jsonl,.ndjson,text/plain,application/x-ndjson"
                        onChange={(event) => void importFile(event)}
                      />
                    </label>
                  </div>

                  <label className="field unit-editor">
                    <span>
                      {parseMode === 'lines'
                        ? '每个非空行会成为一条独立任务，并生成唯一 ID'
                        : '普通 JSON 值原样作为 input；只有 {$unit:{label,input,expectedOutput}} 是包装'}
                    </span>
                    <textarea
                      className="code-input"
                      value={rawUnits}
                      onChange={(event) => {
                        setRawUnits(event.target.value);
                        setUnits([]);
                        setQuote(null);
                      }}
                      rows={13}
                      placeholder={
                        parseMode === 'lines'
                          ? '题目 1\n题目 2\n题目 3'
                          : '{"question":"普通对象即使有 input 字段也原样保留"}\n{"$unit":{"label":"question-0002","input":{"question":"..."},"expectedOutput":{"answer":"42"}}}'
                      }
                    />
                  </label>
                  {parseMode === 'jsonl' ? (
                    <div className="unit-envelope-note">
                      <ShieldCheck aria-hidden="true" />
                      <p>
                        <strong>每行一个 JSON。</strong>只有带 <code>$unit</code>{' '}
                        的行才会拆出编号和预设答案。
                      </p>
                    </div>
                  ) : null}
                  <div className="unit-parse-bar">
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={parseCurrentUnits}
                    >
                      <FileJson2 aria-hidden="true" /> 检查数据
                    </button>
                    <span>
                      {units.length
                        ? `已识别 ${units.length.toLocaleString('zh-CN')} 条任务`
                        : '解析成功后会显示条数'}
                    </span>
                  </div>
                  {parseError ? (
                    <div className="form-error" role="alert">
                      {parseError}
                    </div>
                  ) : null}

                  {units.length ? (
                    <div className="unit-preview capsule-unit-preview">
                      <div className="unit-preview-head">
                        <div>
                          <strong>任务数据预览</strong>
                          <span>显示前 {Math.min(units.length, 6)} 条</span>
                        </div>
                        <div className="coverage-readout">
                          <span>已提供预设答案</span>
                          <strong>
                            {coverage.covered}/{coverage.total} · {coverage.percent}%
                          </strong>
                        </div>
                      </div>
                      {units.slice(0, 6).map((unit, index) => (
                        <div className="capsule-unit-row" key={index}>
                          <span>{String(index + 1).padStart(4, '0')}</span>
                          <div>
                            <small>外部引用 ID</small>
                            <strong>{unit.label}</strong>
                          </div>
                          <code>{printableValue(unit.input)}</code>
                          <span
                            className={
                              unit.expectedOutput === undefined ? 'coverage-miss' : 'coverage-hit'
                            }
                          >
                            {unit.expectedOutput === undefined
                              ? '未提供预设答案'
                              : `预设 ${printableValue(unit.expectedOutput, 48)}`}
                          </span>
                        </div>
                      ))}
                      {references.length ? (
                        <div className="form-error" role="alert">
                          {references.join('；')}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </section>

            <section className="capsule-section-card delivery-contract-card">
              <div className="acceptance-builder">
                <div className="capsule-subhead">
                  <div>
                    <span className="section-index">怎样算做完</span>
                    <h2>
                      {deliveryTarget === 'webhook' ? '由你的地址确认' : '怎样才算完成？'}
                    </h2>
                  </div>
                </div>
                {deliveryTarget === 'webhook' ? (
                  <div className="webhook-acceptance-lock">
                    <Webhook aria-hidden="true" />
                    <div>
                      <strong>在高级里填接收地址</strong>
                      <p>结果发到你给的地址，由那边确认。</p>
                    </div>
                  </div>
                ) : (
                  <div className="acceptance-option-grid">
                    {DEFAULT_ACCEPTANCE_OPTIONS.map((option) => (
                      <button
                        type="button"
                        key={option.value}
                        className={
                          acceptanceMode === option.value
                            ? 'acceptance-option active'
                            : 'acceptance-option'
                        }
                        onClick={() => selectAcceptance(option.value)}
                      >
                        <span>
                          {acceptanceMode === option.value ? <Check aria-hidden="true" /> : null}
                        </span>
                        <strong>{option.label}</strong>
                        <small>{option.detail}</small>
                      </button>
                    ))}
                  </div>
                )}
                {advancedAcceptance ? (
                  <p className="protocol-boundary">当前使用高级完成规则，细节在下方「高级」里。</p>
                ) : null}
                {datasetMode === 'https' && exactMode ? (
                  <p className="protocol-boundary">
                    选这个时，文件里每条都要带预设答案。
                  </p>
                ) : null}

                <div className="acceptance-check-list">
                  {checks.map((check) => (
                    <article className={check.ready ? 'ready' : 'not-ready'} key={check.id}>
                      <span>
                        {check.ready ? (
                          <Check aria-hidden="true" />
                        ) : (
                          <AlertTriangle aria-hidden="true" />
                        )}
                      </span>
                      <div>
                        <strong>{plainCheckText(check.label)}</strong>
                        <small>{plainCheckText(check.detail)}</small>
                      </div>
                      <em>
                        {datasetMode === 'https' && check.id === 'hidden_exact'
                          ? '远程文件'
                          : plainCheckText(check.coverage)}
                      </em>
                    </article>
                  ))}
                </div>

                <details className="normalization-panel">
                  <summary>
                    高级 <span>格式检查、外部地址</span>{' '}
                    <ChevronDown aria-hidden="true" />
                  </summary>
                  <p>需要检查格式，或把结果发到外部地址时再打开。</p>

                  <div className="delivery-target-grid">
                    <button
                      type="button"
                      className={
                        deliveryTarget === 'platform' ? 'delivery-target active' : 'delivery-target'
                      }
                      onClick={() => setTarget('platform')}
                    >
                      <Layers3 aria-hidden="true" />
                      <span>
                        <strong>保存在这里</strong>
                        <small>做完后你可以在详情里看结果</small>
                      </span>
                      {deliveryTarget === 'platform' ? <CheckCircle2 aria-hidden="true" /> : null}
                    </button>
                    <button
                      type="button"
                      className={
                        deliveryTarget === 'webhook'
                          ? 'delivery-target active warm'
                          : 'delivery-target'
                      }
                      onClick={() => setTarget('webhook')}
                    >
                      <Webhook aria-hidden="true" />
                      <span>
                        <strong>发到你的地址</strong>
                        <small>结果直接送到你给的网址</small>
                      </span>
                      {deliveryTarget === 'webhook' ? <CheckCircle2 aria-hidden="true" /> : null}
                    </button>
                  </div>

                  <fieldset className="field format-field">
                    <legend>结果格式</legend>
                    <div className="segment-control">
                      <button
                        type="button"
                        className={deliveryFormat === 'text' ? 'active' : ''}
                        onClick={() => setFormat('text')}
                      >
                        TEXT
                      </button>
                      <button
                        type="button"
                        className={deliveryFormat === 'json' ? 'active' : ''}
                        onClick={() => setFormat('json')}
                      >
                        JSON
                      </button>
                    </div>
                  </fieldset>

                  {deliveryFormat === 'json' ? (
                    <label className="field schema-editor-field">
                      <span>
                        JSON Schema <small>只检查结构，不代表正确性或质量</small>
                      </span>
                      <textarea
                        className="code-input"
                        value={schemaText}
                        onChange={(event) => setSchemaText(event.target.value)}
                        rows={7}
                        placeholder={
                          '{"type":"object","required":["answer"],"properties":{"answer":{"type":"string"}}}'
                        }
                      />
                      <span
                        className={
                          schemaState.error
                            ? 'schema-parse-state schema-parse-error'
                            : schemaState.value
                              ? 'schema-parse-state schema-parse-ready'
                              : 'schema-parse-state'
                        }
                        role="status"
                      >
                        {schemaState.error ? (
                          <>
                            <X aria-hidden="true" /> {schemaState.error}
                          </>
                        ) : schemaState.value ? (
                          <>
                            <Check aria-hidden="true" /> JSON 语法已解析；发布时服务端仍会再次检查
                            Schema
                          </>
                        ) : (
                          '等待 Schema；不用 Schema 检查时可以留空。'
                        )}
                      </span>
                    </label>
                  ) : null}

                  {deliveryTarget === 'platform' ? (
                    <div className="acceptance-option-grid">
                      {ADVANCED_ACCEPTANCE_OPTIONS.map((option) => {
                        const disabled = deliveryFormat !== 'json';
                        return (
                          <button
                            type="button"
                            key={option.value}
                            disabled={disabled}
                            className={
                              acceptanceMode === option.value
                                ? 'acceptance-option active'
                                : 'acceptance-option'
                            }
                            onClick={() => selectAcceptance(option.value)}
                          >
                            <span>
                              {acceptanceMode === option.value ? (
                                <Check aria-hidden="true" />
                              ) : null}
                            </span>
                            <strong>{option.label}</strong>
                            <small>{disabled ? '先把结果格式切为 JSON' : option.detail}</small>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {deliveryTarget === 'webhook' ? (
                    <div className="webhook-config">
                      <div className="webhook-warning">
                        <AlertTriangle aria-hidden="true" />
                        <p>
                          <strong>结果会直接发到这个地址。</strong>
                          领取的人需要同意外发，对方也看得到来源网络。
                        </p>
                      </div>
                      <label className="field">
                        <span>
                          接收地址 <small>必须是 HTTPS</small>
                        </span>
                        <span className="input-shell">
                          <Globe2 aria-hidden="true" />
                          <input
                            type="url"
                            value={webhookUrl}
                            onChange={(event) => setWebhookUrl(event.target.value)}
                            placeholder="https://hooks.example.com/agentpool/a8f3…"
                          />
                        </span>
                        <small>
                          请用一个不容易猜到的地址。
                        </small>
                      </label>
                      <div className="receipt-secret-card">
                        <div>
                          <KeyRound aria-hidden="true" />
                          <span>
                            <strong>确认密钥</strong>
                            <small>复制一次，关掉后看不到</small>
                          </span>
                        </div>
                        <input
                          aria-label="确认密钥，已隐藏"
                          type="password"
                          value={receiptSecret}
                          readOnly
                          tabIndex={-1}
                        />
                        <div>
                          <button
                            className="button button-primary button-small"
                            type="button"
                            disabled={secretCopied}
                            onClick={() => void copySecretOnce()}
                          >
                            <Copy aria-hidden="true" /> {secretCopied ? '已复制一次' : '一次性复制'}
                          </button>
                          <button
                            className="button button-outline button-small"
                            type="button"
                            onClick={regenerateSecret}
                          >
                            <RefreshCw aria-hidden="true" /> 重新生成
                          </button>
                        </div>
                        {copyNotice ? <p role="status">{copyNotice}</p> : null}
                      </div>
                      <div className="webhook-protocol-grid">
                        <article>
                          <span>发出去的内容</span>
                          <CopyCommand command={callbackExample()} />
                        </article>
                        <article>
                          <span>对方回过来的确认</span>
                          <CopyCommand command={receiptExample()} />
                        </article>
                      </div>
                      <p className="protocol-boundary">
                        示例里的签名是 [REDACTED]，不会带上真实密钥。
                      </p>
                    </div>
                  ) : null}

                  {exactMode ? (
                    <div className="normalization-grid">
                      <label>
                        <input
                          type="checkbox"
                          checked={answerNormalization.trimStrings}
                          onChange={(event) =>
                            setAnswerNormalization((current) => ({
                              ...current,
                              trimStrings: event.target.checked,
                            }))
                          }
                        />
                        去首尾空白
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={answerNormalization.collapseWhitespace}
                          onChange={(event) =>
                            setAnswerNormalization((current) => ({
                              ...current,
                              collapseWhitespace: event.target.checked,
                            }))
                          }
                        />
                        合并连续空白
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={answerNormalization.caseInsensitive}
                          onChange={(event) =>
                            setAnswerNormalization((current) => ({
                              ...current,
                              caseInsensitive: event.target.checked,
                            }))
                          }
                        />
                        忽略大小写
                      </label>
                      <label className="tolerance-field">
                        <span>数值容差</span>
                        <NumberDraftInput
                          min={0}
                          step="any"
                          value={answerNormalization.numericTolerance}
                          onValueChange={(numericTolerance) =>
                            setAnswerNormalization((current) => ({
                              ...current,
                              numericTolerance,
                            }))
                          }
                          placeholder="严格"
                        />
                      </label>
                    </div>
                  ) : null}
                </details>
              </div>
            </section>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="ignition-stage">
            <section className="capsule-section-card">
              <div className="form-section-heading">
                <span>03</span>
                <div>
                  <h2>花多少、何时截止、是否先试几条</h2>
                  <p>建议先开放 1–3 条试跑；你看过结果后，再手动开放剩余任务。</p>
                </div>
              </div>

              <div className="launch-mode-grid">
                <button
                  type="button"
                  className={launchMode === 'pilot' ? 'launch-mode active' : 'launch-mode'}
                  onClick={() => setLaunchMode('pilot')}
                >
                  <Flame aria-hidden="true" />
                  <span>
                    <strong>先试跑</strong>
                    <small>先开放少量任务，确认结果后再开放其余任务</small>
                  </span>
                  <em>默认</em>
                </button>
                <button
                  type="button"
                  className={launchMode === 'immediate' ? 'launch-mode active warm' : 'launch-mode'}
                  onClick={() => setLaunchMode('immediate')}
                >
                  <Rocket aria-hidden="true" />
                  <span>
                    <strong>全部开放</strong>
                    <small>发布后就可以被人领</small>
                  </span>
                </button>
              </div>

              {launchMode === 'pilot' ? (
                <div className="pilot-config-line">
                  <label className="field">
                    <span>试跑条数</span>
                    <NumberDraftInput
                      min={1}
                      max={Math.min(3, Math.max(1, unitCount))}
                      value={pilotUnits}
                      onValueChange={setPilotUnits}
                    />
                  </label>
                  <div className="pilot-flow-mini" aria-label="试跑发布流程">
                    <strong>{pilotUnits} 条试跑</strong>
                    <ArrowRight aria-hidden="true" />
                    <span>{heldUnits.toLocaleString('zh-CN')} 条暂不开放</span>
                    <ArrowRight aria-hidden="true" />
                    <em>你确认后开放</em>
                  </div>
                </div>
              ) : null}

              <div className="capacity-grid ignition-capacity-grid">
                <div className="wizard-form">
                  <div className="form-grid-2">
                    <label className="field">
                      <span>每条任务奖励</span>
                      <span className="input-shell">
                        <Zap aria-hidden="true" />
                        <NumberDraftInput
                          min={1}
                          max={1_000_000}
                          value={rewardPerUnit}
                          onValueChange={(value) => {
                            setRewardPerUnit(value);
                            setQuote(null);
                          }}
                        />
                      </span>
                      <small>每条给多少积分</small>
                    </label>
                    <label className="field">
                      <span>全部任务的截止时间</span>
                      <input
                        type="datetime-local"
                        value={deadlineAt}
                        onChange={(event) => {
                          setDeadlineAt(event.target.value);
                          setQuote(null);
                        }}
                      />
                    </label>
                  </div>

                  <fieldset className="field">
                    <legend>用哪个来做</legend>
                    <div className="agent-selector">
                      {(['codex', 'claude'] as const).map((agent) => {
                        const item = catalog.find((entry) => entry.adapter === agent);
                        return (
                          <label
                            key={agent}
                            className={
                              requestedAgent === agent
                                ? 'agent-option agent-option-active'
                                : 'agent-option'
                            }
                          >
                            <input
                              type="radio"
                              name="agent"
                              checked={requestedAgent === agent}
                              onChange={() => selectAgent(agent)}
                            />
                            <Bot aria-hidden="true" />
                            <span>
                              <strong>{agent === 'codex' ? 'Codex' : 'Claude'}</strong>
                              <small>目前可接</small>
                            </span>
                            {requestedAgent === agent ? <CheckCircle2 aria-hidden="true" /> : null}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  <label className="field exact-model-field">
                    <span>
                      模型 <small>填写要用的那个</small>
                    </span>
                    <span className="input-shell">
                      <Cpu aria-hidden="true" />
                      <input
                        list="model-catalog"
                        value={requestedModel}
                        maxLength={120}
                        onChange={(event) => {
                          setRequestedModel(event.target.value);
                          setQuote(null);
                        }}
                        placeholder="输入准确的模型名称"
                      />
                    </span>
                    <datalist id="model-catalog">
                      {currentModels.map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </label>
                  <div className="form-grid-2">
                    <label className="field">
                      <span>同时执行上限</span>
                      <span className="input-shell">
                        <Gauge aria-hidden="true" />
                        <NumberDraftInput
                          min={1}
                          max={Math.max(1, unitCount)}
                          value={requiredConcurrency}
                          onValueChange={(value) => {
                            setRequiredConcurrency(value);
                            setQuote(null);
                          }}
                        />
                      </span>
                      <small>同一时间最多做这么多条</small>
                    </label>
                    <label className="field">
                      <span>每条任务最长执行时间</span>
                      <span className="input-shell">
                        <Clock3 aria-hidden="true" />
                        <NumberDraftInput
                          min={10}
                          max={3600}
                          value={maxUnitSeconds}
                          onValueChange={(value) => {
                            setMaxUnitSeconds(value);
                            setQuote(null);
                          }}
                        />
                      </span>
                      <small>秒，超时会按设置重试</small>
                    </label>
                  </div>
                </div>

                <aside className="budget-card ignition-budget-card">
                  <div className="budget-icon">
                    <WalletCards aria-hidden="true" />
                  </div>
                  <span className="mono-label">预计锁定预算</span>
                  <strong>{points(budget)}</strong>
                  <span className="pulse-boundary-tag">现在还不是真钱</span>
                  <dl>
                    <div>
                      <dt>任务条数</dt>
                      <dd>{unitCount.toLocaleString('zh-CN')}</dd>
                    </div>
                    <div>
                      <dt>首次开放</dt>
                      <dd>{launchMode === 'pilot' ? pilotUnits : unitCount}</dd>
                    </div>
                    <div>
                      <dt>当前可消费</dt>
                      <dd>{points(wallet?.purchasedAvailable || 0)}</dd>
                    </div>
                  </dl>
                  {budget <= (wallet?.purchasedAvailable || 0) ? (
                    <p className="budget-ok">
                      <Check aria-hidden="true" /> 发布时会先扣下这些积分
                    </p>
                  ) : null}
                </aside>
              </div>
            </section>
          </div>
        ) : null}

        {step === 4 && quote ? (
          <div className="launch-confirm-stage">
            <div className="form-section-heading">
              <span>04</span>
              <div>
                <h2>看一下再发布</h2>
                <p>确认先开放多少条，以及结果送到哪里。</p>
              </div>
            </div>

            <section className="ignition-sequence-card">
              <header>
                <div>
                  <Flame aria-hidden="true" />
                  <span>
                    <small>发布方式</small>
                    <strong>{launchMode === 'pilot' ? '先试跑' : '全部开放'}</strong>
                  </span>
                </div>
                <span>{quote.feasible ? '当前可用 Runner 较多' : '当前可用 Runner 有限'}</span>
              </header>
              <div className="ignition-sequence">
                <article className="active">
                  <span>首次开放</span>
                  <strong>{launchMode === 'pilot' ? pilotUnits : unitCount}</strong>
                  <small>{launchMode === 'pilot' ? '条试跑任务' : '条全部任务'}</small>
                </article>
                <ArrowRight aria-hidden="true" />
                <article>
                  <span>暂不开放</span>
                  <strong>{heldUnits}</strong>
                  <small>条任务</small>
                </article>
                <ArrowRight aria-hidden="true" />
                <article className={launchMode === 'pilot' ? 'warm' : 'active'}>
                  <span>后续操作</span>
                  <strong>{launchMode === 'pilot' ? '你来确认' : '等人来领'}</strong>
                  <small>{launchMode === 'pilot' ? '看过试跑再开放剩下的' : '发布后即可领取'}</small>
                </article>
              </div>
              {launchMode === 'pilot' ? (
                <p>试跑通过后，再在详情页开放剩下的。</p>
              ) : null}
            </section>

            <div
              className={
                quote.feasible
                  ? 'capacity-quote capacity-quote-good'
                  : 'capacity-quote capacity-quote-warn'
              }
            >
              <header>
                <div>
                  {quote.feasible ? (
                    <CheckCircle2 aria-hidden="true" />
                  ) : (
                    <AlertTriangle aria-hidden="true" />
                  )}
                  <span>
                    <strong>
                      {quote.feasible
                        ? '现在有人能接'
                        : '现在能接的人不多'}
                    </strong>
                    <small>
                      {quote.adapter} / {quote.model}
                    </small>
                  </span>
                </div>
                <span className="quote-verdict">{quote.feasible ? '参考充足' : '参考有限'}</span>
              </header>
              <div className="quote-metrics">
                <div>
                  <span>
                    {deliveryTarget === 'webhook' ? '可领取回调任务的 Runner' : '当前在线 Runner'}
                  </span>
                  <strong>{quote.onlineNodes.toLocaleString('zh-CN')}</strong>
                  <small>有性能记录的 Runner {quote.certifiedNodes}</small>
                </div>
                <div>
                  <span>
                    {deliveryTarget === 'webhook' ? '回调任务可用并发参考' : '当前可用并发参考'}
                  </span>
                  <strong>{quote.availableConcurrency.toLocaleString('zh-CN')}</strong>
                  <small>同时执行上限 {quote.requiredConcurrency}</small>
                </div>
                <div>
                  <span>较慢任务耗时（P95）</span>
                  <strong>{quote.p95Ms === null ? '无证据' : duration(quote.p95Ms / 1000)}</strong>
                </div>
                <div>
                  <span>预计完成时间</span>
                  <strong>{duration(quote.estimatedSeconds)}</strong>
                  <small>截止 {fullDateTime(quote.deadlineAt)}</small>
                </div>
              </div>
              {quote.reasons.length ? (
                <ul className="quote-reasons">
                  {quote.reasons.map((reason) => (
                    <li key={reason}>{capacityReason(reason)}</li>
                  ))}
                </ul>
              ) : null}
              <p className="webhook-capacity-note">这些数字是现在的参考，发布后等人来领。</p>
            </div>

            <div className="compiled-contract-grid">
              <section className="compiled-preview-card">
                <header>
                  <div>
                    <Code2 aria-hidden="true" />
                    <span>
                      <small>对方会看到</small>
                      <strong>任务说明</strong>
                    </span>
                  </div>
                  <span>V1</span>
                </header>
                <pre>{compiledPreview}</pre>
              </section>
              <aside className="contract-facts-card">
                <span className="section-index">任务设置</span>
                <dl>
                  <div>
                    <dt>数据来源</dt>
                    <dd>
                      {datasetMode === 'https'
                        ? `${datasetHost || webhookHostname(datasetUrl)} · ${unitCount.toLocaleString('zh-CN')} 条`
                        : `粘贴导入 · ${unitCount.toLocaleString('zh-CN')} 条`}
                    </dd>
                  </div>
                  <div>
                    <dt>结果格式</dt>
                    <dd>{deliveryFormat.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt>完成规则</dt>
                    <dd>
                      {acceptanceMode === 'webhook'
                        ? '由你的地址确认'
                        : ACCEPTANCE_OPTIONS.find((option) => option.value === acceptanceMode)
                            ?.label || acceptanceMode}
                    </dd>
                  </div>
                  <div>
                    <dt>预设答案覆盖</dt>
                    <dd>{datasetMode === 'https' ? '看文件' : `${coverage.percent}%`}</dd>
                  </div>
                  <div>
                    <dt>结果去向</dt>
                    <dd>
                      {deliveryTarget === 'webhook'
                        ? webhookHostname(webhookUrl)
                        : '保存在这里'}
                    </dd>
                  </div>
                </dl>
                <div className="acceptance-check-list compact">
                  {checks.map((check) => (
                    <article className={check.ready ? 'ready' : 'not-ready'} key={check.id}>
                      <span>{check.ready ? <Check aria-hidden="true" /> : <AlertTriangle />}</span>
                      <div>
                        <strong>{plainCheckText(check.label)}</strong>
                        <small>{plainCheckText(check.coverage)}</small>
                      </div>
                    </article>
                  ))}
                </div>
              </aside>
            </div>

            {deliveryTarget === 'webhook' ? (
              <div className="webhook-final-boundary">
                <Webhook aria-hidden="true" />
                <div>
                  <strong>结果发送到 {webhookHostname(webhookUrl)}</strong>
                  <p>
                    结果直接发到这个地址，详情里只看确认情况。
                  </p>
                </div>
              </div>
            ) : null}

            {!quote.feasible ? (
              <div className="capacity-warning">
                <AlertTriangle aria-hidden="true" />
                <p>
                  <strong>现在能接的人不多，你仍可以发布。</strong>
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        <footer className="wizard-footer">
          <button
            className="button button-quiet"
            type="button"
            disabled={step === 1 || publishing}
            onClick={() => setStep((current) => Math.max(1, current - 1))}
          >
            <ArrowLeft aria-hidden="true" /> 上一步
          </button>
          <div>
            <span>
              {step < 4
                ? `${step} / 4`
                : launchMode === 'pilot'
                  ? `先开放 ${pilotUnits} 条`
                  : '开放全部'}
            </span>
            {step === 3 && budget > (wallet?.purchasedAvailable || 0) ? (
              <p className="budget-warning wizard-inline-warning">
                <AlertTriangle aria-hidden="true" /> 积分不足
              </p>
            ) : null}
            {step < 4 ? (
              <button
                className="button button-primary"
                type="button"
                disabled={
                  loadingQuote ||
                  checkingDataset ||
                  (step === 3 && budget > (wallet?.purchasedAvailable || 0))
                }
                onClick={() => void next()}
              >
                {loadingQuote || checkingDataset
                  ? datasetMode === 'https' && step === 2
                    ? '正在检查地址…'
                    : '正在估算…'
                  : step === 3
                    ? '下一步'
                    : '继续'}{' '}
                {!loadingQuote && !checkingDataset ? <ArrowRight aria-hidden="true" /> : null}
              </button>
            ) : (
              <button
                className={quote?.feasible ? 'button button-primary' : 'button button-warm'}
                type="button"
                disabled={publishing || !quoteIsCurrent}
                onClick={() => void publish()}
              >
                {publishing
                  ? '正在发布…'
                  : launchMode === 'pilot'
                    ? '发布试跑'
                    : '发布'}{' '}
                {!publishing ? <Flame aria-hidden="true" /> : null}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
