import type {
  DatasetSource,
  RequestedAgent,
  TaskCategory,
  WalletSummary,
} from '@agent-pool/shared';
import { DATASET_UNIT_MAX, INLINE_UNIT_MAX, formatCredits } from '@agent-pool/shared';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileJson2,
  Link2,
  LockKeyhole,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DocumentTitle } from '../components/DocumentTitle';
import { InlineError, LoadingState } from '../components/LoadingState';
import { NumberDraftInput } from '../components/NumberDraftInput';
import { PageHeader } from '../components/PageHeader';
import { api, ApiError } from '../lib/api';
import { capacityReason, fullDateTime } from '../lib/format';
import {
  attachPublishDataset,
  buildTaskCapsule,
  generateReceiptSecret,
  isHttpsDatasetUrl,
  isHttpsWebhook,
  localExampleWorkUrl,
  parseConstraints,
  parseExampleOutput,
  parseJsonObject,
  unitReferenceIssues,
  type AcceptanceMode,
  type CreatePoolWebInput,
  type DeliveryFormat,
  type DeliveryMode,
  type LaunchMode,
  type TaskCapsule,
  type TaskExampleDraft,
} from '../lib/taskContract';
import {
  clearPublishDraft,
  defaultPublishDeadline,
  readPublishDraft,
  writePublishDraft,
  type WorkPreview,
} from '../lib/publishDraft';
import type { CapacityCatalogItem } from '../lib/types';
import type { TaskUnitDraft } from '../lib/unitTypes';
import { lockedBudget, parseUnits, type UnitParseMode } from '../lib/units';

type SourceMode = DatasetSource['mode'];

const CATEGORIES: Array<{ value: TaskCategory; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'data', label: '数据' },
  { value: 'coding', label: '代码' },
  { value: 'research', label: '研究' },
  { value: 'math', label: '数学' },
  { value: 'vision', label: '视觉' },
  { value: 'other', label: '其他' },
];

const STEPS = [
  { id: 1, label: '契约' },
  { id: 2, label: '条件' },
  { id: 3, label: '确认' },
] as const;

const ACCEPTANCE_LABEL: Record<AcceptanceMode, string> = {
  non_empty: '结果非空',
  hidden_exact: '与托管答案一致',
  schema: 'JSON Schema',
  schema_and_hidden_exact: 'Schema + 托管答案',
  manual: '人工确认',
  webhook: '回调回执',
};

const EMPTY_EXAMPLE: TaskExampleDraft = { input: '', output: '', note: '' };

const PROBE_CAPSULE: TaskCapsule = {
  version: 'ap-task/1',
  goal: 'Validate hosted work package',
  inputDescription: 'Hosted unit input',
  outputDescription: 'Hosted unit output',
  constraints: [],
  examples: [{ input: { probe: true }, output: 'ok' }],
  delivery: { format: 'text', maxBytes: 1024 },
  acceptance: { mode: 'non_empty', criteria: ['non-empty'] },
};

function defaultDeadline(): string {
  return defaultPublishDeadline();
}

function deadlineIso(value: string): string {
  const time = new Date(value).getTime();
  return Number.isFinite(time)
    ? new Date(time).toISOString()
    : new Date(Date.now() + 86_400_000).toISOString();
}

function points(value: number): string {
  return `${formatCredits(value)} 积分`;
}

