import type {
  CapacityQuote,
  RequestedAgent,
  TaskCategory,
  WalletSummary,
} from '@agent-pool/shared';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
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
  RadioTower,
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
import { capacityReason, credits, duration, fullDateTime } from '../lib/format';
import {
  acceptanceChecks,
  callbackExample,
  compileAgentInstruction,
  expectedOutputCoverage,
  generateReceiptSecret,
  isHttpsWebhook,
  parseConstraints,
  parseExampleOutput,
  parseJsonObject,
  receiptExample,
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
  code: string;
  detail: string;
}> = [
  { value: 'text', label: '文本', code: 'TX', detail: '理解 · 生成' },
  { value: 'data', label: '数据', code: 'DT', detail: '清洗 · 标注' },
  { value: 'coding', label: '代码', code: 'CD', detail: '实现 · 审查' },
  { value: 'research', label: '研究', code: 'RS', detail: '搜索 · 归纳' },
  { value: 'math', label: '数学', code: 'MX', detail: '计算 · 证明' },
  { value: 'vision', label: '视觉', code: 'VS', detail: '识别 · 观察' },
  { value: 'other', label: '其他', code: 'OT', detail: '自定义任务' },
];

function CategoryGlyph({ category }: { category: TaskCategory }) {
  const glyph = (() => {
    switch (category) {
      case 'text':
        return (
          <>
            <path d="M11 14h26M11 21h18M11 28h24M11 35h13" />
            <path className="glyph-core" d="M33 19v11l5-3v-5z" />
          </>
        );
      case 'data':
        return (
          <>
            <ellipse cx="24" cy="13" rx="13" ry="5" />
            <path d="M11 13v10c0 2.8 5.8 5 13 5s13-2.2 13-5V13M11 23v10c0 2.8 5.8 5 13 5s13-2.2 13-5V23" />
            <path className="glyph-core" d="M30 20h4" />
          </>
        );
      case 'coding':
        return (
          <>
            <path d="m18 14-9 10 9 10M30 14l9 10-9 10" />
            <path className="glyph-core" d="m27 10-6 28" />
          </>
        );
      case 'research':
        return (
          <>
            <circle cx="21" cy="21" r="9" />
            <path d="m28 28 9 9M21 8V5M8 21H5M12 12 9 9" />
            <path className="glyph-core" d="M17 21h8M21 17v8" />
          </>
        );
      case 'math':
        return (
          <>
            <path d="M35 10H14l11 14-11 14h21" />
            <path className="glyph-core" d="M30 18h9M34.5 13.5v9" />
          </>
        );
      case 'vision':
        return (
          <>
            <path d="M5 24s7-11 19-11 19 11 19 11-7 11-19 11S5 24 5 24Z" />
            <circle className="glyph-core" cx="24" cy="24" r="6" />
            <path d="M24 8V4M24 44v-4M8 24H4M44 24h-4" />
          </>
        );
      default:
        return (
          <>
            <path d="m24 7 5 7 9 1-4 8 4 8-9 1-5 9-5-9-9-1 4-8-4-8 9-1z" />
            <circle className="glyph-core" cx="24" cy="23" r="4" />
          </>
        );
    }
  })();

  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 48 48">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        {glyph}
      </g>
    </svg>
  );
}

const STEPS = [
  { id: 1, label: '任务说明' },
  { id: 2, label: '任务数据' },
  { id: 3, label: '执行与预算' },
  { id: 4, label: '检查并发布' },
] as const;