export function PublishPage() {
  const navigate = useNavigate();
  const [draft] = useState(readPublishDraft);
  const [step, setStep] = useState<number>(draft?.step ?? 1);
  const [source, setSource] = useState<SourceMode>(draft?.source ?? 'work');
  const [workUrl, setWorkUrl] = useState(draft?.workUrl ?? '');
  const [workPreview, setWorkPreview] = useState<WorkPreview | null>(draft?.workPreview ?? null);
  const [checking, setChecking] = useState(false);

  const [title, setTitle] = useState(draft?.title ?? '');
  const [category, setCategory] = useState<TaskCategory>(draft?.category ?? 'text');
  const [goal, setGoal] = useState(draft?.goal ?? '');
  const [inputDescription, setInputDescription] = useState(draft?.inputDescription ?? '');
  const [outputDescription, setOutputDescription] = useState(draft?.outputDescription ?? '');
  const [constraintsRaw, setConstraintsRaw] = useState(draft?.constraintsRaw ?? '');
  const [examples, setExamples] = useState<TaskExampleDraft[]>(
    draft?.examples?.length ? draft.examples : [{ ...EMPTY_EXAMPLE }],
  );
  const [datasetUrl, setDatasetUrl] = useState(draft?.datasetUrl ?? '');
  const [datasetHost, setDatasetHost] = useState<string | null>(draft?.datasetHost ?? null);
  const [remoteUnitCount, setRemoteUnitCount] = useState(draft?.remoteUnitCount ?? 0);
  const [datasetCheckedUrl, setDatasetCheckedUrl] = useState(draft?.datasetCheckedUrl ?? '');
  const [rawUnits, setRawUnits] = useState(draft?.rawUnits ?? '');
  const [parseMode, setParseMode] = useState<UnitParseMode>(draft?.parseMode ?? 'jsonl');
  const [units, setUnits] = useState<TaskUnitDraft[]>(draft?.units ?? []);
  const [parseError, setParseError] = useState<string | null>(null);
  const [acceptanceMode, setAcceptanceMode] = useState<AcceptanceMode>(
    draft?.acceptanceMode ?? 'non_empty',
  );
  const [deliveryFormat, setDeliveryFormat] = useState<DeliveryFormat>(
    draft?.deliveryFormat ?? 'text',
  );
  const [schemaText, setSchemaText] = useState(draft?.schemaText ?? '');
  const [deliveryTarget, setDeliveryTarget] = useState<DeliveryMode>(
    draft?.deliveryTarget ?? 'platform',
  );
  const [webhookUrl, setWebhookUrl] = useState(draft?.webhookUrl ?? '');
  const [receiptSecret, setReceiptSecret] = useState(
    () => draft?.receiptSecret || generateReceiptSecret(),
  );

  const [requestedAgent, setRequestedAgent] = useState<RequestedAgent>(
    draft?.requestedAgent ?? 'codex',
  );
  const [requestedModel, setRequestedModel] = useState(draft?.requestedModel ?? '');
  const [requiredConcurrency, setRequiredConcurrency] = useState(draft?.requiredConcurrency ?? 3);
  const [maxUnitSeconds, setMaxUnitSeconds] = useState(draft?.maxUnitSeconds ?? 120);
  const [deadlineAt, setDeadlineAt] = useState(draft?.deadlineAt ?? defaultDeadline);
  const [rewardPerUnit, setRewardPerUnit] = useState(draft?.rewardPerUnit ?? 10);
  const [launchMode, setLaunchMode] = useState<LaunchMode>(draft?.launchMode ?? 'pilot');
  const [pilotUnits, setPilotUnits] = useState(draft?.pilotUnits ?? 3);

  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [catalog, setCatalog] = useState<CapacityCatalogItem[]>([]);
  const [quoteNote, setQuoteNote] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.wallet(), api.capacityCatalog()])
      .then(([walletResult, catalogResult]) => {
        setWallet(walletResult);
        setCatalog(catalogResult);
        if (draft?.requestedModel) return;
        const codex = catalogResult.find((entry) => entry.adapter === 'codex');
        if (codex?.models[0]) setRequestedModel(codex.models[0]);
      })
      .catch((requestError) => {
        setError(requestError instanceof ApiError ? requestError.message : '无法读取容量目录');
      })
      .finally(() => setLoading(false));
  }, [draft]);

  useEffect(() => {
    writePublishDraft({
      v: 1,
      step: step === 2 || step === 3 ? step : 1,
      source,
      workUrl,
      workPreview,
      title,
      category,
      goal,
      inputDescription,
      outputDescription,
      constraintsRaw,
      examples,
      datasetUrl,
      datasetHost,
      remoteUnitCount,
      datasetCheckedUrl,
      rawUnits,
      parseMode,
      units,
      acceptanceMode,
      deliveryFormat,
      schemaText,
      deliveryTarget,
      webhookUrl,
      receiptSecret,
      requestedAgent,
      requestedModel,
      requiredConcurrency,
      maxUnitSeconds,
      deadlineAt,
      rewardPerUnit,
      launchMode,
      pilotUnits,
    });
  }, [
    acceptanceMode,
    category,
    constraintsRaw,
    datasetCheckedUrl,
    datasetHost,
    datasetUrl,
    deadlineAt,
    deliveryFormat,
    deliveryTarget,
    examples,
    goal,
    inputDescription,
    launchMode,
    maxUnitSeconds,
    outputDescription,
    parseMode,
    pilotUnits,
    rawUnits,
    receiptSecret,
    remoteUnitCount,
    requestedAgent,
    requestedModel,
    requiredConcurrency,
    rewardPerUnit,
    schemaText,
    source,
    step,
    title,
    units,
    webhookUrl,
    workPreview,
    workUrl,
  ]);

  const constraints = useMemo(() => parseConstraints(constraintsRaw), [constraintsRaw]);
  const schemaState = useMemo(() => parseJsonObject(schemaText), [schemaText]);
  const httpsReady =
    source === 'https' &&
    datasetCheckedUrl === datasetUrl.trim() &&
    remoteUnitCount >= 2 &&
    remoteUnitCount <= DATASET_UNIT_MAX;
  const dataset: DatasetSource =
    source === 'work'
      ? { mode: 'work', url: workUrl.trim() }
      : source === 'https'
        ? { mode: 'https', url: datasetUrl.trim() }
        : { mode: 'inline' };
  const unitCount =
    source === 'work'
      ? workPreview?.url === workUrl.trim()
        ? workPreview.totalUnits
        : 0
      : source === 'https'
        ? httpsReady
          ? remoteUnitCount
          : 0
        : units.length;
  const budget = lockedBudget(unitCount, rewardPerUnit);
  const purchasedAvailable = wallet?.purchasedAvailable ?? 0;
  const budgetShort = budget > purchasedAvailable;
  const currentModels = catalog.find((entry) => entry.adapter === requestedAgent)?.models ?? [];
  const effectiveAgent = source === 'work' && workPreview ? workPreview.adapter : requestedAgent;
  const effectiveModel =
    source === 'work' && workPreview ? workPreview.model : requestedModel.trim();
  const effectiveTitle =
    source === 'work' && workPreview ? workPreview.title : title.trim() || '未命名任务';
  const effectiveAcceptance =
    source === 'work' && workPreview ? workPreview.acceptance : acceptanceMode;

  const voidError = (message: string): false => {
    setError(message);
    return false;
  };

  const parseCurrentUnits = (): TaskUnitDraft[] | null => {
    try {
      const parsed = parseUnits(rawUnits, parseMode);
      if (parsed.length < 2) {
        setParseError('至少需要 2 条任务');
        return null;
      }
      if (parsed.length > INLINE_UNIT_MAX) {
        setParseError('粘贴条数太多，请改用工作包或 JSONL 地址');
        return null;
      }
      setUnits(parsed);
      setParseError(null);
      return parsed;
    } catch (parseIssue) {
      setParseError(parseIssue instanceof Error ? parseIssue.message : '无法解析这些任务');
      return null;
    }
  };

  const buildCapsule = (): TaskCapsule =>
    buildTaskCapsule({
      goal,
      inputDescription,
      outputDescription,
      constraints,
      examples: examples
        .filter((example) => example.input.trim() || example.output.trim())
        .map((example) => ({
          input: example.input,
          output: parseExampleOutput(example.output, deliveryFormat),
          ...(example.note.trim() ? { note: example.note.trim() } : {}),
        })),
      format: deliveryFormat,
      schema: schemaState.value,
      acceptanceMode,
      criteria: [ACCEPTANCE_LABEL[acceptanceMode]],
    });

  const buildPayload = (): CreatePoolWebInput => {
    const delivery: CreatePoolWebInput['deliveryTarget'] =
      deliveryTarget === 'webhook'
        ? { mode: 'webhook', url: webhookUrl.trim(), receiptSecret }
        : { mode: 'platform' };
    const base = {
      title: source === 'work' && workPreview ? workPreview.title : title.trim(),
      category: (source === 'work' && workPreview
        ? workPreview.category
        : category) as TaskCategory,
      publicSummary:
        source === 'work' && workPreview
          ? workPreview.publicSummary
          : goal.trim() || inputDescription.trim() || 'Hosted task batch',
      requestedAgent: effectiveAgent,
      requestedModel: effectiveModel,
      requiredConcurrency,
      maxUnitSeconds,
      deadlineAt: deadlineIso(deadlineAt),
      rewardPerUnit,
      validationMode:
        effectiveAcceptance === 'manual' || effectiveAcceptance === 'webhook' ? 'manual' : 'auto',
      taskCapsule: source === 'work' && workPreview ? workPreview.taskCapsule : buildCapsule(),
      deliveryTarget:
        source === 'work' && workPreview
          ? workPreview.taskCapsule.acceptance.mode === 'webhook'
            ? delivery
            : { mode: 'platform' as const }
          : delivery,
      launchMode,
      pilotUnits,
    } satisfies Omit<CreatePoolWebInput, 'dataset' | 'units'>;
    return attachPublishDataset(base, dataset, units);
  };

  const probeWork = async (): Promise<boolean> => {
    if (!isHttpsDatasetUrl(workUrl)) {
      return voidError('工作包必须是 HTTPS 地址，本机开发也可用 http://127.0.0.1');
    }
    setChecking(true);
    setError(null);
    try {
      const result = await api.validatePool({
        title: 'Work package',
        category: 'other',
        publicSummary: 'Validating hosted work package',
        requestedAgent: 'mock',
        requestedModel: 'mock-v1',
        requiredConcurrency: 1,
        maxUnitSeconds: 120,
        deadlineAt: deadlineIso(defaultDeadline()),
        rewardPerUnit: 1,
        validationMode: 'auto',
        taskCapsule: PROBE_CAPSULE,
        deliveryTarget: { mode: 'platform' },
        launchMode: 'pilot',
        pilotUnits: 3,
        dataset: { mode: 'work', url: workUrl.trim() },
      });
      if (result.dataset.mode !== 'work' || !result.workPackage || !result.taskCapsule) {
        return voidError('这个地址不是有效的 ap-work/1 工作包');
      }
      const preview: WorkPreview = {
        url: workUrl.trim(),
        title: result.workPackage.title,
        category: result.workPackage.category,
        publicSummary: result.workPackage.publicSummary,
        adapter: result.workPackage.adapter as RequestedAgent,
        model: result.workPackage.model,
        urlHost: result.workPackage.urlHost,
        unitsHost: result.workPackage.unitsHost,
        answersHost: result.workPackage.answersHost,
        acceptance: result.workPackage.acceptance as AcceptanceMode,
        totalUnits: result.totalUnits,
        taskCapsule: result.taskCapsule,
      };
      setWorkPreview(preview);
      setRequestedAgent(preview.adapter);
      setRequestedModel(preview.model);
      setRequiredConcurrency((current) => Math.min(current, preview.totalUnits));
      setPilotUnits((current) => Math.min(current, Math.min(3, preview.totalUnits)));
      return true;
    } catch (requestError) {
      setWorkPreview(null);
      return voidError(
        requestError instanceof ApiError ? requestError.message : '无法读取这个工作包',
      );
    } finally {
      setChecking(false);
    }
  };

  const probeHttps = async (): Promise<boolean> => {
    if (!isHttpsDatasetUrl(datasetUrl)) {
      return voidError('JSONL 必须是 HTTPS 地址，本机开发也可用 http://127.0.0.1');
    }
    setChecking(true);
    setError(null);
    setParseError(null);
    try {
      const result = await api.validatePool({
        ...buildPayload(),
        requestedAgent,
        requestedModel: requestedModel.trim() || 'pending-model',
        requiredConcurrency: 1,
        rewardPerUnit: 1,
        taskCapsule: buildTaskCapsule({
          goal: goal.trim() || 'Validate hosted JSONL',
          inputDescription: inputDescription.trim() || 'One JSON object per line',
          outputDescription: outputDescription.trim() || 'Any non-empty result',
          constraints,
          examples: [{ input: { probe: true }, output: 'ok' }],
          format: 'text',
          acceptanceMode: 'non_empty',
          criteria: ['non-empty'],
        }),
        deliveryTarget: { mode: 'platform' },
        dataset: { mode: 'https', url: datasetUrl.trim() },
      });
      setRemoteUnitCount(result.totalUnits);
      setDatasetCheckedUrl(datasetUrl.trim());
      setDatasetHost(result.dataset.mode === 'https' ? result.dataset.host : null);
      return true;
    } catch (requestError) {
      setRemoteUnitCount(0);
      setDatasetCheckedUrl('');
      setDatasetHost(null);
      const message = requestError instanceof ApiError ? requestError.message : '无法检查这个地址';
      setParseError(message);
      return voidError(message);
    } finally {
      setChecking(false);
    }
  };

  const validateStep = (): boolean => {
    setError(null);
    if (step === 1) {
      if (source === 'work') {
        if (!workPreview || workPreview.url !== workUrl.trim()) {
          return voidError('请先读取并确认工作包');
        }
      } else {
        if (title.trim().length < 3) return voidError('任务名称至少 3 个字');
        if (goal.trim().length < 8) return voidError('请写清目标');
        if (inputDescription.trim().length < 8) return voidError('请说明每条任务提供什么');
        if (outputDescription.trim().length < 8) return voidError('请说明希望收到什么');
        if (!examples[0]?.input.trim() || !examples[0]?.output.trim()) {
          return voidError('至少提供 1 组示例');
        }
        if (!requestedModel.trim()) return voidError('请填写精确模型名称');
        if (acceptanceMode === 'schema' || acceptanceMode === 'schema_and_hidden_exact') {
          if (deliveryFormat !== 'json') return voidError('Schema 检查要求 JSON 结果');
          if (!schemaState.value) return voidError(schemaState.error || '请填写 JSON Schema');
        }
        if (deliveryTarget === 'webhook' && !isHttpsWebhook(webhookUrl)) {
          return voidError('接收地址必须是有效的 HTTPS');
        }
        if (source === 'https' && !httpsReady) return voidError('请先检查 JSONL 地址');
        if (source === 'inline') {
          const parsed = parseCurrentUnits();
          if (!parsed) return false;
          if (acceptanceMode === 'hidden_exact' || acceptanceMode === 'schema_and_hidden_exact') {
            if (parsed.some((unit) => unit.expectedOutput === undefined)) {
              return voidError('与预设答案比对时，每条任务都要带 expectedOutput');
            }
          }
          if (deliveryTarget === 'webhook') {
            const issues = unitReferenceIssues(parsed);
            if (issues.length) return voidError(issues.join('；'));
          }
        }
      }
    }
    if (step === 2) {
      if (!unitCount) return voidError('请先确认任务数据');
      if (requiredConcurrency < 1 || requiredConcurrency > unitCount) {
        return voidError('同时领取数必须在 1 到任务条数之间');
      }
      if (maxUnitSeconds < 10 || maxUnitSeconds > 3600) {
        return voidError('每条时限必须在 10–3600 秒之间');
      }
      if (rewardPerUnit < 1 || rewardPerUnit > 1_000_000) {
        return voidError('每条奖励必须在 1–1,000,000 积分之间');
      }
      if (launchMode === 'pilot' && (pilotUnits < 1 || pilotUnits > Math.min(3, unitCount))) {
        return voidError('试跑条数必须在 1–3 之间');
      }
      const deadlineTime = new Date(deadlineAt).getTime();
      if (!Number.isFinite(deadlineTime) || deadlineTime <= Date.now() + 10_000) {
        return voidError('截止时间至少晚于现在 10 秒');
      }
      if (budget > (wallet?.purchasedAvailable || 0)) {
        return voidError('积分不够，请先去积分页增加');
      }
    }
    if (step === 3 && budget > (wallet?.purchasedAvailable || 0)) {
      return voidError('积分不够，请先去积分页增加');
    }
    return true;
  };

  const next = async () => {
    if (step === 1 && source === 'work' && (!workPreview || workPreview.url !== workUrl.trim())) {
      const ready = await probeWork();
      if (!ready) return;
    }
    if (step === 1 && source === 'https' && !httpsReady) {
      const ready = await probeHttps();
      if (!ready) return;
    }
    if (!validateStep()) return;
    if (step === 2) {
      try {
        const nextQuote = await api.capacityQuote({
          adapter: effectiveAgent,
          model: effectiveModel,
          deliveryMode:
            source === 'work'
              ? workPreview?.taskCapsule.acceptance.mode === 'webhook'
                ? 'webhook'
                : 'platform'
              : deliveryTarget,
          unitCount,
          requiredConcurrency,
          maxUnitSeconds,
          deadlineAt: deadlineIso(deadlineAt),
        });
        setQuoteNote(
          nextQuote.feasible
            ? `当前网络大约能同时跑 ${nextQuote.availableConcurrency} 条。这只是参考，不会自动派单。`
            : nextQuote.reasons.map((reason) => capacityReason(reason)).join('；') ||
                '容量评估未通过，仍可发布，等人主动领取。',
        );
      } catch {
        setQuoteNote('容量评估暂时不可用，仍可发布，等人主动领取。');
      }
    }
    setStep((current) => Math.min(3, current + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const publish = async () => {
    if (!validateStep()) return;
    setPublishing(true);
    setError(null);
    try {
      const created = await api.createPool(buildPayload());
      clearPublishDraft();
      navigate(`/app/pools/${created.id}`, { replace: true });
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  if (loading && !wallet) return <LoadingState label="正在加载" />;

  return (
    <div className="page publish-page capsule-publish-page contract-publish-page">
      <DocumentTitle title="发布任务" />
      <PageHeader
        eyebrow="发布任务"
        title="按契约发出去。"
        description="题目和验收放在你自己的地址。平台只记住索引、预算和领取规则。"
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

      <section className="wizard-panel publish-workbench contract-desk">
        {step === 1 ? (
          <div className="contract-stage">
            <article className="contract-primary">
              <header>
                <span className="contract-kicker">ap-work/1</span>
                <h2>工作包</h2>
                <p>
                  一份 JSON 清单，指向你托管的题目和可选答案。不遵守这份契约，领取方的 Agent
                  不会开工。
                </p>
              </header>

              <label className="field contract-url-field">
                <span>工作包地址</span>
                <input
                  value={workUrl}
                  onChange={(event) => {
                    setWorkUrl(event.target.value);
                    if (workPreview && workPreview.url !== event.target.value.trim()) {
                      setWorkPreview(null);
                    }
                    setSource('work');
                  }}
                  placeholder="https://your.domain/work.json"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              <div className="contract-actions">
                <button
                  className="button button-primary"
                  type="button"
                  disabled={checking}
                  onClick={() => void probeWork()}
                >
                  <Link2 aria-hidden="true" />
                  {checking && source === 'work' ? '正在读取…' : '读取契约'}
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => {
                    const example = localExampleWorkUrl();
                    setWorkUrl(example);
                    setWorkPreview(null);
                    setSource('work');
                    setError(null);
                  }}
                >
                  填入本机示例
                </button>
                <span>正式环境必须 HTTPS。本机开发可用 127.0.0.1。</span>
              </div>

              {workPreview && workPreview.url === workUrl.trim() ? (
                <div className="contract-preview" data-ready="true">
                  <div>
                    <strong>{workPreview.title}</strong>
                    <p>{workPreview.publicSummary}</p>
                  </div>
                  <dl>
                    <div>
                      <dt>条数</dt>
                      <dd>{workPreview.totalUnits.toLocaleString('zh-CN')}</dd>
                    </div>
                    <div>
                      <dt>执行</dt>
                      <dd>
                        {workPreview.adapter} / {workPreview.model}
                      </dd>
                    </div>
                    <div>
                      <dt>验收</dt>
                      <dd>{ACCEPTANCE_LABEL[workPreview.acceptance]}</dd>
                    </div>
                    <div>
                      <dt>题目</dt>
                      <dd>{workPreview.unitsHost}</dd>
                    </div>
                    <div>
                      <dt>答案</dt>
                      <dd>{workPreview.answersHost || '无托管答案'}</dd>
                    </div>
                    <div>
                      <dt>清单</dt>
                      <dd>{workPreview.urlHost}</dd>
                    </div>
                  </dl>
                  <p className="contract-seal">
                    <LockKeyhole aria-hidden="true" />
                    正文不入库。平台只保存哈希、偏移和预算。
                  </p>
                </div>
              ) : (
                <div className="contract-preview">
                  <p>读取后会看到标题、条数、执行器和托管域名。答案地址不会交给领取方。</p>
                </div>
              )}
            </article>

            <details className="contract-alt">
              <summary>不用工作包，改用 JSONL 或少量粘贴</summary>
              <div className="contract-alt-body">
                <div className="delivery-target-grid">
                  <button
                    type="button"
                    className={source === 'https' ? 'delivery-target active' : 'delivery-target'}
                    onClick={() => setSource('https')}
                  >
                    <FileJson2 aria-hidden="true" />
                    <span>
                      <strong>HTTPS JSONL</strong>
                      <small>题目在你的文件里，合同写在本页</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={source === 'inline' ? 'delivery-target active' : 'delivery-target'}
                    onClick={() => setSource('inline')}
                  >
                    <Upload aria-hidden="true" />
                    <span>
                      <strong>粘贴演示</strong>
                      <small>少量任务会进平台数据库</small>
                    </span>
                  </button>
                </div>

                {source !== 'work' ? (
                  <div className="contract-editor">
                    <label className="field capsule-title-field">
                      <span>任务名称</span>
                      <input
                        value={title}
                        maxLength={120}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="例如：代数题逐题校验"
                      />
                    </label>
                    <fieldset className="field">
                      <legend>类型</legend>
                      <div className="chip-row">
                        {CATEGORIES.map((item) => (
                          <button
                            key={item.value}
                            type="button"
                            className={category === item.value ? 'chip chip-active' : 'chip'}
                            onClick={() => setCategory(item.value)}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <label className="field">
                      <span>目标</span>
                      <textarea
                        rows={3}
                        value={goal}
                        onChange={(event) => setGoal(event.target.value)}
                        placeholder="Agent 要完成什么"
                      />
                    </label>
                    <div className="contract-pair">
                      <label className="field">
                        <span>每条输入</span>
                        <textarea
                          rows={3}
                          value={inputDescription}
                          onChange={(event) => setInputDescription(event.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>期望输出</span>
                        <textarea
                          rows={3}
                          value={outputDescription}
                          onChange={(event) => setOutputDescription(event.target.value)}
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>约束（可选，逗号或换行）</span>
                      <input
                        value={constraintsRaw}
                        onChange={(event) => setConstraintsRaw(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>示例输入</span>
                      <textarea
                        rows={2}
                        value={examples[0]?.input ?? ''}
                        onChange={(event) =>
                          setExamples([
                            { ...EMPTY_EXAMPLE, ...examples[0], input: event.target.value },
                          ])
                        }
                      />
                    </label>
                    <label className="field">
                      <span>示例输出</span>
                      <textarea
                        rows={2}
                        value={examples[0]?.output ?? ''}
                        onChange={(event) =>
                          setExamples([
                            { ...EMPTY_EXAMPLE, ...examples[0], output: event.target.value },
                          ])
                        }
                      />
                    </label>
                    <div className="contract-pair">
                      <label className="field">
                        <span>执行器</span>
                        <select
                          value={requestedAgent}
                          onChange={(event) => {
                            const next = event.target.value as RequestedAgent;
                            setRequestedAgent(next);
                            const first = catalog.find((entry) => entry.adapter === next)
                              ?.models[0];
                            if (first) setRequestedModel(first);
                          }}
                        >
                          {catalog.map((entry) => (
                            <option key={entry.adapter} value={entry.adapter}>
                              {entry.adapter}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>精确模型</span>
                        <input
                          list="publish-models"
                          value={requestedModel}
                          onChange={(event) => setRequestedModel(event.target.value)}
                          placeholder="必须和 Runner 认证完全一致"
                        />
                        <datalist id="publish-models">
                          {currentModels.map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </label>
                    </div>
                    <fieldset className="field">
                      <legend>怎样算做完</legend>
                      <div className="chip-row">
                        {(
                          [
                            ['non_empty', '结果非空'],
                            ['hidden_exact', '与答案一致'],
                            ['manual', '人工确认'],
                            ['schema', 'JSON Schema'],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            className={acceptanceMode === value ? 'chip chip-active' : 'chip'}
                            onClick={() => setAcceptanceMode(value)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    {acceptanceMode === 'schema' || acceptanceMode === 'schema_and_hidden_exact' ? (
                      <label className="field">
                        <span>JSON Schema</span>
                        <textarea
                          rows={6}
                          value={schemaText}
                          onChange={(event) => {
                            setSchemaText(event.target.value);
                            setDeliveryFormat('json');
                          }}
                        />
                      </label>
                    ) : null}
                    {source === 'https' ? (
                      <label className="field">
                        <span>JSONL 地址</span>
                        <input
                          value={datasetUrl}
                          onChange={(event) => {
                            setDatasetUrl(event.target.value);
                            setDatasetCheckedUrl('');
                          }}
                          placeholder="https://your.domain/units.jsonl"
                          spellCheck={false}
                        />
                        <button
                          className="button button-secondary"
                          type="button"
                          disabled={checking}
                          onClick={() => void probeHttps()}
                        >
                          {checking ? '检查中…' : '检查文件'}
                        </button>
                        {httpsReady ? (
                          <small>
                            {remoteUnitCount.toLocaleString('zh-CN')} 条 · {datasetHost}
                          </small>
                        ) : null}
                      </label>
                    ) : (
                      <label className="field">
                        <span>任务正文</span>
                        <div className="chip-row">
                          <button
                            type="button"
                            className={parseMode === 'jsonl' ? 'chip chip-active' : 'chip'}
                            onClick={() => setParseMode('jsonl')}
                          >
                            JSONL
                          </button>
                          <button
                            type="button"
                            className={parseMode === 'lines' ? 'chip chip-active' : 'chip'}
                            onClick={() => setParseMode('lines')}
                          >
                            每行一条
                          </button>
                        </div>
                        <textarea
                          rows={8}
                          value={rawUnits}
                          onChange={(event) => setRawUnits(event.target.value)}
                          placeholder={
                            '{"$unit":{"id":"q1","input":{"q":"1+1"}}}\n{"$unit":{"id":"q2","input":{"q":"2+2"}}}'
                          }
                          spellCheck={false}
                        />
                      </label>
                    )}
                    {parseError ? <p className="field-error">{parseError}</p> : null}
                  </div>
                ) : null}
              </div>
            </details>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="contract-stage">
            <article className="contract-primary">
              <header>
                <span className="contract-kicker">市场条件</span>
                <h2>这些留在平台。</h2>
                <p>单价、截止、同时领取数和试跑，是市场字段，不写进工作包。</p>
              </header>
              <div className="contract-market">
                <label className="field">
                  <span>每条积分</span>
                  <NumberDraftInput
                    value={rewardPerUnit}
                    min={1}
                    max={1_000_000}
                    onValueChange={setRewardPerUnit}
                  />
                </label>
                <label className="field">
                  <span>同时领取</span>
                  <NumberDraftInput
                    value={requiredConcurrency}
                    min={1}
                    max={Math.max(1, unitCount)}
                    onValueChange={setRequiredConcurrency}
                  />
                </label>
                <label className="field">
                  <span>每条时限（秒）</span>
                  <NumberDraftInput
                    value={maxUnitSeconds}
                    min={10}
                    max={3600}
                    onValueChange={setMaxUnitSeconds}
                  />
                </label>
                <label className="field">
                  <span>截止时间</span>
                  <input
                    type="datetime-local"
                    value={deadlineAt}
                    onChange={(event) => setDeadlineAt(event.target.value)}
                  />
                </label>
              </div>
              <fieldset className="field">
                <legend>开放方式</legend>
                <div className="delivery-target-grid">
                  <button
                    type="button"
                    className={
                      launchMode === 'pilot' ? 'delivery-target active' : 'delivery-target'
                    }
                    onClick={() => setLaunchMode('pilot')}
                  >
                    <ShieldCheck aria-hidden="true" />
                    <span>
                      <strong>先试跑</strong>
                      <small>最多 3 条，通过后再放剩余</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={
                      launchMode === 'immediate' ? 'delivery-target active' : 'delivery-target'
                    }
                    onClick={() => setLaunchMode('immediate')}
                  >
                    <ArrowRight aria-hidden="true" />
                    <span>
                      <strong>立即开放</strong>
                      <small>全部进入可领取</small>
                    </span>
                  </button>
                </div>
              </fieldset>
              {launchMode === 'pilot' ? (
                <label className="field">
                  <span>试跑条数</span>
                  <NumberDraftInput
                    value={pilotUnits}
                    min={1}
                    max={Math.min(3, Math.max(1, unitCount))}
                    onValueChange={setPilotUnits}
                  />
                </label>
              ) : null}
              <p className={`contract-budget${budgetShort ? ' contract-budget-short' : ''}`}>
                将锁定 <strong>{points(budget)}</strong>
                {wallet ? ` · 可用 ${points(wallet.purchasedAvailable)}` : null}
                {budgetShort ? (
                  <>
                    {' '}
                    · 不够发布。
                    <Link to="/app/wallet">去积分页增加</Link>
                  </>
                ) : null}
              </p>
            </article>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="contract-stage">
            <article className="contract-primary">
              <header>
                <span className="contract-kicker">确认</span>
                <h2>{effectiveTitle}</h2>
                <p>
                  {unitCount.toLocaleString('zh-CN')} 条 · {effectiveAgent} / {effectiveModel} ·{' '}
                  {ACCEPTANCE_LABEL[effectiveAcceptance]}
                </p>
              </header>
              <dl className="contract-confirm">
                <div>
                  <dt>数据</dt>
                  <dd>
                    {source === 'work'
                      ? `工作包 ${workPreview?.urlHost ?? ''}`
                      : source === 'https'
                        ? `JSONL ${datasetHost ?? ''}`
                        : '粘贴在平台内'}
                  </dd>
                </div>
                <div>
                  <dt>单价</dt>
                  <dd>{points(rewardPerUnit)}</dd>
                </div>
                <div>
                  <dt>锁定</dt>
                  <dd>{points(budget)}</dd>
                </div>
                <div>
                  <dt>同时领取</dt>
                  <dd>{requiredConcurrency}</dd>
                </div>
                <div>
                  <dt>截止</dt>
                  <dd>{fullDateTime(deadlineIso(deadlineAt))}</dd>
                </div>
                <div>
                  <dt>开放</dt>
                  <dd>{launchMode === 'pilot' ? `先试跑 ${pilotUnits} 条` : '立即全部开放'}</dd>
                </div>
              </dl>
              {quoteNote ? <p className="contract-quote">{quoteNote}</p> : null}
              {budgetShort ? (
                <p className="contract-budget contract-budget-short">
                  积分不够，还差 {points(budget - purchasedAvailable)}。
                  <Link to="/app/wallet">去积分页增加</Link>
                </p>
              ) : null}
              <p className="contract-seal">
                <LockKeyhole aria-hidden="true" />
                不会自动派单。领取必须由 Runner 主人显式确认。
              </p>
            </article>
          </div>
        ) : null}

        <footer className="wizard-footer">
          <div>
            {step > 1 ? (
              <button
                className="button button-secondary"
                type="button"
                onClick={() => setStep(step - 1)}
              >
                <ArrowLeft aria-hidden="true" /> 上一步
              </button>
            ) : (
              <span />
            )}
            {step < 3 ? (
              <button
                className="button button-primary"
                type="button"
                disabled={checking || (step === 2 && budgetShort)}
                onClick={() => void next()}
              >
                下一步 <ArrowRight aria-hidden="true" />
              </button>
            ) : (
              <button
                className="button button-primary"
                type="button"
                disabled={publishing || budgetShort}
                onClick={() => void publish()}
              >
                {publishing ? '正在发布…' : `锁定 ${points(budget)} 并发布`}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