const ACCEPTANCE_OPTIONS: Array<{
  value: Exclude<AcceptanceMode, 'webhook'>;
  label: string;
  detail: string;
}> = [
  { value: 'non_empty', label: '结果非空', detail: '只确认有内容，不判断正确性' },
  { value: 'schema', label: 'JSON Schema', detail: '检查形状、类型和必填字段' },
  { value: 'hidden_exact', label: '与预设答案一致', detail: '每条任务都要提供预设答案' },
  {
    value: 'schema_and_hidden_exact',
    label: 'Schema + 预设答案',
    detail: '格式和答案都符合才算完成',
  },
  { value: 'manual', label: '人工确认', detail: '由你查看结果后决定是否完成' },
];

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
  const coverage = useMemo(() => expectedOutputCoverage(units), [units]);
  const references = useMemo(() => unitReferenceIssues(units), [units]);
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

  const budget = lockedBudget(units.length, rewardPerUnit);
  const heldUnits = launchMode === 'pilot' ? Math.max(0, units.length - pilotUnits) : 0;
  const capacityInput = useMemo(
    () => ({
      adapter: requestedAgent,
      model: requestedModel.trim(),
      deliveryMode: deliveryTarget,
      unitCount: units.length,
      requiredConcurrency,
      maxUnitSeconds,
      deadlineAt: Number.isNaN(new Date(deadlineAt).getTime())
        ? ''
        : new Date(deadlineAt).toISOString(),
    }),
    [
      requestedAgent,
      requestedModel,
      deliveryTarget,
      units.length,
      requiredConcurrency,
      maxUnitSeconds,
      deadlineAt,
    ],
  );
  const currentFingerprint = JSON.stringify(capacityInput);
  const quoteIsCurrent = quote !== null && quoteFingerprint === currentFingerprint;

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

  const parseCurrentUnits = (): TaskUnitDraft[] | null => {
    try {
      const parsed = parseUnits(rawUnits, parseMode);
      if (parsed.length < 2) throw new Error('至少需要 2 条独立任务数据');
      if (parsed.length > 20_000) throw new Error('一次最多发布 20,000 条任务');
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
      if (parsed.length > 20_000) throw new Error('一次最多发布 20,000 条任务');
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
      setCopyNotice('已复制一次。请现在写入你的回执服务；平台保存后不会回显。');
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

  const validateStep = (): boolean => {
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
      const parsed = parseCurrentUnits();
      if (!parsed) return false;
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
      const parsedCoverage = expectedOutputCoverage(parsed);
      if (acceptanceMode === 'schema' || acceptanceMode === 'schema_and_hidden_exact') {
        if (deliveryFormat !== 'json') return voidError('Schema 检查要求结果格式为 JSON');
        if (!schemaText.trim()) return voidError('这种完成规则需要填写 JSON Schema');
        if (schemaState.error || !schemaState.value)
          return voidError(`JSON Schema 尚未就绪：${schemaState.error || '请填写对象'}`);
      }
      if (acceptanceMode === 'hidden_exact' || acceptanceMode === 'schema_and_hidden_exact') {
        if (parsedCoverage.covered !== parsedCoverage.total)
          return voidError(
            `与预设答案比对需要覆盖全部任务，目前 ${parsedCoverage.covered}/${parsedCoverage.total}`,
          );
      }
      if (deliveryTarget === 'webhook') {
        if (!isHttpsWebhook(webhookUrl)) return voidError('Webhook 必须是有效的 HTTPS URL');
        const issues = unitReferenceIssues(parsed);
        if (issues.length) return voidError(issues.join('；').replaceAll('Unit', '任务'));
        if (!secretCopied) return voidError('请先一次性复制 receipt secret，再继续发布');
      }
    }
    if (step === 3) {
      if (!requestedModel.trim()) return voidError('必须手输或选择精确模型，平台不会自动替换');
      if (!units.length) return voidError('请先添加任务数据');
      if (requiredConcurrency < 1 || requiredConcurrency > units.length)
        return voidError('同时执行上限必须在 1 到任务条数之间');
      if (maxUnitSeconds < 10 || maxUnitSeconds > 3600)
        return voidError('每条任务时限必须在 10–3600 秒之间');
      if (rewardPerUnit < 1 || rewardPerUnit > 1_000_000)
        return voidError('每条任务奖励必须在 1–1,000,000 PULSE 之间');
      if (launchMode === 'pilot' && (pilotUnits < 1 || pilotUnits > Math.min(3, units.length)))
        return voidError('试跑条数必须在 1–3 之间，且不能超过任务总数');
      const deadlineTime = new Date(deadlineAt).getTime();
      if (!Number.isFinite(deadlineTime) || deadlineTime <= Date.now() + 10_000)
        return voidError('请选择至少晚于当前时间 10 秒的截止时间');
      if (budget > (wallet?.purchasedAvailable || 0))
        return voidError('可消费 PULSE 不足，请先去 PULSE 账本增加演示积分');
    }
    return true;
  };

  const next = async () => {
    if (!validateStep()) return;
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
    const parsedExamples = examples
      .filter((example) => example.input.trim() || example.output.trim())
      .map((example) => ({
        input: example.input,
        output: parseExampleOutput(example.output, deliveryFormat),
        ...(example.note.trim() ? { note: example.note.trim() } : {}),
      }));
    const exactMode =
      acceptanceMode === 'hidden_exact' || acceptanceMode === 'schema_and_hidden_exact';
    const payload: CreatePoolWebInput = {
      title: title.trim(),
      category,
      publicSummary: goal.trim().slice(0, 300),
      requestedAgent,
      requestedModel: requestedModel.trim(),
      requiredConcurrency,
      maxUnitSeconds,
      deadlineAt: capacityInput.deadlineAt,
      rewardPerUnit,
      validationMode: legacyValidation(acceptanceMode),
      units,
      taskCapsule: {
        version: 'ap-task/1',
        goal: goal.trim(),
        inputDescription: inputDescription.trim(),
        outputDescription: outputDescription.trim(),
        constraints,
        examples: parsedExamples,
        delivery: {
          format: deliveryFormat,
          ...(schemaState.value ? { schema: schemaState.value } : {}),
          maxBytes: 1024 * 1024,
        },
        acceptance: {
          mode: acceptanceMode,
          criteria: checks.map((check) => `${check.label}：${check.detail}`),
          ...(exactMode ? { normalization: answerNormalization } : {}),
        },
      },
      deliveryTarget:
        deliveryTarget === 'webhook'
          ? { mode: 'webhook', url: webhookUrl.trim(), receiptSecret }
          : { mode: 'platform' },
      launchMode,
      pilotUnits: launchMode === 'pilot' ? pilotUnits : Math.min(3, units.length),
    };

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

  if (loading) return <LoadingState label="正在读取当前容量" />;

  return (
    <div className="page publish-page capsule-publish-page">
      <PageHeader
        eyebrow="发布新任务"
        title="把任务说清楚，再交给 Agent。"
        description="填写每条任务会提供什么、要产出什么；先用几条试跑，确认后再开放剩余任务。"
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
                  <span className="capsule-signal" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    <small>任务说明 / 第 1 步</small>
                    <strong>{title.trim() || '未命名任务'}</strong>
                  </span>
                </div>
                <span className="capsule-state">
                  <CircleDot aria-hidden="true" /> 草稿
                </span>
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
                  <fieldset className="field capsule-category-field">
                    <legend>
                      任务类型 <small>选一个最接近的分类</small>
                    </legend>
                    <div className="capsule-category-track">
                      {CATEGORIES.map((item) => (
                        <label
                          key={item.value}
                          className={`category-cassette category-${item.value}${
                            category === item.value ? ' category-cassette-active' : ''
                          }`}
                        >
                          <input
                            type="radio"
                            name="category"
                            value={item.value}
                            checked={category === item.value}
                            onChange={() => setCategory(item.value)}
                          />
                          <span className="category-channel">{item.code}</span>
                          <span className="category-glyph">
                            <CategoryGlyph category={item.value} />
                          </span>
                          <span className="category-copy">
                            <strong>{item.label}</strong>
                            <small>{item.detail}</small>
                          </span>
                          <span className="category-lock" aria-hidden="true" />
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
                  <LockKeyhole aria-hidden="true" /> 任务说明、示例和每条数据不会显示给 Runner 主人
                </span>
                <strong>AP-TASK / V1</strong>
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
                  <h2>添加任务数据</h2>
                  <p>每一行对应一条任务。添加后再选择结果保存在哪里。</p>
                </div>
              </div>

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
                    onChange={importFile}
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
                    <strong>JSONL 规则。</strong>普通对象会原样作为任务数据；只有明确的{' '}
                    <code>$unit</code> envelope 才提取 label 与隐藏 expectedOutput。
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
                    : '支持 2–20,000 条任务'}
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
            </section>

            <section className="capsule-section-card delivery-contract-card">
              <div className="capsule-subhead">
                <div>
                  <span className="section-index">结果去向</span>
                  <h2>结果交到哪里？</h2>
                </div>
              </div>
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
                    <strong>保存在平台</strong>
                    <small>平台加密保存结果，支持自动检查或人工确认</small>
                  </span>
                  {deliveryTarget === 'platform' ? <CheckCircle2 aria-hidden="true" /> : null}
                </button>
                <button
                  type="button"
                  className={
                    deliveryTarget === 'webhook' ? 'delivery-target active warm' : 'delivery-target'
                  }
                  onClick={() => setTarget('webhook')}
                >
                  <Webhook aria-hidden="true" />
                  <span>
                    <strong>发送到回调地址（Webhook，实验）</strong>
                    <small>结果不存平台，只保留外部服务的确认摘要</small>
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

              {deliveryTarget === 'webhook' ? (
                <div className="webhook-config">
                  <div className="webhook-warning">
                    <AlertTriangle aria-hidden="true" />
                    <p>
                      <strong>结果会直接发送给外部服务，不是隐身通道。</strong>外部服务会看到 Runner
                      的网络地址； Runner 主人需要在领取时明确允许回调地址（
                      <code>--allow-webhooks</code>）。
                    </p>
                  </div>
                  <label className="field">
                    <span>
                      回调地址（Webhook HTTPS URL） <small>使用不可猜的长 path 作为入站授权</small>
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
                      平台不会向 callback 发送 receipt secret；URL 的不可猜 path 负责入站授权。
                    </small>
                  </label>
                  <div className="receipt-secret-card">
                    <div>
                      <KeyRound aria-hidden="true" />
                      <span>
                        <strong>回执签名密钥（Receipt HMAC secret）</strong>
                        <small>用来确认回执没有被篡改 · 平台加密保存 · 发布后不回显</small>
                      </span>
                    </div>
                    <input
                      aria-label="回执签名密钥，已隐藏"
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
                      <span>回调请求（CALLBACK REQUEST）</span>
                      <CopyCommand command={callbackExample()} />
                    </article>
                    <article>
                      <span>确认回执（ACCEPTANCE RECEIPT）</span>
                      <CopyCommand command={receiptExample()} />
                    </article>
                  </div>
                  <p className="protocol-boundary">
                    回执签名密钥只用于 HMAC 签名（确认回执未被篡改）。示例永远使用
                    [REDACTED]，不包含真实 secret。
                  </p>
                </div>
              ) : null}

              <div className="acceptance-builder">
                <div className="capsule-subhead">
                  <div>
                    <span className="section-index">完成规则</span>
                    <h2>{deliveryTarget === 'webhook' ? '由签名回执确认' : '怎样才算完成？'}</h2>
                  </div>
                </div>
                {deliveryTarget === 'platform' ? (
                  <div className="acceptance-option-grid">
                    {ACCEPTANCE_OPTIONS.map((option) => {
                      const schemaMode =
                        option.value === 'schema' || option.value === 'schema_and_hidden_exact';
                      const disabled = schemaMode && deliveryFormat !== 'json';
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
                          onClick={() => setAcceptanceMode(option.value)}
                        >
                          <span>
                            {acceptanceMode === option.value ? <Check aria-hidden="true" /> : null}
                          </span>
                          <strong>{option.label}</strong>
                          <small>{disabled ? '先把结果格式切为 JSON' : option.detail}</small>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="webhook-acceptance-lock">
                    <Webhook aria-hidden="true" />
                    <div>
                      <strong>回调地址签名确认（Webhook / HMAC）</strong>
                      <p>平台不保存结果；只记录外部服务的确认状态与结果指纹（digest）。</p>
                    </div>
                  </div>
                )}

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
                      <em>{plainCheckText(check.coverage)}</em>
                    </article>
                  ))}
                </div>

                {acceptanceMode === 'hidden_exact' ||
                acceptanceMode === 'schema_and_hidden_exact' ? (
                  <details className="normalization-panel">
                    <summary>
                      答案比较方式 <span>默认严格</span> <ChevronDown aria-hidden="true" />
                    </summary>
                    <p>这些选项只影响答案比较时如何处理空白和大小写，不会改成语义评分。</p>
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
                  </details>
                ) : null}
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
                  <h2>设置 Agent、执行数量和预算</h2>
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
                    <small>发布后立即开放所有任务，等待 Runner 主人主动领取</small>
                  </span>
                </button>
              </div>

              {launchMode === 'pilot' ? (
                <div className="pilot-config-line">
                  <label className="field">
                    <span>试跑条数</span>
                    <NumberDraftInput
                      min={1}
                      max={Math.min(3, Math.max(1, units.length))}
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
                  <fieldset className="field">
                    <legend>指定 Agent</legend>
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
                              <small>{item?.models.length || 0} 个有历史性能记录的模型</small>
                            </span>
                            {requestedAgent === agent ? <CheckCircle2 aria-hidden="true" /> : null}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  <label className="field exact-model-field">
                    <span>
                      使用的模型 <small>需要准确填写；平台不会换成别的模型</small>
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
                          max={Math.max(1, units.length)}
                          value={requiredConcurrency}
                          onValueChange={(value) => {
                            setRequiredConcurrency(value);
                            setQuote(null);
                          }}
                        />
                      </span>
                      <small>同一时刻最多执行这么多条；不会触发自动派发</small>
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
                  <div className="form-grid-2">
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
                      <small>PULSE · 演示积分 / 非真实法币</small>
                    </label>
                  </div>
                </div>

                <aside className="budget-card ignition-budget-card">
                  <div className="budget-icon">
                    <WalletCards aria-hidden="true" />
                  </div>
                  <span className="mono-label">预计锁定预算</span>
                  <strong>{credits(budget)}</strong>
                  <span className="pulse-boundary-tag">演示积分 / 非真实法币</span>
                  <dl>
                    <div>
                      <dt>任务条数</dt>
                      <dd>{units.length.toLocaleString('zh-CN')}</dd>
                    </div>
                    <div>
                      <dt>首次开放</dt>
                      <dd>{launchMode === 'pilot' ? pilotUnits : units.length}</dd>
                    </div>
                    <div>
                      <dt>当前可消费</dt>
                      <dd>{credits(wallet?.purchasedAvailable || 0)}</dd>
                    </div>
                  </dl>
                  {budget <= (wallet?.purchasedAvailable || 0) ? (
                    <p className="budget-ok">
                      <Check aria-hidden="true" /> 发布时锁定全部预算，试跑后由你决定是否继续
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
                <h2>检查设置并发布</h2>
                <p>最后确认 Agent 会看到什么、首次开放多少条，以及结果保存在哪里。</p>
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
                  <strong>{launchMode === 'pilot' ? pilotUnits : units.length}</strong>
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
                  <strong>{launchMode === 'pilot' ? '你来确认' : 'Runner 主动领取'}</strong>
                  <small>{launchMode === 'pilot' ? '看过结果后手动开放' : '不会自动派发'}</small>
                </article>
              </div>
              {launchMode === 'pilot' ? (
                <p>试跑结果全部通过后，剩余任务仍不会自动开放；你需要在详情页手动确认。</p>
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
                        ? deliveryTarget === 'webhook'
                          ? '当前支持回调地址的 Runner 较多'
                          : '当前可用 Runner 较多'
                        : deliveryTarget === 'webhook'
                          ? '当前支持回调地址的 Runner 有限'
                          : '当前可用 Runner 有限'}
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
              {deliveryTarget === 'webhook' ? (
                <p className="webhook-capacity-note">
                  这里只统计明确支持 Webhook（回调地址）、且 Agent 和模型匹配的 Runner。
                </p>
              ) : null}
              <p className="webhook-capacity-note">
                这些数字只是此刻的参考，不会预订 Runner，也不会自动派发。发布后仍需要 Runner
                主人主动领取。
              </p>
            </div>

            <div className="compiled-contract-grid">
              <section className="compiled-preview-card">
                <header>
                  <div>
                    <Code2 aria-hidden="true" />
                    <span>
                      <small>Agent 实际看到的内容</small>
                      <strong>Agent 将收到的任务说明</strong>
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
                    <dt>结果格式</dt>
                    <dd>{deliveryFormat.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt>完成规则</dt>
                    <dd>
                      {acceptanceMode === 'webhook'
                        ? '回调地址签名回执'
                        : ACCEPTANCE_OPTIONS.find((option) => option.value === acceptanceMode)
                            ?.label || acceptanceMode}
                    </dd>
                  </div>
                  <div>
                    <dt>预设答案覆盖</dt>
                    <dd>{coverage.percent}%</dd>
                  </div>
                  <div>
                    <dt>结果去向</dt>
                    <dd>
                      {deliveryTarget === 'webhook'
                        ? webhookHostname(webhookUrl)
                        : '平台（加密保存）'}
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
                    平台不保存结果；只保存外部回执状态、结果指纹（digest）和签名校验摘要（HMAC）。
                    回执签名密钥会加密保存，且不会在详情页回显。
                  </p>
                </div>
              </div>
            ) : null}

            {!quote.feasible ? (
              <div className="capacity-warning">
                <AlertTriangle aria-hidden="true" />
                <p>
                  <strong>你仍然可以发布。</strong>任务会开放给模型匹配的 Runner
                  主人主动领取；系统不会自动启动，也不会换模型凑数。
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
                  ? `首先发布 ${pilotUnits} 条试跑任务`
                  : '将立即开放全部任务'}
            </span>
            {step === 3 && budget > (wallet?.purchasedAvailable || 0) ? (
              <p className="budget-warning wizard-inline-warning">
                <AlertTriangle aria-hidden="true" /> PULSE 不足
              </p>
            ) : null}
            {step < 4 ? (
              <button
                className="button button-primary"
                type="button"
                disabled={
                  loadingQuote ||
                  (step === 3 && budget > (wallet?.purchasedAvailable || 0))
                }
                onClick={() => void next()}
              >
                {loadingQuote ? '正在检查可用 Runner…' : step === 3 ? '检查并继续' : '继续'}{' '}
                {!loadingQuote ? <ArrowRight aria-hidden="true" /> : null}
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
                    ? `锁定 PULSE，发布 ${pilotUnits} 条试跑任务`
                    : '锁定 PULSE，发布全部任务'}{' '}
                {!publishing ? <Flame aria-hidden="true" /> : null}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
